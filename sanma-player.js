"use strict";

const Majiang = require('@kobalab/majiang-core');

const N = 3;

class SanmaBoard extends Majiang.Board {
    menfeng(id) {
        return (id + N - this.qijia + N * N - this.jushu) % N;
    }

    qipai(qipai) {
        this.zhuangfeng = qipai.zhuangfeng;
        this.jushu      = qipai.jushu;
        this.changbang  = qipai.changbang;
        this.lizhibang  = qipai.lizhibang;
        this.shan       = new SanmaBoardShan(qipai.baopai);
        for (let l = 0; l < N; l++) {
            let paistr = qipai.shoupai[l] || '_'.repeat(13);
            this.shoupai[l] = Majiang.Shoupai.fromString(paistr);
            this.he[l]      = new Majiang.He();
            this.player_id[l] = (this.qijia + this.jushu + l) % N;
            this.defen[this.player_id[l]] = qipai.defen[l];
        }
        this.lunban = -1;

        this._lizhi     = false;
        this._fenpei    = null;
        this._changbang = qipai.changbang;
        this._lizhibang = qipai.lizhibang;
    }

    hule(hule) {
        let shoupai = this.shoupai[hule.l];
        shoupai.fromString(hule.shoupai);
        if (hule.baojia != null) shoupai.dapai(shoupai.get_dapai().pop());
        if (this._fenpei) {
            this.changbang = 0;
            this.lizhibang = 0;
            for (let l = 0; l < N; l++) {
                this.defen[this.player_id[l]] += this._fenpei[l];
            }
        }
        this.shan.fubaopai = hule.fubaopai;
        this._fenpei = hule.fenpei;
        this._lizhibang = 0;
        if (hule.l == 0) this._lianzhuang = true;
    }

    pingju(pingju) {
        if (!pingju.name.match(/^三家和/)) this.lizhi();
        for (let l = 0; l < N; l++) {
            if (pingju.shoupai[l])
                this.shoupai[l].fromString(pingju.shoupai[l]);
        }
        this._fenpei = pingju.fenpei;
        this._lizhibang = this.lizhibang;
        this._lianzhuang = true;
    }

    last() {
        if (!this._fenpei) return;
        this.changbang = this._lianzhuang ? this._changbang + 1 : 0;
        this.lizhibang = this._lizhibang;
        for (let l = 0; l < N; l++) {
            this.defen[this.player_id[l]] += this._fenpei[l];
        }
    }

    jieju(paipu) {
        for (let id = 0; id < N; id++) {
            this.defen[id] = paipu.defen[id];
        }
        this.lunban = -1;
    }
}

class SanmaBoardShan {
    constructor(baopai) {
        this.paishu = 55;
        this.baopai = [].concat(baopai || []);
        this.fubaopai = undefined;
    }
    zimo(p) { this.paishu--; return p || '_'; }
    kaigang(baopai) { this.baopai.push(baopai); }
}

class SanmaPlayer extends Majiang.Player {
    constructor() {
        super();
        this._model = new SanmaBoard();
        this._n_kita = 0;
        this._kita_all = [0, 0, 0];
    }

    action(msg, callback) {
        this._callback = callback;

        if      (msg.kaiju)    this.kaiju  (msg.kaiju);
        else if (msg.qipai)    { this._n_kita = 0; this._kita_all = [0, 0, 0]; this.qipai(msg.qipai); }
        else if (msg.zimo)     this.zimo   (msg.zimo);
        else if (msg.dapai)    this.dapai  (msg.dapai);
        else if (msg.fulou)    this.fulou  (msg.fulou);
        else if (msg.gang)     this.gang   (msg.gang);
        else if (msg.kita)     this.action_kita(msg.kita);
        else if (msg.gangzimo) this.zimo   (msg.gangzimo, true);
        else if (msg.kaigang)  this.kaigang(msg.kaigang);
        else if (msg.hule)     this.hule   (msg.hule);
        else if (msg.pingju)   this.pingju (msg.pingju);
        else if (msg.jieju)    this.jieju  (msg.jieju);
    }

    allow_hule(shoupai, p, hupai) {
        try {
            return super.allow_hule(shoupai, p, hupai);
        } catch(e) {
            return false;
        }
    }
}

const WIND = ['東', '南', '西'];

class SimpleAI extends SanmaPlayer {

    action_kaiju(kaiju) { this._callback(); }
    action_qipai(qipai) { this._callback(); }

