"use strict";

const http = require("http");
const Majiang = require("@kobalab/majiang-core");
const { SanmaPlayer } = require("./sanma-player");

const N = 3;
const SERVER_URL = process.env.MAHJONGLM_URL || "http://127.0.0.1:8889";

// ── Tile utilities ──────────────────────────────────────────────────
const SUIT_BASE = { m: 0, p: 9, s: 18, z: 27 };

function tileIndex(tile) {
    let d = parseInt(tile[1]);
    if (d === 0) d = 5;
    return SUIT_BASE[tile[0]] + d - 1;
}

function tileSortKey(tile) {
    return tileIndex(tile) * 10 + (tile[1] === "0" ? 0 : 1);
}

function normTile(pai) {
    return pai.replace(/[_+\-=*]/g, "").slice(0, 2);
}

function doraTile(pai) {
    return normTile(pai).replace("0", "5");
}

function handToTiles(shoupaiStr) {
    const tiles = [];
    const concealed = shoupaiStr.split(",")[0];
    let suit = "";
    for (const ch of concealed) {
        if ("mpsz".includes(ch)) { suit = ch; }
        else if (ch >= "0" && ch <= "9") { tiles.push(suit + ch); }
    }
    return tiles.sort((a, b) => tileSortKey(a) - tileSortKey(b));
}

// ── TENBO encoding ──────────────────────────────────────────────────
const TENBO_UNITS = [
    [10000, "TENBO_10000"], [9000, "TENBO_9000"], [8000, "TENBO_8000"],
    [7000, "TENBO_7000"],   [6000, "TENBO_6000"], [5000, "TENBO_5000"],
    [4000, "TENBO_4000"],   [3000, "TENBO_3000"], [2000, "TENBO_2000"],
    [1000, "TENBO_1000"],   [900, "TENBO_900"],   [800, "TENBO_800"],
    [700, "TENBO_700"],     [600, "TENBO_600"],   [500, "TENBO_500"],
    [400, "TENBO_400"],     [300, "TENBO_300"],   [200, "TENBO_200"],
    [100, "TENBO_100"],
];

function encodeTenbo(value) {
    if (value === 0) return ["TENBO_ZERO"];
    const sign = value > 0 ? "TENBO_PLUS" : "TENBO_MINUS";
    let rem = Math.abs(value);
    const tokens = [sign];
    for (const [u, tok] of TENBO_UNITS) {
        while (rem >= u) { tokens.push(tok); rem -= u; }
    }
    return tokens;
}

// ── HTTP helper ─────────────────────────────────────────────────────
function postJSON(path, body, serverUrl) {
    return new Promise((resolve, reject) => {
        const data = JSON.stringify(body);
        const u = new URL(path, serverUrl || SERVER_URL);
        const req = http.request(
            { hostname: u.hostname, port: u.port, path: u.pathname,
              method: "POST", headers: {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(data),
              },
            },
            (res) => {
                let buf = "";
                res.on("data", (c) => (buf += c));
                res.on("end", () => {
                    try { resolve(JSON.parse(buf)); }
                    catch { reject(new Error(`bad JSON: ${buf.slice(0, 200)}`)); }
                });
            }
        );
        req.on("error", reject);
        req.setTimeout(30000, () => { req.destroy(); reject(new Error("timeout")); });
        req.end(data);
    });
}

async function generate(tokens, allowed, n, serverUrl) {
    const body = { tokens, n: n || 1 };
    if (allowed) body.allowed = allowed;
    const res = await postJSON("/generate", body, serverUrl);
    if (res.error) throw new Error(`server: ${res.error}`);
    return res.generated;
}

// ── Self-option priority (matches engine.py) ────────────────────────
const SELF_OPT_PRIORITY = {
    tsumo: 0, kyushukyuhai: 1, penuki: 2, riichi: 3, ankan: 4, kakan: 5,
};

function selfOptOrder(opts) {
    return [...opts].sort(
        (a, b) => (SELF_OPT_PRIORITY[a] ?? 99) - (SELF_OPT_PRIORITY[b] ?? 99)
    );
}

