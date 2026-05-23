"use strict";

const fs = require('fs');
const path = require('path');
const Majiang = require('@kobalab/majiang-core');
const AI = require('@kobalab/majiang-ai');
const QwenPlayer = require('./qwen-player');
const MahjongLMPlayer = require('./mahjonglm-player');
const SanmaMahjongLMPlayer = require('./sanma-mahjonglm-player');
const SanmaGame = require('./sanma-game');
const SanmaQwenPlayer = require('./sanma-qwen-player');
const { SimpleAI } = require('./sanma-player');
const { makeSeededShan, mulberry32, shanSeed } = require('./seeded-random');
const { broadcast } = require('./live-server');
const llm = require('./llm-provider');

const YONMA_GAMES = parseInt(process.env.YONMA_GAMES || '0');
const SANMA_GAMES = parseInt(process.env.SANMA_GAMES || '0');
const DURATION_MS = parseInt(process.env.DURATION_HOURS || '12') * 3600 * 1000;
const USE_GAME_COUNT = YONMA_GAMES > 0 || SANMA_GAMES > 0;
const PAIPU_DIR = path.join(__dirname, 'paipu');

const LLM_PROVIDER = process.env.LLM_PROVIDER || 'opencode';
const LLM_MODEL = process.env.LLM_MODEL || 'deepseek-v4-flash-free';
const PLAYER_TYPE = process.env.PLAYER_TYPE || 'llm';
const PLAYER_NAME = process.env.PLAYER_NAME || (PLAYER_TYPE === 'mahjonglm' ? 'MahjongLM' : LLM_MODEL || LLM_PROVIDER);

let gameCount = 0;
let yonmaPlayed = 0;
let sanmaPlayed = 0;
let results = [];
let startTime;
let currentMode = '';
let currentQwenSeat = 0;

function parsePlayer(config, seatIdx) {
    if (!config) {
        return { type: 'ai', name: `P${seatIdx + 1}` };
    }
    const cleanConfig = config.trim();
    const lowerConfig = cleanConfig.toLowerCase();
    
    if (lowerConfig === 'ai') {
        return { type: 'ai', name: `CPU-AI` };
    }
    if (lowerConfig.startsWith('mahjonglm')) {
        let serverUrl = undefined;
        if (cleanConfig.includes(':')) {
            const parts = cleanConfig.split(':');
            parts.shift(); // remove 'mahjonglm'
            const rest = parts.join(':').trim();
            if (rest.startsWith('http://') || rest.startsWith('https://')) {
                serverUrl = rest;
            } else if (/^\d+$/.test(rest)) {
                serverUrl = `http://127.0.0.1:${rest}`;
            } else {
                serverUrl = rest;
            }
        }
        let name = 'MahjongLM';
        if (serverUrl) {
            try {
                const u = new URL(serverUrl);
                name = `MahjongLM(${u.port || u.hostname})`;
            } catch {
                name = `MahjongLM(${serverUrl})`;
            }
        }
        return { type: 'mahjonglm', name, serverUrl };
    }
    if (lowerConfig.startsWith('llm')) {
        let provider = LLM_PROVIDER;
        let modelId = LLM_MODEL;
        if (cleanConfig.includes(':')) {
            const part = cleanConfig.substring(cleanConfig.indexOf(':') + 1).trim();
            if (part.includes('/')) {
                const parts = part.split('/');
                provider = parts[0].trim();
                modelId = parts.slice(1).join('/').trim();
            } else {
                provider = part;
                modelId = undefined;
            }
        }
        const name = modelId ? `${provider}/${modelId}` : provider;
        return { type: 'llm', name, provider, modelId };
    }
    return { type: 'ai', name: `P${seatIdx + 1}` };
}

