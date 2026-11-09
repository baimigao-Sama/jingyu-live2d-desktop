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
/* 鲸诺海 · 主入口（网页版 / Electron 桌面版共用）
 * 依赖顺序见 index.html。模型配置用 models/nono.model3.json —— 它只是
 * 原 model3.json 的一份「加了表情/动作注册」的副本，原模型文件一个字节没动。
 */
(function () {
  'use strict';

  var Live2DModel = window.PIXI && window.PIXI.live2d && window.PIXI.live2d.Live2DModel;
  var statusEl = document.getElementById('status');
  var note = window.NONO_NOTE || function () {};
  var S = window.NonoStrings || {};
  var L = S.loading || {};

  if (S.window && S.window.title) document.title = S.window.title;

  function status(s) {
    if (statusEl && !window.NONO_DESKTOP) statusEl.textContent = s;
  }

  if (!Live2DModel) {
    note('Live2DModel 没挂上 —— 检查 lib/cubism4.min.js 是否加载');
    return;
  }

  // 0号第三轮任务四：缩放过滤显式设 LINEAR + mipmap ON（尾巴像素点排查步骤之一）
  try {
    window.PIXI.settings.SCALE_MODE = window.PIXI.SCALE_MODES.LINEAR;
    if (window.PIXI.MIPMAP_MODES) window.PIXI.settings.MIPMAP_TEXTURES = window.PIXI.MIPMAP_MODES.ON;
  } catch (e) {}

  var app = new window.PIXI.Application({
    backgroundAlpha: 0,
    resizeTo: window,
    antialias: true,
    autoDensity: true,
    resolution: Math.min(window.devicePixelRatio || 1, 2),
    preserveDrawingBuffer: true // petbox 同款:像素级智能穿透要用 readPixels 读透明度
  });
  // petbox 同款:Ctrl+滚轮调桌宠大小(0.5~2.0倍,session-only)
  var baseScale = 1;
  window.addEventListener('wheel', function (e) {
    if (!e.ctrlKey || !window.__nonoModel) return;
    e.preventDefault();
    baseScale = Math.max(0.5, Math.min(2.0, baseScale * (e.deltaY < 0 ? 1.06 : 1 / 1.06)));
    window.__nonoModel.scale.set(window.__nonoModel.scale.x / (window.__nonoModel.scale.x / baseScale));
  }, { passive: false });
  document.getElementById('stage').appendChild(app.view);
  window.__nonoApp = app;

  // petbox 同款·像素级智能穿透:鼠标下的像素透明→穿透,摸到她→可交互。
  // 40ms 节流;alpha>16 算摸到;经 IPC 让主进程切 setIgnoreMouseEvents。
  var lastPixCheck = 0, lastPixHit = null;
  window.addEventListener('mousemove', function (e) {
    var now2 = performance.now();
    if (now2 - lastPixCheck < 40) return;
    lastPixCheck = now2;
    try {
      // 0号督办任务2:鼠标在小蓝钮/回复卡上也算「摸到」——DOM 层不参与 canvas 透明度
      var tEl = document.elementFromPoint(e.clientX, e.clientY);
      var domHit = !!(tEl && tEl.closest && tEl.closest('.bubble-f, #reply-card'));
      var hit = domHit;
      if (!hit) {
        var view = app.view;
        var px = Math.round(e.clientX * (window.devicePixelRatio || 1));
        var py = view.height - Math.round(e.clientY * (window.devicePixelRatio || 1));
        var gl = app.renderer.gl;
        if (!gl) return;
        var buf = new Uint8Array(4);
        gl.readPixels(px, py, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, buf);
        hit = buf[3] > 16;
      }
      if (hit !== lastPixHit && window.NonoDesktop && window.NonoDesktop.pixelHit) {
        lastPixHit = hit;
        window.NonoDesktop.pixelHit(hit);
      }
    } catch (e2) {}
  });

  function layout(model) {
    // 注意：model.width/height 是「已缩放」的尺寸。这里必须除回当前缩放拿到
    // 原始尺寸，否则窗口第二次触发 resize 时会把缩放越乘越大（ intermittently
    // 变回 1.0 的元凶）。
    var w = model.width / (model.scale.x || 1);
    var h = model.height / (model.scale.y || 1);
    var sw = app.screen.width, sh = app.screen.height;
    var s;
    if (window.NONO_DESKTOP) {
      // 桌面窗口是固定的竖长条，按高度留一点边距
      s = Math.min((sw * 0.92) / w, (sh * 0.88) / h);
    } else {
      s = Math.min((sw * 0.42) / w, (sh * 0.66) / h);
    }
    model.scale.set(s);
    model.position.set(sw * 0.5, window.NONO_DESKTOP ? sh * 0.52 : sh * 0.62);
  }

  async function load() {
    status(L.main || '加载模型…');
    var slowTimer = setTimeout(function () {
      if (!window.__nonoReady) status(L.slow || '还在加载，再等一下…');
    }, 3000);
    var verySlowTimer = setTimeout(function () {
      if (!window.__nonoReady) status(L.very_slow || '还在加载…');
    }, 10000);
    var model = await Live2DModel.from('models/nono.model3.json', { autoInteract: false });
    app.stage.addChild(model);
    model.anchor.set(0.5, 0.5);

    // 0号《回信》+鲸语PR#2:尾巴等被遮挡部件的锯齿 = 裁剪蒙版缓冲只有256,
    // 一个蒙版纹素摊3~6个屏幕像素。官方 API 提到 2048(约16MB显存),一次设置。
    try {
      var im = model.internalModel || {};
      var renderer = im.renderer || im.cubismRenderer || null;
      if (renderer && typeof renderer.setClippingMaskBufferSize === 'function') {
        renderer.setClippingMaskBufferSize(2048);
        console.warn('[nono] 裁剪蒙版缓冲已提至2048(尾巴锯齿修复)');
      } else {
        console.warn('[nono] 未找到 renderer 入口,蒙版缓冲保持默认');
      }
    } catch (e) { console.warn('[nono] 蒙版缓冲设置失败:', e && e.message); }
    layout(model);
    window.__nonoModel = model;

    // 2026-11-06：不再自动播模型自带的 Idle。
    // 一是它是 6 秒循环的现成动作，会跟行为层的呼吸/眨眼/发呆抢参数；
    // 二是「宁可发呆，别匀速循环」——待机交给 behavior.js，动作只在被点名时播。

    var behavior = new window.NonoBehavior(model, app);
    behavior.start();
    window.__nonoBehavior = behavior;

    // 0号督办任务1:阶段气泡接进主循环(init 一次+每帧 tick;开关走 stage_bubbles_enabled)
    if (window.NonoStageBubbles) {
      window.NonoStageBubbles.init();
      app.ticker.add(function () {
        window.NonoStageBubbles.tick(app.ticker.deltaMS);
      });
    }

    // 互动层：摸头 / 戳戳 / 拖窗口 / 气泡与小心心
    if (window.NonoInteract) {
      window.__nonoInteract = new window.NonoInteract(model, app, behavior);
      // 主进程来的文字（first_run / 时段问候）借互动层的气泡冒出来
      behavior.bubbleFn = function (text, dur) {
        window.__nonoInteract.bubble(text, dur || 4200);
      };
      // 他回来了：静止 10 分钟以上再动 → 分档台词（0号：10分钟档/1小时档）
      behavior.onWelcome = function (awayMs) {
        var inter = window.__nonoInteract;
        if (!inter) return;
        var line = awayMs > 3600000 ? inter.t('returned_60', '你回来了')
          : inter.t('returned_10', '你回来啦');
        if (line) inter.bubble(line, 2200);
      };
      // 快速绕头一圈：被绕晕 → 嫌弃 → 黑脸（2026-11-07 参考 petbox）
      behavior.onCircleAngry = function () {
        if (window.__nonoInteract) window.__nonoInteract.bubble('绕、绕一圈想把我绕晕吗……', 2400);
        if (window.NonoSfx) window.NonoSfx.play('annoyed');
        if (window.NonoMood) window.NonoMood.pokeBad('被绕着转圈');
      };
      // 彩蛋：偷偷打了个小嗝
      behavior.onHiccup = function () {
        var T2 = (window.NonoStrings && window.NonoStrings.interact) || {};
        if (window.NonoSfx) window.NonoSfx.play('hiccup');
        if (T2.hiccup) window.__nonoInteract.bubble(T2.hiccup, 1400);
      };
      // 托盘切音效开关
      if (window.NonoDesktop && window.NonoDesktop.onSfx) {
        window.NonoDesktop.onSfx(function (v) {
          if (window.NonoSfx) window.NonoSfx.setEnabled(v);
        });
      }
      // 托盘切「说话出声」
      if (window.NonoDesktop && window.NonoDesktop.onTts) {
        window.NonoDesktop.onTts(function (v) {
          if (window.NonoVoice) window.NonoVoice.setEnabled(v);
        });
      }
      // 0号第三轮任务一：把 behavior 探测到的真实参数范围报给主进程
      if (window.NonoDesktop && window.NonoDesktop.sendCaps) {
        try { window.NonoDesktop.sendCaps(behavior.knownRanges()); } catch (e) {}
      }
    }

    var reportState = function () {
      if (window.NonoDesktop && window.NonoDesktop.mcpState) {
        window.NonoDesktop.mcpState(behavior.snapshot());
      }
    };
    window.NonoControlBridge.init(function (cmd) {
      behavior.applyCommand(cmd);
      reportState();
      // 0号台词库：error活动配「我看看」类气泡；react配被夸/被凶/吃醋台词
      if (window.__nonoInteract && cmd) {
        if (cmd.action === 'activity' && cmd.name === 'error') {
          var le = window.__nonoInteract.t('error');
          if (le) window.__nonoInteract.bubble(le, 1800);
        } else if (cmd.action === 'react' && cmd.mood) {
          var lr = window.__nonoInteract.t(cmd.mood);
          if (lr) window.__nonoInteract.bubble(lr, 1800);
        } else if (cmd.action === 'pat_auto') {
          window.__nonoInteract.autoPat();          // 右键菜单「摸摸头」
        } else if (cmd.action === 'say_something') {
          window.__nonoInteract.saySomething();     // 右键菜单「说句话」
        } else if (cmd.action === 'peek') {
          // 轻探针：主进程报来的前台窗口（只有进程名和标题，没有截图）
          if (window.__nonoInteract) window.__nonoInteract.onPeek(cmd.proc, cmd.title);
        } else if (cmd.action === 'fps') {
          // 帧率档位：'auto' 走原来的「空闲 30 / 活跃 60」，其它固定
          window.__nonoFpsCap = cmd.value === 'auto' ? 0 : (Number(cmd.value) || 0);
        } else if (cmd.action === '_touchall') {
          // 调试：直接触发一次「摸遍全身」的害羞表演（只在本地 WS 用，不暴露给 MCP）
          if (window.__nonoInteract) window.__nonoInteract.touchAll();
        } else if (cmd.action === '_zones') {
          // 调试：把分区网格写进 touch.jsonl（只在本地 WS 用，不暴露给 MCP）
          var it = window.__nonoInteract;
          if (it && window.NonoDesktop) {
            var bb = it.model.getBounds();
            var code = { head: 'h', neck: 'n', chest: 'c', belly: 'b', skirt: 's',
              hands: 'd', feet: 'f', legs: 'l', tail: 't', body: 'o' };
            var rows = [];
            for (var yy = 20; yy <= 600; yy += 20) {
              var row = '';
              for (var xx = 20; xx <= 400; xx += 20) row += (code[it.zoneAt(xx, yy)] || '-');
              rows.push(yy + ':' + row);
            }
            window.NonoDesktop.touchLog({ kind: 'zones',
              bounds: { x: bb.x, y: bb.y, w: bb.width, h: bb.height },
              canvas: { w: window.innerWidth, h: window.innerHeight }, rows: rows });
          }
        }
      }
    });
    // get_state 的数据源：每半秒同步一次（表情淡出、说完话这些自然变化也要跟上）
    reportState();
    setInterval(reportState, 500);

    /* 情绪账本（2026-11-07）：每 30 分钟记一笔「没人理」，情绪够了让她自己开口。
     * 静默时段（1-8 点）只记账不开口；两阵之间至少 25 分钟。 */
    setInterval(function () {
      if (!window.NonoMood || !window.__nonoBehavior) return;
      var it = window.__nonoInteract;
      var st = it && it.stats;
      var lastH = st && st.lastAt ? (Date.now() - st.lastAt) / 3600000 : 0;
      if (st && st.lastAt && lastH > 2) window.NonoMood.neglect();   // 没记录过就不记账
      var m = window.NonoMood.current();
      if (m.level < 0.5) return;
      var h = new Date().getHours();
      if (h >= 1 && h < 8) return;
      if (performance.now() - window.__nonoBehavior.lastMouseMove < 5000) return;
      if (!it || performance.now() < (it.moodSpeakAt || 0)) return;
      it.moodSpeakAt = performance.now() + 25 * 60000;
      var pool = {
        annoyed: ['哼……', '不理你了', '……（撇过头）'],
        sad: ['……你都不理我', '有点冷清……', '在忙吗'],
        happy: ['今天心情不错～', '嘿嘿'],
        shy: ['……有点害羞', '别、别一直看我'],
        close: ['……最喜欢你了', '今天想黏着你']
      }[m.mood];
      if (pool) it.bubble(pool[Math.floor(Math.random() * pool.length)], 2400);
    }, 60000);

    // 桌面版：主进程每 16ms 推一次「真实鼠标」的屏幕绝对坐标
    if (window.NonoDesktop && window.NonoDesktop.onCursor) {
      window.NonoDesktop.onCursor(function (d) {
        if (window.__nonoBehavior) {
          window.__nonoBehavior.setCursorAbsolute(d.x, d.y, d.w, d.h);
        }
      });
    }
    if (window.NonoDesktop && window.NonoDesktop.onInteractive) {
      window.NonoDesktop.onInteractive(function (v) {
        if (window.__nonoBehavior) window.__nonoBehavior.interactive = v;
      });
    }
    window.addEventListener('resize', function () {
      layout(model);
      if (window.__nonoBehavior) window.__nonoBehavior.noteLayout();
    });

    // petbox 同款:失焦降帧(高刷屏CPU三倍坑)
    window.addEventListener('blur', function () {
      if (window.__nonoApp && window.__nonoApp.ticker) window.__nonoApp.ticker.maxFPS = 15;
    });
    window.addEventListener('focus', function () {
      if (window.__nonoApp && window.__nonoApp.ticker) window.__nonoApp.ticker.maxFPS = 60;
    });

    // 0号第四优先②：运行时内存——页面隐藏停渲染；不活动降到 30fps（尾巴/裙摆别顿）
    var fpsTimer = setInterval(function () {
      if (!window.__nonoApp || !window.__nonoApp.ticker) return;
      if (document.hidden) { window.__nonoApp.ticker.maxFPS = 15; return; }
      var cap = window.__nonoFpsCap || 0;      // 0 = 自动（空闲 30 / 活跃 60）
      if (cap > 0) { window.__nonoApp.ticker.maxFPS = cap; return; }
      var idleMs = performance.now() - (window.__nonoBehavior ? window.__nonoBehavior.lastMouseMove : 0);
      window.__nonoApp.ticker.maxFPS = idleMs > 10000 ? 30 : 60;
    }, 1000);
    document.addEventListener('visibilitychange', function () {
      if (!window.__nonoApp || !window.__nonoApp.ticker) return;
      if (document.hidden) window.__nonoApp.ticker.stop();
      else window.__nonoApp.ticker.start();
    });

    clearTimeout(slowTimer);
    clearTimeout(verySlowTimer);
    status(window.NONO_DESKTOP ? '' : '鲸诺海在 (๑˘ ³˘๑)');
    window.__nonoReady = true;
    if (window.NonoDesktop && window.NonoDesktop.ready) window.NonoDesktop.ready();
  }

  load().catch(function (e) {
    console.error(e);
    var msg = e && e.message ? e.message : String(e);
    note('加载失败：' + msg);
    // 桌面模式状态栏是藏起来的——分类后交给主进程弹窗，她出事必须喊人
    if (window.NONO_DESKTOP && window.NonoDesktop && window.NonoDesktop.fatalError) {
      var key = 'unknown';
      var m = String(msg);
      if (/404|Failed to fetch|NetworkError|model3/i.test(m)) key = 'model_missing';
      else if (/moc3|version|版本/i.test(m)) key = 'model_version';
      else if (/json|parse|invalid/i.test(m)) key = 'model_broken';
      window.NonoDesktop.fatalError(key, m);
    }
  });
})();