// ── Hupai name → yaku token ────────────────────────────────────────
const HUPAI_TOKEN = {
    "門前清自摸和": "yaku_menzen_tsumo", "立直": "yaku_riichi",
    "一発": "yaku_ippatsu", "槍槓": "yaku_chankan",
    "嶺上開花": "yaku_rinshan", "海底摸月": "yaku_haitei",
    "河底撈魚": "yaku_houtei", "平和": "yaku_pinfu",
    "断幺九": "yaku_tanyao", "一盃口": "yaku_iipeikou",
    "自風 東": "yaku_jikaze_ton", "自風 南": "yaku_jikaze_nan",
    "自風 西": "yaku_jikaze_shaa", "自風 北": "yaku_jikaze_pei",
    "場風 東": "yaku_bakaze_ton", "場風 南": "yaku_bakaze_nan",
    "場風 西": "yaku_bakaze_shaa", "場風 北": "yaku_bakaze_pei",
    "役牌 白": "yaku_haku", "役牌 發": "yaku_hatsu", "役牌 中": "yaku_chun",
    "ダブル立直": "yaku_double_riichi", "七対子": "yaku_chiitoitsu",
    "混全帯幺九": "yaku_chanta", "一気通貫": "yaku_ittsu",
    "三色同順": "yaku_sanshoku_doujun", "三色同刻": "yaku_sanshoku_doukou",
    "三槓子": "yaku_sankantsu", "対々和": "yaku_toitoi",
    "三暗刻": "yaku_sanankou", "小三元": "yaku_shousangen",
    "混老頭": "yaku_honroutou", "二盃口": "yaku_ryanpeikou",
    "純全帯幺九": "yaku_junchan", "混一色": "yaku_honitsu",
    "清一色": "yaku_chinitsu", "天和": "yaku_tenhou", "地和": "yaku_chiihou",
    "大三元": "yaku_daisangen", "四暗刻": "yaku_suuankou",
    "四暗刻単騎": "yaku_suuankou_tanki", "字一色": "yaku_tsuuiisou",
    "緑一色": "yaku_ryuuiisou", "清老頭": "yaku_chinroutou",
    "九蓮宝燈": "yaku_chuuren_poutou",
    "純正九蓮宝燈": "yaku_junsei_chuuren_poutou",
    "国士無双": "yaku_kokushi_musou",
    "国士無双１３面": "yaku_kokushi_musou_13_wait",
    "大四喜": "yaku_daisuushi", "小四喜": "yaku_shousuushi",
    "四槓子": "yaku_suukantsu",
    "ドラ": "yaku_dora", "裏ドラ": "yaku_ura_dora", "赤ドラ": "yaku_aka_dora",
    "北抜きドラ": "yaku_dora",
};
const DORA_HUPAI = new Set(["ドラ", "裏ドラ", "赤ドラ", "北抜きドラ"]);

const PINGJU_TOKEN = {
    "荒牌平局": "ryukyoku", "流局": "ryukyoku",
    "流し満貫": "nagashimangan", "九種九牌": "kyushukyuhai",
    "四風連打": "sufurenda", "四開槓": "sukantsu", "四槓散了": "sukantsu",
    "四家立直": "suuchariichi", "三家和": "sanchahou", "三家和了": "sanchahou",
};

function parseTilesFromHand(shoupaiStr) {
    const tiles = [];
    const concealed = shoupaiStr.split(",")[0].replace(/[_*]/g, "");
    let suit = "";
    for (const ch of concealed) {
        if ("mpsz".includes(ch)) { suit = ch; }
        else if (ch >= "0" && ch <= "9") { tiles.push(suit + ch); }
    }
    return tiles;
}

function dirSuffix(lunban, menfeng) {
    return ["", "+", "-"][(N + lunban - menfeng) % N];
}

// ── Player ──────────────────────────────────────────────────────────
class SanmaMahjongLMPlayer extends SanmaPlayer {
    constructor(options = {}) {
        super();
        this._serverUrl = options.serverUrl || SERVER_URL;
        this._seq = [];
        this._viewerPlayer = 0;
        this._pendingDora = null;
        this._qijia = 0;
        this._lastKanType = null;
        this._pendingReaction = null;
    }

