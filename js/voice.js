/* 鲸诺海 · 说话的声音（任务 3）
 * 2026-11-06 · 6号
 *
 * 链路：DSH / 菜单说一句话
 *   → 主进程用本机 tools\tts 的 edge-tts 合成 mp3（同一个句子只合成一次，缓存在 userData\tts）
 *   → 渲染层 decodeAudioData 播放
 *   → AnalyserNode 每帧算 RMS，喂给 behavior.voiceLevel
 *   → behavior 用这个值驱动 ParamMouthOpenY（attack 快、release 慢，像真说话）
 *
 * 合成期间嘴先抿着等（petbox 的做法），合成失败再退回原来的随机音节口型。
 */
(function () {
  'use strict';

  var ctx = null, analyser = null, data = null, src = null;
  var behavior = null;
  var enabled = true;
  var cache = {};
  var speaking = false;
  var level = 0;

  function ensureCtx() {
    if (!ctx) {
      try {
        var AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        ctx = new AC();
        analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        analyser.smoothingTimeConstant = 0.6;
        data = new Uint8Array(analyser.fftSize);
        analyser.connect(ctx.destination);
      } catch (e) { return null; }
    }
    if (ctx.state === 'suspended') { try { ctx.resume(); } catch (e) {} }
    return ctx;
  }

  function rms() {
    if (!analyser || !data) return 0;
    analyser.getByteTimeDomainData(data);
    var sum = 0;
    for (var i = 0; i < data.length; i++) {
      var v = (data[i] - 128) / 128;
      sum += v * v;
    }
    return Math.sqrt(sum / data.length);
  }

  function stop() {
    speaking = false;
    if (src) { try { src.stop(); } catch (e) {} src = null; }
    if (behavior) behavior.voiceLevel = null;
  }

  function loop() {
    if (!speaking) {
      if (behavior) behavior.voiceLevel = null;
      return;
    }
    // 说话的音量映射：0.02 保底（嘴别完全闭死），0.85 封顶（别张到吓人）
    var target = Math.min(1, rms() * 3.4);
    var k = target > level ? 0.5 : 0.26;      // 张嘴快、闭嘴慢
    level += (target - level) * k;
    if (behavior) behavior.voiceLevel = Math.max(0.02, Math.min(0.85, level));
    requestAnimationFrame(loop);
  }

  function playBuffer(buf) {
    var c = ensureCtx();
    if (!c) return false;
    stop();
    level = 0;
    src = c.createBufferSource();
    src.buffer = buf;
    src.connect(analyser);
    speaking = true;
    src.onended = function () {
      speaking = false;
      src = null;
      setTimeout(function () {
        if (!speaking && behavior) behavior.voiceLevel = null;
      }, 160);
    };
    try { src.start(0); } catch (e) { speaking = false; return false; }
    requestAnimationFrame(loop);
    return true;
  }

  function fallbackMouth(text) {
    if (behavior) {
      try { behavior.startSay(text, 0); } catch (e) {}
    }
  }

  function speak(text) {
    text = String(text || '').trim();
    if (!enabled || !text) return;
    behavior = window.__nonoBehavior || null;
    if (!behavior) return;

    if (cache[text]) { playBuffer(cache[text]); return; }

    // 合成还没回来：先别乱动嘴（随机音节反而会抢先）
    behavior.sayPlan = null;
    behavior.speakUntil = 0;

    if (!window.NonoDesktop || !window.NonoDesktop.tts) { fallbackMouth(text); return; }
    window.NonoDesktop.tts(text).then(function (res) {
      if (!res || !res.ok || !res.audio) { fallbackMouth(text); return; }
      var raw;
      try { raw = atob(res.audio); } catch (e) { fallbackMouth(text); return; }
      var arr = new Uint8Array(raw.length);
      for (var i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
      var c = ensureCtx();
      if (!c) { fallbackMouth(text); return; }
      c.decodeAudioData(arr.buffer).then(function (buf) {
        cache[text] = buf;
        if (!playBuffer(buf)) fallbackMouth(text);
      }).catch(function () { fallbackMouth(text); });
    }, function () { fallbackMouth(text); });
  }

  window.NonoVoice = {
    speak: speak,
    stop: stop,
    setEnabled: function (v) { enabled = !!v; if (!enabled) stop(); },
    isEnabled: function () { return enabled; }
  };
})();