    action_zimo(zimo, gangzimo) {
        if (zimo.l !== this._menfeng) return this._callback();

        if (this.allow_hule(this.shoupai, null,
                gangzimo || this.shoupai.lizhi || this.shan.paishu === 0)) {
            return this._callback({ hule: '-' });
        }

        if (this.allow_pingju(this.shoupai) &&
            Majiang.Util.xiangting(this.shoupai) >= 6) {
            return this._callback({ daopai: '-' });
        }

        if (this.shoupai.lizhi) {
            const gang = this.get_gang_mianzi(this.shoupai);
            if (gang.length > 0) return this._callback({ gang: gang[0] });
            return this._callback({ dapai: this.shoupai._zimo });
        }

        if (this._canKita()) {
            return this._callback({ kita: '-' });
        }

        const dapai = this.get_dapai(this.shoupai);

        for (const p of dapai) {
            if (this.allow_lizhi(this.shoupai, p)) {
                return this._callback({ dapai: p + '*' });
            }
        }

        const gang = this.get_gang_mianzi(this.shoupai);
        if (gang.length > 0 && Math.random() < 0.3) {
            return this._callback({ gang: gang[0] });
        }

        const best = this._chooseDapai(dapai);
        this._callback({ dapai: best });
    }

    action_dapai(dapai) {
        if (dapai.l === this._menfeng) {
            if (this.allow_no_daopai(this.shoupai))
                return this._callback({ daopai: '-' });
            return this._callback();
        }

        const d = ['', '+', '-'][(N + this._model.lunban - this._menfeng) % N];
        const rongpai = dapai.p.slice(0, 2) + d;
        if (this.allow_hule(this.shoupai, rongpai)) {
            return this._callback({ hule: '-' });
        }

        const peng = this.get_peng_mianzi(this.shoupai, rongpai);
        if (peng.length > 0 && Majiang.Util.xiangting(this.shoupai) <= 2) {
            return this._callback({ fulou: peng[0] });
        }

        const gang_m = this.get_gang_mianzi(this.shoupai, rongpai);
        if (gang_m.length > 0 && Majiang.Util.xiangting(this.shoupai) <= 1) {
            return this._callback({ fulou: gang_m[0] });
        }

        if (this.allow_no_daopai(this.shoupai))
            return this._callback({ daopai: '-' });
        this._callback();
    }

    action_fulou(fulou) {
        if (fulou.l !== this._menfeng) return this._callback();
        if (fulou.m.match(/^[mpsz]\d{4}/)) return this._callback();

        const dapai = this.get_dapai(this.shoupai);
        const best = this._chooseDapai(dapai);
        this._callback({ dapai: best });
    }

    action_gang(gang) {
        if (gang.l === this._menfeng) return this._callback();
        if (!gang.m.match(/^[mpsz]\d{4}$/)) {
            const d = ['', '+', '-'][(N + this._model.lunban - this._menfeng) % N];
            const rongpai = gang.m[0] + gang.m.slice(-1) + d;
            if (this.allow_hule(this.shoupai, rongpai, true)) {
                return this._callback({ hule: '-' });
            }
        }
        return this._callback();
    }

    action_kita(kita) {
        this._kita_all[kita.l]++;
        if (kita.l === this._menfeng) {
            this._n_kita++;
        }
        if (this._callback) this._callback();
    }

    action_hule(hule) { this._callback(); }
    action_pingju(pingju) { this._callback(); }
    action_jieju(jieju) { this._callback(); }

    _canKita() {
        if (this.shoupai.lizhi) return false;
        if (this.shan.paishu === 0) return false;
        if (this.shoupai._bingpai.z[4] === 0) return false;
        let shoupai = this.shoupai.clone();
        shoupai.dapai('z4');
        let xt_without = Majiang.Util.xiangting(shoupai);
        let xt_with = Majiang.Util.xiangting(this.shoupai);
        return xt_without <= xt_with;
    }

    _chooseDapai(dapai) {
        let bestPai = dapai[dapai.length - 1];
        let bestScore = -Infinity;

        for (const p of dapai) {
            const shoupai = this.shoupai.clone();
            shoupai.dapai(p);
            const xt = Majiang.Util.xiangting(shoupai);
            let score = -xt * 100;
            if (xt === 0) {
                const ting = Majiang.Util.tingpai(shoupai);
                score += ting.length * 10;
            }
            if (p.match(/^z/)) score += 1;
            if (p.match(/^[mps][19]/)) score += 0.5;

            if (score > bestScore) {
                bestScore = score;
                bestPai = p;
            }
        }
        return bestPai;
    }
}

module.exports = { SanmaPlayer, SanmaBoard, SimpleAI };