    // ── lifecycle ───────────────────────────────────────────────────

    action_kaiju(kaiju) {
        const qijia = kaiju.qijia != null ? kaiju.qijia : 0;
        this._qijia = qijia;
        this._viewerPlayer = (this._id - qijia + N) % N;
        this._seq = [
            "<bos>",
            "rule_player_3",
            "rule_length_hanchan",
            `view_imperfect_${this._viewerPlayer}`,
            "game_start",
        ];
        this._callback();
    }

    action_qipai(qipai) {
        this._pendingDora = null;
        this._lastKanType = null;
        this._pendingReaction = null;
        const m = this._model;
        const seat = this._menfeng;

        const toks = [];
        toks.push("round_start");
        toks.push(`bakaze_${m.zhuangfeng}`);
        toks.push(`kyoku_${m.jushu}`);
        toks.push("honba", ...encodeTenbo(m.changbang * 100));
        toks.push("riichi_sticks", ...encodeTenbo(m.lizhibang * 1000));
        toks.push("dora", doraTile(m.shan.baopai[0]));

        for (let s = 0; s < N; s++) {
            const pid = m.player_id[s];
            toks.push(`score_${s}`, ...encodeTenbo(m.defen[pid]));
        }

        for (let s = 0; s < N; s++) {
            if (s === seat) {
                toks.push(`haipai_${s}`);
                toks.push(...handToTiles(this.shoupai.toString()));
            } else {
                toks.push(`hidden_haipai_${s}`);
            }
        }
        this._seq.push(...toks);
        this._callback();
    }

    // ── kaigang (new dora after kan) ───────────────────────────────

    kaigang(kaigang) {
        this._pendingDora = doraTile(kaigang.baopai);
        super.kaigang(kaigang);
    }

    _emitDeferredDora() {
        if (this._pendingDora) {
            this._seq.push("dora", this._pendingDora);
            this._pendingDora = null;
        }
    }

    _extractWinningTile(shoupaiStr) {
        if (!shoupaiStr) return null;
        const tiles = parseTilesFromHand(shoupaiStr);
        return tiles.length > 0 ? tiles[tiles.length - 1] : null;
    }

    _resolvePendingReaction(outcome) {
        const pr = this._pendingReaction;
        if (!pr) return;
        this._pendingReaction = null;
        this._seq.length = pr.checkpoint;
        if (outcome === 'accepted') {
            this._seq.push(...pr.generatedTokens);
        } else {
            for (const opt of pr.reactOpts) {
                this._seq.push(`pass_react_${pr.mySeat}_${opt}_forced_priority`);
            }
        }
    }

    // ── zimo (draw) ─────────────────────────────────────────────────

    action_zimo(zimo, gangzimo) {
        this._pendingReaction = null;
        if (gangzimo && this._pendingDora) {
            if (this._lastKanType === 'ankan') {
                this._seq.push("dora", this._pendingDora);
                this._pendingDora = null;
            }
        }

        if (zimo.l !== this._menfeng) {
            this._seq.push(`draw_${zimo.l}_hidden`);
            return this._callback();
        }

        const seat = this._menfeng;
        const tile = normTile(zimo.p);
        this._seq.push(`draw_${seat}_${tile}`);

        const canTsumo = this.allow_hule(this.shoupai, null, gangzimo);
        if (canTsumo) {
            const selfOpts = this._computeSelfOptions(seat, gangzimo);
            const ordered = selfOptOrder(selfOpts);
            for (const opt of ordered) {
                this._seq.push(`opt_self_${seat}_${opt}`);
            }
            this._seq.push(`take_self_${seat}_tsumo`, tile);
            for (let i = 0; i < ordered.length; i++) {
                if (ordered[i] !== 'tsumo') {
                    this._seq.push(`pass_self_${seat}_${ordered[i]}`);
                }
            }
            console.log("  [MahjongLM] ツモ和了!");
            return this._callback({ hule: "-" });
        }

        this._asyncSelfDecision(seat, tile, gangzimo);
    }

