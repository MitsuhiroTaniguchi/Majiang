"use strict";

const Majiang = require('@kobalab/majiang-core');

function mulberry32(seed) {
    let s = seed | 0;
    return function() {
        s = (s + 0x6D2B79F5) | 0;
        let t = Math.imul(s ^ (s >>> 15), 1 | s);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function shanSeed(hanchanSeed, zhuangfeng, jushu, changbang) {
    return ((hanchanSeed * 997 + zhuangfeng * 131 + jushu * 37 + changbang * 7) & 0x7FFFFFFF) | 0;
}

function buildPaiList(rule) {
    const hongpai = rule['赤牌'];
    const pai = [];
    for (const s of ['m', 'p', 's', 'z']) {
        for (let n = 1; n <= (s === 'z' ? 7 : 9); n++) {
            for (let i = 0; i < 4; i++) {
                if (n === 5 && i < hongpai[s]) pai.push(s + 0);
                else                           pai.push(s + n);
            }
        }
    }
    return pai;
}

function seededShuffle(pai, rng) {
    const arr = pai.slice();
    const shuffled = [];
    while (arr.length) {
        shuffled.push(arr.splice(rng() * arr.length | 0, 1)[0]);
    }
    return shuffled;
}

class SeededShan extends Majiang.Shan {
    constructor(rule, rng) {
        super(rule);
        if (!rng) return;
        const pai = buildPaiList(rule);
        this._pai = seededShuffle(pai, rng);
        this._baopai   = [this._pai[4]];
        this._fubaopai = rule['裏ドラあり'] ? [this._pai[9]] : null;
        this._weikaigang = false;
        this._closed     = false;
    }
}

function makeSeededShan(rule, hanchanSeed, zhuangfeng, jushu, changbang) {
    const seed = shanSeed(hanchanSeed, zhuangfeng, jushu, changbang);
    return new SeededShan(rule, mulberry32(seed));
}

module.exports = { mulberry32, shanSeed, SeededShan, makeSeededShan, buildPaiList, seededShuffle };