class LiveView {
    constructor(model, mode, qwenSeat) {
        this._model = model;
        this._mode = mode;
        this._qwenSeat = qwenSeat;
    }
    kaiju() {
        const m = this._model;
        const qs = this._qwenSeat;
        let player;
        if (this._mode === 'sanma') {
            player = [m.player[qs], m.player[(qs + 1) % 3], '', m.player[(qs + 2) % 3]];
        } else {
            player = [m.player[qs], m.player[(qs + 1) % 4], m.player[(qs + 2) % 4], m.player[(qs + 3) % 4]];
        }
        broadcast('kaiju', {
            title: m.title,
            player,
            qijia: m.qijia,
            mode: this._mode,
            qwenSeat: qs,
            gameCount,
        });
    }
    redraw() {
        const m = this._model;
        const qs = this._qwenSeat;
        const n = this._mode === 'sanma' ? 3 : 4;

        const shoupai = ['', '', '', ''];
        const defen = [0, 0, 0, 0];
        const player_id = [0, 0, 0, 0];

        if (this._mode === 'sanma') {
            for (let l = 0; l < 3; l++) {
                shoupai[l] = m.shoupai[l].toString();
                const realPid = (m.qijia + m.jushu + l) % 3;
                if (realPid === qs) player_id[l] = 0;
                else if (realPid === (qs + 1) % 3) player_id[l] = 1;
                else player_id[l] = 3;
                defen[l] = m.defen[realPid];
            }
            player_id[3] = 2;
        } else {
            for (let l = 0; l < 4; l++) {
                shoupai[l] = m.shoupai[l].toString();
                const realPid = (m.qijia + m.jushu + l) % 4;
                player_id[l] = (realPid - qs + 4) % 4;
                defen[l] = m.defen[realPid];
            }
        }

        broadcast('qipai', {
            zhuangfeng: m.zhuangfeng,
            jushu: m.jushu,
            changbang: m.changbang,
            lizhibang: m.lizhibang,
            defen,
            baopai: m.shan.baopai[0],
            shoupai,
            paishu: m.shan.paishu,
            mode: this._mode,
            player_id,
        });
    }
    update(paipu) {
        if (!paipu) { broadcast('update', null); return; }
        if (this._mode === 'sanma') {
            paipu = JSON.parse(JSON.stringify(paipu));
            if (paipu.hule && paipu.hule.fenpei)
                while (paipu.hule.fenpei.length < 4) paipu.hule.fenpei.push(0);
            if (paipu.pingju) {
                if (paipu.pingju.fenpei)
                    while (paipu.pingju.fenpei.length < 4) paipu.pingju.fenpei.push(0);
                if (paipu.pingju.shoupai)
                    while (paipu.pingju.shoupai.length < 4) paipu.pingju.shoupai.push('');
            }
        }
        broadcast('update', paipu);
    }
    summary(paipu) { broadcast('summary', { results }); }
    say(name, l) { broadcast('say', { name, l }); }
}

if (!fs.existsSync(PAIPU_DIR)) fs.mkdirSync(PAIPU_DIR);

function padSanmaPaipu(paipu) {
    const p = JSON.parse(JSON.stringify(paipu));
    while (p.player.length < 4) p.player.push('');
    while (p.defen.length < 4)  p.defen.push(0);
    while (p.rank.length < 4)   p.rank.push(4);
    while (p.point.length < 4)  p.point.push(0);
    for (let li = 0; li < p.log.length; li++) {
        const newLog = [];
        let afterKita = false;
        for (const entry of p.log[li]) {
            if (entry.kita) {
                newLog.push({ dapai: { l: entry.kita.l, p: 'z4_' } });
                afterKita = true;
                continue;
            }
            if (afterKita && entry.gangzimo) {
                newLog.push({ zimo: entry.gangzimo });
                afterKita = false;
                continue;
            }
            afterKita = false;
            if (entry.qipai) {
                const q = entry.qipai;
                while (q.defen.length < 4)   q.defen.push(0);
                while (q.shoupai.length < 4) q.shoupai.push('');
            }
            if (entry.hule && entry.hule.fenpei)
                while (entry.hule.fenpei.length < 4) entry.hule.fenpei.push(0);
            if (entry.pingju) {
                if (entry.pingju.fenpei)
                    while (entry.pingju.fenpei.length < 4) entry.pingju.fenpei.push(0);
                if (entry.pingju.shoupai)
                    while (entry.pingju.shoupai.length < 4) entry.pingju.shoupai.push('');
            }
            newLog.push(entry);
        }
        p.log[li] = newLog;
    }
    return p;
}

function savePaipu(paipu, seed, mode) {
    const filename = `${String(seed).padStart(6, '0')}_${mode}.json`;
    const filepath = path.join(PAIPU_DIR, filename);
    const data = mode === 'sanma' ? padSanmaPaipu(paipu) : paipu;
    fs.writeFileSync(filepath, JSON.stringify(data, null, 1));
    console.log(`  牌譜: ${filepath}`);
}