    async _asyncSelfDecision(seat, drawnTile, gangzimo) {
        try {
            const selfOpts = this._computeSelfOptions(seat, gangzimo);
            for (const opt of selfOptOrder(selfOpts)) {
                this._seq.push(`opt_self_${seat}_${opt}`);
            }

            const dapai = this.get_dapai(this.shoupai);
            let lizhiCandidates = [];
            for (const p of dapai) {
                if (this.allow_lizhi(this.shoupai, p)) lizhiCandidates.push(p);
            }

            const ordered = selfOptOrder(selfOpts);
            let takenIdx = -1;
            for (let i = 0; i < ordered.length; i++) {
                const opt = ordered[i];
                const allowed = [
                    `take_self_${seat}_${opt}`,
                    `pass_self_${seat}_${opt}`,
                ];
                const [decision] = await generate(this._seq, allowed, 1, this._serverUrl);
                this._seq.push(decision.token);

                if (decision.token === `take_self_${seat}_${opt}`) {
                    takenIdx = i;

                    if (opt === "tsumo") {
                        this._seq.push(drawnTile);
                    }
                    let kanTile = null;
                    if (opt === "ankan" || opt === "kakan") {
                        kanTile = await this._resolveKanTile(seat, opt);
                    }

                    for (let j = i + 1; j < ordered.length; j++) {
                        this._seq.push(`pass_self_${seat}_${ordered[j]}`);
                    }

                    if (opt === "tsumo") {
                        console.log("  [MahjongLM] ツモ和了!");
                        return this._callback({ hule: "-" });
                    }
                    if (opt === "penuki") {
                        console.log("  [MahjongLM] 北抜き");
                        return this._callback({ kita: "-" });
                    }
                    if (opt === "riichi") {
                        return this._resolveRiichiDiscard(seat, lizhiCandidates);
                    }
                    if (opt === "ankan") {
                        return this._resolveAnkan(seat, kanTile);
                    }
                    if (opt === "kakan") {
                        return this._resolveKakan(seat, kanTile);
                    }
                    if (opt === "kyushukyuhai") {
                        console.log("  [MahjongLM] 九種九牌");
                        return this._callback({ daopai: "-" });
                    }
                    break;
                }
            }

            await this._resolveDiscard(seat, dapai);
        } catch (err) {
            console.error(`  [MahjongLM] self-decision error: ${err.message}`);
            const dapai = this.get_dapai(this.shoupai);
            this._callback({ dapai: dapai[0] });
        }
    }

    _computeSelfOptions(seat, gangzimo) {
        const opts = [];
        if (this.allow_hule(this.shoupai, null, gangzimo)) {
            opts.push("tsumo");
        }
        if (this.allow_pingju(this.shoupai)) {
            opts.push("kyushukyuhai");
        }
        if (this._canKita()) {
            opts.push("penuki");
        }
        if (!this.shoupai.lizhi) {
            const dapai = this.get_dapai(this.shoupai);
            for (const p of dapai) {
                if (this.allow_lizhi(this.shoupai, p)) {
                    opts.push("riichi");
                    break;
                }
            }
        }
        const gang = this.get_gang_mianzi(this.shoupai);
        for (const g of gang) {
            if (g.match(/^[mpsz]\d{4}$/)) opts.push("ankan");
            else opts.push("kakan");
        }
        return [...new Set(opts)];
    }

    _canKita() {
        if (this.shan.paishu === 0) return false;
        if (this.shoupai.lizhi) {
            return this.shoupai._zimo === "z4";
        }
        return this.shoupai._bingpai.z[4] > 0;
    }

