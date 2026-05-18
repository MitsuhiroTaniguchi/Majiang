/*!
 *  電脳麻将: Qwen対局観戦 v2.5.1
 */
"use strict";

const { hide, show, scale } = Majiang.UI.Util;

const LLAMA_URL = 'http://localhost:8080';

const WIND = ['東', '南', '西', '北'];

const SYSTEM_MSG = 'あなたは日本式リーチ麻雀のAIです。牌記法: m=萬子,p=筒子,s=索子,z=字牌(1東2南3西4北5白6發7中),0=赤5。手牌例: m123p456s789z11 副露例: m12-3(チー),z555=(ポン)。合法手から最善の1つを選び、その記号だけ回答せよ。';

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
    const tingpai = xiangting === 0
        ? (Majiang.Util.tingpai(player.shoupai) || []) : [];
    const lines = [];
    lines.push(visibleInfo(player));
    lines.push(`手牌:${player.shoupai.toString()}`);
    if (xiangting === 0 && tingpai.length > 0) {
        lines.push(`テンパイ! 待ち:[${tingpai.join(',')}]`);
    } else if (xiangting > 0) {
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
    constructor() { super(); }

    action_kaiju(kaiju) { this._callback(); }
    action_qipai(qipai) { this._callback(); }

    action_zimo(zimo, gangzimo) {
        if (zimo.l !== this._menfeng) return this._callback();
        if (this.allow_hule(this.shoupai, null,
                gangzimo || this.shoupai.lizhi || this.shan.paishu === 0)) {
            return this._callback({ hule: '-' });
        }
        if (this.allow_pingju(this.shoupai) &&
            Majiang.Util.xiangting(this.shoupai) >= 4) {
            return this._callback({ daopai: '-' });
        }
        if (this.shoupai.lizhi) {
            const gang = this.get_gang_mianzi(this.shoupai);
            if (gang.length > 0) return this._callback({ gang: gang[0] });
            return this._callback({ dapai: this.shoupai._zimo });
        }
        const gangInfo = buildGangPrompt(this);
        const { prompt, legal } = buildDapaiPrompt(this);
        if (gangInfo) {
            const allLegal = [...gangInfo.legal.filter(o => o !== 'skip'), ...legal];
            const combinedPrompt = `${prompt}\nカンも可:[${gangInfo.legal.join(',')}]`;
            this._asyncAction(combinedPrompt, allLegal, (chosen) => {
                if (chosen === 'skip') return this._callback({ dapai: legal[0] });
                if (gangInfo.legal.includes(chosen) && chosen !== 'skip') {
                    return this._callback({ gang: chosen });
                }
                this._callback({ dapai: chosen });
            });
            return;
        }
        this._asyncAction(prompt, legal, (chosen) => {
            this._callback({ dapai: chosen });
        });
    }

    action_dapai(dapai) {
        if (dapai.l === this._menfeng) {
            if (this.allow_no_daopai(this.shoupai)) return this._callback({ daopai: '-' });
            return this._callback();
        }
        const d = ['', '+', '=', '-'][(4 + this._model.lunban - this._menfeng) % 4];
        const rongpai = dapai.p.slice(0, 2) + d;
        if (this.allow_hule(this.shoupai, rongpai)) {
            return this._callback({ hule: '-' });
        }
        const xiangting = Majiang.Util.xiangting(this.shoupai);
        if (xiangting > 2) return this._callback();
        const fulouInfo = buildFulouPrompt(this, dapai);
        if (!fulouInfo) return this._callback();
        this._asyncAction(fulouInfo.prompt, fulouInfo.legal, (chosen) => {
            if (chosen === 'skip') {
                if (this.allow_no_daopai(this.shoupai)) return this._callback({ daopai: '-' });
                return this._callback();
            }
            this._callback({ fulou: chosen });
        });
    }

    action_fulou(fulou) {
        if (fulou.l !== this._menfeng) return this._callback();
        if (fulou.m.match(/^[mpsz]\d{4}/)) return this._callback();
        const { prompt, legal } = buildDapaiPrompt(this);
        this._asyncAction(prompt, legal, (chosen) => {
            this._callback({ dapai: chosen });
        });
    }

    action_gang(gang) {
        if (gang.l === this._menfeng) return this._callback();
        if (!gang.m.match(/^[mpsz]\d{4}$/)) {
            const d = ['', '+', '=', '-'][(4 + this._model.lunban - this._menfeng) % 4];
            const rongpai = gang.m[0] + gang.m.slice(-1) + d;
            if (this.allow_hule(this.shoupai, rongpai, true)) {
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
            console.error(`[Qwen] LLM error: ${err.message}, fallback`);
            onResult(legal[0]);
        });
    }
}

const QWEN_SEAT = 0;

let loaded;

$(function(){
    let game;
    const pai   = Majiang.UI.pai($('#loaddata'));
    const audio = Majiang.UI.audio($('#loaddata'));
    const rule  = Majiang.rule(
                    JSON.parse(localStorage.getItem('Majiang.rule')||'{}'));

    function start() {
        let players = [];
        for (let i = 0; i < 4; i++) {
            players[i] = (i === QWEN_SEAT) ? new QwenPlayer() : new Majiang.AI();
        }
        game = new Majiang.Game(players, start, rule);
        game.view = new Majiang.UI.Board($('#board .board'),
                                        pai, audio, game.model);
        game.wait = 500;
        game._model.title
            = game._model.title.replace(/^[^\n]*/, $('title').text());
        game._model.player[QWEN_SEAT] = 'Qwen';
        game._view.open_shoupai = true;

        $('body').attr('class','board');
        scale($('#board'), $('#space'));

        $(window).off('keyup').on('keyup', (ev)=>{
            if (ev.key == ' ') {
                if (gamectl.stoped) gamectl.start();
                else                gamectl.stop();
                game.handler = ()=> gamectl.stop();
            }
            else if (ev.key == 's') gamectl.shoupai();
            else if (ev.key == 'h') gamectl.he();
            return false;
        });
        $('#board .board').off('click').on('click', ()=>{
            if (gamectl.stoped) gamectl.start();
            else                gamectl.stop();
            game.handler = ()=> gamectl.stop();
        });

        const gamectl = new Majiang.UI.GameCtl($('#board'), 'Majiang.pref',
                                                game, game._view);
        game.kaiju();
    }

    $(window).on('resize', ()=>scale($('#board'), $('#space')));

    $(window).on('load', function(){
        hide($('#title .loading'));
        $('#title .start').on('click', start)
        show($('#title .start'));
    });
    if (loaded) $(window).trigger('load');
});

$(window).on('load', ()=> loaded = true);