function printResult(paipu, playerConfigs, mode) {
    const defen = paipu.defen;
    const rank = paipu.rank;
    const point = paipu.point;
    const nPlayers = mode === 'sanma' ? 3 : 4;
    
    const specSeat = playerConfigs.findIndex(c => c.type !== 'ai');
    const displaySeat = specSeat !== -1 ? specSeat : 0;
    
    console.log(`\n===== 第${gameCount}半荘終了 (${mode}, seed=${gameCount - 1}, 観戦対象席:${displaySeat}) =====`);
    for (let i = 0; i < nPlayers; i++) {
        const name = paipu.player[i];
        const isAI = playerConfigs[i].type === 'ai';
        const tag = isAI ? '[AI]  ' : `[${name}]`;
        console.log(`  ${tag} ${name}: ${defen[i]}点 (${rank[i]}位, ${point[i] >= 0 ? '+' : ''}${point[i]})`);
    }

    for (let i = 0; i < nPlayers; i++) {
        results.push({
            mode,
            name: paipu.player[i],
            type: playerConfigs[i].type,
            seat: i,
            defen: defen[i],
            rank: rank[i],
            point: parseFloat(point[i]),
        });
    }
}

function printSummary() {
    const totalMatches = yonmaPlayed + sanmaPlayed;
    console.log(`\n========================================`);
    console.log(`  全${totalMatches}半荘の結果`);
    console.log(`========================================`);

    for (const mode of ['yonma', 'sanma']) {
        const mr = results.filter(r => r.mode === mode);
        if (mr.length === 0) continue;
        const label = mode === 'sanma' ? '三麻' : '四麻';
        const nPlayers = mode === 'sanma' ? 3 : 4;
        const names = [...new Set(mr.map(r => r.name))];

        console.log(`\n--- ${label} ---`);
        for (const name of names) {
            const pmr = mr.filter(r => r.name === name);
            const mn = pmr.length;
            if (mn === 0) continue;

            const avgRank = pmr.reduce((s, r) => s + r.rank, 0) / mn;
            const totalPoint = pmr.reduce((s, r) => s + r.point, 0);
            const avgPoint = totalPoint / mn;
            const rankDist = new Array(nPlayers).fill(0);
            for (const r of pmr) rankDist[r.rank - 1]++;

            console.log(`  * プレイヤー: ${name} (${mn}半荘)`);
            console.log(`    平均順位: ${avgRank.toFixed(2)}`);
            console.log(`    合計ポイント: ${totalPoint >= 0 ? '+' : ''}${totalPoint.toFixed(1)}`);
            console.log(`    平均ポイント: ${avgPoint >= 0 ? '+' : ''}${avgPoint.toFixed(1)}`);
            const rankStr = rankDist.map((c, i) => `${i + 1}位:${c}`).join(' ');
            console.log(`    順位分布: ${rankStr}`);
        }
    }

    const elapsed = ((Date.now() - startTime) / 1000 / 3600).toFixed(1);
    console.log(`\n  所要時間: ${elapsed}時間 (${totalMatches}半荘)`);
    if (totalMatches > 0) {
        console.log(`  1半荘あたり: ${((Date.now() - startTime) / 1000 / totalMatches).toFixed(0)}秒`);
    }
}