    async _resolveRiichiDiscard(seat, lizhiCandidates) {
        const allowed = [];
        for (const d of lizhiCandidates) {
            const tile = normTile(d);
            const kind = d.endsWith("_") ? "tsumogiri" : "tedashi";
            allowed.push(`discard_${seat}_${tile}_${kind}`);
        }
        if (allowed.length === 0) {
            allowed.push(`discard_${seat}_${normTile(this.shoupai._zimo)}_tsumogiri`);
        }
        const [decision] = await generate(this._seq, allowed, 1, this._serverUrl);
        this._seq.push(decision.token);
        this._emitDeferredDora();
        const chosen = this._discardTokenToAction(decision.token, true);
        console.log(`  [MahjongLM] リーチ打${chosen}`);
        this._callback({ dapai: chosen });
    }

    async _resolveKanTile(seat, opt) {
        const gang = this.get_gang_mianzi(this.shoupai);
        const candidates = [];
        for (const g of gang) {
            const stripped = g.replace(/[+\-=]/g, "");
            if (opt === "ankan" && stripped.match(/^[mpsz]\d{4}$/)) {
                candidates.push(normTile(stripped.slice(0, 2)));
            } else if (opt === "kakan" && !stripped.match(/^[mpsz]\d{4}$/)) {
                candidates.push(normTile(stripped.slice(0, 2)));
            }
        }
        if (candidates.length === 1) {
            this._seq.push(candidates[0]);
            return candidates[0];
        }
        const [decision] = await generate(this._seq, candidates, 1, this._serverUrl);
        this._seq.push(decision.token);
        return decision.token;
    }

    _resolveAnkan(seat, kanTile) {
        const gang = this.get_gang_mianzi(this.shoupai);
        for (const g of gang) {
            const stripped = g.replace(/[+\-=]/g, "");
            if (stripped.match(/^[mpsz]\d{4}$/) && normTile(stripped.slice(0, 2)) === kanTile) {
                console.log(`  [MahjongLM] 暗槓:${g}`);
                return this._callback({ gang: g });
            }
        }
        this._callback({ gang: gang[0] });
    }

    _resolveKakan(seat, kanTile) {
        const gang = this.get_gang_mianzi(this.shoupai);
        for (const g of gang) {
            const stripped = g.replace(/[+\-=]/g, "");
            if (!stripped.match(/^[mpsz]\d{4}$/) && normTile(stripped.slice(0, 2)) === kanTile) {
                console.log(`  [MahjongLM] 加槓:${g}`);
                return this._callback({ gang: g });
            }
        }
        this._callback({ gang: gang[0] });
    }

    async _resolveDiscard(seat, dapai) {
        const allowed = [];
        for (const d of dapai) {
            const tile = normTile(d);
            const kind = d.endsWith("_") ? "tsumogiri" : "tedashi";
            allowed.push(`discard_${seat}_${tile}_${kind}`);
        }
        const [decision] = await generate(this._seq, allowed, 1, this._serverUrl);
        this._seq.push(decision.token);
        this._emitDeferredDora();
        const chosen = this._discardTokenToAction(decision.token, false);
        console.log(`  [MahjongLM] 打${chosen}`);
        this._callback({ dapai: chosen });
    }

    _discardTokenToAction(token, isRiichi) {
        const parts = token.split("_");
        const tile = parts[2];
        const kind = parts[3];
        const suffix = kind === "tsumogiri" ? "_" : "";
        const star = isRiichi ? "*" : "";
        return tile + suffix + star;
    }

    // ── dapai (discard by someone) ──────────────────────────────────

    action_dapai(dapai) {
        const seat = dapai.l;
        const tile = normTile(dapai.p);
        const isRiichi = dapai.p.includes("*");
        const isTsumogiri = dapai.p.includes("_");

        if (seat === this._menfeng) {
            if (this.allow_no_daopai(this.shoupai)) {
                return this._callback({ daopai: "-" });
            }
            return this._callback();
        }

        if (isRiichi) {
            this._seq.push(`take_self_${seat}_riichi`);
        }
        this._seq.push(`discard_${seat}_${tile}_${isTsumogiri ? "tsumogiri" : "tedashi"}`);
        this._emitDeferredDora();

        const d = dirSuffix(this._model.lunban, this._menfeng);
        const rongpai = dapai.p.slice(0, 2) + d;

        if (this.allow_hule(this.shoupai, rongpai)) {
            const mySeat = this._menfeng;
            const p = dapai.p.slice(0, 2) + d;
            const allReactOpts = ["ron"];
            if (this.get_peng_mianzi(this.shoupai, p).length > 0) allReactOpts.push("pon");
            if (this.get_gang_mianzi(this.shoupai, p).length > 0) allReactOpts.push("minkan");
            for (const opt of allReactOpts) {
                this._seq.push(`opt_react_${mySeat}_${opt}`);
            }
            this._seq.push(`take_react_${mySeat}_ron`);
            for (let j = 1; j < allReactOpts.length; j++) {
                this._seq.push(`pass_react_${mySeat}_${allReactOpts[j]}_voluntary`);
            }
            console.log("  [MahjongLM] ロン!");
            return this._callback({ hule: "-" });
        }

        this._asyncReaction(dapai);
    }

