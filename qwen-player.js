"use strict";

const Majiang = require('@kobalab/majiang-core');

const LLAMA_URL = process.env.LLAMA_URL || 'http://localhost:8080';

const WIND = ['東', '南', '西', '北'];

const SYSTEM_MSG =
`あなたは日本式リーチ麻雀のAIプレイヤーです。

牌の表記:
  m = 萬子 (1-9)
  p = 筒子 (1-9)
  s = 索子 (1-9)
  z = 字牌 (1=東 2=南 3=西 4=北 5=白 6=發 7=中)
  0 = 赤5 (例: m0 = 赤萬子5)

回答は合法手リストから最善の1つを選び、その記号だけ答えてください。`;

async function queryLLM(prompt) {
    const body = JSON.stringify({
        messages: [
            { role: 'system', content: SYSTEM_MSG },
            { role: 'user', content: prompt },
        ],
        max_tokens: 12,
        temperature: 0.3,
        repeat_penalty: 1.0,
    });

    const res = await fetch(`${LLAMA_URL}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
    });
    const data = await res.json();
    return (data.choices?.[0]?.message?.content || '').trim();
}

function expandPai(compact) {
    const tiles = [];
    let s = '';
    for (const ch of compact) {
        if ('mpsz'.includes(ch)) {
            s = ch;
        } else if ('0123456789'.includes(ch)) {
            tiles.push(s + ch);
        }
    }
    return tiles;
}

function formatShoupai(shoupaiStr) {
    const parts = shoupaiStr.split(',');
    const hand = expandPai(parts[0]).join(' ');
    if (parts.length <= 1) return hand;

    const melds = [];
    for (let i = 1; i < parts.length; i++) {
        const tiles = expandPai(parts[i]);
        melds.push(tiles.join(' '));
    }
    return hand + ' | ' + melds.join(', ');
}

function formatOption(opt) {
    if (opt === 'skip' || opt === 'kita') return opt;
    if (opt.match(/^[mpsz]\d\*$/)) return opt.slice(0, 2) + ' *';
    if (opt.match(/^[mpsz]\d$/)) return opt;
    const tiles = expandPai(opt);
    return tiles.join(' ');
}

function stripDir(opt) {
    return opt.replace(/[\+\=\-]/g, '');
}

function formatHe(paiArr) {
    return paiArr.map(p => p.slice(0, 2)).join(' ');
}

function visibleInfo(player) {
    const model = player._model;
    const mf = player._menfeng;
    const lines = [];
    lines.push(`${WIND[model.zhuangfeng]} ${model.jushu + 1}局 ${model.changbang}本場`);
    lines.push(`自風: ${WIND[mf]}`);
    lines.push(`残: ${player.shan.paishu}枚`);
    lines.push(`ドラ: ${model.shan.baopai.map(p => p || '').join(' ')}`);

    const scores = [];
    for (let i = 0; i < 4; i++) {
        const rel = (i - mf + 4) % 4;
        const tag = ['自', '下', '対', '上'][rel];
        const id = model.player_id[i];
        scores.push(`${tag} ${model.defen[id]}`);
    }
    lines.push(`点数: ${scores.join(' / ')}`);
    return lines.join('\n');
}

function discardInfo(player) {
    const model = player._model;
    const mf = player._menfeng;
    const parts = [];
    for (let i = 0; i < 4; i++) {
        const rel = (i - mf + 4) % 4;
        if (rel === 0) continue;
        const tag = ['', '下家', '対面', '上家'][rel];
        const he = model.he[i];
        if (he && he._pai && he._pai.length > 0) {
            parts.push(`${tag}捨牌: ${formatHe(he._pai)}`);
        }
    }
    return parts.join('\n');
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
    const tingpai = xiangting === 0
        ? (Majiang.Util.tingpai(player.shoupai) || []) : [];

    const lines = [];
    lines.push(visibleInfo(player));
    lines.push(`手牌: ${formatShoupai(player.shoupai.toString())}`);
    if (xiangting === 0 && tingpai.length > 0) {
        lines.push(`テンパイ! 待ち: ${tingpai.join(' ')}`);
    } else if (xiangting > 0) {
        lines.push(`向聴数: ${xiangting}`);
    }
    const dinfo = discardInfo(player);
    if (dinfo) lines.push(dinfo);
    if (lizhi_candidates.length > 0) {
        lines.push(`(* 付きはリーチ宣言。テンパイならリーチ推奨)`);
    }
    lines.push(`選択: [${allOptions.map(formatOption).join(', ')}]`);
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
    lines.push(`手牌: ${formatShoupai(player.shoupai.toString())}`);
    lines.push(`他家打牌: ${dapaiMsg.p.slice(0, 2)}`);
    lines.push(`選択: [${options.map(formatOption).join(', ')}] skip = スルー`);
    return { prompt: lines.join('\n'), legal: options };
}

function buildGangPrompt(player) {
    const gangOptions = player.get_gang_mianzi(player.shoupai);
    if (gangOptions.length === 0) return null;

    const options = [...gangOptions, 'skip'];
    const lines = [];
    lines.push(`手牌: ${formatShoupai(player.shoupai.toString())}`);
    lines.push(`カン選択: [${options.map(formatOption).join(', ')}]`);
    return { prompt: lines.join('\n'), legal: options };
}

function parseResponse(response, legal) {
    const cleaned = response.replace(/[\s`「」　*\+\=\-]/g, '');

    for (const opt of legal) {
        const optClean = stripDir(opt).replace(/[\s*]/g, '');
        if (cleaned === optClean) return opt;
    }
    for (const opt of legal) {
        const optClean = stripDir(opt).replace(/[\s*]/g, '');
        if (cleaned.includes(optClean)) return opt;
    }
    if (/skip|スキップ|スルー/.test(cleaned)) {
        if (legal.includes('skip')) return 'skip';
    }

    for (const opt of legal) {
        if (opt === 'skip') continue;
        const base = stripDir(opt).replace(/[*\s]/g, '').slice(0, 2);
        if (cleaned.includes(base)) return opt;
    }

    if (legal.find(o => o.endsWith('*'))) {
        if (/リーチ|立直|reach/i.test(response)) {
            return legal.find(o => o.endsWith('*')) || legal[0];
        }
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
            const combinedPrompt = `${prompt}\nカンも可: [${gangInfo.legal.map(formatOption).join(', ')}]`;
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

        const xiangting = Majiang.Util.xiangting(this.shoupai);
        if (xiangting > 2) return this._callback();

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
        queryLLM(prompt).then(response => {
            const chosen = parseResponse(response, legal);
            onResult(chosen);
        }).catch(err => {
            console.error(`  [Qwen] LLM error: ${err.message}, fallback`);
            onResult(legal[0]);
        });
    }
}

module.exports = QwenPlayer;
