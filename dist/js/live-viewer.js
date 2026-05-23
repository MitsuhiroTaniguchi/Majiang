"use strict";

const { scale } = Majiang.UI.Util;

$(function(){

    const pai   = Majiang.UI.pai($('#loaddata'));
    const audio = Majiang.UI.audio($('#loaddata'));

    let audioUnlocked = false;
    function unlockAudio() {
        if (audioUnlocked) return;
        audioUnlocked = true;
        try {
            const ctx = new (window.AudioContext || window.webkitAudioContext)();
            ctx.resume().then(() => ctx.close());
        } catch(e) {}
        document.querySelectorAll('#loaddata audio').forEach(a => {
            a.play().then(() => { a.pause(); a.currentTime = 0; }).catch(() => {});
        });
        $('#soundHint').fadeOut(500);
        document.removeEventListener('click', unlockAudio);
        document.removeEventListener('keydown', unlockAudio);
    }
    document.addEventListener('click', unlockAudio);
    document.addEventListener('keydown', unlockAudio);

    let model;
    let uiBoard;
    let qwenSeat = 0;
    let currentMode = '';

    const queue = [];
    let playing = false;

    function initBoard(kaiju) {
        model = new Majiang.Board(kaiju);
        uiBoard = new Majiang.UI.Board($('#board .board'), pai, audio, model);
        uiBoard.open_shoupai = true;
        uiBoard.viewpoint = 0;
        currentMode = kaiju.mode;
        hideDuimian(currentMode === 'sanma');
        scale($('#board'), $('#space'));
    }

    function hideDuimian(sanma) {
        const v = sanma ? 'hidden' : '';
        $('.shoupai.duimian, .he.duimian, .player.duimian, .say.duimian').css('visibility', v);
        $('.score .defen .duimian').css('visibility', v);
    }

    function updateStats(results) {
        const el = document.getElementById('stats');
        if (!el) return;
        if (!results || results.length === 0) {
            el.textContent = '';
            return;
        }
        el.innerHTML = '';
        for (const mode of ['yonma', 'sanma']) {
            const mr = results.filter(r => r.mode === mode);
            if (mr.length === 0) continue;
            const label = mode === 'sanma' ? '三麻' : '四麻';
            const mn = mr.length;
            const avgRank = (mr.reduce((s,r) => s + r.qwen_rank, 0) / mn).toFixed(2);
            const totalPt = mr.reduce((s,r) => s + r.qwen_point, 0);
            const line = document.createElement('span');
            line.className = totalPt >= 0 ? 'pos' : 'neg';
            line.textContent = `${totalPt >= 0 ? '+' : ''}${totalPt.toFixed(1)}pt`;
            el.appendChild(document.createTextNode(`${label} ${mn}半荘 平均${avgRank}位 `));
            el.appendChild(line);
            el.appendChild(document.createElement('br'));
        }
    }

    function enqueue(item) {
        queue.push(item);
        if (!playing) playNext();
    }

    function flushQueue() {
        queue.length = 0;
        playing = false;
    }

    function adaptDelay(base) {
        const len = queue.length;
        if (len > 60) return 0;
        if (len > 30) return Math.min(base, 30);
        if (len > 15) return Math.min(base, 100);
        return base;
    }

    function playNext() {
        if (queue.length === 0) { playing = false; return; }
        playing = true;
        const item = queue.shift();
        let delay;
        try {
            delay = processItem(item);
        } catch (e) {
            console.error('live-viewer processItem error:', e);
            delay = 0;
        }
        if (delay === 0) {
            setTimeout(playNext, 0);
        } else {
            setTimeout(playNext, delay);
        }
    }

    function applyModel(data) {
        if (data.zimo)          model.zimo(data.zimo);
        else if (data.dapai)    model.dapai(data.dapai);
        else if (data.fulou)    model.fulou(data.fulou);
        else if (data.gang)     model.gang(data.gang);
        else if (data.gangzimo) model.zimo(data.gangzimo);
        else if (data.kaigang)  model.kaigang(data.kaigang);
        else if (data.kita)     model.shoupai[data.kita.l].dapai('z4');
        else if (data.hule)     model.hule(data.hule);
        else if (data.pingju)   model.pingju(data.pingju);
    }

    function dismissDialog() {
        if (!uiBoard) return;
        if (uiBoard._timeout_id) {
            clearTimeout(uiBoard._timeout_id);
            uiBoard._timeout_id = null;
        }
        if (uiBoard._view && uiBoard._view.dialog) uiBoard._view.dialog.hide();
    }

    function processItem(item) {
        if (!model || !uiBoard) return 0;
        const behind = queue.length > 15;

        if (item.type === 'say') {
            if (behind) return 0;
            uiBoard.say(item.data.name, item.data.l);
            return adaptDelay(300);
        }

        if (item.type === 'qipai') {
            dismissDialog();
            model.qipai(item.data);
            if (item.data.player_id) {
                for (let l = 0; l < 4; l++) model.player_id[l] = item.data.player_id[l];
                const defen = [0, 0, 0, 0];
                for (let l = 0; l < 4; l++) defen[item.data.player_id[l]] = item.data.defen[l] || 0;
                model.defen = defen;
            }
            uiBoard.redraw();
            hideDuimian(currentMode === 'sanma');
            return adaptDelay(600);
        }

        if (item.type === 'update') {
            const data = item.data;
            if (!data) return 0;

            applyModel(data);

            if (data.kita) {
                if (uiBoard._view && uiBoard._view.shoupai && uiBoard._view.shoupai[data.kita.l])
                    uiBoard._view.shoupai[data.kita.l].redraw();
                return adaptDelay(300);
            }

            if (data.hule) {
                uiBoard.update(data);
                return Math.max(adaptDelay(4000), 2500);
            }
            if (data.pingju) {
                uiBoard.update(data);
                return Math.max(adaptDelay(3500), 2000);
            }

            uiBoard.update(data);

            if (data.dapai)    return adaptDelay(300);
            if (data.fulou)    return adaptDelay(400);
            if (data.gang)     return adaptDelay(400);
            if (data.zimo)     return adaptDelay(150);
            if (data.gangzimo) return adaptDelay(200);
            if (data.kaigang)  return adaptDelay(200);
            return adaptDelay(100);
        }

        if (item.type === 'summary') {
            dismissDialog();
            updateStats(item.data.results);
            return 0;
        }

        return 0;
    }

    const es = new EventSource('/events');

    es.addEventListener('kaiju', function(e) {
        const data = JSON.parse(e.data);
        flushQueue();
        qwenSeat = data.qwenSeat;
        initBoard(data);
        if (!audioUnlocked) {
            $('#overlay').text('クリックで開始').show().one('click', function() {
                unlockAudio();
                $(this).hide();
            });
        } else {
            $('#overlay').hide();
        }
        document.title = `第${data.gameCount}半荘 (${data.mode === 'sanma' ? '三麻' : '四麻'}) — Qwen対局ライブ`;
    });

    es.addEventListener('qipai', function(e) {
        const data = JSON.parse(e.data);
        if (!model) return;
        enqueue({ type: 'qipai', data });
    });

    es.addEventListener('update', function(e) {
        const data = JSON.parse(e.data);
        if (!model) return;
        enqueue({ type: 'update', data });
    });

    es.addEventListener('say', function(e) {
        const data = JSON.parse(e.data);
        if (!uiBoard) return;
        enqueue({ type: 'say', data });
    });

    es.addEventListener('think', function(e) {
        const data = JSON.parse(e.data);
        const panel = document.getElementById('think-panel');
        if (!panel) return;
        panel.textContent = data.text;
        panel.style.display = 'block';
        panel.scrollTop = panel.scrollHeight;
        clearTimeout(panel._hideTimer);
        if (!data.partial) {
            panel._hideTimer = setTimeout(() => { panel.style.display = 'none'; }, 8000);
        }
    });

    es.addEventListener('summary', function(e) {
        const data = JSON.parse(e.data);
        enqueue({ type: 'summary', data });
    });

    es.onerror = function() {
        $('#overlay').text('接続切断 — 再接続中...').show();
    };
    es.onopen = function() {
        if (model && audioUnlocked) $('#overlay').hide();
    };

    $(window).on('resize', () => scale($('#board'), $('#space')));
});
