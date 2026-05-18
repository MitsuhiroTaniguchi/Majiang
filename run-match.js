"use strict";

const Majiang = require('@kobalab/majiang-core');
const AI = require('@kobalab/majiang-ai');
const QwenPlayer = require('./qwen-player');

const NUM_GAMES = parseInt(process.env.NUM_GAMES || '3');
const QWEN_SEAT = parseInt(process.env.QWEN_SEAT || '0');

let gameCount = 0;
let results = [];
let startTime;

function printResult(paipu) {
    const defen = paipu.defen;
    const rank = paipu.rank;
    const point = paipu.point;
    console.log(`\n===== 第${gameCount}局終了 =====`);
    for (let i = 0; i < 4; i++) {
        const tag = i === QWEN_SEAT ? '[Qwen]' : '[AI]  ';
        console.log(`  ${tag} ${paipu.player[i]}: ${defen[i]}点 (${rank[i]}位, ${point[i] >= 0 ? '+' : ''}${point[i]})`);
    }
    results.push({
        qwen_defen: defen[QWEN_SEAT],
        qwen_rank: rank[QWEN_SEAT],
        qwen_point: parseFloat(point[QWEN_SEAT]),
    });
}

function printSummary() {
    console.log(`\n========== 全${results.length}局の結果 ==========`);
    const avgRank = results.reduce((s, r) => s + r.qwen_rank, 0) / results.length;
    const totalPoint = results.reduce((s, r) => s + r.qwen_point, 0);
    const avgPoint = totalPoint / results.length;
    console.log(`  Qwen 平均順位: ${avgRank.toFixed(2)}`);
    console.log(`  Qwen 合計ポイント: ${totalPoint >= 0 ? '+' : ''}${totalPoint.toFixed(1)}`);
    console.log(`  Qwen 平均ポイント: ${avgPoint >= 0 ? '+' : ''}${avgPoint.toFixed(1)}`);
    const rankDist = [0, 0, 0, 0];
    for (const r of results) rankDist[r.qwen_rank - 1]++;
    console.log(`  順位分布: 1位:${rankDist[0]} 2位:${rankDist[1]} 3位:${rankDist[2]} 4位:${rankDist[3]}`);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
    console.log(`  所要時間: ${elapsed}秒`);
}

function startGame() {
    gameCount++;
    if (gameCount > NUM_GAMES) {
        printSummary();
        process.exit(0);
    }

    console.log(`\n>>>>> 第${gameCount}局開始 <<<<<`);

    const players = [];
    for (let i = 0; i < 4; i++) {
        if (i === QWEN_SEAT) {
            players[i] = new QwenPlayer();
        } else {
            players[i] = new AI();
        }
    }

    const rule = Majiang.rule();
    const game = new Majiang.Game(players, (paipu) => {
        printResult(paipu);
        startGame();
    }, rule);
    game.speed = 0;
    game._model.player[QWEN_SEAT] = 'Qwen';
    game.kaiju();
}

startTime = Date.now();
console.log(`Qwen麻雀対局: ${NUM_GAMES}局, Qwenは席${QWEN_SEAT}`);
console.log(`モデル: Qwen3.6-27B-UD-IQ2_XXS (llama.cpp)`);
startGame();