    async _asyncReaction(dapai) {
        try {
            const mySeat = this._menfeng;
            const d = dirSuffix(this._model.lunban, this._menfeng);
            const p = dapai.p.slice(0, 2) + d;

            const pengMelds = this.get_peng_mianzi(this.shoupai, p);
            const gangMelds = this.get_gang_mianzi(this.shoupai, p);

            if (pengMelds.length === 0 && gangMelds.length === 0) {
                if (this.allow_no_daopai(this.shoupai)) {
                    return this._callback({ daopai: "-" });
                }
                return this._callback();
            }

            const reactOpts = [];
            if (pengMelds.length > 0) reactOpts.push("pon");
            if (gangMelds.length > 0) reactOpts.push("minkan");

            for (const opt of reactOpts) {
                this._seq.push(`opt_react_${mySeat}_${opt}`);
            }
            const checkpoint = this._seq.length;

            let taken = null;
            let takenIdx = -1;
            for (let i = 0; i < reactOpts.length; i++) {
                const opt = reactOpts[i];
                const allowed = [
                    `take_react_${mySeat}_${opt}`,
                    `pass_react_${mySeat}_${opt}_voluntary`,
                ];
                const [decision] = await generate(this._seq, allowed, 1, this._serverUrl);
                this._seq.push(decision.token);

                if (decision.token === `take_react_${mySeat}_${opt}`) {
                    taken = opt;
                    takenIdx = i;
                    break;
                }
            }

            let meld = null;
            if (taken === "pon") {
                meld = await this._resolvePon(mySeat, pengMelds);
            }

            if (taken) {
                for (let j = takenIdx + 1; j < reactOpts.length; j++) {
                    this._seq.push(`pass_react_${mySeat}_${reactOpts[j]}_voluntary`);
                }
            }

            const generatedTokens = this._seq.slice(checkpoint);
            this._pendingReaction = { checkpoint, reactOpts, mySeat, taken, generatedTokens };

            if (!taken) {
                this._pendingReaction = null;
                if (this.allow_no_daopai(this.shoupai)) {
                    return this._callback({ daopai: "-" });
                }
                return this._callback();
            }

            if (taken === "pon") {
                console.log(`  [MahjongLM] ポン:${meld}`);
                return this._callback({ fulou: meld });
            }
            if (taken === "minkan") {
                console.log(`  [MahjongLM] 大明槓:${gangMelds[0]}`);
                return this._callback({ fulou: gangMelds[0] });
            }
        } catch (err) {
            console.error(`  [MahjongLM] reaction error: ${err.message}`);
            this._callback();
        }
    }

    async _resolvePon(seat, melds) {
        if (melds.length === 1) {
            const hasRed = this._meldHasRedFive(melds[0]);
            if (hasRed !== null) {
                this._seq.push(hasRed ? "red_used" : "red_not_used");
            }
            return melds[0];
        }
        const allowed = ["red_used", "red_not_used"];
        const [decision] = await generate(this._seq, allowed, 1, this._serverUrl);
        this._seq.push(decision.token);
        const useRed = decision.token === "red_used";
        for (const m of melds) {
            if (this._meldHasRedFive(m) === useRed) return m;
        }
        return melds[0];
    }

