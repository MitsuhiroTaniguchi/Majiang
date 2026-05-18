"use strict";

const Majiang = require('@kobalab/majiang-core');

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const MODEL = process.env.QWEN_MODEL || 'qwen3:14b';
const NUM_CTX = parseInt(process.env.QWEN_NUM_CTX || '2048');

const WIND = ['東', '南', '西', '北'];
const SUIT = { m: '萬', p: '筒', s: '索', z: '' };
const ZNAME = { 1: '東', 2: '南', 3: '西', 4: '北', 5: '白', 6: '發', 7: '中' };

function paiName(p) {
    const s = p[0], n = p[1];
    if (s === 'z') return ZNAME[n] || p;
    if (n === '0') return `赤5${SUIT[s]}`;
    return `${n}${SUIT[s]}`;
}

function shoupaiStr(shoupai) {
    return shoupai.toString();
}

function heStr(he) {
    if (!he || !he._pai || he._pai.length === 0) return 'なし';
    return he._pai.map(p => p.slice(0, 2)).join(',');
}

async function queryOllama(prompt) {
    const body = JSON.stringify({
        model: MODEL,
        messages: [{ role: 'user', content: prompt }],
        stream: false,
        think: false,
        options: {
            num_predict: 15,
            temperature: 0.3,
            num_ctx: NUM_CTX,
            repeat_penalty: 1.0,
        },
        keep_alive: '30m',
    });

    const res = await fetch(`${OLLAMA_URL}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
    });
    const data = await res.json();
    return (data.message?.content || '').trim();
}

function buildDapaiPrompt(player, gangzimo) {
    const model = player._model;
    const mf = player._menfeng;
    const zf = model.zhuangfeng;

    let lines = [];
    lines.push(`場風:${WIND[zf]} 自風:${WIND[mf]} 残り:${player.shan.paishu}枚`);
    lines.push(`ドラ表示:${model.shan.baopai.join(',')}`);
    lines.push(`手牌:${shoupaiStr(player.shoupai)}`);

    const dapai = player.get_dapai(player.shoupai);
    lines.push(`合法打牌:[${dapai.join(',')}]`);
    lines.push(`打牌を1つ選べ。記号のみ回答。例: m3`);
    return { prompt: lines.join('\n'), legal: dapai };
}

function buildFulouPrompt(player, dapaiMsg) {
    const model = player._model;
    const mf = player._menfeng;
    const d = ['', '+', '=', '-'][(4 + model.lunban - mf) % 4];
    const p = dapaiMsg.p.slice(0, 2) + d;

    let options = [];
    for (const m of player.get_chi_mianzi(player.shoupai, p)) options.push(m);
    for (const m of player.get_peng_mianzi(player.shoupai, p)) options.push(m);
    for (const m of player.get_gang_mianzi(player.shoupai, p)) options.push(m);

    if (options.length === 0) return null;

    options.push('skip');

    let lines = [];
    lines.push(`手牌:${shoupaiStr(player.shoupai)}`);
    lines.push(`他家打牌:${dapaiMsg.p}`);
    lines.push(`選択肢:[${options.join(',')}]`);
    lines.push(`鳴くかスキップか。記号のみ回答。`);
    return { prompt: lines.join('\n'), legal: options };
}

function buildGangPrompt(player) {
    const gangOptions = player.get_gang_mianzi(player.shoupai);
    if (gangOptions.length === 0) return null;

    let options = [...gangOptions, 'skip'];
    let lines = [];
    lines.push(`手牌:${shoupaiStr(player.shoupai)}`);
    lines.push(`カン選択肢:[${options.join(',')}]`);
    lines.push(`カンするかスキップか。記号のみ回答。`);
    return { prompt: lines.join('\n'), legal: options };
}

function parseResponse(response, legal) {
    const cleaned = response.replace(/[`\s「」]/g, '');
    for (const opt of legal) {
        if (cleaned.includes(opt)) return opt;
    }
    for (const opt of legal) {
        if (cleaned.includes(opt.slice(0, 2))) return opt;
    }
    return legal[0];
}

