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
/* 鲸诺海 · 互动层（3 号新增）
 * 摸头、戳戳、拖窗口、气泡、小心心。
 *
 * 分区（相对模型包围盒）：
 *   头   —— 按住来回蹭 = 摸头；快速点一下 = 戳头
 *   身体 —— 点 = 吓一跳；桌面版按住拖 = 挪窗口
 *   尾巴 —— 点 = 她急了（尾巴是禁区）
 *   腿   —— 点 = 呜哇
 * 任何位置 900ms 内三连点 = 她烦了。
 *
 * 摸头有「好感度」：存在 localStorage，每摸够 10 下她会说句不一样的。
 */
(function () {
  'use strict';

  var clamp = function (v, a, b) { return Math.max(a, Math.min(b, v)); };

  var PAT_KEY = 'nono.patCount';
  var BUBBLES = {
    patMid:   ['呜……', '嗯……', '哼……'],
    patDone:  ['嘿嘿……', '舒服……', '再、再摸一下嘛'],
    patMax:   '……最喜欢你了',
    pokeHead: ['呜？', '干嘛啦', '别戳嘛'],
    body:     ['呀！', '别闹', '呜哇'],
    tail:     '尾、尾巴不行！',
    legs:     '呜哇！',
    neck:     ['痒……别弄那儿', '呜……脖子不行', '别挠嘛'],
    chest:    ['那、那里不行', '呜……别碰这儿', '你手放哪'],
    belly:    ['哈哈……痒', '别、别挠', '住手嘛～'],
    skirt:    ['裙、裙子不行', '呀！别掀', '护住护住'],
    feet:     ['脚、脚底不行', '呀！痒', '别碰那儿嘛'],
    hands:    ['手……牵手？', '唔……', '你握这么紧干嘛'],
    touchAll: ['……你、你摸遍全身了', '呜……别到处乱摸嘛', '全身都被你摸过了……', '不、不许再摸了！'],
    // 亲密度：隔了很久的第一下 / 今天已经被摸很多下的第一下
    affLongGap: ['你、你终于来了……', '还以为你今天不来了', '……等你好久了'],
    affClingy:  ['今天已经摸了好多下了……', '还、还要摸吗……', '黏人精……'],
    // 轻探针：知道主人在干什么（只读进程名+标题，不截图）
    peekEditor: ['又在写代码？', '这次要写多久呀', '记得喝口水'],
    peekGame:   ['又在打游戏……', '打完这局理理我嘛', '……玩的什么呀'],
    peekVideo:  ['在看什么？', '这个好看吗', '……我也想一起看'],
    peekBrowser:['在查东西吗？', '别看太久屏幕', '眼睛要休息'],
    angry:    '烦死了！'
  };
  // 亲密度：累计/今天/最常摸哪/连续天数（本地，删掉就当清零）
  var STATS_KEY = 'nono.touchStats';

  function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

  function NonoInteract(model, app, behavior) {
    this.model = model;
    this.app = app;
    this.behavior = behavior;
    // 连点排队：这一下演完，行为层把队列里的下一个还回来
    var self = this;
    behavior.onQueuedPoke = function (z) { self.doPoke(z); };

    this.down = null;          // {x, y, t, zone}
    this.patting = false;
    this.patDist = 0;
    this.patStrokes = 0;
    this.lastPatDir = 0;
    this.dragging = false;
    this.clickTimes = [];
    // 2026-11-07 小海：摸得太多 / 摸遍全身 → 害羞 + 左顾右盼。
    // pokeLog 只留最近 8 秒的触摸（zone 去重后算「摸过几个地方」）
    this.pokeLog = [];
    this.touchAllUntil = 0;     // 全身害羞表演期间，不再接新的戳
    this.lastDragZone = '';     // 拖动跨区时用来记「又摸到一个新地方」

    this.patCount = 0;
    try { this.patCount = parseInt(localStorage.getItem(PAT_KEY) || '0', 10) || 0; } catch (e) {}
    // 亲密度账本（2026-11-07 参考 petbox）：
    //   total 累计 / today 今天几下 / zones 最常摸哪 / days 连续天数 / lastAt 上次时间
    this.stats = { total: 0, today: 0, day: '', days: 0, lastDay: '', lastAt: 0, zones: {} };
    try {
      var st0 = JSON.parse(localStorage.getItem(STATS_KEY) || 'null');
      if (st0 && typeof st0 === 'object') this.stats = Object.assign(this.stats, st0);
    } catch (e) {}
    this.peekKind = '';           // 轻探针：当前前台窗口归类
    this.peekSpeakAt = 0;         // 主动开口节流（25 分钟一次）

    this.fx = document.getElementById('fx');
    this.bubbleEl = document.getElementById('bubble');
    this.bubbleTimer = 0;
    this.floatBubbles = [];

    // 互动台词走 strings.json（0号要求：字不许写死在代码里），BUBBLES 只当兜底
    this.T = (window.NonoStrings && window.NonoStrings.interact) || {};
    // 0号台词库抽卡：主台词走 bubble_pool，最近 5 句内不重复；BUBBLES 兜底
    this.BP = (window.NonoStrings && window.NonoStrings.bubble_pool) || {};
    this.recentLines = {};
    this.ambientNextAt = performance.now() + 600000;   // 自言自语：10分钟一次（小海定的）

    // 悬停反应（0号 3.1）：穿透模式下收不到鼠标事件，用 behavior 的全局光标
    this.hover = { zone: null, since: 0, fired: {} };
    this.hoverFrame = 0;
    this.app.ticker.add(this.checkHover, this);

    this.attach();

    // 0号方案B:热区双击(右键两下/左键双击都算)弹菜单——穿透时主进程临时放开热区
    var view = this.app.view;
    var this2Dbl = [];
    view.addEventListener('pointerdown', function (e) {
      if (e.button !== 2 || !self2Hotzone()) return;
      var n = performance.now();
      this2Dbl = this2Dbl.filter(function (t) { return n - t < 700; });
      this2Dbl.push(n);
      if (this2Dbl.length >= 2) {
        this2Dbl = [];
        if (window.NonoDesktop) window.NonoDesktop.contextMenu();
      }
    });
    view.addEventListener('dblclick', function (e) {
      if (self2Hotzone() && window.NonoDesktop) window.NonoDesktop.contextMenu();
    });
    function self2Hotzone() {
      var b = window.__nonoBehavior;
      return b && b.mouseY < 0.12 && b.mouseX > 0.35 && b.mouseX < 0.65;
    }

    // 回复卡:小海打字回给她(气泡+留痕);Enter 也发
    var card = document.getElementById('reply-card');
    var inp = document.getElementById('reply-input');
    var sendBtn = document.getElementById('reply-send');
    if (sendBtn && inp) {
      var self = this;   // 之前漏了这句,self 一直指到 window.self,发送必炸
      var doSend = function () {
        var v = inp.value.trim();
        if (!v) return;
        inp.value = '';
        var special = self.specialReply(v);
        self.bubble('小海：' + v, special ? 1800 : 3200);
        // 0号督办任务2:先存成文件(G:\任务中枢\待领\说话\时间戳.txt),DSH 后面再接
        if (window.NonoDesktop && window.NonoDesktop.writeSpeak) window.NonoDesktop.writeSpeak(v);
        if (window.NonoDesktop && window.NonoDesktop.touchLog) window.NonoDesktop.touchLog({ kind: 'reply', text: v, special: special || '' });
        if (special) setTimeout(function () { self.performSpecial(special); }, 260);
        self.closeReplyCard();
      };
      sendBtn.addEventListener('click', doSend);
      inp.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter') doSend();
        else if (ev.key === 'Escape') self.closeReplyCard();  // 输入框能关
      });
    }
  }

  /* 回复栏专属字眼：识别到就换成专属台词 + 表情 + 小动作 */
  var SPECIAL_WORDS = [
    { kind: 'baby', words: ['宝宝', '诺宝宝'] },
    { kind: 'love', words: ['爱你', '喜欢你', '好喜欢', '最喜欢你'] },
    { kind: 'praise', words: ['诺诺棒棒', '棒棒', '真棒', '厉害'] },
    { kind: 'kiss', words: ['亲亲', '么么', '啾', '亲一下'] },
    { kind: 'hug', words: ['抱抱', '贴贴', '抱紧', '抱一下'] },
    { kind: 'miss', words: ['想你了', '想你', '思念'] }
  ];
  NonoInteract.prototype.specialReply = function (text) {
    var s = String(text || '');
    for (var i = 0; i < SPECIAL_WORDS.length; i++) {
      var w = SPECIAL_WORDS[i];
      for (var j = 0; j < w.words.length; j++) {
        if (s.indexOf(w.words[j]) >= 0) return w.kind;
      }
    }
    return '';
  };
  NonoInteract.prototype.performSpecial = function (kind) {
    var b = this.behavior;
    if (!b) return;
    var all = (window.NonoStrings && window.NonoStrings.reply_special) || {};
    var fallback = ['……嗯。'];
    var line = this.t('reply_' + kind, all[kind] && all[kind].length ? all[kind] : fallback);
    var act = function (expr, preset, motion) {
      try { b.setExpression(expr, 1, false, 2600); } catch (e) {}
      if (preset && b.flashPreset) b.flashPreset(preset, 2600);
      if (motion && b.playMotion) b.playMotion(motion, 0, { resetPose: true });
      if (b.applyCommand) b.applyCommand({ action: 'look', target: 'user', duration_ms: 2400 });
    };
    switch (kind) {
      case 'baby': act('shy', '脸红'); break;
      case 'love': act('shy', '爱心眼', '默认手切举手'); break;
      case 'praise': act('happy', '爱心眼', '默认手切举手'); break;
      case 'kiss':
        act('shy', '脸红');
        if (b.tongue) b.tongue(650);
        break;
      case 'hug': act('happy', '脸红', '默认手切举手'); break;
      case 'miss': act('excited', '爱心眼', '默认手切举手'); break;
      default: act('happy', '', ''); break;
    }
    this.bubble(line, 3600);
  };

  /* 抽卡器（0号台词库第四节）：随机抽→记入最近队列→池内避开最近5句→全轮过一遍再洗 */
  NonoInteract.prototype.t = function (key, fallback) {
    var pool = this.BP[key];
    if (!pool || !pool.length) {
      pool = typeof fallback === 'string' ? [fallback] : fallback;
    }
    if (!pool || !pool.length) return '';
    var recent = this.recentLines[key] || (this.recentLines[key] = []);
    var cands = pool.filter(function (x) { return recent.indexOf(x) < 0; });
    if (!cands.length) { recent.length = 0; cands = pool; }
    var line = cands[Math.floor(Math.random() * cands.length)];
    recent.push(line);
    if (recent.length > 5) recent.shift();
    return line;
  };
  NonoInteract.prototype.tCount = function (key, n, fallback) {
    var v = this.T[key];
    if (typeof v !== 'string' || !v) return fallback;
    return v.replace('{n}', String(n));
  };

  /* ---------- 分区 ----------
   * 2026-11-07 多分区（学 chieri）：头/脖子/胸口/肚子/裙摆/手/腿/脚/尾巴。
   * 比例按 getBounds() 实测标定（420x620 画布下 bounds 约 x77.1 y49.6 w265.7 h545.6，
   * 比画出来的身体大一圈，所以不能拿画面的像素比例直接套）。
   * 白手套在裙摆两侧、又被蓝色尾鳍压着，所以「手」是 0.24–0.37 / 0.63–0.77 那一条，
   * 尾巴让到更外侧（<0.24 / >0.77），禁区还在，只是不再吃手套。
   */
  var ZONES = { head: 0.355, neck: 0.40, chest: 0.48, belly: 0.555, skirt: 0.70, feet: 0.89 };
  // 拆细以后，脖子/胸口/肚子/裙摆都算「身体」：被盯着看那套反应不能只残在原来的 body 缝里
  var BODYISH = { head: 1, body: 1, neck: 1, chest: 1, belly: 1, skirt: 1 };
  NonoInteract.prototype.zoneAt = function (x, y) {
    var b = this.model.getBounds();
    if (!b || b.width < 4) return null;
    if (x < b.x || x > b.x + b.width || y < b.y || y > b.y + b.height) return null;
    var fx = (x - b.x) / b.width, fy = (y - b.y) / b.height;
    // 先把两侧分掉：手（窄条，腰侧）和尾巴（更外侧）
    if (fy >= 0.48 && fy < 0.63) {
      if ((fx >= 0.24 && fx < 0.37) || (fx > 0.63 && fx <= 0.77)) return 'hands';
      if (fx < 0.24 || fx > 0.77) return 'tail';
    }
    if (fy >= 0.45 && fy < ZONES.skirt && (fx < 0.24 || fx > 0.77)) return 'tail';
    if (fy < ZONES.head) return (fx > 0.26 && fx < 0.74) ? 'head' : 'body';
    if (fy < ZONES.neck) return (fx > 0.30 && fx < 0.70) ? 'neck' : 'body';
    if (fy < ZONES.chest) return (fx > 0.26 && fx < 0.74) ? 'chest' : 'body';
    if (fy < ZONES.belly) return (fx > 0.28 && fx < 0.72) ? 'belly' : 'body';
    if (fy >= ZONES.feet) return (fx > 0.34 && fx < 0.66) ? 'feet' : 'body';
    if (fy < ZONES.skirt) return (fx > 0.22 && fx < 0.78) ? 'skirt' : 'body';
    if (fy < ZONES.feet) return 'legs';
    return 'body';
  };

  /* ---------- 气泡(petbox 同款:浮动可多颗,上飘+淡出;最多5颗) ----------
   * 0号督办任务2:她说的每颗气泡角上挂小蓝钮,点开=在桌宠窗口里直接打字;
   * 鼠标停在气泡上→暂停淡出,离开→接着淡。
   */
  NonoInteract.prototype.bubble = function (text, dur) {
    var el = document.createElement('div');
    el.className = 'bubble-f';
    el.textContent = text;
    var b = this.model.getBounds();
    if (b && b.width > 4) {
      el.style.left = Math.round(b.x + b.width * (0.08 + Math.random() * 0.55)) + 'px';
      el.style.top = Math.round(Math.max(8, b.y + b.height * 0.02 + Math.random() * 30)) + 'px';
    } else {
      el.style.left = '40px'; el.style.top = '60px';
    }
    var btn = document.createElement('button');
    btn.className = 'rbtn';
    btn.textContent = '回她';
    el.appendChild(btn);
    document.body.appendChild(el);
    var self = this;
    btn.addEventListener('click', function (ev) { ev.stopPropagation(); self.replyCard(); });
    var life = dur || 2600;
    function hide() { el.style.opacity = '0'; el.style.transition = 'opacity .5s'; }
    function gone() { if (el.parentNode) el.parentNode.removeChild(el); }
    var fadeT = setTimeout(hide, life);
    var goneT = setTimeout(gone, life + 600);
    el.addEventListener('mouseenter', function () {
      clearTimeout(fadeT); clearTimeout(goneT);
      el.style.animationPlayState = 'paused';
    });
    el.addEventListener('mouseleave', function () {
      el.style.animationPlayState = 'running';
      fadeT = setTimeout(hide, 900);
      goneT = setTimeout(gone, 1500);
    });
    var all = document.querySelectorAll('.bubble-f');
    if (all.length > 5) all[0].parentNode.removeChild(all[0]);
  };
  /* 回复卡(小海打字回给她):输入→气泡+存文件,事件留痕 */
  NonoInteract.prototype.replyCard = function () {
    var card = document.getElementById('reply-card');
    if (!card) return;
    card.style.display = 'block';
    // 卡开着时窗口保持可点,不然像素穿透把输入框让给桌面
    if (window.NonoDesktop && window.NonoDesktop.forceInteractive) window.NonoDesktop.forceInteractive(true);
    var inp = document.getElementById('reply-input');
    if (inp) { inp.value = ''; inp.focus(); }
  };
  NonoInteract.prototype.closeReplyCard = function () {
    var card = document.getElementById('reply-card');
    if (card) card.style.display = 'none';
    if (window.NonoDesktop && window.NonoDesktop.forceInteractive) window.NonoDesktop.forceInteractive(false);
  };

  /* ---------- 小心心 ---------- */
  NonoInteract.prototype.heart = function (x, y, big) {
    if (!this.fx) return;
    var el = document.createElement('div');
    el.className = 'heart' + (big ? ' big' : '');
    el.style.left = (x + (Math.random() * 36 - 18)) + 'px';
    el.style.top = (y + (Math.random() * 14 - 7)) + 'px';
    this.fx.appendChild(el);
    setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 1400);
  };

  /* ---------- 摸头 ---------- */
  NonoInteract.prototype.startPat = function (x, y) {
    this.patting = true;
    this.patDist = 0;
    this.patStrokes = 0;
    // 摸着的时候她开心：参数层微笑（挂住）+ 模型自带爱心眼 preset
    this.behavior.setExpression('happy', 0.9, true);
    try { this.model.expression('爱心眼'); } catch (e) {}
    this.heart(x, y, false);
  };
  NonoInteract.prototype.patMove = function (x, y, dx, dy) {
    this.patDist += Math.abs(dx) + Math.abs(dy);
    // 每蹭够一段算「一下」：冒心、头跟着歪
    if (this.patDist > 90) {
      this.patDist = 0;
      this.patStrokes++;
      this.patCount++;
      try { localStorage.setItem(PAT_KEY, String(this.patCount)); } catch (e) {}
      this.lastPatDir = dx >= 0 ? 1 : -1;
      var big = this.patStrokes % 5 === 0;
      this.heart(x, y, big);
      if (window.NonoSfx) window.NonoSfx.play('pat', big);
      this.behavior.idleAction = {
        name: '被摸头', dur: 0.4, t0: performance.now(),
        targets: { AngleZ: 7 * this.lastPatDir, AngleY: 4 }
      };
      if (this.patStrokes === 1) this.bubble(this.t('pat_start', pick(BUBBLES.patMid)), 1200);
      if (this.patStrokes === 3) this.bubble(this.t('pat_comfy', pick(BUBBLES.patDone)), 1200);
      if (this.patCount % 10 === 0) {
        this.bubble(this.patCount >= 50 ? this.t('pat_max', BUBBLES.patMax)
          : this.tCount('patCount', this.patCount, '已经摸了 ' + this.patCount + ' 下了……'), 2000);
      }
    }
  };
  NonoInteract.prototype.endPat = function (x, y) {
    this.patting = false;
    this.noteTouch('head');   // 摸头也算一次，凑够次数一样会害羞
    this.behavior.clearExpression();
    // 摸完了还回味一会儿：微笑慢慢淡掉，爱心眼再留一小段
    this.behavior.setExpression('happy', 0.8);
    var bhb = this.behavior;
    setTimeout(function () { bhb.resetPreset(); }, 1800);
    if (this.patStrokes >= 2) this.bubble(pick(BUBBLES.patDone), 1800);
    for (var i = 0; i < 3; i++) {
      setTimeout(function (xx, yy) { this.heart(xx, yy, false); }.bind(this, x, y), i * 160);
    }
  };

  /* ---------- 戳戳 ---------- */
  NonoInteract.prototype.poke = function (zone, x, y) {
    var b = this.behavior;
    var nowP = performance.now();
    b.lastMouseMove = nowP;
    // 2026-11-06 排查「点脖子出黑影」：每次戳都把关键参数打进日志，下次出现能对账
    try {
      console.warn('[poke] ' + zone + ' ' + JSON.stringify(b.snapshot().params));
    } catch (e0) {}
    var st = this.noteTouch(zone);
    if (nowP < this.touchAllUntil) return;   // 全身害羞表演中，先不理新的戳
    if (this.maybeTouchAll()) return;        // 这一下直接升级成「摸遍全身」
    // 连点不打断：上一个反应演完（约 0.95 秒）才接下一下，最多排 2 个
    if (b.pokeBusyUntil > nowP) {
      b.pokeQueue = b.pokeQueue || [];
      if (b.pokeQueue.length < 2) b.pokeQueue.push(zone);
      return;
    }
    this.doPoke(zone, x, y);
    // 亲密度：当天第一下的额外反应（放在分区反应之后，免得被覆盖）
    if (st && st.firstToday) {
      if (st.gapH > 6) {
        this.bubble(pick(BUBBLES.affLongGap), 2200);
        setTimeout(function () { b.setExpression('surprised', 0.6, false, 1200); }, 360);
      } else if (st.todayBefore >= 15) {
        this.bubble(pick(BUBBLES.affClingy), 2000);
        setTimeout(function () { b.setExpression('shy', 0.75, false, 1600); }, 360);
      }
    }
  };

  /* 记一次触摸（只留最近 8 秒，用来判断「摸多了」和「摸遍几个地方」） */
  NonoInteract.prototype.noteTouch = function (zone) {
    if (!zone || zone === 'body') return null;
    var now = performance.now();
    this.pokeLog.push({ t: now, zone: zone });
    while (this.pokeLog.length && now - this.pokeLog[0].t > 8000) this.pokeLog.shift();
    return this.bumpStats(zone);
  };

  /* 更新亲密度账本，返回「这是不是当天第一下、隔了多久、今天之前几下」 */
  NonoInteract.prototype.bumpStats = function (zone) {
    var s = this.stats;
    var today = new Date().toDateString();
    var firstToday = s.day !== today;
    var todayBefore = firstToday ? 0 : s.today;
    var gapH = s.lastAt ? (Date.now() - s.lastAt) / 3600000 : 999;
    if (firstToday) {
      if (s.day && s.lastDay === s.day) s.days++;
      else if (!s.day) s.days = 1;
      s.lastDay = today;
      s.day = today;
      s.today = 0;
    }
    s.total++; s.today++;
    s.zones[zone] = (s.zones[zone] || 0) + 1;
    s.lastAt = Date.now();
    try { localStorage.setItem(STATS_KEY, JSON.stringify(s)); } catch (e) {}
    if (window.NonoMood) window.NonoMood.onTouch(zone, firstToday, gapH);
    return { firstToday: firstToday, todayBefore: todayBefore, gapH: gapH, total: s.total };
  };

  /* 摸得越多越耐摸：翻脸阈值 3 → 4 → 5 下（petbox 同款思路） */
  NonoInteract.prototype.patThreshold = function () {
    var t = this.stats.total;
    return t >= 200 ? 5 : (t >= 80 ? 4 : 3);
  };

  /* ---------- 轻探针：主进程每 45 秒报一次前台窗口，只读进程名和标题 ---------- */
  NonoInteract.prototype.onPeek = function (proc, title) {
    var s = String(proc || '') + ' ' + String(title || '');
    var kind = '';
    if (/Code\.exe|Code - Insiders|devenv|idea64|webstorm|sublime|Trae|Cursor|Notepad|vim|rider|pycharm/i.test(s)) kind = 'editor';
    else if (/steam|game|League|Genshin|YuanShen|StarRail|battle\.net|epic/i.test(s)) kind = 'game';
    else if (/potplayer|vlc|mpv|bilibili|youtube|iqiyi|腾讯视频|爱奇艺|Netflix/i.test(s)) kind = 'video';
    else if (/chrome|msedge|firefox|brave|opera/i.test(s)) kind = 'browser';
    if (!kind) return;
    this.peekKind = kind;
    // 静默时段（凌晨 1-8 点）只记不开口
    var h = new Date().getHours();
    if (h >= 1 && h < 8) return;
    var b = this.behavior;
    if (performance.now() - b.lastMouseMove < 6000) return;   // 人就在跟前，别抢话
    if (performance.now() < this.peekSpeakAt) return;
    if (Math.random() > 0.55) return;                        // 不是每次都开口，免得像监控
    this.peekSpeakAt = performance.now() + 25 * 60000;
    var pool = BUBBLES['peek' + kind.charAt(0).toUpperCase() + kind.slice(1)] || BUBBLES.peekBrowser;
    this.bubble(pick(pool), 2600);
    b.idleAction = { name: '瞄一眼主人', dur: 0.6, t0: performance.now(),
      targets: { AngleX: 8, AngleY: 3, AngleZ: -3 } };
  };

  /* 8 秒内 ≥6 下，或者摸到 ≥5 个不同分区 → 触发一次「摸遍全身」 */
  NonoInteract.prototype.maybeTouchAll = function () {
    var now = performance.now();
    if (now < this.touchAllUntil) return false;
    var uniq = {}, uc = 0, k;
    for (var i = 0; i < this.pokeLog.length; i++) uniq[this.pokeLog[i].zone] = 1;
    for (k in uniq) if (Object.prototype.hasOwnProperty.call(uniq, k)) uc++;
    if (this.pokeLog.length < 6 && uc < 5) return false;
    this.pokeLog.length = 0;
    this.touchAll();
    return true;
  };

  /* 害羞 + 左顾右盼：轨迹和动作库里的「左顾右盼」一致，外面再叠害羞表情和脸红 */
  NonoInteract.prototype.touchAll = function () {
    var b = this.behavior;
    this.touchAllUntil = performance.now() + 28000;   // 28 秒内不触发第二次
    b.pokeQueue = [];
    b.pokeBusyUntil = performance.now() + 7200;       // 表演期间不接新的戳
    b.setExpression('shy', 1, false, 4200);
    if (b.flashPreset) b.flashPreset('脸红', 3200);
    b.applyCommand({ action: 'plan', interruptible: false, steps: [
      { at: 0, type: 'trajectory', duration: 6.6, frames: [
        { time: 0.0, values: { AngleX: 0, AngleY: 0, AngleZ: 0, PositionX: 0, LeanInput: -4 } },
        { time: 1.2, values: { AngleX: 22, AngleY: 2, AngleZ: -7, PositionX: 10, LeanInput: -7 } },
        { time: 2.6, values: { AngleX: 22, AngleY: 2, AngleZ: -7, PositionX: 10, LeanInput: -7 } },
        { time: 3.8, values: { AngleX: -20, AngleY: -4, AngleZ: 8, PositionX: -9, LeanInput: -9 } },
        { time: 5.2, values: { AngleX: -20, AngleY: -4, AngleZ: 8, PositionX: -9, LeanInput: -9 } },
        { time: 6.4, values: { AngleX: 0, AngleY: 0, AngleZ: 0, PositionX: 0, LeanInput: -3 } }
      ] }
    ]});
    if (window.NonoSfx) window.NonoSfx.play('pat');
    this.bubble(pick(BUBBLES.touchAll), 2800);
  };

  NonoInteract.prototype.doPoke = function (zone, x, y) {
    var b = this.behavior;
    b.pokeBusyUntil = performance.now() + 950;
    // 摸头/戳头偶尔吐下舌头，像图里那种小表情
    if (zone === 'head' && Math.random() < 0.18) b.tongue(700);
    switch (zone) {
      case 'head':
        b.triggerBlink(false);
        if (window.NonoSfx) window.NonoSfx.play('poke');
        b.idleAction = { name: '被戳头', dur: 0.5, t0: performance.now(),
          targets: { AngleZ: 6, AngleY: 3 } };
        this.bubble(this.t('pokeHead', pick(BUBBLES.pokeHead)));
        break;
      case 'body':
        if (window.NonoSfx) window.NonoSfx.play('poke');
        b.setExpression('surprised', 0.55);
        b.idleAction = { name: '被戳一缩', dur: 0.45, t0: performance.now(),
          targets: { ParamBodyAngleX: 4, AngleY: 2 } };
        this.bubble(this.t('pokeBody', pick(BUBBLES.body)));
        break;
      case 'tail': {
        // 0号想法③b：记仇——数次数，不靠随机。30秒没再点就消账
        var nowT = performance.now();
        if (nowT - b.tailLastAt > 30000) b.tailStrikes = 0;
        b.tailLastAt = nowT;
        b.tailStrikes++;
        if (nowT < b.tailHiddenUntil) {
          // 记仇期：尾巴已经卷起来藏好了，一碰就躲
          if (window.NonoSfx) window.NonoSfx.play('tail');
          b.idleAction = { name: '护住尾巴', dur: 0.6, t0: nowT,
            targets: { AngleY: 8, ParamBodyAngleX: 5 } };
          var lc = this.t('tail_calm', BUBBLES.tail);
          if (lc) this.bubble(lc, 1600);
          break;
        }
        if (b.tailStrikes >= 3) {
          // 第三次：真炸 + 把尾巴卷起来藏到身后（5分钟内一碰就躲）
          if (window.NonoSfx) window.NonoSfx.play('annoyed');
          if (window.NonoMood) window.NonoMood.pokeBad('尾巴被连着摸');
          b.setExpression('angry', 0.8, false, 2400);
          var l3 = this.t('tail_3', BUBBLES.angry);
          if (l3) this.bubble(l3, 2000);
          b.tailHiddenUntil = nowT + 5 * 60000;
          b.idleAction = { name: '卷尾巴藏起来', dur: 1.2, t0: nowT,
            targets: { Param_Angle_Rotation84: 30, Param_Angle_Rotation85: 26, Param_Angle_Rotation86: 20 } };
        } else if (b.tailStrikes === 2) {
          // 第二次：尾巴先抽开，回头瞪
          if (window.NonoSfx) window.NonoSfx.play('tail');
          b.setExpression('angry', 0.7, false, 1800);
          var l2 = this.t('tail_2', BUBBLES.tail);
          if (l2) this.bubble(l2, 1800);
          b.idleAction = { name: '回头瞪', dur: 1.0, t0: nowT,
            targets: { AngleX: 10, AngleY: 6, Param_Angle_Rotation84: -18 } };
        } else {
          // 第一次：黑脸 + 警告
          if (window.NonoSfx) window.NonoSfx.play('tail');
          try { this.model.expression('黑脸'); } catch (e) {}
          b.setExpression('angry', 0.55);
          var l1 = this.t('tail_1', BUBBLES.tail);
          if (l1) this.bubble(l1, 2000);
          setTimeout(function () { this.behavior.resetPreset(); }.bind(this), 2200);
        }
        break;
      }
      case 'neck':
        b.triggerBlink(false);
        if (window.NonoSfx) window.NonoSfx.play('poke');
        b.setExpression('shy', 0.6, false, 1600);
        b.idleAction = { name: '缩脖子', dur: 0.55, t0: performance.now(),
          targets: { AngleY: 6, LeanInput: 2, ParamBodyAngleX: 2 } };
        this.bubble(this.t('pokeNeck', BUBBLES.neck));
        break;
      case 'chest':
        b.triggerBlink(false);
        if (window.NonoSfx) window.NonoSfx.play('poke');
        b.setExpression('shy', 0.85, false, 2000);
        if (b.flashPreset) b.flashPreset('脸红', 2200);
        b.idleAction = { name: '护住胸口', dur: 0.9, t0: performance.now(),
          targets: { AngleY: 9, AngleZ: -4, ParamBodyAngleX: 4 } };
        this.bubble(this.t('pokeChest', BUBBLES.chest));
        break;
      case 'belly':
        if (window.NonoSfx) window.NonoSfx.play('poke');
        b.setExpression('happy', 0.6, false, 1200);
        b.idleAction = { name: '痒得缩一下', dur: 0.45, t0: performance.now(),
          targets: { AngleZ: 5, AngleY: 3, ParamBodyAngleX: -3, LeanInput: 2 } };
        this.bubble(this.t('pokeBelly', BUBBLES.belly));
        break;
      case 'skirt':
        if (window.NonoSfx) window.NonoSfx.play('tail');
        b.setExpression('surprised', 0.7, false, 900);
        b.idleAction = { name: '护住裙摆', dur: 0.7, t0: performance.now(),
          targets: { AngleX: 5, AngleY: 10, ParamBodyAngleX: 5 } };
        this.bubble(this.t('pokeSkirt', BUBBLES.skirt));
        break;
      case 'hands':
        b.triggerBlink(false);
        if (window.NonoSfx) window.NonoSfx.play('pat');
        b.setExpression('shy', 0.65, false, 2000);
        this.heart(x, y, false);
        b.idleAction = { name: '被牵手', dur: 0.8, t0: performance.now(),
          targets: { AngleZ: 4, AngleY: 4, ParamEyeBallX: -0.2 } };
        this.bubble(this.t('pokeHands', BUBBLES.hands));
        break;
      case 'feet':
        if (window.NonoSfx) window.NonoSfx.play('poke');
        b.setExpression('shy', 0.5, false, 1400);
        this.heart(x, y, false);
        b.idleAction = { name: '缩脚', dur: 0.6, t0: performance.now(),
          targets: { AngleY: 8, LeanInput: 2, AngleZ: 3 } };
        this.bubble(this.t('pokeFeet', BUBBLES.feet));
        break;
      case 'legs':
        b.triggerBlink(false);
        if (window.NonoSfx) window.NonoSfx.play('poke');
        this.bubble(this.t('pokeLegs', BUBBLES.legs));
        break;
    }
  };

  /* ---------- 事件 ---------- */
  NonoInteract.prototype.attach = function () {
    var self = this;
    var view = this.app.view;

    view.addEventListener('pointerdown', function (e) {
      // petbox 同款:点触留痕(谁在什么时候摸了她)——256KB 自动轮转
      if (window.NonoDesktop && window.NonoDesktop.touchLog) {
        window.NonoDesktop.touchLog({ zone: self.zoneAt(e.clientX, e.clientY), x: e.clientX, y: e.clientY, button: e.button });
      }
      if (window.NONO_DESKTOP && !self.behavior.interactive) return; // 穿透时轮不到我们
      if (e.button !== 0) return;   // 右键/中键留给菜单，摸头只认左键
      var zone = self.zoneAt(e.clientX, e.clientY);
      // alt = 这一下是「按住 Alt 拖动」：平时点她只做互动，不再误拖窗口
      self.down = { x: e.clientX, y: e.clientY, t: performance.now(), zone: zone, alt: e.altKey };
      self.patDist = 0;
      if (zone === 'head') self.startPat(e.clientX, e.clientY);
    });
    // 0号第三轮任务三：右键弹菜单（可交互模式下；穿透模式收不到右键，走托盘同款菜单）
    view.addEventListener('contextmenu', function (e) {
      e.preventDefault();
      if (window.NonoDesktop && window.NonoDesktop.contextMenu) window.NonoDesktop.contextMenu();
    });

    view.addEventListener('pointermove', function (e) {
      if (!self.down) return;
      var dx = e.clientX - (self.lastPX === undefined ? e.clientX : self.lastPX);
      var dy = e.clientY - (self.lastPY === undefined ? e.clientY : self.lastPY);
      self.lastPX = e.clientX; self.lastPY = e.clientY;
      var moved = Math.abs(e.clientX - self.down.x) + Math.abs(e.clientY - self.down.y);

      if (self.patting) {
        // 摸着的时候手稍微滑出头区很正常，不中断；只有离开画布才收尾（pointerleave）
        self.patMove(e.clientX, e.clientY, dx, dy);
      } else if (moved > 8 && self.down.alt && window.NONO_DESKTOP && self.behavior.interactive && self.down.zone !== 'head') {
        // 按住 Alt + 拖 = 挪窗口（2026-11-07 参考 petbox：平时怎么摸都不会把窗口拖走）
        if (!self.dragging && window.NonoDesktop && window.NonoDesktop.dragStart) {
          self.dragging = true;
          window.NonoDesktop.dragStart();
          self.behavior.startDrag();
        }
        if (self.dragging) {
          // 拖着她划过不同区域也算「摸过」——用于摸遍全身的判定
          var dz = self.zoneAt(e.clientX, e.clientY);
          if (dz && dz !== self.lastDragZone) { self.lastDragZone = dz; self.noteTouch(dz); }
          // 拖动的身体感：速度快时她往反方向歪
          self.behavior.dragLean(clamp((dx || 0) / 22, -1, 1));
        }
      }
    });

    var up = function (e) {
      if (!self.down) { self.lastPX = self.lastPY = undefined; return; }
      var d = self.down;
      self.down = null;
      self.lastPX = self.lastPY = undefined;
      if (self.dragging) {
        self.dragging = false;
        self.lastDragZone = '';
        self.behavior.endDrag();
        if (window.NonoSfx) window.NonoSfx.play('drop');
        if (Math.random() < 0.3) self.bubble(self.t('dragDrop', '站稳啦'), 1400);
        if (window.NonoDesktop && window.NonoDesktop.dragEnd) window.NonoDesktop.dragEnd();
        return;
      }
      var moved = Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y);
      var dt = performance.now() - d.t;
      if (self.patting) {
        self.patting = false;
        if (self.patStrokes === 0 && moved < 8 && dt < 350) {
          // 没蹭动 = 戳头：把摸头的开心收干净，换成被戳的反应
          self.behavior.clearExpression();
          self.behavior.resetPreset();
          self.poke('head', e.clientX, e.clientY);
        } else {
          self.endPat(e.clientX, e.clientY);
        }
        return;
      }
      if (moved < 8 && dt < 350 && d.zone) {
        // 三连点 = 烦；否则按分区戳
        var now = performance.now();
        self.clickTimes = self.clickTimes.filter(function (t) { return now - t < 900; });
        self.clickTimes.push(now);
        // 摸得越多越耐摸：阈值 3 → 4 → 5 下
        if (self.clickTimes.length >= self.patThreshold()) {
          self.clickTimes = [];
          if (window.NonoSfx) window.NonoSfx.play('annoyed');
          if (window.NonoMood) window.NonoMood.pokeBad('被连着戳');
          self.behavior.setExpression('angry', 0.7);
          self.bubble(self.t('annoyed', BUBBLES.angry), 1800);
        } else {
          self.poke(d.zone, e.clientX, e.clientY);
        }
      }
    };
    view.addEventListener('pointerup', up);
    view.addEventListener('pointercancel', up);
    view.addEventListener('pointerleave', function (e) {
      if (self.patting) { self.endPat(e.clientX, e.clientY); self.down = null; }
      if (self.dragging) {
        self.dragging = false;
        if (window.NonoDesktop && window.NonoDesktop.dragEnd) window.NonoDesktop.dragEnd();
      }
    });
  };

  /* 右键菜单「摸摸头」：自动摸三下（冒心+音效），然后收手回味 */
  NonoInteract.prototype.autoPat = function () {
    var b = this.model.getBounds();
    if (!b || b.width < 4) return;
    var x = b.x + b.width * 0.5, y = b.y + b.height * 0.15;
    this.startPat(x, y);
    var self = this, n = 0;
    var iv = setInterval(function () {
      n++;
      self.patMove(x + (n % 2 ? 50 : -50), y, 100, 0);
      if (n >= 3) { clearInterval(iv); self.endPat(x, y); }
    }, 350);
  };

  /* 右键菜单「说句话」：全池随机 + 最近5句不重复 */
  NonoInteract.prototype.saySomething = function () {
    var all = [];
    for (var k in this.BP) if (Array.isArray(this.BP[k])) all = all.concat(this.BP[k]);
    if (!all.length) {
      for (var k2 in BUBBLES) {
        var v = BUBBLES[k2];
        if (Array.isArray(v)) all = all.concat(v);
        else if (typeof v === 'string') all.push(v);
      }
    }
    if (!all.length) return;
    var recent = this.recentLines._say || (this.recentLines._say = []);
    var cands = all.filter(function (x) { return recent.indexOf(x) < 0; });
    if (!cands.length) { recent.length = 0; cands = all; }
    var line = cands[Math.floor(Math.random() * cands.length)];
    recent.push(line);
    if (recent.length > 5) recent.shift();
    this.bubble(line, 2600);
    // 任务3：说句话也要真出声（先排音节口型兜底，TTS 音频一到就用音频驱动）
    this.behavior.startSay(line, 2600);
    if (window.NonoVoice) window.NonoVoice.speak(line);
  };

  /* ---------- 悬停反应（0号 3.1）----------
   * 穿透时 canvas 收不到鼠标事件，所以用 behavior 的全局光标（主进程 16ms 推）。
   * 原则：有反应但不过分，同一轮停留每种只触发一次，移开就重置。
   */
  NonoInteract.prototype.checkHover = function () {
    // 节流到 ~100ms 一次
    if (++this.hoverFrame % 6 !== 0) return;
    var b = this.behavior;
    if (!b || !this.model) return;

    // 自言自语（小海定的：10分钟一次，深夜用0号的night池，白天借时段问候）
    var nowA = performance.now();
    var idleA = nowA - b.lastMouseMove;
    if (idleA > 600000 && nowA > this.ambientNextAt && b.sleepState !== 'asleep' && !b.dragging) {
      this.ambientNextAt = nowA + 600000;
      var hA = new Date().getHours();
      var lineA = '';
      if (hA < 5) lineA = this.t('night_3');
      else if (hA >= 22 || hA < 3) lineA = this.t('night_0');
      else {
        var tg = (window.NonoStrings && window.NonoStrings.time_greeting) || {};
        lineA = tg[hA < 10 ? 'morning' : hA < 14 ? 'noon' : hA < 21 ? 'evening' : 'night'] || '';
      }
      if (lineA) this.bubble(lineA, 3200);
    }

    if (b.dragging) { this.hover.zone = null; return; }

    var x = b.mouseX * window.innerWidth;
    var y = b.mouseY * window.innerHeight;
    var zone = this.zoneAt(x, y);
    var now = performance.now();

    if (zone !== this.hover.zone) {
      this.hover.zone = zone;
      this.hover.since = zone ? now : 0;
      this.hover.fired = {};
      return;
    }
    if (!zone || !this.hover.since) return;
    var held = now - this.hover.since;

    // 0号台词分档：被盯看的秒数各冒一次（3秒/20秒；5秒随躲闪、8秒随偷瞄）
    if (BODYISH[zone]) {
      if (held > 3000 && held < 5000 && !this.hover.fired.s3) {
        this.hover.fired.s3 = true;
        var q3 = this.t('stared_3');
        if (q3) this.bubble(q3, 1500);
      }
      if (held > 20000 && !this.hover.fired.s20) {
        this.hover.fired.s20 = true;
        var q20 = this.t('stared_20');
        if (q20) this.bubble(q20, 2200);
      }
    }

    // 0号想法③a：她会「偷看」——假装没注意→突然对视→慌张躲开（10秒一遇）
    if (BODYISH[zone] && held > 10000 && !this.hover.fired.peek) {
      this.hover.fired.peek = true;
      var self2 = this;
      b.lookMode = 'away'; b.lookUntil = now + 1200;          // 1) 假装没注意
      setTimeout(function () {
        b.lookMode = null; b.lookUntil = 0;                    // 2) 突然抬眼对上
        b.setExpression('surprised', 0.35, false, 500);
        setTimeout(function () {                               // 3) 慌慌张张躲开
          b.setExpression('shy', 0.55, false, 1800);
          b.lookMode = 'away'; b.lookUntil = performance.now() + 1300;
          var q8 = self2.t('stared_8');
          if (q8) self2.bubble(q8, 1600);
        }, 700);
      }, 1300);
      return;
    }

    // 停在头顶 2 秒 → 害羞：眼珠向上、头微低、脸颊红
    if (zone === 'head' && held > 2000 && !this.hover.fired.head) {
      this.hover.fired.head = true;
      b.setExpression('shy', 0.6, false, 3000);
      try { this.model.expression('脸红'); } catch (e) {}
      var b1 = this.behavior;
      setTimeout(function () { b1.resetPreset(); }, 3200);
      return;
    }

    // 被盯着看 8 秒（害羞完了）→ 先把视线躲开，1.5 秒后再偷偷瞄回来
    if (zone === 'head' && held > 8000 && !this.hover.fired.dodge) {
      this.hover.fired.dodge = true;
      b.lookMode = 'away';
      b.lookUntil = now + 1500;
      b.setExpression('shy', 0.4, false, 2600);
      var q5 = this.t('stared_5');
      if (q5) this.bubble(q5, 1600);
      return;
    }

    // 停在脖子上 1.5 秒 → 缩脖子害羞（拆细分区后补的小反应）
    if (zone === 'neck' && held > 1500 && !this.hover.fired.neck) {
      this.hover.fired.neck = true;
      b.setExpression('shy', 0.55, false, 1800);
      b.idleAction = { name: '缩脖子', dur: 0.5, t0: now,
        targets: { AngleY: 6, LeanInput: 2 } };
      return;
    }

    // 停在她身上 30 秒 → 她反过来盯着你，像在问「你要干嘛」
    if (BODYISH[zone] && held > 30000 && !this.hover.fired.stare) {
      this.hover.fired.stare = true;
      b.setExpression('shy', 0.5, false, 4000);
      b.idleAction = { name: '盯着你', dur: 1.2, t0: now,
        targets: { AngleY: 5, ParamEyeBallX: 0.15 } };
      return;
    }

    // 停在尾巴上 1.5 秒 → 尾巴先抽开，然后她回头看自己的尾巴，一脸无辜
    if (zone === 'tail' && held > 1500 && !this.hover.fired.tail) {
      this.hover.fired.tail = true;
      b.idleAction = { name: '尾巴抽开', dur: 0.7, t0: now,
        targets: { Param_Angle_Rotation84: -20, Param_Angle_Rotation85: -14 } };
      var self = this;
      setTimeout(function () {
        self.behavior.idleAction = { name: '回头看尾巴', dur: 1.6, t0: performance.now(),
          targets: { AngleX: 9, AngleY: 8, ParamEyeBallX: 0.5, ParamEyeBallY: 0.35 } };
      }, 800);
      return;
    }
  };

  window.NonoInteract = NonoInteract;
})();
