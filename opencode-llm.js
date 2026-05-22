"use strict";

const { spawn } = require('child_process');
const http = require('http');

const PORT = 4097;
const MODEL_ID = 'deepseek-v4-flash-free';
const PROVIDER_ID = 'opencode';
const DISABLED_TOOLS = {
    read: false, edit: false, bash: false, grep: false, glob: false,
    list: false, webfetch: false, websearch: false, lsp: false,
    todowrite: false, task: false, skill: false,
};

let serverProcess = null;
let serverReady = false;
let msgCount = 0;

function httpPost(path, body) {
    return new Promise((resolve, reject) => {
        const data = JSON.stringify(body);
        const req = http.request({
            hostname: '127.0.0.1',
            port: PORT,
            path,
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
        }, (res) => {
            let buf = '';
            res.on('data', c => buf += c);
            res.on('end', () => {
                try { resolve(JSON.parse(buf)); }
                catch (e) { reject(new Error(`Bad JSON: ${buf.slice(0, 200)}`)); }
            });
        });
        req.on('error', reject);
        req.setTimeout(60000, () => { req.destroy(); reject(new Error('timeout')); });
        req.end(data);
    });
}

function httpGet(path) {
    return new Promise((resolve, reject) => {
        const req = http.request({
            hostname: '127.0.0.1',
            port: PORT,
            path,
            method: 'GET',
        }, (res) => {
            let buf = '';
            res.on('data', c => buf += c);
            res.on('end', () => {
                try { resolve(JSON.parse(buf)); }
                catch (e) { reject(new Error(`Bad JSON: ${buf.slice(0, 200)}`)); }
            });
        });
        req.on('error', reject);
        req.setTimeout(5000, () => { req.destroy(); reject(new Error('timeout')); });
        req.end();
    });
}

async function waitForServer(maxWait = 15000) {
    const start = Date.now();
    while (Date.now() - start < maxWait) {
        try {
            await httpGet('/global/health');
            return;
        } catch (_) {
            await new Promise(r => setTimeout(r, 500));
        }
    }
    throw new Error('opencode serve did not start');
}

async function ensureServer() {
    if (serverReady) return;
    if (!serverProcess) {
        serverProcess = spawn('opencode', ['serve', '--pure', '--port', String(PORT)], {
            cwd: '/tmp',
            stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env },
        });
        serverProcess.on('exit', (code) => {
            console.error(`opencode serve exited (code ${code})`);
            serverProcess = null;
            serverReady = false;
        });
        serverProcess.stderr.on('data', () => {});
        serverProcess.stdout.on('data', () => {});
    }
    await waitForServer();
    serverReady = true;
    console.log('opencode serve ready');
}

async function createSession() {
    const ses = await httpPost('/session', {
        model: { id: MODEL_ID, providerID: PROVIDER_ID },
    });
    if (!ses.id) throw new Error('Failed to create session: ' + JSON.stringify(ses));
    return ses.id;
}

async function queryLLM(prompt) {
    await ensureServer();
    const sid = await createSession();
    const resp = await httpPost(`/session/${sid}/message`, {
        parts: [{ type: 'text', text: prompt }],
        tools: DISABLED_TOOLS,
    });
    msgCount++;
    if (msgCount % 50 === 0) console.log(`[opencode] ${msgCount} queries completed`);
    if (resp.parts) {
        for (const part of resp.parts) {
            if (part.type === 'text' && part.text) return part.text.trim();
        }
    }
    throw new Error('No text in response: ' + JSON.stringify(resp).slice(0, 200));
}

function shutdown() {
    if (serverProcess) {
        serverProcess.kill();
        serverProcess = null;
    }
}

module.exports = { queryLLM, ensureServer, shutdown };
