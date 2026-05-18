"use strict";

const fs = require('fs');
const path = require('path');
const Majiang = require('@kobalab/majiang-core');
const AI = require('@kobalab/majiang-ai');
const QwenPlayer = require('./qwen-player');
const SanmaGame = require('./sanma-game');
const SanmaQwenPlayer = require('./sanma-qwen-player');
const { SimpleAI } = require('./sanma-player');
const { makeSeededShan, mulberry32, shanSeed } = require('./seeded-random');

const DURATION_MS = parseInt(process.env.DURATION_HOURS || '12') * 3600 * 1000;
const PAIPU_DIR = path.join(__dirname, 'paipu');

let gameCount = 0;
let results = [];
let startTime;

if (!fs.existsSync(PAIPU_DIR)) fs.mkdirSync(PAIPU_DIR);

function savePaipu(paipu, seed, mode) {
    const filename = `${String(seed).padStart(6, '0')}_${mode}.json`;
    const filepath = path.join(PAIPU_DIR, filename);
    fs.writeFileSync(filepath, JSON.stringify(paipu, null, 1));
    console.log(`  牌譜: ${filepath}`);
}

function printResult(paipu, qwenSeat, mode) {
    const defen = paipu.defen;
    const rank = paipu.rank;
    const point = paipu.point;
    const nPlayers = mode === 'sanma' ? 3 : 4;
    console.log(`\n===== 第${gameCount}半荘終了 (${mode}, seed=${gameCount - 1}, Qwen席${qwenSeat}) =====`);
    for (let i = 0; i < nPlayers; i++) {
        const tag = i === qwenSeat ? '[Qwen]' : '[AI]  ';
        console.log(`  ${tag} ${paipu.player[i]}: ${defen[i]}点 (${rank[i]}位, ${point[i] >= 0 ? '+' : ''}${point[i]})`);
    }
    results.push({
        mode,
        qwen_seat: qwenSeat,
        qwen_defen: defen[qwenSeat],
        qwen_rank: rank[qwenSeat],
        qwen_point: parseFloat(point[qwenSeat]),
    });
}

function printSummary() {
    const n = results.length;
    console.log(`\n========================================`);
    console.log(`  全${n}半荘の結果`);
    console.log(`========================================`);

    for (const mode of ['yonma', 'sanma']) {
        const mr = results.filter(r => r.mode === mode);
        if (mr.length === 0) continue;
        const label = mode === 'sanma' ? '三麻' : '四麻';
        const mn = mr.length;
        const avgRank = mr.reduce((s, r) => s + r.qwen_rank, 0) / mn;
        const totalPoint = mr.reduce((s, r) => s + r.qwen_point, 0);
        const avgPoint = totalPoint / mn;
        const nPlayers = mode === 'sanma' ? 3 : 4;
        const rankDist = new Array(nPlayers).fill(0);
        for (const r of mr) rankDist[r.qwen_rank - 1]++;

        console.log(`\n  [${label}] ${mn}半荘`);
        console.log(`    平均順位: ${avgRank.toFixed(2)}`);
        console.log(`    合計ポイント: ${totalPoint >= 0 ? '+' : ''}${totalPoint.toFixed(1)}`);
        console.log(`    平均ポイント: ${avgPoint >= 0 ? '+' : ''}${avgPoint.toFixed(1)}`);
        const rankStr = rankDist.map((c, i) => `${i + 1}位:${c}`).join(' ');
        console.log(`    順位分布: ${rankStr}`);
    }

    const elapsed = ((Date.now() - startTime) / 1000 / 3600).toFixed(1);
    console.log(`\n  所要時間: ${elapsed}時間 (${n}半荘)`);
    console.log(`  1半荘あたり: ${((Date.now() - startTime) / 1000 / n).toFixed(0)}秒`);
}

function startGame() {
    if (Date.now() - startTime >= DURATION_MS) {
        printSummary();
        process.exit(0);
    }

    const seed = gameCount;
    gameCount++;
    const mode = gameCount % 2 === 1 ? 'yonma' : 'sanma';
    const seatRng = mulberry32(seed * 31 + 12345);
    const nPlayers = mode === 'sanma' ? 3 : 4;
    const qwenSeat = seatRng() * nPlayers | 0;
    const qijia = seatRng() * nPlayers | 0;

    if (mode === 'sanma') {
        console.log(`\n>>>>> 第${gameCount}半荘開始 (三麻, seed=${seed}, Qwen席${qwenSeat}) <<<<<`);

        const players = [];
        for (let i = 0; i < 3; i++) {
            players[i] = (i === qwenSeat) ? new SanmaQwenPlayer() : new SimpleAI();
        }

        const game = new SanmaGame(players, (paipu) => {
            paipu.title = `Qwen三麻 seed=${seed}`;
            savePaipu(paipu, seed, 'sanma');
            printResult(paipu, qwenSeat, 'sanma');
            startGame();
        }, null, null, seed);
        game.speed = 0;
        game._model.player[qwenSeat] = 'Qwen';
        game.kaiju(qijia);
    } else {
        console.log(`\n>>>>> 第${gameCount}半荘開始 (四麻, seed=${seed}, Qwen席${qwenSeat}) <<<<<`);

        const players = [];
        for (let i = 0; i < 4; i++) {
            players[i] = (i === qwenSeat) ? new QwenPlayer() : new AI();
        }

        const rule = Majiang.rule();
        const origQipai = Majiang.Game.prototype.qipai;
        const game = new Majiang.Game(players, (paipu) => {
            paipu.title = `Qwen四麻 seed=${seed}`;
            savePaipu(paipu, seed, 'yonma');
            printResult(paipu, qwenSeat, 'yonma');
            startGame();
        }, rule);
        game.speed = 0;
        game._model.player[qwenSeat] = 'Qwen';

        const origGameQipai = game.qipai.bind(game);
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
const hours = DURATION_MS / 3600000;
console.log(`Qwen麻雀耐久対局: ${hours}時間, 三麻四麻交互, seed=0~`);
console.log(`モデル: Qwen3.6-27B-UD-IQ2_XXS (llama.cpp)`);
console.log(`牌譜保存先: ${PAIPU_DIR}`);
startGame();
