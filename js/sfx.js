/* 鲸诺海 · 音效合成器（Web Audio，无外部素材）
 * 依据：小海 2026-11-04 点单——点击要有反应、有萌萌的音效。
 *
 * 原则（对齐《行为设计》防"假"清单）：
 *   1. 每次音高随机微调（±半音内），不许每次一模一样——否则变成按钮音
 *   2. 音量小（0.08-0.22），是"她在轻声应你"，不是提示音
 *   3. 全部现场合成：正弦/三角波 + 滑音，零文件、零版权，开源版干净
 * 开关：托盘菜单切，默认开，状态存 userData\config.json
 */
(function () {
  'use strict';

  var ctx = null;
  var enabled = true;

  function ensure() {
    if (!ctx) {
      try {
        var AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        ctx = new AC();
      } catch (e) { return null; }
    }
    if (ctx.state === 'suspended' && ctx.resume) { try { ctx.resume(); } catch (e) {} }
    return ctx;
  }

  /* 每次音高随机 ±6%，别像按钮 */
  function det() { return 1 + (Math.random() * 0.12 - 0.06); }

  /* 基础音：f0→f1 滑音 + 软起音软收尾 */
  function tone(opt) {
    if (!enabled) return;
    var c = ensure(); if (!c) return;
    var t0 = c.currentTime + (opt.delay || 0);
    var dur = opt.dur || 0.12;
    var osc = c.createOscillator();
    var g = c.createGain();
    var lp = c.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = opt.cut || 3200;
    osc.type = opt.type || 'sine';
    var f0 = opt.f0 * (opt.detune || det());
    var f1 = (opt.f1 || opt.f0) * (opt.detune || det());
    osc.frequency.setValueAtTime(Math.max(20, f0), t0);
    if (f1 !== f0) osc.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t0 + dur);
    var v = opt.vol || 0.18;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(v, t0 + (opt.attack || 0.008));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(lp).connect(g).connect(c.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.06);
  }

  /* 落地那种"噗"：一点低频正弦 + 一点软噪声 */
  function thump(opt) {
    if (!enabled) return;
    var c = ensure(); if (!c) return;
    var t0 = c.currentTime + (opt.delay || 0);
    var dur = opt.dur || 0.09;
    var osc = c.createOscillator();
    var g = c.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(opt.f0 * det(), t0);
    osc.frequency.exponentialRampToValueAtTime(opt.f1 * det(), t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(opt.vol || 0.2, t0 + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(c.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
    if (opt.noise) {
      var len = Math.floor(c.sampleRate * dur * 0.7);
      var buf = c.createBuffer(1, len, c.sampleRate);
      var d = buf.getChannelData(0);
      for (var i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
      var src = c.createBufferSource();
      var ng = c.createGain();
      var bp = c.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = opt.noise;
      bp.Q.value = 1.2;
      ng.gain.value = (opt.vol || 0.2) * 0.55;
      src.buffer = buf;
      src.connect(bp).connect(ng).connect(c.destination);
      src.start(t0);
    }
  }

  /* 连续摸头：音高随第几下微微上爬，蹭出爱心那一下更亮 */
  var patN = 0;
  /* 0号批「音效软萌化」:全部去硬起音/去噪声爆点/主音量 -20%,改水滴/泡泡/棉花系 */
  var SFX = {
    pat: function (big) {
      patN++;
      var step = Math.min(patN % 5, 4);
      var base = (big ? 660 : 500 + step * 40);
      tone({ f0: base, f1: base * 1.18, dur: 0.09, vol: 0.12, attack: 0.02 });
      if (big) tone({ f0: base * 1.5, f1: base * 1.7, dur: 0.14, vol: 0.07, delay: 0.05 });
    },
    poke: function () {
      tone({ f0: 300, f1: 520, dur: 0.06, vol: 0.15, type: 'sine', attack: 0.004 });
    },
    tail: function () {
      tone({ f0: 420, f1: 640, dur: 0.18, vol: 0.13, type: 'triangle', cut: 2000 });
    },
    annoyed: function () {
      tone({ f0: 210, f1: 170, dur: 0.22, vol: 0.12, type: 'triangle' });
    },
    drop: function () {
      tone({ f0: 130, f1: 85, dur: 0.14, vol: 0.16, attack: 0.02 });
      tone({ f0: 320, f1: 380, dur: 0.08, vol: 0.05, delay: 0.1 });
    },
    hiccup: function () {
      tone({ f0: 240, f1: 520, dur: 0.12, vol: 0.11 });
    },
    heart: function () {
      tone({ f0: 880, dur: 0.12, vol: 0.06 });
      tone({ f0: 1320, dur: 0.14, vol: 0.05, delay: 0.03 });
    },
    speakTick: function (energy) {
      /* 说话咕哝音(0号批·A案):软音节,与口型同一时间轴 */
      var base = 350 + Math.random() * 200;
      tone({ f0: base, f1: base * (0.92 + Math.random() * 0.16), dur: 0.09, vol: 0.05, type: 'triangle', cut: 1800 });
    }
  };

  window.NonoSfx = {
    play: function (name, arg) {
      try { if (SFX[name]) SFX[name](arg); } catch (e) {}
    },
    setEnabled: function (v) { enabled = !!v; },
    isEnabled: function () { return enabled; }
  };
})();
