"use strict";

const Majiang = require('@kobalab/majiang-core');
const AI = require('@kobalab/majiang-ai');
const QwenPlayer = require('./qwen-player');
const SanmaGame = require('./sanma-game');
const SanmaQwenPlayer = require('./sanma-qwen-player');
const { SimpleAI } = require('./sanma-player');

const DURATION_MS = parseInt(process.env.DURATION_HOURS || '12') * 3600 * 1000;

let gameCount = 0;
let results = [];
let startTime;

function printResult(paipu, qwenSeat, mode) {
    const defen = paipu.defen;
    const rank = paipu.rank;
    const point = paipu.point;
    const nPlayers = mode === 'sanma' ? 3 : 4;
    console.log(`\n===== 第${gameCount}半荘終了 (${mode}, Qwen席${qwenSeat}) =====`);
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

    gameCount++;
    const mode = gameCount % 2 === 1 ? 'yonma' : 'sanma';

    if (mode === 'sanma') {
        const qwenSeat = Math.floor(Math.random() * 3);
        console.log(`\n>>>>> 第${gameCount}半荘開始 (三麻, Qwen席${qwenSeat}) <<<<<`);

        const players = [];
        for (let i = 0; i < 3; i++) {
            players[i] = (i === qwenSeat) ? new SanmaQwenPlayer() : new SimpleAI();
        }

        const game = new SanmaGame(players, (paipu) => {
            printResult(paipu, qwenSeat, 'sanma');
            startGame();
        });
        game.speed = 0;
        game._model.player[qwenSeat] = 'Qwen';
        game.kaiju();
    } else {
        const qwenSeat = Math.floor(Math.random() * 4);
        console.log(`\n>>>>> 第${gameCount}半荘開始 (四麻, Qwen席${qwenSeat}) <<<<<`);

        const players = [];
        for (let i = 0; i < 4; i++) {
            players[i] = (i === qwenSeat) ? new QwenPlayer() : new AI();
        }

        const rule = Majiang.rule();
        const game = new Majiang.Game(players, (paipu) => {
            printResult(paipu, qwenSeat, 'yonma');
            startGame();
        }, rule);
        game.speed = 0;
        game._model.player[qwenSeat] = 'Qwen';
        game.kaiju();
    }
}

startTime = Date.now();
const hours = DURATION_MS / 3600000;
console.log(`Qwen麻雀耐久対局: ${hours}時間, 三麻四麻交互, ランダム席`);
console.log(`モデル: Qwen3.6-27B-UD-IQ2_XXS (llama.cpp)`);
startGame();
