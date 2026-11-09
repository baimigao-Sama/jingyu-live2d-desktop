/* ============================================================
 * 鲸诺海 · 桌面 Live2D 形象（nono-live2d-desktop）
 * Copyright (c) 2026 白米糕-Sama / 鲸诺海。保留所有权利。
 *
 * 授权：PolyForm Noncommercial License 1.0.0（开源发行版）
 *   允许：非商业使用、修改、分发（分发须带上本许可与 Required Notice）
 *   禁止：任何商业用途
 * 模型素材版权归原作者（神宫凉子 / 霓虹猫_NeonNeko），不在本许可内。
 * 完整条款见 LICENSE.txt；作者自用版见 LICENSE-作者自用版.txt。
 * ============================================================ */
/* 鲸诺海 · 本地情绪账本（2026-11-07）
 *
 * 参考 petbox 的「一本账」思路，去掉 DSH 会话依赖，做成脱机版：
 *   1. 每种情绪有自己的半衰期，没人碰会自己消
 *   2. 记「因为什么」——不是随机抽风
 *   3. 被摸一下能把委屈/不痛快当场清账
 *
 * 存 localStorage，删掉就当清零。
 */
(function () {
  'use strict';

  var KEY = 'nono.mood';
  // 半衰期（小时）+ 对应的语义表情
  var PROFILE = {
    happy:   { halfLife: 2,   expr: 'happy', label: '开心' },
    shy:     { halfLife: 1,   expr: 'shy',   label: '害羞' },
    annoyed: { halfLife: 6,   expr: 'angry', label: '不痛快' },
    sad:     { halfLife: 6,   expr: 'sad',   label: '有点委屈' },
    close:   { halfLife: 240, expr: 'smile', label: '亲近' }
  };
  var s = { mood: 'neutral', since: 0, level: 0, cause: '', lastTouch: 0 };

  function load() {
    try {
      var v = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (v && typeof v === 'object') s = Object.assign(s, v);
    } catch (e) {}
  }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch (e) {} }

  function decayed(now) {
    if (!s.mood || s.mood === 'neutral') return { mood: 'neutral', level: 0 };
    var p = PROFILE[s.mood];
    if (!p) return { mood: 'neutral', level: 0 };
    var ageH = (now - (s.since || now)) / 3600000;
    var level = (s.level || 0) * Math.pow(0.5, ageH / p.halfLife);
    if (level < 0.08) return { mood: 'neutral', level: 0 };
    return { mood: s.mood, level: level };
  }

  function set(mood, level, cause) {
    s.mood = mood;
    s.level = Math.max(0, Math.min(1, level));
    s.since = Date.now();
    s.cause = cause || '';
    save();
    var b = window.__nonoBehavior;
    if (b && PROFILE[mood]) {
      try { b.setExpression(PROFILE[mood].expr, Math.min(1, s.level), false, 4200); } catch (e) {}
    }
  }

  window.NonoMood = {
    current: function () { return decayed(Date.now()); },
    label: function () {
      var d = decayed(Date.now());
      return d.mood === 'neutral' ? '平静' : (PROFILE[d.mood] ? PROFILE[d.mood].label : '平静');
    },
    cause: function () { return s.cause || ''; },
    level: function () { return decayed(Date.now()).level; },

    /* 被摸：委屈/不痛快当场清账；隔久了的第一下变成「亲近」 */
    onTouch: function (zone, firstToday, gapH) {
      s.lastTouch = Date.now();
      var d = decayed(Date.now());
      if (d.mood === 'annoyed' || d.mood === 'sad') {
        set('neutral', 0, '');
        return;
      }
      if (gapH > 6) { set('close', 0.55, '好久没见，被摸了一下'); return; }
      var lv = d.mood === 'close' ? Math.min(1, d.level + 0.12) : 0.5;
      set('happy', lv, zone === 'head' ? '被摸了头' : '被摸了摸');
    },

    /* 被闹烦（三连点 / 摸尾巴 / 绕圈） */
    pokeBad: function (cause) { set('annoyed', 0.8, cause || '被闹烦了'); },

    /* 长时间没人理：攒委屈，最多到 1 */
    neglect: function () {
      var d = decayed(Date.now());
      if (d.mood === 'annoyed') return;
      var base = d.mood === 'sad' ? d.level : 0;
      set('sad', Math.min(1, 0.35 + base * 1.5), '好久没人理');
    }
  };

  load();
  // 从没被摸过却挂着「委屈/不痛快」= 旧账，清掉，第一次见面不该是生气的
  if (!s.lastTouch && (s.mood === 'sad' || s.mood === 'annoyed')) {
    s.mood = 'neutral'; s.level = 0; s.cause = ''; save();
  }
})();
