"use strict";

const { spawn, execFile } = require('child_process');
const http = require('http');
const { broadcast } = require('./live-server');

const RETRY_INTERVAL_MS = 3000;
const MAX_RETRIES = 5;

// --- opencode serve provider ---

const OC_PORT = 4097;
const OC_DISABLED_TOOLS = {
    read: false, edit: false, bash: false, grep: false, glob: false,
    list: false, webfetch: false, websearch: false, lsp: false,
    todowrite: false, task: false, skill: false,
};

let ocProcess = null;
let ocReady = false;

function httpJson(method, port, path, body) {
    return new Promise((resolve, reject) => {
        const data = body ? JSON.stringify(body) : null;
        const headers = {};
        if (data) {
            headers['Content-Type'] = 'application/json';
            headers['Content-Length'] = Buffer.byteLength(data);
        }
        const req = http.request({ hostname: '127.0.0.1', port, path, method, headers }, (res) => {
            let buf = '';
            res.on('data', c => buf += c);
            res.on('end', () => {
                try { resolve(JSON.parse(buf)); }
                catch (e) { reject(new Error(`Bad JSON: ${buf.slice(0, 300)}`)); }
            });
        });
        req.on('error', reject);
        req.setTimeout(90000, () => { req.destroy(); reject(new Error('HTTP timeout')); });
        req.end(data);
    });
}

async function ensureOpencode() {
    if (ocReady) return;
    if (!ocProcess) {
        ocProcess = spawn('opencode', ['serve', '--pure', '--port', String(OC_PORT)], {
            cwd: '/tmp',
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        ocProcess.on('exit', () => { ocProcess = null; ocReady = false; });
        ocProcess.stderr.on('data', () => {});
        ocProcess.stdout.on('data', () => {});
    }
    const start = Date.now();
    while (Date.now() - start < 20000) {
        try { await httpJson('GET', OC_PORT, '/global/health'); ocReady = true; return; }
        catch (_) { await new Promise(r => setTimeout(r, 500)); }
    }
    throw new Error('opencode serve did not start');
}

async function queryOpencode(prompt, modelId) {
    await ensureOpencode();
    const [providerID, id] = modelId.includes('/') ? modelId.split('/', 2) : ['opencode', modelId];
    const ses = await httpJson('POST', OC_PORT, '/session', {
        model: { id, providerID },
    });
    if (!ses.id) throw new Error('session create failed');
    const resp = await httpJson('POST', OC_PORT, `/session/${ses.id}/message`, {
        parts: [{ type: 'text', text: prompt }],
        tools: OC_DISABLED_TOOLS,
    });
    let text = '';
    if (resp.parts) {
        for (const part of resp.parts) {
            if (part.type === 'reasoning' && part.text) {
                console.log(`  [THINK] ${part.text}`);
                broadcast('think', { text: part.text });
            }
            if (part.type === 'text' && part.text) {
                text = part.text.trim();
            }
        }
    }
    if (!text) throw new Error('No text in opencode response');
    return text;
}

// --- copilot provider ---

async function queryCopilot(prompt, modelId) {
    return new Promise((resolve, reject) => {
        const args = ['-p', prompt, '--output-format', 'text'];
        if (modelId) args.push('--model', modelId);
        execFile('copilot', args, {
            timeout: 90000,
            cwd: '/tmp',
            env: { ...process.env, NO_COLOR: '1' },
            maxBuffer: 1024 * 1024,
        }, (err, stdout) => {
            if (err) return reject(err);
            const text = stdout.replace(/\x1b\[[0-9;]*m/g, '').trim();
            if (!text) return reject(new Error('Empty copilot response'));
            resolve(text);
        });
    });
}

// --- gemini provider (REST API, no agent overhead) ---

async function queryGemini(prompt, modelId) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error('GEMINI_API_KEY environment variable not set');

    const model = modelId || 'gemini-2.0-flash';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 120000);
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
            signal: controller.signal,
            body: JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: {
                    temperature: 0.3,
                    maxOutputTokens: 2048,
                },
            }),
        });
        clearTimeout(timeoutId);

        if (!res.ok) {
            const err = await res.text().catch(() => '');
            throw new Error(`Gemini API ${res.status}: ${err.slice(0, 200)}`);
        }

        const data = await res.json();
        const parts = data.candidates?.[0]?.content?.parts;
        const text = parts?.filter(p => !p.thought).pop()?.text;
        if (!text) throw new Error('Empty gemini response');
        return text.trim();
    } catch (e) {
        clearTimeout(timeoutId);
        throw e;
    }
}

