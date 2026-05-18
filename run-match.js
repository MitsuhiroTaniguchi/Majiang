"use strict";

const Majiang = require('@kobalab/majiang-core');
const AI = require('@kobalab/majiang-ai');
const QwenPlayer = require('./qwen-player');

const DURATION_MS = parseInt(process.env.DURATION_HOURS || '12') * 3600 * 1000;

let gameCount = 0;
let results = [];
let startTime;

function printResult(paipu, qwenSeat) {
    const defen = paipu.defen;
    const rank = paipu.rank;
    const point = paipu.point;
    console.log(`\n===== 第${gameCount}半荘終了 (Qwen席${qwenSeat}) =====`);
    for (let i = 0; i < 4; i++) {
        const tag = i === qwenSeat ? '[Qwen]' : '[AI]  ';
        console.log(`  ${tag} ${paipu.player[i]}: ${defen[i]}点 (${rank[i]}位, ${point[i] >= 0 ? '+' : ''}${point[i]})`);
    }
    results.push({
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
    const avgRank = results.reduce((s, r) => s + r.qwen_rank, 0) / n;
    const totalPoint = results.reduce((s, r) => s + r.qwen_point, 0);
    const avgPoint = totalPoint / n;
    console.log(`  Qwen 平均順位: ${avgRank.toFixed(2)}`);
    console.log(`  Qwen 合計ポイント: ${totalPoint >= 0 ? '+' : ''}${totalPoint.toFixed(1)}`);
    console.log(`  Qwen 平均ポイント: ${avgPoint >= 0 ? '+' : ''}${avgPoint.toFixed(1)}`);
    const rankDist = [0, 0, 0, 0];
    for (const r of results) rankDist[r.qwen_rank - 1]++;
    console.log(`  順位分布: 1位:${rankDist[0]} 2位:${rankDist[1]} 3位:${rankDist[2]} 4位:${rankDist[3]}`);
    const seatDist = [0, 0, 0, 0];
    for (const r of results) seatDist[r.qwen_seat]++;
    console.log(`  席分布: 東:${seatDist[0]} 南:${seatDist[1]} 西:${seatDist[2]} 北:${seatDist[3]}`);
    const elapsed = ((Date.now() - startTime) / 1000 / 3600).toFixed(1);
    console.log(`  所要時間: ${elapsed}時間 (${n}半荘)`);
    console.log(`  1半荘あたり: ${((Date.now() - startTime) / 1000 / n).toFixed(0)}秒`);
}

function startGame() {
    if (Date.now() - startTime >= DURATION_MS) {
        printSummary();
        process.exit(0);
    }

    gameCount++;
    const qwenSeat = Math.floor(Math.random() * 4);

    console.log(`\n>>>>> 第${gameCount}半荘開始 (Qwen席${qwenSeat}) <<<<<`);

    const players = [];
    for (let i = 0; i < 4; i++) {
        players[i] = (i === qwenSeat) ? new QwenPlayer() : new AI();
    }

    const rule = Majiang.rule();
    const game = new Majiang.Game(players, (paipu) => {
        printResult(paipu, qwenSeat);
        startGame();
    }, rule);
    game.speed = 0;
    game._model.player[qwenSeat] = 'Qwen';
    game.kaiju();
}

startTime = Date.now();
const hours = DURATION_MS / 3600000;
console.log(`Qwen麻雀耐久対局: ${hours}時間, 4麻半荘, ランダム席`);
console.log(`モデル: Qwen3.6-27B-UD-IQ2_XXS (llama.cpp)`);
startGame();