    _meldHasRedFive(meld) {
        const stripped = meld.replace(/[+\-=]/g, "");
        let hasFive = false;
        let hasRed = false;
        let suit = "";
        for (const ch of stripped) {
            if ("mpsz".includes(ch)) suit = ch;
            else {
                if (ch === "0") { hasRed = true; hasFive = true; }
                if (ch === "5" && "mps".includes(suit)) hasFive = true;
            }
        }
        if (!hasFive) return null;
        return hasRed;
    }

    // ── fulou (meld completed) ──────────────────────────────────────

    action_fulou(fulou) {
        if (fulou.l !== this._menfeng) {
            if (this._pendingReaction) {
                this._resolvePendingReaction('preempted');
            }
            const stripped = fulou.m.replace(/[+\-=]/g, "");
            const tiles = [];
            let suit = "";
            for (const ch of stripped) {
                if ("mpsz".includes(ch)) suit = ch;
                else tiles.push(SUIT_BASE[suit] + (ch === "0" ? 4 : parseInt(ch) - 1));
            }
            const action = tiles.length === 4 ? "minkan" : "pon";
            if (action === 'minkan') this._lastKanType = 'minkan';
            this._seq.push(`take_react_${fulou.l}_${action}`);
            if (action === "pon") {
                const red = this._meldHasRedFive(fulou.m);
                if (red !== null) this._seq.push(red ? "red_used" : "red_not_used");
            }
            return this._callback();
        }

        this._resolvePendingReaction('accepted');

        if (fulou.m.match(/^[mpsz]\d{4}/)) {
            this._lastKanType = 'minkan';
            return this._callback();
        }

        this._asyncPostMeldDiscard();
    }

    async _asyncPostMeldDiscard() {
        try {
            const seat = this._menfeng;
            const dapai = this.get_dapai(this.shoupai);
            await this._resolveDiscard(seat, dapai);
        } catch (err) {
            console.error(`  [MahjongLM] post-meld error: ${err.message}`);
            const dapai = this.get_dapai(this.shoupai);
            this._callback({ dapai: dapai[0] });
        }
    }

    // ── gang (kan) ──────────────────────────────────────────────────

    action_gang(gang) {
        const meld = gang.m;
        const stripped = meld.replace(/[+\-=]/g, "");
        this._lastKanType = stripped.match(/^[mpsz]\d{4}$/) ? 'ankan' : 'kakan';

        if (gang.l === this._menfeng) return this._callback();
        const isAnkan = stripped.match(/^[mpsz]\d{4}$/);
        const kanType = isAnkan ? "ankan" : "kakan";
        const tile = normTile(stripped.slice(0, 2));
        this._seq.push(`take_self_${gang.l}_${kanType}`, tile);

        if (!isAnkan) {
            const d = dirSuffix(this._model.lunban, this._menfeng);
            const rongpai = meld[0] + meld.slice(-1) + d;
            if (this.allow_hule(this.shoupai, rongpai, true)) {
                const mySeat = this._menfeng;
                this._seq.push(`opt_react_${mySeat}_ron`);
                this._seq.push(`take_react_${mySeat}_ron`);
                console.log("  [MahjongLM] 槍槓ロン!");
                return this._callback({ hule: "-" });
            }
        }
        return this._callback();
    }

    // ── kita (north extraction) ─────────────────────────────────────

    action_kita(kita) {
        this._kita_all[kita.l]++;
        if (this._model && this._model.shoupai && this._model.shoupai[kita.l]) {
            this._model.shoupai[kita.l].dapai('z4');
        }
        if (kita.l === this._menfeng) {
            this._n_kita++;
        } else {
            this._seq.push(`take_self_${kita.l}_penuki`);
        }
        if (this._callback) this._callback();
    }

    // ── terminal events ─────────────────────────────────────────────

