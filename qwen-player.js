"use strict";

const Majiang = require('@kobalab/majiang-core');

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const MODEL = process.env.QWEN_MODEL || 'qwen3:14b';
const NUM_CTX = parseInt(process.env.QWEN_NUM_CTX || '2048');

const WIND = ['東', '南', '西', '北'];

const SYSTEM_MSG = `あなたは日本式リーチ麻雀のAIです。牌記法: m=萬子,p=筒子,s=索子,z=字牌(1東2南3西4北5白6發7中),0=赤5。手牌例: m123p456s789z11 副露例: m12-3(チー),z555=(ポン)。合法手から最善の1つを選び、その記号だけ回答せよ。`;

async function queryOllama(prompt) {
    const body = JSON.stringify({
        model: MODEL,
        messages: [
            { role: 'system', content: SYSTEM_MSG },
            { role: 'user', content: prompt },
        ],
        stream: false,
        think: false,
        options: {
            num_predict: 12,
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

function visibleInfo(player) {
    const model = player._model;
    const mf = player._menfeng;
    const parts = [];
    parts.push(`${WIND[model.zhuangfeng]}${model.jushu + 1}局${model.changbang}本場`);
    parts.push(`自風${WIND[mf]}`);
    parts.push(`残${player.shan.paishu}枚`);
    parts.push(`ドラ${model.shan.baopai.join(',')}`);

    const scores = [];
    for (let i = 0; i < 4; i++) {
        const rel = (i - mf + 4) % 4;
        const tag = ['自', '下', '対', '上'][rel];
        const id = model.player_id[i];
        scores.push(`${tag}${model.defen[id]}`);
    }
    parts.push(scores.join('/'));
    return parts.join(' ');
}

function discardInfo(player) {
    const model = player._model;
    const mf = player._menfeng;
    const parts = [];
    for (let i = 0; i < 4; i++) {
        const rel = (i - mf + 4) % 4;
        if (rel === 0) continue;
        const tag = ['', '下', '対', '上'][rel];
        const he = model.he[i];
        if (he && he._pai && he._pai.length > 0) {
            parts.push(`${tag}捨:${he._pai.map(p => p.slice(0, 2)).join('')}`);
        }
    }
    return parts.join(' ');
}

function buildDapaiPrompt(player) {
    const dapai = player.get_dapai(player.shoupai);

    let lizhi_candidates = [];
    for (const p of dapai) {
        if (player.allow_lizhi(player.shoupai, p)) {
            lizhi_candidates.push(p + '*');
        }
    }

    const allOptions = [...dapai, ...lizhi_candidates];

    const xiangting = Majiang.Util.xiangting(player.shoupai);
    const tingpai = xiangting === 0 ? Majiang.Util.tingpai(player.shoupai) : [];

    const lines = [];
    lines.push(visibleInfo(player));
    lines.push(`手牌:${player.shoupai.toString()}`);
    if (xiangting === 0) {
        lines.push(`テンパイ! 待ち:[${tingpai.join(',')}]`);
    } else {
        lines.push(`向聴数:${xiangting}`);
    }
    lines.push(discardInfo(player));
    if (lizhi_candidates.length > 0) {
        lines.push(`(*付=リーチ宣言。テンパイならリーチ推奨)`);
    }
    lines.push(`選択:[${allOptions.join(',')}]`);
    return { prompt: lines.join('\n'), legal: allOptions };
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

    const lines = [];
    lines.push(visibleInfo(player));
    lines.push(`手牌:${player.shoupai.toString()}`);
    lines.push(`他家打:${dapaiMsg.p}`);
    lines.push(`選択:[${options.join(',')}] skipはスルー`);
    return { prompt: lines.join('\n'), legal: options };
}

function buildGangPrompt(player) {
    const gangOptions = player.get_gang_mianzi(player.shoupai);
    if (gangOptions.length === 0) return null;

    const options = [...gangOptions, 'skip'];
    const lines = [];
    lines.push(`手牌:${player.shoupai.toString()}`);
    lines.push(`カン選択:[${options.join(',')}]`);
    return { prompt: lines.join('\n'), legal: options };
}

function parseResponse(response, legal) {
    const cleaned = response.replace(/[\s`「」　]/g, '');

    for (const opt of legal) {
        if (cleaned === opt) return opt;
    }
    for (const opt of legal) {
        if (cleaned.includes(opt)) return opt;
    }
    if (cleaned.includes('skip') || cleaned.includes('スキップ') || cleaned.includes('スルー')) {
        if (legal.includes('skip')) return 'skip';
    }
    for (const opt of legal) {
        if (opt !== 'skip' && cleaned.includes(opt.slice(0, 2))) return opt;
    }
    return legal[0];
}

class QwenPlayer extends Majiang.Player {

    constructor() {
        super();
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

        if (this.shoupai.lizhi) {
            const gang = this.get_gang_mianzi(this.shoupai);
            if (gang.length > 0) {
                return this._callback({ gang: gang[0] });
            }
            return this._callback({ dapai: this.shoupai._zimo });
        }

        const gangInfo = buildGangPrompt(this);
        const { prompt, legal } = buildDapaiPrompt(this);

        if (gangInfo) {
            const allLegal = [...gangInfo.legal.filter(o => o !== 'skip'), ...legal];
            const combinedPrompt = `${prompt}\nカンも可:[${gangInfo.legal.join(',')}]`;
            this._asyncAction(combinedPrompt, allLegal, (chosen) => {
                if (chosen === 'skip') {
                    return this._callback({ dapai: legal[0] });
                }
                if (gangInfo.legal.includes(chosen) && chosen !== 'skip') {
                    console.log(`  [Qwen] カン:${chosen}`);
                    return this._callback({ gang: chosen });
                }
                console.log(`  [Qwen] 打${chosen}`);
                this._callback({ dapai: chosen });
            });
            return;
        }

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
            console.error(`  [Qwen] LLM error: ${err.message}, fallback`);
            onResult(legal[0]);
        });
    }
}

module.exports = QwenPlayer;