function startGame() {
    if (USE_GAME_COUNT) {
        if (yonmaPlayed >= YONMA_GAMES && sanmaPlayed >= SANMA_GAMES) {
            printSummary();
            process.exit(0);
        }
    } else if (Date.now() - startTime >= DURATION_MS) {
        printSummary();
        process.exit(0);
    }

    const seed = gameCount;
    gameCount++;

    let mode;
    if (USE_GAME_COUNT) {
        if (yonmaPlayed >= YONMA_GAMES) mode = 'sanma';
        else if (sanmaPlayed >= SANMA_GAMES) mode = 'yonma';
        else mode = gameCount % 2 === 1 ? 'yonma' : 'sanma';
    } else {
        mode = gameCount % 2 === 1 ? 'yonma' : 'sanma';
    }
    const nPlayers = mode === 'sanma' ? 3 : 4;
    const qijia = mulberry32(seed * 31 + 12345)() * nPlayers | 0;

    // Build seat configuration
    const hasSeatConfig = (
        process.env.SEAT0 !== undefined ||
        process.env.SEAT1 !== undefined ||
        process.env.SEAT2 !== undefined ||
        (nPlayers === 4 && process.env.SEAT3 !== undefined)
    );

    let playerConfigs = [];
    let qwenSeat = 0;

    if (hasSeatConfig) {
        for (let i = 0; i < nPlayers; i++) {
            playerConfigs[i] = parsePlayer(process.env[`SEAT${i}`], i);
        }
        const specSeat = playerConfigs.findIndex(c => c.type !== 'ai');
        qwenSeat = specSeat !== -1 ? specSeat : 0;
    } else {
        const seatRng = mulberry32(seed * 31 + 67890);
        qwenSeat = seatRng() * nPlayers | 0;
        for (let i = 0; i < nPlayers; i++) {
            if (i === qwenSeat) {
                playerConfigs[i] = {
                    type: PLAYER_TYPE,
                    name: PLAYER_NAME,
                    provider: LLM_PROVIDER,
                    modelId: LLM_MODEL,
                    serverUrl: undefined
                };
            } else {
                playerConfigs[i] = { type: 'ai', name: `P${i + 1}` };
            }
        }
    }

    const specPlayerName = playerConfigs[qwenSeat].name;

    if (mode === 'sanma') {
        console.log(`\n>>>>> 第${gameCount}半荘開始 (三麻, seed=${seed}, 観戦席:${specPlayerName}席${qwenSeat}) <<<<<`);

        const players = [];
        for (let i = 0; i < 3; i++) {
            const cfg = playerConfigs[i];
            if (cfg.type === 'mahjonglm') {
                players[i] = new SanmaMahjongLMPlayer({ serverUrl: cfg.serverUrl });
            } else if (cfg.type === 'llm') {
                players[i] = new SanmaQwenPlayer({ provider: cfg.provider, modelId: cfg.modelId });
            } else {
                players[i] = new SimpleAI();
            }
        }

        const game = new SanmaGame(players, (paipu) => {
            paipu.title = `${specPlayerName}三麻 seed=${seed}`;
            savePaipu(paipu, seed, 'sanma');
            printResult(paipu, playerConfigs, 'sanma');
            sanmaPlayed++;
            setImmediate(startGame);
        }, null, null, seed);
        game.speed = 0;
        
        let pn = 1;
        for (let i = 0; i < 3; i++) {
            if (playerConfigs[i].type === 'ai') {
                game._model.player[i] = `P${pn++}`;
            } else {
                game._model.player[i] = playerConfigs[i].name;
            }
        }
        
        game.view = new LiveView(game._model, 'sanma', qwenSeat);
        game.kaiju(qijia);
    } else {
        console.log(`\n>>>>> 第${gameCount}半荘開始 (四麻, seed=${seed}, 観戦席:${specPlayerName}席${qwenSeat}) <<<<<`);

        const players = [];
        for (let i = 0; i < 4; i++) {
            const cfg = playerConfigs[i];
            if (cfg.type === 'mahjonglm') {
                players[i] = new MahjongLMPlayer({ serverUrl: cfg.serverUrl });
            } else if (cfg.type === 'llm') {
                players[i] = new QwenPlayer({ provider: cfg.provider, modelId: cfg.modelId });
            } else {
                players[i] = new AI();
            }
        }

        const rule = Majiang.rule();
        const origQipai = Majiang.Game.prototype.qipai;
        const game = new Majiang.Game(players, (paipu) => {
            paipu.title = `${specPlayerName}四麻 seed=${seed}`;
            savePaipu(paipu, seed, 'yonma');
            printResult(paipu, playerConfigs, 'yonma');
            yonmaPlayed++;
            setImmediate(startGame);
        }, rule);
        game.speed = 0;
        
        let pn = 1;
        for (let i = 0; i < 4; i++) {
            if (playerConfigs[i].type === 'ai') {
                game._model.player[i] = `P${pn++}`;
            } else {
                game._model.player[i] = playerConfigs[i].name;
            }
        }
        
        game.view = new LiveView(game._model, 'yonma', qwenSeat);

        game.qipai = function(shan) {
            if (!shan) {
                const model = this._model;
                shan = makeSeededShan(this._rule, seed,
                    model.zhuangfeng, model.jushu, model.changbang);
            }
            return origQipai.call(this, shan);
        };
        game.kaiju(qijia);
    }
}

startTime = Date.now();
if (PLAYER_TYPE !== 'mahjonglm') {
    llm.configure(LLM_PROVIDER, LLM_MODEL);
}
const prefix = PLAYER_TYPE === 'mahjonglm' ? 'MahjongLM' : 'LLM';
if (USE_GAME_COUNT) {
    console.log(`${prefix}麻雀対局: 四麻${YONMA_GAMES}半荘 + 三麻${SANMA_GAMES}半荘 = ${YONMA_GAMES + SANMA_GAMES}半荘, seed=0~`);
} else {
    const hours = DURATION_MS / 3600000;
    console.log(`${prefix}麻雀耐久対局: ${hours}時間, 三麻四麻交互, seed=0~`);
}
console.log(`牌譜保存先: ${PAIPU_DIR}`);
process.on('SIGINT', () => { llm.shutdown(); printSummary(); process.exit(0); });
process.on('SIGTERM', () => { llm.shutdown(); printSummary(); process.exit(0); });
startGame();