    action_hule(hule) {
        const h = hule;
        const winner = h.l;

        if (winner !== this._menfeng) {
            if (h.baojia != null) {
                if (this._pendingReaction) {
                    this._resolvePendingReaction('preempted');
                }
                this._seq.push(`take_react_${winner}_ron`);
            } else {
                const winTile = this._extractWinningTile(h.shoupai);
                if (winTile) {
                    this._seq.push(`take_self_${winner}_tsumo`, winTile);
                }
            }
        }

        this._seq.push(`hule_${winner}`);

        if (h.shoupai) {
            const tiles = parseTilesFromHand(h.shoupai);
            if (tiles.length > 1) {
                const concealed = tiles.slice(0, -1).sort((a, b) => tileSortKey(a) - tileSortKey(b));
                this._seq.push(`opened_hand_${winner}`, ...concealed);
            }
        }

        if (h.fubaopai && h.hupai && h.hupai.some(y => y.name === "立直" || y.name === "ダブル立直")) {
            this._seq.push("ura_dora", ...h.fubaopai.map(t => doraTile(t)));
        }

        if (h.hupai) {
            for (const yaku of h.hupai) {
                const tok = HUPAI_TOKEN[yaku.name];
                if (!tok) continue;
                const repeat = DORA_HUPAI.has(yaku.name) && typeof yaku.fanshu === "number" ? yaku.fanshu : 1;
                for (let i = 0; i < repeat; i++) this._seq.push(tok);
            }
        }

        if (h.damanguan) {
            this._seq.push(`yakuman_${h.damanguan}`);
        } else {
            if (h.fanshu) {
                this._seq.push(`han_${Math.min(h.fanshu, 13)}`);
            }
            if (h.fu) {
                this._seq.push(`fu_${h.fu}`);
            }
        }

        if (h.fenpei) {
            this._appendScoreDeltaAndRank(h.fenpei);
        }

        this._seq.push("round_end");
        this._callback();
    }

    action_pingju(pingju) {
        const p = pingju;
        const name = p.name || "荒牌平局";
        const token = PINGJU_TOKEN[name] || "ryukyoku";
        this._seq.push(`pingju_${token}`);

        if (!["流し満貫", "四風連打", "四開槓", "四槓散了"].includes(name) && p.shoupai) {
            for (let s = 0; s < N; s++) {
                if (p.shoupai[s]) {
                    const tiles = parseTilesFromHand(p.shoupai[s]);
                    if (tiles.length > 0) {
                        const sorted = tiles.sort((a, b) => tileSortKey(a) - tileSortKey(b));
                        this._seq.push(`opened_hand_${s}`, ...sorted);
                    }
                }
            }
        }

        if (p.fenpei) {
            this._appendScoreDeltaAndRank(p.fenpei);
        }

        this._seq.push("round_end");
        this._callback();
    }

    action_jieju(jieju) {
        this._seq.push("game_end");

        const paipu = jieju;
        if (paipu && paipu.defen) {
            for (let gs = 0; gs < N; gs++) {
                const pid = (this._qijia + gs) % N;
                this._seq.push(`final_score_${gs}`, ...encodeTenbo(paipu.defen[pid]));
            }
        }
        if (paipu && paipu.rank) {
            for (let gs = 0; gs < N; gs++) {
                const pid = (this._qijia + gs) % N;
                this._seq.push(`final_rank_${gs}_${paipu.rank[pid]}`);
            }
        }

        this._callback();
    }

    _appendScoreDeltaAndRank(fenpei) {
        for (let s = 0; s < N; s++) {
            this._seq.push(`score_delta_${s}`, ...encodeTenbo(fenpei[s] || 0));
        }
        const m = this._model;
        const scores = [];
        for (let s = 0; s < N; s++) {
            scores[s] = m.defen[m.player_id[s]] + (fenpei[s] || 0);
        }
        const kyoku = m.jushu;
        const order = Array.from({ length: N }, (_, s) => s);
        order.sort((a, b) => scores[b] - scores[a] || ((kyoku + a) % N) - ((kyoku + b) % N));
        const places = new Array(N);
        for (let i = 0; i < N; i++) places[order[i]] = i + 1;
        for (let s = 0; s < N; s++) {
            this._seq.push(`rank_${s}_${places[s]}`);
        }
    }
}

module.exports = SanmaMahjongLMPlayer;