// --- claude provider ---

async function queryClaude(prompt, modelId) {
    return new Promise((resolve, reject) => {
        const args = ['-p'];
        if (modelId) args.push('--model', modelId);
        args.push(prompt);
        execFile('claude', args, {
            timeout: 90000,
            cwd: '/tmp',
            env: { ...process.env, NO_COLOR: '1' },
            maxBuffer: 1024 * 1024,
        }, (err, stdout) => {
            if (err) return reject(err);
            const text = stdout.replace(/\x1b\[[0-9;]*m/g, '').trim();
            if (!text) return reject(new Error('Empty claude response'));
            resolve(text);
        });
    });
}

// --- codex provider ---

async function queryCodex(prompt, modelId) {
    return new Promise((resolve, reject) => {
        const args = ['exec'];
        if (modelId) args.push('-m', modelId);
        args.push(prompt);
        execFile('codex', args, {
            timeout: 90000,
            cwd: '/tmp',
            env: { ...process.env, NO_COLOR: '1' },
            maxBuffer: 1024 * 1024,
        }, (err, stdout) => {
            if (err) return reject(err);
            const text = stdout.replace(/\x1b\[[0-9;]*m/g, '').trim();
            if (!text) return reject(new Error('Empty codex response'));
            resolve(text);
        });
    });
}

// --- local (llama.cpp / ollama) provider ---

const LOCAL_URL = process.env.LLAMA_URL || 'http://localhost:8080';

async function queryLocal(prompt, modelId) {
    const body = JSON.stringify({
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 12,
        temperature: 0.3,
        repeat_penalty: 1.0,
        ...(modelId ? { model: modelId } : {}),
    });
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 90000);
    try {
        const res = await fetch(`${LOCAL_URL}/v1/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: controller.signal,
            body,
        });
        clearTimeout(timeoutId);
        if (!res.ok) {
            const err = await res.text().catch(() => '');
            throw new Error(`Local API ${res.status}: ${err.slice(0, 200)}`);
        }
        const data = await res.json();
        return (data.choices?.[0]?.message?.content || '').trim();
    } catch (e) {
        clearTimeout(timeoutId);
        throw e;
    }
}

// --- dispatcher with retry ---

const PROVIDERS = {
    opencode: queryOpencode,
    copilot: queryCopilot,
    gemini: queryGemini,
    claude: queryClaude,
    codex: queryCodex,
    local: queryLocal,
};

let currentProvider = 'opencode';
let currentModelId = 'deepseek-v4-flash-free';
let queryCount = 0;

function configure(provider, modelId) {
    if (!PROVIDERS[provider]) throw new Error(`Unknown provider: ${provider}. Available: ${Object.keys(PROVIDERS).join(', ')}`);
    currentProvider = provider;
    currentModelId = modelId || '';
    console.log(`LLM provider: ${provider}${modelId ? ' (' + modelId + ')' : ''}`);
}

async function queryLLM(prompt, provider, modelId) {
    const prov = provider || currentProvider;
    const model = modelId !== undefined ? modelId : currentModelId;
    const fn = PROVIDERS[prov];
    if (!fn) throw new Error(`Unknown provider: ${prov}`);
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            const result = await fn(prompt, model);
            queryCount++;
            if (queryCount % 50 === 0) console.log(`[LLM] ${queryCount} queries completed`);
            return result;
        } catch (err) {
            console.error(`  [LLM] attempt ${attempt}/${MAX_RETRIES} failed: ${err.message}`);
            if (attempt < MAX_RETRIES) {
                console.log(`  [LLM] retrying in ${RETRY_INTERVAL_MS / 1000}s...`);
                await new Promise(r => setTimeout(r, RETRY_INTERVAL_MS));
            } else {
                throw new Error(`LLM failed after ${MAX_RETRIES} attempts: ${err.message}`);
            }
        }
    }
}

function shutdown() {
    if (ocProcess) { ocProcess.kill(); ocProcess = null; }
}

process.on('exit', shutdown);

module.exports = { queryLLM, configure, shutdown };