class QwenPlayer extends Majiang.Player {

    constructor() {
        super();
        this._pending = null;
    }

    action_kaiju(kaiju) { this._callback(); }
    action_qipai(qipai) { this._callback(); }

    action_zimo(zimo, gangzimo) {
        if (zimo.l !== this._menfeng) return this._callback();

        if (this.allow_hule(this.shoupai, null,
                gangzimo || this.shoupai.lizhi || this.shan.paishu === 0)) {
            console.log(`  [Qwen] ツモ和了!`);
            return this._callback({ hule: '-' });
        }

        if (this.allow_pingju(this.shoupai) &&
            Majiang.Util.xiangting(this.shoupai) >= 4) {
            return this._callback({ daopai: '-' });
        }

        const gangInfo = buildGangPrompt(this);
        if (gangInfo && gangInfo.legal.length === 2) {
            // Only one gang option + skip — ask LLM
        }

        const { prompt, legal } = buildDapaiPrompt(this, gangzimo);
        this._asyncAction(prompt, legal, (chosen) => {
            console.log(`  [Qwen] 打${chosen}`);
            this._callback({ dapai: chosen });
        });
    }

    action_dapai(dapai) {
        if (dapai.l === this._menfeng) {
            if (this.allow_no_daopai(this.shoupai)) {
                return this._callback({ daopai: '-' });
            }
            return this._callback();
        }

        const d = ['', '+', '=', '-'][(4 + this._model.lunban - this._menfeng) % 4];
        const rongpai = dapai.p.slice(0, 2) + d;
        if (this.allow_hule(this.shoupai, rongpai)) {
            console.log(`  [Qwen] ロン!`);
            return this._callback({ hule: '-' });
        }

        const fulouInfo = buildFulouPrompt(this, dapai);
        if (!fulouInfo) return this._callback();

        this._asyncAction(fulouInfo.prompt, fulouInfo.legal, (chosen) => {
            if (chosen === 'skip') {
                if (this.allow_no_daopai(this.shoupai)) {
                    return this._callback({ daopai: '-' });
                }
                return this._callback();
            }
            console.log(`  [Qwen] 鳴き:${chosen}`);
            this._callback({ fulou: chosen });
        });
    }

    action_fulou(fulou) {
        if (fulou.l !== this._menfeng) return this._callback();
        if (fulou.m.match(/^[mpsz]\d{4}/)) return this._callback();

        const { prompt, legal } = buildDapaiPrompt(this);
        this._asyncAction(prompt, legal, (chosen) => {
            console.log(`  [Qwen] 鳴き後打${chosen}`);
            this._callback({ dapai: chosen });
        });
    }

    action_gang(gang) {
        if (gang.l === this._menfeng) return this._callback();
        if (!gang.m.match(/^[mpsz]\d{4}$/)) {
            const d = ['', '+', '=', '-'][(4 + this._model.lunban - this._menfeng) % 4];
            const rongpai = gang.m[0] + gang.m.slice(-1) + d;
            if (this.allow_hule(this.shoupai, rongpai, true)) {
                console.log(`  [Qwen] 槍槓ロン!`);
                return this._callback({ hule: '-' });
            }
        }
        return this._callback();
    }

    action_hule(hule) { this._callback(); }
    action_pingju(pingju) { this._callback(); }
    action_jieju(jieju) { this._callback(); }

    _asyncAction(prompt, legal, onResult) {
        queryOllama(prompt).then(response => {
            const chosen = parseResponse(response, legal);
            onResult(chosen);
        }).catch(err => {
            console.error(`  [Qwen] LLM error: ${err.message}, falling back to first legal`);
            onResult(legal[0]);
        });
    }
}

module.exports = QwenPlayer;
