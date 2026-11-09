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
/* 鲸诺海 · 行为系统（3 号接手版）
 * 依据：《行为设计-诺诺桌面形象.md》
 * 原则：一切不匀速。宁可发呆，别像机器。
 *
 * 相对 2 号（豆包）版本修掉的三处硬伤：
 *   1. mouseActive 是个只升不降的布尔 → 鼠标停住后永远不回正、不飘眼、不打呵欠
 *   2. 表情结束后只清了 key* 开关，其它参数（歪头、嘴角）会一直挂着
 *   3. mouth 指令是常量张嘴，像广播体操；改成有停顿、有随机的说话节奏
 * 另补：状态机十态、motion、互动层、彩蛋、桌面全局光标的时间戳判定。
 */
(function () {
  'use strict';

  var rand = function (a, b) { return a + Math.random() * (b - a); };
  var clamp = function (v, a, b) { return Math.max(a, Math.min(b, v)); };

  // 语义表情 → 参数目标。参数名已逐个对过 大肥鱼.cdi3.json（509 个）。
  // 模型自带的 Exp3 是 key1~13 开关，用于 preset 指令，不与这里混用，
  // 免得 expressionManager 每帧覆盖参数。
  // 2026-11-06 · 6号：脱捕不再禁。
  // 它以前根本播不出来——nono.model3.json 的 Motions 在顶层，pixi-live2d-display
  // 只读 FileReferences.Motions。把 Motions 挪进去之后逐帧截图验证：
  // 0.3/1/3/5/6/8/9/10.5/11/13 秒，蒙版 256 与 2048，都没有黑影。
  // 真正让画面发黑的从来不是这个动作，是「动作没注册 + 各层参数互相覆盖」。
  var MOTION_DUR = {   // 秒，从 motion3.json 的 Meta.Duration 读出来，写死一份省得每帧解析
    'IDLE': 5.983, 'Idle': 5.983,
    '举手切默认手': 1.017, '默认手切举手': 1.133,
    '狗尾草切换出来': 1.233, '狗尾草切回默认手': 1.133,
    '竖手指切出来动画': 1.25, '竖手指切回默认': 1.25,
    '脱捕': 13.15
  };
  // 动作结束后要放回默认的「动作专用参数」——不然她会一直张着嘴、手扭着
  var MOTION_RESIDUE = ['JawOpen', 'Param11', 'Param55', 'Param56', 'Param57', 'Param58',
    'Param36', 'Param39', 'Param40', 'Param41', 'Param42', 'Param43',
    // 左臂和右臂是两套参数，以前只收右臂，左臂会卡在「举手切默认手」留下的 0
    'Param59', 'Param60', 'Param61', 'Param62'];
  // 每个动作会占用哪一个「手势」参数。模型作者的 Movement1/2/3 是单选的，
  // 两个同时停在 1 会把手折到一起（看起来像手臂没了）。播新动作前清掉另外两个。
  var MOTION_POSE = {
    '默认手切举手': ['Movement2'], '举手切默认手': ['Movement2'],
    '狗尾草切换出来': ['Movement1', 'Movement3'], '狗尾草切回默认手': ['Movement1', 'Movement3'],
    '竖手指切出来动画': ['Movement1', 'Movement3'], '竖手指切回默认': ['Movement1', 'Movement3'],
    '脱捕': ['Movement1']
  };
  var MOVEMENT_IDS = ['Movement1', 'Movement2', 'Movement3'];
  // 「切回默认手」类动作演完必须把姿势和胳膊形变一起还原，不然手会卡没
  var RETURN_MOTIONS = {
    '举手切默认手': 1, '狗尾草切回默认手': 1, '竖手指切回默认': 1
  };
  // 手势姿势自带的胳膊形变；姿势还在时不能按默认值清零，不然两只手会叠一起
  // 右臂 36/39/40/41/42/43 + 左臂 59/60/61/62，左右必须成对收，少一边就会「没手」
  var ARM_DEFORM = ['Param36', 'Param39', 'Param40', 'Param41', 'Param42', 'Param43',
    'Param59', 'Param60', 'Param61', 'Param62', 'LArm'];
  // 2026-11-07 定稿 v2（小海反馈：左手要到裙前、手心像右手，且启动后不能自己往前跑）：
  //  - LArm 范围只有 ±1。原来写 2 会被夹到 1，settleArms 一路拉到 1 —— 就是「启动瞬间手在后面、
  //    然后跑到前面」的漂移来源。现在固定 0.5：手露在身侧、手臂还贴着身体，位移只有半格。
  //  - 试过 LForearm / LHand / LWrist / Param44 / Param60：都只能把左手送到裙边或翻不出来，
  //    「到裙前 + 手心同右手」这套 rig 做不到，就用 0.5。
  //  - 【5号撤回记录 18:4x】v3 曾试过大臂Z(Param36/62)=-1 贴身：静止态截图好看，但真实使用里
  //    动作播完（切回默认手/竖手指等）和它叠加会把手折进身体=「没手」。已整体撤回此线，等把
  //    「每个动作播完后的叠加态」全截图验过一遍再议。
  // 2026-11-07 定稿 v5（小海：双手要藏在裙子后面、手指朝下、掌心朝正确方向）：
  //  手臂全部回作者默认（全 0）——大臂/小臂/手腕都不钉，手套自然垂在裙后，
  //  运动时由 physics3 带着跟身体、跟头走（大臂 LArm 本来就是物理输出）。
  var LEFT_HAND_BASE = { Param59: 0, Param60: 0, Param61: 0, Param62: 0, LArm: 0 };
  var RIGHT_HAND_BASE = {};
  var IDLE_HAND_M2 = 0;
  // 0号定的映射表:语义表情 → 叠预设 + 配动作(只走 MCP/菜单路径,互动层自管)
  // 自查修复:表情幅度放大1.4倍(小海:表情看不出来)——在目标值乘完后统一放大
  var EXPR_BOOST = 1.4;
  var PRESET_FOR = { happy: '爱心眼', excited: '爱心眼', sad: '流泪', surprised: '圈圈眼', serious: '单片眼镜', shy: '脸红', angry: '黑脸' };
  var MOTION_FOR = { happy: '默认手切举手', excited: '竖手指切出来动画' };
  var EXPRESSIONS = {
    idle:      function () { return {}; },
    thinking:  function (i) { return { ParamEyeBallY: -0.35 * i, AngleZ: 6 * i, ParamBrowInnerUp: 0.35 * i }; },
    typing:    function (i) { return { ParamEyeBallY: 0.15 * i, ParamMouthOpenY: 0.12 * i }; },
    happy:     function (i) { return { EyeSmile: 0.65 * i, ParamMouthForm: 0.5 * i, AngleZ: 3 * i }; },
    smile:     function (i) { return { EyeSmile: 0.6 * i, ParamMouthForm: 0.45 * i, AngleZ: 2 * i }; },
    shy:       function (i) { return { key7: 1 * i, ParamEyeBallY: 0.35 * i, AngleZ: 9 * i, ParamMouthForm: -0.2 * i }; },
    sad:       function (i) { return { ParamBrowLY: -0.35 * i, ParamBrowRY: -0.35 * i, ParamMouthForm: -0.45 * i, eyeBase: 1 - 0.08 * i }; },
    serious:   function (i) { return { EyeSmile: -0.2 * i, ParamMouthForm: -0.15 * i, AngleY: 2 * i }; },
    sleepy:    function (i) { return { eyeBase: 1 - 0.3 * i, ParamEyeBallY: 0.3 * i, AngleY: 7 * i }; },
    proud:     function (i) { return { EyeSmile: 0.6 * i, ParamMouthForm: 0.55 * i, AngleY: -8 * i, ParamBodyAngleX: -3 * i }; },
    greeting:  function (i) { return { EyeSmile: 0.8 * i, ParamMouthForm: 0.5 * i, AngleZ: 4 * i }; },
    playful:   function (i) { return { EyeSmile: 0.4 * i, ParamMouthForm: 0.75 * i, AngleZ: 8 * i }; },
    excited:   function (i) { return { EyeSmile: 0.5 * i, ParamMouthOpenY: 0.25 * i, AngleY: -4 * i }; },
    angry:     function (i) { return { Angry: 0.7 * i, ParamBrowLY: 0.5 * i, ParamBrowRY: 0.5 * i, CheeckPuff: 0.4 * i }; },
    surprised: function (i) { return { SHOCKEYE: 0.85 * i, ParamMouthOpenY: 0.5 * i }; }
  };

  /* 尾巴情绪分档（2026-11-07）：以前固定正弦，什么心情都一个摆法。
   * 按当前表情给「幅度 + 速度」，两者都缓动过去，换表情不跳。
   * 生气是快甩、困了是无力下垂、开心大幅慢摆、被吓到猛抽一下。 */
  var TAIL_MOODS = {
    idle:      { amp: 11, speed: 1.0 },
    thinking:  { amp: 7,  speed: 0.7 },
    typing:    { amp: 9,  speed: 1.0 },
    happy:     { amp: 16, speed: 1.2 },
    smile:     { amp: 14, speed: 1.1 },
    proud:     { amp: 15, speed: 1.2 },
    greeting:  { amp: 14, speed: 1.3 },
    playful:   { amp: 18, speed: 1.5 },
    shy:       { amp: 6,  speed: 0.7 },
    sad:       { amp: 5,  speed: 0.5 },
    serious:   { amp: 5,  speed: 0.8 },
    sleepy:    { amp: 4,  speed: 0.45 },
    excited:   { amp: 20, speed: 1.6 },
    angry:     { amp: 18, speed: 2.4 },
    surprised: { amp: 20, speed: 1.8 }
  };

  // 空闲小动作：3-10 分钟随机一个，一次只做一个，做完有停顿
  var IDLE_ACTIONS = [
    { name: '歪头看旁边', dur: 1.6, targets: { AngleZ: 10, ParamEyeBallX: 0.5 } },
    { name: '抬眼看上面', dur: 2.0, targets: { ParamEyeBallY: -0.6, AngleY: -9 } },
    { name: '低头看手',   dur: 1.8, targets: { AngleY: 12, ParamEyeBallY: 0.5 } },
    { name: '伸懒腰',     dur: 2.2, targets: { ParamBodyAngleX: -7, ParamMouthOpenY: 0.22, AngleY: 4 } },
    { name: '小声叹气',   dur: 1.5, targets: { ParamMouthOpenY: 0.16, ShoulderY: 6 } },
    { name: '玩尾巴',     dur: 2.0, targets: { Param_Angle_Rotation84: 24, Param_Angle_Rotation85: 30, Param_Angle_Rotation86: 32 } },
    { name: '摸耳鳍',     dur: 1.5, targets: { AngleZ: 5, ParamEyeBallY: -0.2 } },
    { name: '突然挺直',   dur: 0.9, targets: { AngleY: 0, AngleX: 0, AngleZ: 0 } },
    { name: '想事情',     dur: 2.6, targets: { ParamEyeBallY: -0.55, AngleZ: 8, ParamBrowInnerUp: 0.3, AngleY: -6 } }
  ];

  var SWITCH_PARAMS = ['Angry', 'SHOCKEYE', 'CheeckPuff', 'EyeSmile', 'JawOpen', 'ShoulderY'];

  function NonoBehavior(model, app) {
    this.model = model;
    this.app = app;
    this.core = model.internalModel.coreModel;
    this.rangeCache = {};
    this.idxCache = {};
    this.targets = {};

    // 鼠标：一律用「最后一次真实移动的时间」判断，不用布尔
    this.mouseX = 0.5; this.mouseY = 0.5;
    // 2026-11-07 最后一轮「全身流畅」：鼠标先过低通（55ms），再去算头/身体的角。
    // 原来直接拿原始坐标当目标，指针一抖头就抖；低通之后目标本身是连续的。
    this.mouseSX = 0.5; this.mouseSY = 0.5;
    this.mouseVelX = 0;
    // 二阶弹簧状态（头三个轴 + 前后倾 + 身体横移）：只改「怎么到位」，不改幅度
    this.headVX = 0; this.headVY = 0; this.headVZ = 0; this.leanV = 0;
    this.bodyShiftV = 0;
    this.lastMouseMove = performance.now();
    this.lastMouseSpeed = 0;
    this.pointerInside = false;

    this.breathP = Math.random();
    this.breathSpeed = 0.045;

    // 眨眼
    this.blinkState = 'open';
    this.blinkT = 0;
    this.blinkNextAt = performance.now() + rand(8000, 15000);
    this.blinkCount = 1;
    this.blinkAsym = false;           // 彩蛋：两眼不一样快
    this.eyeCmd = 1;                  // eyeopen 指令
    this.eyeExpr = 1;                 // 表情压低
    this.eyeTime = 1;                 // 时段压低
    this.blinkMode = 'auto';          // MCP set_blink：auto / stop / slow / one
    this.blinkStopUntil = 0;          // stop 最多 3 秒，自动恢复（安全默认值）

    // 连点排队（戳一下演完再接下一个）
    this.pokeBusyUntil = 0;
    this.pokeQueue = [];
    // 单眼眨（wink）：两只眼睛是独立参数，可以只闭一只
    this.winkSide = null;             // 'L' / 'R' / null
    this.winkStart = 0;
    this.winkNextAt = performance.now() + rand(45000, 90000);
    // 吐舌头（模型自带 TongueOut / ParamTongueUpDown / ParamTongueWidth）
    this.tongueUntil = 0;
    // 裙子摆动相位（模型有 SkirtX1-4，没进 physics，我们自己摆）
    this.skirtP = 0;
    // 轨迹（全身头身关键帧）
    this.traj = null;
    // 隔几分钟来一次「扭一扭」：整体摇摆放大 2.2 倍，像脱捕那种全身在动
    this.bigSwayUntil = 0;
    this.bigSwayNextAt = performance.now() + rand(180000, 300000);

    // MCP look_at：视线覆盖
    this.lookMode = null;
    this.lookUntil = 0;

    // petbox 同款·待机摇摆:呼吸之外的轻身体摆(肩/身/头,各自相位不同——像活着)
    this.swayT = Math.random() * 6.28;
    this.swayAmp = 1;
    this.swayZ = 0;                   // 这一帧的摇摆量，由 applyHead 叠加到 AngleZ
    // 头（真正认的 AngleX/Y/Z）。headX=偏航, headY=俯仰, headZ=侧倾
    this.headX = 0; this.headY = 0; this.headZ = 0;
    this.leanCur = 0;                 // 身体前后倾（LeanInput，负值前倾）
    // 动作层：播 motion 期间由动作接管参数，行为层让位（Soullink 的分层思路）
    this.motionOn = false;
    this.motionEndAt = 0;
    this.motionGroup = '';
    // 外观：形态（Clothes2 大小变）/ 鞋子（Clothes4）
    this.formValue = 0;      // 当前形态（0=诺诺 / 0.4=小诺诺 / 1.0=诺宝宝）
    this.formTarget = 0;     // 目标形态——中间用缓动过渡，不再一下子跳过去
    this.shoeValue = 0;      // 0=穿着 / 1=脱掉
    this.skirtCur = 1; this.skirtTarget = 1;   // Clothes1：1 短裙 / 0 长裙（实测）
    this.tailCur = 1; this.tailTarget = 1;     // Clothes5：1 有尾巴 / 0 收起来
    this.voiceLevel = null;  // 真 TTS 播放时由 js/voice.js 每帧写入 0~1
    this.headOffX = 0; this.headOffY = 0; this.headOffZ = 0;   // 空闲动作/活动的头偏移
    this.planHead = null;    // play_plan 的精确角度 {x,y,z,until}
    this.baseY = model.y;    // 没变小之前的位置（换形态时按比例往下挪，脚别飘）
    // 空闲动作
    this.idleAction = null;
    // 首个动作提前到 20-45 秒(小海要看得到"她在动"),之后回归 3-10 分钟的正常节奏
    this.idleNextAt = performance.now() + (20000 + Math.random() * 25000);
    this.lastActionName = null;
    // 动作库的手臂小表演：4-8 分钟一次。一定要给初值，不然 ready 第一帧 now > 0 就立刻演一段
    this.armMotionNextAt = performance.now() + 180000 + Math.random() * 180000;  // 3-6 分钟演一次
    // 尾巴情绪：相位自己累加（按心情变速），幅度/速度缓动过去
    this.tailPhase = 0;
    this.tailAmp = 11;
    this.tailSpeed = 1.0;
    this.bodyShift = 0;               // 身体跟着鼠标的横向位移
    this.resetPoseAfter = false;
    this.motionIsReturn = false;     // 这次播的是「切回默认手」类动作
    this.presetUntil = 0;            // 预设表情到点自动摘（防止单片眼镜一直戴着）
    this.defaultCache = {};          // 参数默认值缓存（settleArms 每帧用，别反复查 moc3）
    this.armPin = {};                // 调试用：临时钉住胳膊参数，settleArms 不覆盖

    // 时间感
    this.timeBucket = this.bucketNow();
    this.dozeNextAt = performance.now() + rand(20000, 40000);

    // 发呆
    this.wanderTarget = null;
    this.wanderTimer = 0;
    this.yawned = false;
    this.lazyUntil = 0;

    // 表情：结束时能把每一个参数放回基线
    this.expr = null;
    this.exprTouched = [];
    this.exprTargets = {};
    this.holdExpr = false;

    // 口型（用帧累积时钟，不受后台节流影响）
    this.frameTime = 0;
    this.speakUntil = 0;
    this.speakLevel = 0;
    this.speakNext = 0;
    this.speakOpen = 0;
    this.mouthCmd = null;
    this.sayPlan = null;              // MCP say：按文本编好的音节节奏
    this.sayText = '';
    this.sayLastUnit = 0;             // 咕哝音:当前音节序号(换音节时出声)
    this.presetActive = false;        // 叠加的 exp3 预设是否在(过期要复位)

    // MCP get_state 用
    this.lastInteractionAt = performance.now();

    // 互动
    this.clickTimes = [];
    this.hoverSince = 0;
    this.dragging = false;
    this.interactive = false;   // 桌面版穿透时不接点击；托盘切「可拖动」才为 true

    // 主动 / 彩蛋（小海 2026-11-04 点单）
    this.prevIdleMs = 0;              // welcome 检测：上一帧的静止时长
    this.onWelcome = null;            // 他回来了（静止≥10分钟后再动）→ 渲染层接气泡
    this.onHiccup = null;             // 打嗝彩蛋 → 渲染层接音效+气泡
    this.dawnLookNextAt = 0;          // 凌晨歪头看他
    this.tailTwitchNextAt = performance.now() + rand(120000, 300000);
    this.hiccupNextAt = performance.now() + rand(50 * 60000, 150 * 60000);
    this.circleBuf = [];              // 追圈彩蛋：最近鼠标轨迹
    this.circleCoolUntil = 0;
    this.circleUntil = 0;

    // 0号 2026-11-04 想法①：她知道自己在忙什么（set_activity）
    this.activity = 'idle';
    this.activityUntil = 0;           // Infinity = 一直保持
    // 0号想法②：小诺（DSH）在不在线——在的时候她更精神，不在时安静
    this.companionOnline = null;      // null=未知
    // 0号想法③b：尾巴记仇（数次数，不靠随机）
    this.tailStrikes = 0;
    this.tailLastAt = 0;
    this.tailHiddenUntil = 0;         // 尾巴卷起来藏身后，5分钟内一碰就躲
    // 0号想法③c：凌晨会睡着（3点后20分钟没动静），被鼠标惊醒
    this.sleepState = '';             // '' | 'asleep'
    // 0号第三轮任务二：play_plan 时间轴（逐帧 tick，不用 setTimeout，打断最干净）
    this.plan = null;                 // { steps, interruptible, t0, playing }

    this.attachMouseEvents();
  }

  NonoBehavior.prototype.start = function () {
    this.app.ticker.add(function () { this.update(this.app.ticker.deltaMS / 1000); }, this);
  };

  /* ---------- 参数工具 ---------- */
  // Cubism 4/5 的 framework 里，getParameterMinimumValue / MaximumValue 收的是
  // 参数「索引」，不是参数名。2 号版本传了 id 字符串，拿到 undefined，
  // 于是所有 target 算成 NaN —— 整套行为系统其实没生效。这里一律走索引 API。
  NonoBehavior.prototype.index = function (id) {
    if (!(id in this.idxCache)) {
      try { this.idxCache[id] = this.core.getParameterIndex(id); }
      catch (e) { this.idxCache[id] = -1; }
    }
    return this.idxCache[id];
  };
  NonoBehavior.prototype.range = function (id) {
    if (!(id in this.rangeCache)) {
      var idx = this.index(id);
      if (idx < 0) {
        this.rangeCache[id] = null;
      } else {
        try {
          var min = this.core.getParameterMinimumValue(idx);
          var max = this.core.getParameterMaximumValue(idx);
          this.rangeCache[id] = isFinite(min) && isFinite(max) && max !== min
            ? { idx: idx, min: min, max: max } : null;
        } catch (e) { this.rangeCache[id] = null; }
      }
    }
    return this.rangeCache[id];
  };
  NonoBehavior.prototype.exists = function (id) {
    return this.range(id) !== null;
  };
  NonoBehavior.prototype.neutral = function (id) {
    var r = this.range(id);
    if (!r) return 0;
    // 开关类（key1~13 / Angry / SHOCKEYE…）基线是关 = 最小值
    if (id.indexOf('key') === 0 || SWITCH_PARAMS.indexOf(id) >= 0) return r.min;
    // 角度、眼珠、嘴、眉这类以中点为「回正」
    if (id.indexOf('EyeBall') >= 0 || id.indexOf('Angle') >= 0 ||
        id.indexOf('Mouth') >= 0 || id.indexOf('Brow') >= 0) return (r.min + r.max) / 2;
    return r.min;
  };
  NonoBehavior.prototype.setNorm = function (id, v01) {
    if (!this.exists(id)) return;
    var r = this.range(id); if (!r) return;
    this.targets[id] = r.min + (r.max - r.min) * clamp(v01, 0, 1);
  };
  NonoBehavior.prototype.setSigned = function (id, v) {
    if (!this.exists(id)) return;
    var r = this.range(id); if (!r) return;
    var mid = (r.min + r.max) / 2, half = (r.max - r.min) / 2;
    this.targets[id] = mid + half * clamp(v, -1, 1);
  };
  NonoBehavior.prototype.setRaw = function (id, v) {
    if (!this.exists(id)) return;
    var r = this.range(id); if (!r) return;
    this.targets[id] = clamp(v, r.min, r.max);
  };
  NonoBehavior.prototype.setNow = function (id, v) {
    var r = this.range(id);
    if (r && isFinite(v)) this.core.setParameterValueByIndex(r.idx, clamp(v, r.min, r.max));
  };
  NonoBehavior.prototype.getNow = function (id) {
    var r = this.range(id);
    return r ? this.core.getParameterValueByIndex(r.idx) : 0;
  };
  NonoBehavior.prototype.lerpTo = function (id, dt) {
    var t = this.targets[id];
    if (t === undefined || !isFinite(t)) return;
    var r = this.range(id);
    if (!r) return;
    var cur = this.core.getParameterValueByIndex(r.idx);
    var k = 1 - Math.pow(0.001, dt * this.speedOf(id));
    this.core.setParameterValueByIndex(r.idx, cur + (t - cur) * k);
  };
  NonoBehavior.prototype.speedOf = function (id) {
    if (id.indexOf('EyeBall') >= 0) return 18;
    if (id.indexOf('Angle') >= 0 || id.indexOf('BodyAngle') >= 0) return 6;
    if (id.indexOf('Mouth') >= 0) return 12;
    if (id.indexOf('key') === 0 || SWITCH_PARAMS.indexOf(id) >= 0) return 9;
    return 10;
  };

  /* ---------- 呼吸：吸气慢、呼气快，幅度随时间段 ---------- */
  NonoBehavior.prototype.updateBreath = function (dt) {
    var slow = this.timeBucket === 'dawn' || this.timeBucket === 'night';
    // 0号想法②：小诺在线时她更精神（呼吸略提），不在线时安静；睡着时最慢
    var mood = this.sleepState === 'asleep' ? 0.4
      : this.companionOnline === false ? 0.92
      : this.companionOnline ? 1.06 : 1;
    var speed = this.breathSpeed * (slow ? 0.55 : 1) * mood * rand(0.92, 1.08);
    this.breathP += dt * speed;
    if (this.breathP > 1) this.breathP -= 1;
    var p = this.breathP, b;
    if (p < 0.45) b = 0.5 - 0.5 * Math.cos((p / 0.45) * Math.PI);
    else b = 0.5 + 0.5 * Math.cos(((p - 0.45) / 0.55) * Math.PI);
    var amp = this.timeBucket === 'morning' ? 0.55 : (slow ? 0.42 : 0.5);
    this.setNorm('ParamBreath', 0.25 + amp * b);
  };

  /* ---------- 眨眼：不匀速、偶发连眨、偶发两眼不同步 ---------- */
  NonoBehavior.prototype.triggerBlink = function (double) {
    if (this.blinkState !== 'open') return;
    this.blinkState = 'closing';
    this.blinkT = 0;
    this.blinkCount = double ? 2 : (Math.random() < 0.12 ? 2 : 1);
    this.blinkAsym = Math.random() < 0.005;
  };
  NonoBehavior.prototype.updateBlink = function (dt) {
    var now = performance.now();
    // MCP set_blink: stop = 睁着眼不动，但绝不让她卡住——3 秒后强制回 auto
    if (this.blinkMode === 'stop') {
      if (now >= this.blinkStopUntil) {
        this.blinkMode = 'auto';
      } else {
        var b = Math.min(this.eyeCmd, this.eyeExpr, this.eyeTime);
        this.setNow('ParamEyeLOpen', b);
        this.setNow('ParamEyeROpen', b);
        return;
      }
    }
    var slow = this.timeBucket === 'dawn' || this.timeBucket === 'night';
    var interval = this.timeBucket === 'dawn' ? rand(15, 25)
      : slow ? rand(12, 20)
      : this.timeBucket === 'morning' ? rand(10, 18) : rand(8, 15);
    if (this.blinkMode === 'slow') interval *= 2.5;
    if (this.blinkState === 'open' && now > this.blinkNextAt) this.triggerBlink(false);

    var eye = 1;
    switch (this.blinkState) {
      case 'closing':
        this.blinkT += dt; eye = 1 - clamp(this.blinkT / 0.07, 0, 1);
        if (this.blinkT >= 0.07) { this.blinkState = 'closed'; this.blinkT = 0; }
        break;
      case 'closed':
        this.blinkT += dt; eye = 0;
        if (this.blinkT >= 0.04) { this.blinkState = 'opening'; this.blinkT = 0; }
        break;
      case 'opening':
        this.blinkT += dt; eye = clamp(this.blinkT / 0.09, 0, 1);
        if (this.blinkT >= 0.09) {
          this.blinkCount--;
          if (this.blinkCount > 0) { this.blinkState = 'closing'; this.blinkT = 0; }
          else { this.blinkState = 'open'; this.blinkNextAt = now + interval * 1000; }
        }
        break;
    }
    var base = Math.min(this.eyeCmd, this.eyeExpr, this.eyeTime);
    var l = base * eye, r = base * eye;
    if (this.blinkAsym && this.blinkState !== 'open') r = base * clamp(eye + 0.25, 0, 1);

    // 单眼眨：闭 0.15s、停 0.4s、再睁开；偶尔自己眨一下，不等人点
    if (this.blinkMode === 'auto' && this.blinkState === 'open') {
      if (this.winkSide) {
        var wt = (now - this.winkStart) / 1000;
        if (wt >= 0.75) { this.winkSide = null; }
        else {
          var wv = wt < 0.15 ? 1 - wt / 0.15 : (wt < 0.55 ? 0 : (wt - 0.55) / 0.2);
          if (this.winkSide === 'L') l = Math.min(l, wv); else r = Math.min(r, wv);
        }
      } else if (now > this.winkNextAt) {
        this.winkSide = Math.random() < 0.5 ? 'L' : 'R';
        this.winkStart = now;
        this.winkNextAt = now + rand(45000, 90000);
        if (Math.random() < 0.35) this.tongue(700);   // 眨眼有时配吐舌头，像图里那样
      }
    }
    this.setNow('ParamEyeLOpen', l);
    this.setNow('ParamEyeROpen', r);
  };

  /* 单眼眨：side = 'L' | 'R'，菜单/MCP 都能点 */
  NonoBehavior.prototype.wink = function (side) {
    this.winkSide = side === 'R' ? 'R' : 'L';
    this.winkStart = performance.now();
    this.winkNextAt = performance.now() + rand(45000, 90000);
  };

  /* 吐舌头，ms 毫秒后收回去 */
  NonoBehavior.prototype.tongue = function (ms) {
    this.tongueUntil = performance.now() + (ms || 900);
  };

  /* 舌头/裙子每帧写（模型没给它们做物理，只能自己摆） */
  NonoBehavior.prototype.applyOverlays = function (dt) {
    var now = performance.now();
    if (this.exists('TongueOut')) {
      if (now < this.tongueUntil) {
        this.setNow('TongueOut', 1);
        this.setRaw('ParamTongueUpDown', -0.25);
        this.setRaw('ParamTongueWidth', 0.65);
      } else if (this.tongueWasOn) {
        this.setNow('TongueOut', 0);
      }
      this.tongueWasOn = now < this.tongueUntil;
    }
    // 脖子/下巴那块的硬阴影（cdi3 里 Part8 的名字就叫「阴影」）。
    // 2026-11-07 小海：调到最低、最好看不到 —— 干脆整层隐藏，不再做「低头越深越淡」。
    if (this.core) {
      try { this.core.setPartOpacityById('Part8', 0); } catch (e) {}
    }
    // 裙子：慢速正弦 + 身体前倾时往后掀一点，长短裙都能看见摆动
    this.skirtP += dt * 2.4;
    if (this.exists('SkirtX1')) {
      var s = Math.sin(this.skirtP) * 0.5 + Math.sin(this.skirtP * 0.43 + 1.2) * 0.3;
      // 身体横移时裙摆滞后半拍（bodyShiftV 是横移速度）：裙子跟着身子被拽走，不是钉在腰上
      var sk = s * 0.30 + clamp(this.leanCur, -18, 8) / 18 * 0.22
        - clamp(this.bodyShiftV * 0.012, -0.22, 0.22);
      this.setRaw('SkirtX1', clamp(sk, -0.55, 0.55));
      this.setRaw('SkirtX2', clamp(sk * 1.15, -0.55, 0.55));
      this.setRaw('SkirtX3', clamp(sk * 0.85, -0.55, 0.55));
      this.setRaw('SkirtX4', clamp(sk * 1.05, -0.55, 0.55));
    }
  };

  /* ---------- 头：真正认的参数是 AngleX(偏航) / AngleY(俯仰) / AngleZ(侧倾) ----------
   * 2026-11-06 实测：ParamAngleX/Y/Z 写进去模型一点不动（只对头发物理有影响），
   * 真正在动的是模型作者留的 AngleX/Y/Z（cdi3 里 OX/OY/OZ）。
   * 同时按 Soullink 的做法：头眼分离——头转得多时眼珠自动收一点，别像斗鸡眼。
   * 平滑用指数缓动（约 160ms 到位），跟手但不瞬移；坐标轴按实测对正：
   *   鼠标左右 → AngleX（偏航），鼠标上下 → AngleY（俯仰），左右多一点 → AngleZ（微歪）。
   */
  NonoBehavior.prototype.applyHead = function (dt, yaw, pitch, roll, lean) {
    // 精确角度指令（play_plan 的 angle）按住时优先，鼠标转头先让位
    if (this.planHead && performance.now() < this.planHead.until) {
      yaw = this.planHead.x; pitch = this.planHead.y; roll = this.planHead.z;
    }
    // 空闲动作 / activity 的偏移量叠加在这里（不是各写各的 target）
    yaw += this.headOffX || 0;
    pitch += this.headOffY || 0;
    roll += this.headOffZ || 0;
    /* 2026-11-07 最后一轮：一阶指数 → 二阶弹簧。
     * 原来 (target-x)*k 是「越接近越慢」的单调逼近，停手时最后一段像被黏住，
     * 快速甩鼠标时又整段贴死在目标上——手感就是「僵」。
     * 弹簧多带一个速度状态：起步有加速度、到位自然减速、收尾一点点回弹，
     * 幅度（yaw/pitch/roll/lean）一个都没改，只改到达方式。
     */
    var hw = 10.0, hc = 2 * 0.80 * hw;       // 头：略欠阻尼，收尾带约 1% 回弹
    this.headVX += ((yaw - this.headX) * hw * hw - this.headVX * hc) * dt;
    this.headVY += ((pitch - this.headY) * hw * hw - this.headVY * hc) * dt;
    this.headVZ += ((roll - this.headZ) * hw * hw - this.headVZ * hc) * dt;
    this.headX += this.headVX * dt;
    this.headY += this.headVY * dt;
    this.headZ += this.headVZ * dt;
    // 身体前后倾更重一点：LeanInput 负值前倾（实测 -30 明显、+30 几乎看不出）
    var lw = 7.4, lc = 2 * 0.84 * lw;
    this.leanV += (((lean || 0) - this.leanCur) * lw * lw - this.leanV * lc) * dt;
    this.leanCur += this.leanV * dt;
    this.setRaw('AngleX', clamp(this.headX, -20, 20));
    this.setRaw('AngleY', clamp(this.headY, -14, 14));
    // 待机摇摆在这里叠加，不另开一个写入点去盖头
    this.setRaw('AngleZ', clamp(this.headZ + (this.swayZ || 0), -30, 30));
    this.setRaw('LeanInput', clamp(this.leanCur, -18, 8));
  };

  /* ---------- 鼠标低通（眼快头慢的第一半） ----------
   * 原始指针坐标每帧都在跳 1~2px，直接拿来当头的目标就会「抖」或者「贴死」。
   * 这里做 55ms 一阶低通：目标连续了，后面的弹簧才有东西可弹。
   * mouseVelX 给身体做甩尾（快速横扫时身子多带一点）。
   */
  NonoBehavior.prototype.smoothCursor = function (dt) {
    var prev = this.mouseSX;
    var k = 1 - Math.exp(-dt / 0.055);
    this.mouseSX += (this.mouseX - this.mouseSX) * k;
    this.mouseSY += (this.mouseY - this.mouseSY) * k;
    this.mouseVelX = (this.mouseSX - prev) / Math.max(dt, 1e-3);
  };

  /* ---------- 眼睛：跟鼠标 / 停 2 秒回正 / 停 10 秒自己飘 / 停 60 秒打呵欠 ---------- */
  NonoBehavior.prototype.updateLook = function (dt) {
    var now = performance.now();
    var idleMs = now - this.lastMouseMove;

    // 他回来了：静止超过 10 分钟后鼠标重新动 → 立刻抬头，眼睛亮一下
    // （0号《行为设计》4.4：不打扰，但看得见）
    if (this.prevIdleMs > 600000 && idleMs < 2000) {
      this.lookMode = null; this.lookUntil = 0;
      this.setExpression('excited', 0.7, false, 2200);
      this.idleAction = { name: '看他回来', dur: 0.8, t0: now,
        targets: { AngleY: -6, ParamEyeBallY: -0.3 } };
      if (this.onWelcome) { try { this.onWelcome(this.prevIdleMs); } catch (e) {} }
    }
    this.prevIdleMs = idleMs;

    // 轨迹（从鲸语引擎搬来的 trajectory）：一段带关键帧的全身头身运动，优先级最高
    if (this.applyTrajectoryFrame(dt, now)) return;

    // MCP look_at：覆盖式，期间真实鼠标不抢视线；到点自动回 cursor
    if (this.lookMode && this.lookMode !== 'cursor' && now < this.lookUntil) {
      var ox = 0, oy = 0;
      if (this.lookMode === 'user') { ox = -0.15; oy = -0.05; }       // 屏幕中心偏左，小海坐的位置
      else if (this.lookMode === 'away') { ox = 0.7; oy = 0.05; }
      else if (this.lookMode === 'down') { ox = 0; oy = 0.62; }
      this.setSigned('ParamEyeBallX', ox);
      this.setSigned('ParamEyeBallY', oy);
      this.applyHead(dt, ox * 12, oy * 8, ox * -3, -oy * 10);
      return;
    }
    if (this.lookMode && now >= this.lookUntil) this.lookMode = null;

    var ex = 0, ey = 0, yaw = 0, pitch = 0, roll = 0, lean = -2;

    // 眼快手慢：头用低通后的坐标，眼珠用原始坐标（眼睛本来就比脖子快半拍）
    var eyeEx = ex, eyeEy = ey;

    if (idleMs < 2000) {
      // 跟着真实鼠标。桌面版拿到的是屏幕绝对坐标换算后的值，可能越界，先夹住
      ex = clamp((this.mouseSX - 0.5) * 2, -1, 1) * 0.82;
      ey = clamp((0.5 - this.mouseSY) * 2, -1, 1) * 0.82;
      eyeEx = clamp((this.mouseX - 0.5) * 2, -1, 1) * 0.82;
      eyeEy = clamp((0.5 - this.mouseY) * 2, -1, 1) * 0.82;
      // 2026-11-07 小海：左右跟随只剩头、身体不跟了，要更大
      yaw = ex * 18; pitch = ey * 10; roll = ex * -13;
      // 身体跟着鼠标横向位移（模型整体平移），左右各 16px，配合转头就像整个身子转过来
      // 实测 PositionX 正负和画面相反：鼠标在左要写正才往左，所以取负
      this.bodyShiftTarget = -ex * 16;
      // 往下：真探头（前倾 20°）；往上：只留 -3°，不然边抬头边前倾像个乌龟
      lean = ey > 0 ? -3 : ey * 20;
      this.yawned = false; this.lazyUntil = 0;
      this.wanderTarget = null;
    } else if (idleMs > 60000 && !this.yawned) {
      this.yawned = true;
      this.idleAction = { name: '打呵欠', dur: 1.8, t0: now,
        targets: { ParamMouthOpenY: 0.55, AngleY: 5 } };
      this.lazyUntil = now + 25000;
      ex = -0.12; ey = 0.05; yaw = -2; pitch = -3;
    } else if (idleMs > 10000) {
      // 自己飘：看旁边、看下面、再看回中心
      if (!this.wanderTarget || now > this.wanderTimer) {
        var opts = [{ ex: 0.4, ey: -0.1 }, { ex: -0.35, ey: 0.05 }, { ex: 0.1, ey: 0.45 },
                    { ex: -0.1, ey: -0.3 }, { ex: 0, ey: 0 }];
        this.wanderTarget = opts[Math.floor(Math.random() * opts.length)];
        this.wanderTimer = now + rand(3000, 6500);
      }
      ex = this.wanderTarget.ex * 0.7; ey = this.wanderTarget.ey * 0.7;
      yaw = ex * 6; pitch = ey * 4; roll = ex * -2; lean = -ey * 8;
    } else {
      // 鼠标停住 2 秒：慢慢回正，看着屏幕中心偏左（小海坐的位置）
      ex = -0.15; ey = -0.05; yaw = -2; pitch = -3;
    }

    // 头眼分离：头已经转过去了，眼珠就别再顶到边
    var eyeGain = 1 - Math.min(1, Math.abs(this.headX) / 30) * 0.35;
    this.setSigned('ParamEyeBallX', eyeEx * eyeGain);
    this.setSigned('ParamEyeBallY', eyeEy * eyeGain);
    // 身体位移：二阶弹簧（原来一阶 0.18s 是「跟到就停」，像被绳子拉着走）
    // 目标幅度还是 ±16px 不变，只多两点：① 丢掉高档位、留一点过冲收尾
    // ② 快速横扫鼠标时按速度多带最多 3px（甩尾感），停手自然收回来
    var shiftTarget = (idleMs < 2000) ? (this.bodyShiftTarget || 0) : 0;
    shiftTarget += clamp(this.mouseVelX * 26, -3, 3);
    var bw = 6.6, bc = 2 * 0.78 * bw;
    this.bodyShiftV += ((shiftTarget - this.bodyShift) * bw * bw - this.bodyShiftV * bc) * dt;
    this.bodyShift += this.bodyShiftV * dt;
    if (this.exists('PositionX')) this.setRaw('PositionX', clamp(this.bodyShift, -20, 20));
    this.applyHead(dt, yaw, pitch, roll, lean);

    this.eyeTime = (this.timeBucket === 'dawn') ? 0.92
      : (this.timeBucket === 'night') ? 0.97
      : (this.lazyUntil && now > this.lazyUntil) ? 0.9 : 1;
  };

  /* ---------- 时间感：跟着电脑时钟，小海昼夜颠倒所以深夜最要紧 ---------- */
  NonoBehavior.prototype.bucketNow = function () {
    var h = new Date().getHours();
    if (h >= 6 && h < 9) return 'morning';
    if (h >= 9 && h < 18) return 'day';
    if (h >= 18 && h < 22) return 'evening';
    if (h >= 22 || h < 3) return 'night';
    return 'dawn';
  };
  NonoBehavior.prototype.updateTimeSense = function () {
    var b = this.bucketNow();
    if (b !== this.timeBucket) {
      this.timeBucket = b;
      this.idleNextAt = performance.now() + this.idleGap();
    }
    if (b === 'dawn' && this.sleepState !== 'asleep' && performance.now() > this.dozeNextAt) {
      this.dozeNextAt = performance.now() + rand(15000, 35000);
      this.idleAction = { name: '打瞌睡', dur: 1.1, t0: performance.now(),
        targets: { AngleY: 9 } };
    }
    // 凌晨他还在：歪头看他一眼，眼神软下来，眼里有点心疼
    // （0号 4.4 第三条。90-180 秒一次，别盯着看）
    if (b === 'dawn' || b === 'night') {
      var nowMs = performance.now();
      var stillLong = (nowMs - this.lastMouseMove) > 600000;
      if (stillLong && nowMs > this.dawnLookNextAt && !this.idleAction) {
        this.dawnLookNextAt = nowMs + rand(90000, 180000);
        var self = this;
        this.idleAction = { name: '心疼地看他', dur: 1.4, t0: nowMs,
          targets: { AngleZ: 11, AngleX: -7, ParamEyeBallY: 0.18 } };
        this.setExpression('sad', 0.35, false, 3200);
        setTimeout(function () {
          if (!self.idleAction) {
            self.idleAction = { name: '心疼地收回目光', dur: 1.2, t0: performance.now(),
              targets: { AngleZ: -6, ParamEyeBallY: -0.25 } };
          }
        }, 1500);
      }
    }
  };
  NonoBehavior.prototype.idleGap = function () {
    var b = this.timeBucket;
    if (b === 'dawn') return 0;
    if (b === 'night') return rand(300000, 720000);
    if (b === 'morning') return rand(180000, 480000);
    return rand(180000, 600000);
  };

  /* ---------- 随机空闲小动作 ----------
   * 头角度单独走「偏移量」：空闲动作想歪头 10 度，就在 applyHead 上叠 10 度，
   * 不跟鼠标转头抢同一个 target（以前两边各写各的，歪头一帧就被拉回去）。
   */
  NonoBehavior.prototype.updateAction = function (dt) {
    var now = performance.now();
    var ox = 0, oy = 0, oz = 0;
    if (this.idleAction) {
      var a = this.idleAction;
      for (var id in a.targets) {
        if (id === 'eyeBase') continue;
        if (id === 'AngleX') { ox = a.targets[id]; continue; }
        if (id === 'AngleY') { oy = a.targets[id]; continue; }
        if (id === 'AngleZ') { oz = a.targets[id]; continue; }
        if (this.exists(id)) this.targets[id] = a.targets[id];
      }
      this.headOffX = ox; this.headOffY = oy; this.headOffZ = oz;
      if (now - a.t0 > a.dur * 1000) {
        this.idleAction = null;
        this.lastActionName = a.name;
        // 做完要有停顿：把动作参数放回基线
        for (var id2 in a.targets) {
          if (id2 === 'AngleX' || id2 === 'AngleY' || id2 === 'AngleZ') continue;
          if (this.exists(id2)) this.targets[id2] = this.neutral(id2);
        }
        this.headOffX = this.headOffY = this.headOffZ = 0;
      }
      return;
    }
    this.headOffX = this.headOffY = this.headOffZ = 0;
    // 彩蛋：尾巴尖自己抽一下（稀有，2-5 分钟一次，和空闲动作不抢）
    if (!this.idleAction && now > this.tailTwitchNextAt) {
      this.tailTwitchNextAt = now + rand(120000, 300000);
      this.idleAction = { name: '尾巴抽一下', dur: 0.55, t0: now,
        targets: { Param_Angle_Rotation86: 16, Param_Angle_Rotation85: 8 } };
      return;
    }
    // 动作库进日常(0号批):低频随机手臂动作——闲着的时候自己来一段小表演
    // 演配方/走轨迹时不插队，免得抢了配方的动作
    if (!this.idleAction && !this.traj && !(this.plan && this.plan.playing) && now > (this.armMotionNextAt || 0)) {
      this.armMotionNextAt = now + (180000 + Math.random() * 180000);
      var SAFE_MOTIONS = ['竖手指切出来动画', '狗尾草切换出来'];
      // 日常小表演是「演一下」，演完把手放回去；MCP/菜单点名的动作才会保持姿势
      // 不再用「默认手切举手」（抚胸）：举到胸前时手会被围裙挡掉，看起来像没手
      this.playMotion(SAFE_MOTIONS[Math.floor(Math.random() * SAFE_MOTIONS.length)], 0, { resetPose: true });
    }
    if (this.timeBucket !== 'dawn' && now > this.idleNextAt) {
      this.idleNextAt = now + this.idleGap();
      var pool = IDLE_ACTIONS.filter(function (x) { return x.name !== this.lastActionName; }, this);
      var pick = pool[Math.floor(Math.random() * pool.length)];
      this.idleAction = { name: pick.name, dur: pick.dur + rand(0, 0.3), t0: now, targets: pick.targets };
    }
  };

  /* ---------- 口型：有随机、有停顿、逗号停一下，不做广播体操 ----------
   * MCP say 走的是「按文本编好的音节表」：一个字一个开合，标点处整段停，
   * 总时长可指定；说完自动回 0。不是匀速，也不排队（新 say 直接盖掉旧的）。
   */
  NonoBehavior.prototype.startSay = function (text, totalMs) {
    var chars = Array.from(String(text || '').replace(/\s+/g, ''));
    var units = chars.map(function (c) {
      if ('，,。.！!？?；;…~、'.indexOf(c) >= 0) return { open: 0, dur: rand(180, 420) };
      if (Math.random() < 0.08) return { open: 0, dur: rand(90, 180) };   // 偶尔换个气
      return { open: rand(0.2, 0.75), dur: rand(90, 210) };
    });
    if (!units.length) units = [{ open: 0.3, dur: 200 }];
    var est = units.reduce(function (s, u) { return s + u.dur; }, 0);
    if (totalMs > 0 && est > 0) {
      var k = clamp(totalMs / est, 0.35, 3);
      units.forEach(function (u) { u.dur *= k; });
    }
    this.sayText = String(text || '');
    this.sayPlan = { units: units, i: 0, nextAt: this.frameTime };
    this.mouthCmd = null;
    this.speakUntil = 0;
  };
  NonoBehavior.prototype.updateMouth = function () {
    var now = this.frameTime;
    if (this.sayPlan) {
      var p = this.sayPlan;
      if (now >= p.nextAt) {
        if (p.i >= p.units.length) {
          this.sayPlan = null;
          this.targets['ParamMouthOpenY'] = this.neutral('ParamMouthOpenY');
          return;
        }
        var u = p.units[p.i++];
        // 0号批·补充五:说话咕哝音——换音节即出声,与口型同一条时间轴
        if (p.i !== this.sayLastUnit) {
          this.sayLastUnit = p.i;
          if (u.open > 0.05 && typeof window !== 'undefined' && window.NonoSfx) {
            window.NonoSfx.speakTick(u.open);
          }
        }
        this.targets['ParamMouthOpenY'] = u.open;
        p.nextAt = now + u.dur;
      }
      return;
    }
    if (this.mouthCmd !== null) {
      this.speakUntil = now + 1400;
      this.speakLevel = this.mouthCmd;
      this.mouthCmd = null;
      this.speakNext = now;
    }
    if (now > this.speakUntil) {
      this.targets['ParamMouthOpenY'] = this.neutral('ParamMouthOpenY');
      return;
    }
    if (now > this.speakNext) {
      // 大部分时候张 0.2~0.7，偶尔来个逗号/句号整段停
      var rest = Math.random() < 0.18;
      this.speakOpen = rest ? 0 : rand(0.18, 0.72) * this.speakLevel;
      this.speakNext = now + (rest ? rand(180, 420) : rand(90, 210));
    }
    this.targets['ParamMouthOpenY'] = this.speakOpen;
  };

  /* ---------- 表情 / 指令 ---------- */
  NonoBehavior.prototype.clearExpression = function () {
    for (var i = 0; i < this.exprTouched.length; i++) {
      var id = this.exprTouched[i];
      this.targets[id] = this.neutral(id);
    }
    this.exprTouched = [];
    this.exprTargets = {};
    this.expr = null;
    this.eyeExpr = 1;
    this.holdExpr = false;
  };
  NonoBehavior.prototype.setExpression = function (name, intensity, hold, durationMs) {
    this.clearExpression();
    var f = EXPRESSIONS[name];
    if (!f) { console.warn('[nono] 未知表情:', name); return; }
    var t = f(intensity === undefined ? 1 : clamp(intensity, 0, 1));
    this.holdExpr = !!hold;
    // MCP 规格：duration_ms=0 一直保持（由主进程 watchdog 兜底），>0 到点回 idle，
    // 没传则沿用原来的 9 秒自然淡出。
    var ms = durationMs > 0 ? durationMs : (hold ? 0 : 9000);
    this.expr = { name: name, until: ms > 0 ? performance.now() + ms : Infinity };
    for (var id in t) {
      if (id === 'eyeBase') { this.eyeExpr = t[id]; continue; }
      if (!this.exists(id)) continue;
      this.exprTouched.push(id);
      var r = this.range(id);
      var v = t[id];
      // 角度类给的是「度」，是绝对值；开关类 0..1 铺满；其余按 -1..1 折半映射
      var isSwitch = (id.indexOf('key') === 0 || SWITCH_PARAMS.indexOf(id) >= 0);
      var goal = (id.indexOf('Angle') >= 0 && r && Math.abs(v) > 1.5)
        ? clamp(v, r.min, r.max)
        : isSwitch ? r.min + (r.max - r.min) * clamp(v, 0, 1)
        : this.neutral(id) + (r ? (r.max - r.min) * v * 0.5 : 0);
      // 自查修复:表情幅度放大——放大的是偏离中点的差值,再夹回范围内
      var mid = (r.min + r.max) / 2;
      this.exprTargets[id] = clamp(mid + (goal - mid) * EXPR_BOOST, r.min, r.max);
    }
  };
  NonoBehavior.prototype.snapshot = function () {
    // 关键外观/手势参数一起报，出问题时 get_state 就能看到数值（2026-11-06 黑影排查加的）
    var watch = ['Movement1', 'Movement2', 'Movement3', 'Param37', 'Param38',
      'Param36', 'Param39', 'Param40', 'Param41', 'Param42', 'Param43',
      'Param59', 'Param60', 'Param61', 'Param62',
      'LArm', 'RArm', 'LForearm', 'LWrist', 'LHand', 'RForearm', 'RWrist', 'RHand',
      'Param_Angle_Rotation84', 'Param_Angle_Rotation85', 'Param_Angle_Rotation86',
      'Clothes1', 'Clothes2', 'Clothes3', 'Clothes4', 'Clothes5',
      'AngleX', 'AngleY', 'AngleZ', 'LeanInput', 'ParamBodyAngleX', 'PositionX'];
    var params = {};
    for (var i = 0; i < watch.length; i++) {
      if (this.exists(watch[i])) params[watch[i]] = Math.round(this.getNow(watch[i]) * 1000) / 1000;
    }
    return {
      expression: this.expr ? this.expr.name : 'idle',
      blinking: this.blinkMode === 'stop' ? 'stop' : (this.blinkMode === 'slow' ? 'slow' : 'auto'),
      looking: this.lookMode || 'cursor',
      talking: !!this.sayPlan || this.frameTime < this.speakUntil,
      activity: this.activity,
      motion: this.motionOn ? this.motionGroup : '',
      // 2026-11-07 情绪账本：菜单和 MCP 都能看到她现在什么心情
      mood: (window.NonoMood ? window.NonoMood.current().mood : 'neutral'),
      mood_cause: (window.NonoMood ? window.NonoMood.cause() : ''),
      form: this.formValue,
      shoe: this.shoeValue,
      params: params,
      last_interaction_ms: Math.round(performance.now() - this.lastInteractionAt)
    };
  };
  NonoBehavior.prototype.applyCommand = function (cmd) {
    if (!cmd || !cmd.action) return;
    this.lastInteractionAt = performance.now();
    switch (cmd.action) {
      case 'expression':
        this.setExpression(cmd.name, cmd.intensity, cmd.hold, cmd.duration_ms);
        // MCP/菜单的语义表情：叠预设 + 配一次动作（预设到点自动摘，动作演完自动收手）
        var pm2 = PRESET_FOR[cmd.name];
        var presetMs = cmd.duration_ms > 0 ? cmd.duration_ms : (cmd.hold ? 0 : 4000);
        if (pm2) this.flashPreset(pm2, presetMs);
        var gm2 = MOTION_FOR[cmd.name];
        if (gm2 && MOTION_DUR[gm2]) this.playMotion(gm2, 0, { resetPose: true });
        break;
      case 'blink': {
        var mode = String(cmd.mode || 'auto');
        if (mode === 'one') { this.triggerBlink(false); this.blinkMode = 'auto'; }
        else if (mode === 'stop') { this.blinkMode = 'stop'; this.blinkStopUntil = performance.now() + 3000; }
        else this.blinkMode = mode === 'slow' ? 'slow' : 'auto';
        break;
      }
      case 'say':
        this.startSay(cmd.text, cmd.duration_ms || 0);
        // 任务3：有真声音就先出声（TTS 合成好了再接管口型；没声音就退回音节口型）
        if (typeof window !== 'undefined' && window.NonoVoice && cmd.text) {
          try { window.NonoVoice.speak(cmd.text); } catch (e) {}
        }
        break;
      case 'form': {
        // 任务6：小只/中只/大只——模型自带「大小变」，不是窗口缩放
        var fv = cmd.value === 'small' || cmd.value === '小只' ? 1.0
          : cmd.value === 'mid' || cmd.value === '中只' ? 0.4 : 0;
        this.formTarget = fv;   // 缓动过去，不瞬切
        break;
      }
      case 'wink':
        this.wink(cmd.side || 'L');
        break;
      case 'tongue':
        this.tongue(cmd.ms || 900);
        break;
      case 'skirt':
        // 实测：Clothes1 = 1 短裙 / 0 长裙（裙子切换.exp3 是 Add -1，从短变长）
        this.skirtTarget = (cmd.value === 0 || cmd.value === 'short' || cmd.value === 'off') ? 1 : 0;
        break;
      case 'tail':
        this.tailTarget = (cmd.value === 0 || cmd.value === 'off' || cmd.value === '收起') ? 0 : 1;
        break;
      case 'shoe':
        // 任务5：Clothes4 = 鞋子（0 穿 / 1 脱）
        this.shoeValue = (cmd.value === 'off' || cmd.value === 1 || cmd.value === '脱') ? 1 : 0;
        this.applyAppearance();
        break;
      case 'preset':
        // 裙子和尾巴改走「参数缓动」（见 applyAppearance），不走 expression 硬切
        if (cmd.name === '裙子切换') { this.skirtTarget = this.skirtTarget > 0.5 ? 0 : 1; break; }
        if (cmd.name === '尾巴开关') { this.tailTarget = this.tailTarget > 0.5 ? 0 : 1; break; }
        // 模型自带 Exp3（中文名，如「脸红」「爱心眼」「流泪」），不碰参数合成
        try {
          if (cmd.name) this.model.expression(cmd.name);
          else this.resetPreset();
        } catch (e) { console.warn('[nono] preset 没起来:', e && e.message); }
        break;
      case 'eyeopen':
        this.eyeCmd = clamp(cmd.value === undefined ? 1 : cmd.value, 0, 1);
        break;
      case 'mouth':
        this.mouthCmd = clamp(cmd.value === undefined ? 0 : cmd.value, 0, 1);
        break;
      case 'motion':
        // 脱捕现在能播了（nono.model3.json 的 Motions 已挪进 FileReferences）
        this.playMotion(cmd.group || 'Idle', cmd.index || 0);
        break;
      case '_param':
        // 调试：临时钉住某个参数（只给本地排查手型用）
        if (cmd.id && isFinite(cmd.value)) {
          this.armPin[cmd.id] = cmd.value;
          this.targets[cmd.id] = cmd.value;
        }
        break;
      case '_param_clear':
        this.armPin = {};
        break;
      case 'look': {
        // MCP look_at：四种目标 + duration_ms 后自动回 cursor
        var t = cmd.target || cmd.value;
        if (t === 'home') t = 'user';
        this.lastMouseMove = performance.now();
        this.lookMode = (t === 'cursor') ? null : (t || 'user');
        this.lookUntil = cmd.duration_ms > 0 ? performance.now() + cmd.duration_ms : Infinity;
        if (t === 'away') { this.mouseX = 0.85; this.mouseY = 0.5; }
        else if (t === 'user' || t === 'home') { this.mouseX = 0.42; this.mouseY = 0.45; }
        break;
      }
      case 'reset':
        // 4.3 安全默认值：表情 idle / 眨眼 auto / 视线 cursor / 嘴闭合
        this.clearExpression();
        this.mouthCmd = null; this.speakUntil = 0; this.sayPlan = null;
        this.eyeCmd = 1;
        this.blinkMode = 'auto'; this.blinkStopUntil = 0;
        this.lookMode = null; this.lookUntil = 0;
        this.idleAction = null;
        this.resetPreset();
        break;
      case 'bubble':
        // 主进程来的文字（first_run / 时段问候 / 日记开场白）：走互动层的气泡
        if (typeof this.bubbleFn === 'function' && cmd.text) {
          try { this.bubbleFn(cmd.text, cmd.dur); } catch (e) {}
        }
        break;
      case 'stage_bubble':
        // 0号施工令任务1:阶段气泡——上半身随机位置冒小圆泡
        if (window.NonoStageBubbles) window.NonoStageBubbles.spawn(cmd.text || '', cmd.ms || 3000);
        break;
      case 'stage_bubbles_enabled':
        // 0号督办任务1:config 开关 { stage_bubbles: true }——能关
        if (window.NonoStageBubbles) window.NonoStageBubbles.setEnabled(cmd.value !== false);
        break;
      case 'activity': {
        // 0号想法①：set_activity —— 她不是摆姿势，是有正事在干
        var act = String(cmd.name || 'idle');
        this.activity = act;
        this.activityUntil = cmd.duration_ms > 0 ? performance.now() + cmd.duration_ms
          : (cmd.hold ? Infinity : performance.now() + 180000);
        if (act === 'done') {
          // 写完了：伸个懒腰
          this.idleAction = { name: '完工伸懒腰', dur: 2.0, t0: performance.now(),
            targets: { ParamBodyAngleX: -7, ParamMouthOpenY: 0.2, AngleY: 4 } };
          this.activity = 'idle'; this.activityUntil = 0;
        } else if (act === 'error') {
          // 出错：先皱眉，然后抬眼看他一眼（0号：这条最像人）
          this.activity = 'idle'; this.activityUntil = 0;
          this.setExpression('serious', 0.6, false, 1200);
          var se = this;
          setTimeout(function () {
            se.idleAction = { name: '出错看你', dur: 1.2, t0: performance.now(),
              targets: { AngleY: -7, ParamEyeBallY: -0.35 } };
          }, 1300);
        } else if (act === 'idle') {
          this.activityUntil = 0;
        }
        break;
      }
      case 'companion':
        // 0号想法②：小诺在不在——在线更精神，不在线安静（呼吸档位见 updateBreath）
        this.companionOnline = !!cmd.online;
        break;
      case 'react':
        // DSH侧的诺诺让桌面诺诺回应：被夸/被凶/吃醋（气泡由渲染层配台词）
        var mood = String(cmd.mood || '');
        if (mood === 'praised') this.setExpression('happy', 0.7, false, 2600);
        else if (mood === 'scolded') this.setExpression('sad', 0.55, false, 2600);
        else if (mood === 'jealous') this.setExpression('serious', 0.5, false, 2200);
        break;
      case 'plan': {
        // 0号第三轮任务二：复杂动作时间线。interruptible=false 时演完才接新的
        if (this.plan && this.plan.playing && !this.plan.interruptible && !cmd.interruptible) break;
        // 旧表演被打断：先把没演完的动作/手势收干净。
        // 否则像「生气了」在竖手指还没切回默认时切去别的配方，Movement3 会一直亮着，手就卡住。
        if (this.plan && this.plan.playing) {
          if (this.motionOn) this.stopMotion();
          this.clearHandPoses(false);     // 缓动收手，别啪一下弹回
          this.clearMotionResidue(true);
          this.resetPreset();   // 旧计划里的眼镜/爱心眼也跟着收掉
        }
        this.plan = { steps: (cmd.steps || []).slice().sort(function (a, b2) { return a.at - b2.at; }),
          interruptible: cmd.interruptible !== false, t0: performance.now(), playing: true };
        break;
      }
      case 'plan_stop':
        // 0号：表演结束的「收」——平滑回待机（表情淡出+目标回正由 lerp 完成，不硬切）
        this.plan = null;
        if (this.motionOn) this.stopMotion();
        this.clearHandPoses(false);
        this.clearMotionResidue(true);
        this.resetPreset();
        this.clearExpression();
        this.mouthCmd = null; this.speakUntil = 0; this.sayPlan = null;
        this.idleAction = null;
        this.lookMode = null; this.lookUntil = 0;
        break;
      case 'pat_auto':
      case 'say_something':
      case 'peek':
      case 'fps':
      case '_shot':
      case '_interactive':
      case '_menu':
        // 这几条由 js/main.js 的桥接层 / 主进程处理，这里只要不报未知
        break;
      default:
        console.warn('[nono] 未知指令:', cmd.action);
    }
  };

  /* ---------- 0号想法①：她正在做什么（set_activity）---------- */
  NonoBehavior.prototype.updateActivity = function () {
    if (this.activity === 'idle') return;
    if (performance.now() > this.activityUntil) { this.activity = 'idle'; return; }
    if (this.activity === 'reading') {
      // 读东西：眼睛跟着文本方向左右扫，慢速，头轻跟
      var t = this.frameTime / 1000;
      var sweep = Math.sin(t * 1.7) * 0.55;
      this.setSigned('ParamEyeBallX', sweep);
      this.setSigned('ParamEyeBallY', -0.12);
      this.headOffX = sweep * 6;               // 头跟着文本方向轻扫
    } else if (this.activity === 'waiting') {
      // 跑命令等结果：撑下巴歪头等（模型没有手参数，用思考姿势）
      this.setSigned('ParamEyeBallY', -0.35);
      this.setSigned('ParamEyeBallX', 0.15);
      this.headOffZ = 9; this.headOffY = -4;   // 歪头 + 微抬
    }
  };

  /* ---------- 0号想法③c：凌晨会睡着，被鼠标惊醒 ---------- */
  NonoBehavior.prototype.updateDawnSleep = function () {
    var now = performance.now();
    if (this.sleepState !== 'asleep') {
      var h = new Date().getHours();
      var idle = now - this.lastMouseMove;
      if (h >= 3 && h < 6 && idle > 20 * 60000) {
        this.sleepState = 'asleep';
        this.eyeCmd = 0.12;             // 眼睛闭上
      }
      return;
    }
    // 睡着中被惊醒：第一下「吓一跳」，第二下才是「不好意思」
    if (now - this.lastMouseMove < 800) {
      this.sleepState = '';
      this.eyeCmd = 1;
      this.setExpression('surprised', 0.65, false, 800);
      var self = this;
      setTimeout(function () { self.setExpression('shy', 0.5, false, 1600); }, 900);
    }
  };

  /* ---------- 0号第三轮任务二：plan 时间轴 ----------
   * 每帧检查（不 setTimeout）：到点的 step 逐个执行；
   * angle 带 dur 的，执行时排一个内部的「回正」step；
   * 表情用 setExpression 自带的淡出；不同类型天然并行（写的是不同参数）。
   */
  NonoBehavior.prototype.tickPlan = function () {
    if (!this.plan || !this.plan.playing) return;
    var t = performance.now() - this.plan.t0;
    var guard = 0;
    while (this.plan.steps.length && this.plan.steps[0].at <= t && guard++ < 50) {
      var s = this.plan.steps.shift();
      this.runPlanStep(s);
    }
    if (!this.plan.steps.length) this.plan.playing = false;
  };
  /* 轨迹：鲸语引擎的 trajectory 动作。frames = [{time, values:{AngleX,AngleY,AngleZ,PositionX,LeanInput}}]
   * 关键帧之间用 smoothstep 插值，头/身体一起走，演完自动交给鼠标。 */
  NonoBehavior.prototype.startTrajectory = function (s) {
    var frames = (s.frames || []).slice().sort(function (a, b) { return a.time - b.time; });
    if (!frames.length) return;
    this.traj = {
      t0: performance.now(),
      dur: (s.duration || frames[frames.length - 1].time) * 1000,
      frames: frames
    };
  };
  NonoBehavior.prototype.advanceTrajectory = function (now) {
    if (!this.traj) return null;
    var t = (now - this.traj.t0) / 1000;
    if (t >= this.traj.dur / 1000 + 0.4) { this.traj = null; return null; }
    var f = this.traj.frames, a = f[0], b = f[f.length - 1];
    if (t <= f[0].time) b = f[0];
    for (var i = 1; i < f.length; i++) {
      if (t <= f[i].time) { a = f[i - 1]; b = f[i]; break; }
    }
    var u = b.time > a.time ? clamp((t - a.time) / (b.time - a.time), 0, 1) : 1;
    u = u * u * (3 - 2 * u);                       // smoothstep
    var out = {};
    var keys = ['AngleX', 'AngleY', 'AngleZ', 'PositionX', 'LeanInput'];
    for (var k = 0; k < keys.length; k++) {
      var id = keys[k];
      var va = (a.values && a.values[id] !== undefined) ? a.values[id] : 0;
      var vb = (b.values && b.values[id] !== undefined) ? b.values[id] : va;
      out[id] = va + (vb - va) * u;
    }
    return out;
  };

  NonoBehavior.prototype.runPlanStep = function (s) {
    switch (s.type) {
      case 'trajectory':
        this.startTrajectory(s);
        break;
      case 'look':
        this.applyCommand({ action: 'look', target: s.target, duration_ms: s.dur || 0 });
        break;
      case 'expression':
        // 配方里的表情只管表情本身。预设（眼镜/爱心眼）和手势都由配方显式写步骤，
        // 不再偷偷加动作——以前 happy 会自己抬手、serious 会一直戴单片眼镜。
        this.setExpression(s.name, 1, false, s.dur > 0 ? s.dur : 9000);
        break;
      case 'motion':
        this.playMotion(s.group || 'Idle', s.index || 0);
        break;
      case 'preset': {
        // 0号第六轮①:模型自带预设表情(爱心眼/流泪/黑脸…),dur 到点自动复位
        try { this.model.expression(s.name); } catch (e) {}
        if (s.dur > 0) {
          var back2 = { at: s.at + s.dur, type: 'preset_clear' };
          var ins2 = false;
          for (var pi = 0; pi < this.plan.steps.length; pi++) {
            if (this.plan.steps[pi].at > back2.at) { this.plan.steps.splice(pi, 0, back2); ins2 = true; break; }
          }
          if (!ins2) this.plan.steps.push(back2);
        }
        break;
      }
      case 'preset_clear':
        this.resetPreset();
        break;
      case 'angle': {
        // x=偏航(左右) / y=俯仰(上下) / z=侧倾。走 planHead，每帧由 applyHead 读取，
        // 不会像直接写 target 那样被鼠标跟随下一帧拉回去。
        this.planHead = {
          x: isFinite(s.x) ? s.x : 0,
          y: isFinite(s.y) ? s.y : 0,
          z: isFinite(s.z) ? s.z : 0,
          until: s.dur > 0 ? performance.now() + s.dur : Infinity
        };
        if (s.dur > 0) {
          // 到点回正：插一个内部 step，让头「摆过去—停住—回来」
          var back = { at: s.at + s.dur, type: 'angle_back' };
          var inserted = false;
          for (var i = 0; i < this.plan.steps.length; i++) {
            if (this.plan.steps[i].at > back.at) {
              this.plan.steps.splice(i, 0, back); inserted = true; break;
            }
          }
          if (!inserted) this.plan.steps.push(back);
        }
        break;
      }
      case 'angle_back':
        this.planHead = null;
        break;
    }
  };
  /* ---------- 外观：形态 / 鞋子（写的是模型作者的真参数，不是 .exp3 开关） ----------
   * Clothes2 = 大小变：0 原样 / 0.4 中只 / 1.0 小只（实测）
   * Clothes4 = 鞋子：0 穿着 / 1 脱掉（脱鞋.exp3.json 就是 Add 1）
   * 直接写参数而不是走 expression，好处是能跟长裙、尾巴、表情同时存在。
   */
  NonoBehavior.prototype.applyAppearance = function () {
    // 形态：每帧往目标走 12%，约 0.5 秒过渡完——不是啪一下换个人
    if (this.formValue !== this.formTarget) {
      this.formValue += (this.formTarget - this.formValue) * 0.12;
      if (Math.abs(this.formTarget - this.formValue) < 0.004) this.formValue = this.formTarget;
    }
    if (this.exists('Clothes2')) this.setNow('Clothes2', this.formValue);
    if (this.exists('Clothes4')) this.setNow('Clothes4', this.shoeValue);
    // 长裙/短裙、尾巴收放：同样走缓动，不是瞬间换图层
    this.skirtCur += (this.skirtTarget - this.skirtCur) * 0.16;
    if (Math.abs(this.skirtTarget - this.skirtCur) < 0.003) this.skirtCur = this.skirtTarget;
    this.tailCur += (this.tailTarget - this.tailCur) * 0.16;
    if (Math.abs(this.tailTarget - this.tailCur) < 0.003) this.tailCur = this.tailTarget;
    if (this.exists('Clothes1')) this.setNow('Clothes1', this.skirtCur);
    if (this.exists('Clothes5')) this.setNow('Clothes5', this.tailCur);
    // 变小以后她会在半空飘着。实测「大小变」每 1.0 缩掉约 62% 身高，
    // 所以按比例把她往下挪，让脚底留在原来的地面。
    if (this.baseY !== null && this.baseY !== undefined && this.model.height) {
      this.model.y = this.baseY + this.model.height * 0.31 * this.formValue;
    }
  };
  // 窗口改尺寸 / 重新排版后，把「没变小之前的位置」重新记一遍
  NonoBehavior.prototype.noteLayout = function () {
    this.baseY = this.model.y;
  };

  /* 给 get_capabilities 的真实参数范围（behavior 已探测过的） */
  NonoBehavior.prototype.knownRanges = function () {
    var out = {};
    for (var id in this.rangeCache) {
      var r = this.rangeCache[id];
      if (r) out[id] = [r.min, r.max];
    }
    return out;
  };

  /* ---------- 任务4·待机摇摆：4.5 度、0.7 频率，再加一层不匀速 ----------
   * 原来的 2.2 度写的是 ParamBodyAngleX —— 这个参数模型也不认（实测），
   * 所以小海说「看不出来」。现在写进 AngleZ（真正在动的侧倾），
   * 由 applyHead 叠加到头上，不是另开一个写入点去盖转头。
   */
  NonoBehavior.prototype.updateSway = function (dt) {
    this.swayT += dt;
    var t = this.swayT;
    var amp = this.swayAmp * (this.idleAction ? 0.35 : 1);
    if (performance.now() < this.bigSwayUntil) amp *= 2.2;   // 扭一扭
    // 两个很慢的次谐波，让每个波峰不完全一样——匀速正弦看三天就腻
    var wob = 1 + Math.sin(t * 0.21 + 0.7) * 0.22 + Math.sin(t * 0.53 + 2.4) * 0.12;
    this.swayZ = Math.sin(t * 0.7 + 1.2) * 6.2 * amp * wob;
    // ParamBodyAngleX 是尾巴物理的输入（模型身体不认它）：身体横移也喂进去，
    // 这样她往左飘的时候尾巴会晚半拍跟过去——全身一起动，不是只有头在转。
    if (this.exists('ParamBodyAngleX')) {
      this.setRaw('ParamBodyAngleX', this.swayZ * 1.2 + clamp(this.bodyShift * 0.25, -4, 4));
    }
  };

  /* ---------- 动作层：播 motion 期间由动作独占，播完把身体还给她 ----------
   * 借鉴 Soullink 的分层思路：动作、待机、说话各自有「所有权」，
   * 同一时刻只有一层能写同一个参数，避免动作演到一半被呼吸/眨眼拽回去。
   */
  NonoBehavior.prototype.playMotion = function (group, index, opts) {
    var g = String(group || 'Idle');
    // 先清掉「这个动作不用」的另外两个手势；它自己要用的那个留着，
    // 这样「举手→放下」还是连贯动画，不会先啪一下掉下来。
    this.clearHandPoses(true, MOTION_POSE[g]);
    try { this.model.motion(g, index || 0, 'FORCE'); } catch (e) {
      console.warn('[nono] motion 没起来:', e && e.message);
    }
    var dur = MOTION_DUR[g];
    this.motionOn = true;
    this.motionGroup = g;
    this.motionIsReturn = !!RETURN_MOTIONS[g];
    this.motionEndAt = dur ? performance.now() + dur * 1000 : 0;
    this.resetPoseAfter = !!(opts && opts.resetPose);
  };
  /* 把参数放回「模型本来的默认值」——不是最小值。
   * 血的教训：Param39 大臂透视的最小值是 -0.5，默认是 0；
   * 放回最小值会把整条黑袖子折进身体里，看起来就是一团黑影。
   * 用 targets + lerp 过渡，别硬切。
   */
  NonoBehavior.prototype.resetToDefault = function (id) {
    var r = this.range(id);
    if (!r) return;
    var def = this.neutral(id);
    if (!Object.prototype.hasOwnProperty.call(this.defaultCache, id)) {
      try {
        var d = this.core.getParameterDefaultValue(r.idx);
        this.defaultCache[id] = isFinite(d) ? d : def;
      } catch (e) { this.defaultCache[id] = def; }
    }
    def = this.defaultCache[id];
    this.targets[id] = def;
  };
  /* 胳膊形变回「可见手型」：左臂用作者给的基线，右臂回 moc3 默认 */
  NonoBehavior.prototype.resetArmToVisible = function (id) {
    if (Object.prototype.hasOwnProperty.call(this.armPin, id)) {
      this.targets[id] = this.armPin[id];
      return;
    }
    if (Object.prototype.hasOwnProperty.call(LEFT_HAND_BASE, id)) {
      this.targets[id] = LEFT_HAND_BASE[id];
      return;
    }
    if (Object.prototype.hasOwnProperty.call(RIGHT_HAND_BASE, id)) {
      this.targets[id] = RIGHT_HAND_BASE[id];
      return;
    }
    this.resetToDefault(id);
  };
  /* 三个手势参数清零。now=true 立刻写（播新动作前），false 走缓动（动作演完）
   * exceptId：这个动作自己要用的手势，留着不清
   */
  NonoBehavior.prototype.clearHandPoses = function (now, exceptIds) {
    var poses = MOVEMENT_IDS;
    for (var i = 0; i < poses.length; i++) {
      if (exceptIds && exceptIds.indexOf(poses[i]) >= 0) continue;
      if (now) {
        var r = this.range(poses[i]);
        if (r) {
          try { this.core.setParameterValueByIndex(r.idx, this.neutral(poses[i])); } catch (e) {}
        }
        delete this.targets[poses[i]];
      } else {
        this.resetToDefault(poses[i]);
      }
    }
  };
  NonoBehavior.prototype.clearMotionResidue = function (forceArm) {
    // 手势姿势还亮着（Movement1/2/3 > 0.5）就别清胳膊形变——
    // 那是这个姿势自带的胳膊位置，清了会变成两只手叠在一起。
    // forceArm：切回默认手的动作专用，姿势已经收了，胳膊必须一起回默认。
    var poseActive = !forceArm;
    if (poseActive) {
      poseActive = false;
      for (var m = 0; m < MOVEMENT_IDS.length; m++) {
        if (this.exists(MOVEMENT_IDS[m]) && this.getNow(MOVEMENT_IDS[m]) > 0.5) poseActive = true;
      }
    }
    for (var i = 0; i < MOTION_RESIDUE.length; i++) {
      var id = MOTION_RESIDUE[i];
      if (poseActive && ARM_DEFORM.indexOf(id) >= 0) continue;
      if (ARM_DEFORM.indexOf(id) >= 0) this.resetArmToVisible(id);
      else this.resetToDefault(id);
    }
  };
  NonoBehavior.prototype.stopMotion = function () {
    try { this.model.internalModel.motionManager.stopAllMotions(); } catch (e) {}
    this.motionOn = false;
    this.motionEndAt = 0;
    this.motionGroup = '';
    var wasReturn = this.motionIsReturn;
    this.motionIsReturn = false;
    // 待机小表演演完把手放回默认；MCP/菜单点名的动作保持姿势（下次播新动作前会清掉另外两个）
    if (this.resetPoseAfter) this.clearHandPoses(false);
    this.resetPoseAfter = false;
    if (wasReturn) {
      // 「举手切默认手 / 狗尾草切回默认手 / 竖手指切回默认」演完：姿势 + 胳膊形变一起还原（走缓动，别硬切）
      this.clearHandPoses(false);
      this.clearMotionResidue(true);
    } else {
      this.clearMotionResidue();
    }
  };
  /* 预设表情限时：到点自动摘（单片眼镜/圈圈眼这类不能一直戴着） */
  NonoBehavior.prototype.flashPreset = function (name, ms) {
    if (!name) return;
    try { this.model.expression(name); } catch (e) { return; }
    this.presetActive = true;
    this.presetUntil = ms > 0 ? performance.now() + ms : 0;
  };
  /* 真正撤掉预设：库里的 model.expression() 不带参数 = 随机换一个表情！
   * （钢盆/黑框眼镜会自己冒出来的根因）必须走 expressionManager.resetExpression。 */
  NonoBehavior.prototype.resetPreset = function () {
    try {
      var mm = this.model.internalModel && this.model.internalModel.motionManager;
      var em = mm && mm.expressionManager;
      if (em && em.resetExpression) em.resetExpression();
    } catch (e) {}
    this.presetActive = false;
    this.presetUntil = 0;
  };
  /* 静止时把手收干净：没有持久手势时，左右臂都回到「看得见手」的基线。
   * 右手的可见依赖 Movement2 的轻微值；左手的可见靠 Param60=-0.5。
   */
  NonoBehavior.prototype.settleArms = function () {
    if (this.motionOn) return;
    var p1 = this.exists('Movement1') ? this.getNow('Movement1') : 0;
    var p3 = this.exists('Movement3') ? this.getNow('Movement3') : 0;
    if (p1 < 0.15 && p3 < 0.15) {
      if (this.exists('Movement2')) {
        if (Object.prototype.hasOwnProperty.call(this.armPin, 'Movement2')) this.targets['Movement2'] = this.armPin['Movement2'];
        else this.targets['Movement2'] = IDLE_HAND_M2;
      }
      for (var i = 0; i < ARM_DEFORM.length; i++) this.resetArmToVisible(ARM_DEFORM[i]);
    }
  };
  NonoBehavior.prototype.tickMotion = function () {
    if (!this.motionOn) return;
    if (this.motionEndAt) {
      if (performance.now() > this.motionEndAt + 150) this.stopMotion();
      return;
    }
    var mm = this.model.internalModel && this.model.internalModel.motionManager;
    if (mm && !mm.playing) this.stopMotion();
  };
  // 动作期间这些参数归动作管，行为层不许碰
  var MOTION_OWNED = ['AngleX', 'AngleY', 'AngleZ', 'LeanInput', 'PositionX', 'PositionY', 'PositionZ',
    'ParamEyeLOpen', 'ParamEyeROpen', 'ParamMouthOpenY', 'ParamMouthForm', 'JawOpen'];
  // trajectory（鲸语引擎式关键帧）优先级高于动作：演轨迹时头/身体/位置不被动作抢走
  var TRAJ_OWNED = ['AngleX', 'AngleY', 'AngleZ', 'LeanInput', 'PositionX'];
  /* ---------- 0号 Task-E-02 选项A:尾巴行波(根→梢相位延迟正弦,弧长超线性) ----------
   * 2026-11-07：按表情分档（TAIL_MOODS）。相位累加而不是用绝对时间，
   * 速度一变不会跳；幅度和速度都缓动过去。
   */
  NonoBehavior.prototype.tickTail = function (dt) {
    if (this.idleAction || this.sayPlan) return;  // 别和动作/说话打架
    var m = TAIL_MOODS[(this.expr && this.expr.name) || 'idle'] || TAIL_MOODS.idle;
    var k = clamp(dt * 3, 0, 1);
    this.tailAmp += (m.amp - this.tailAmp) * k;
    this.tailSpeed += (m.speed - this.tailSpeed) * k;
    this.tailPhase += dt * 1.6 * this.tailSpeed;
    var s = [0.15, 0.55, 1.0];                     // 弧长位置:根/中/梢
    var ids = ['Param_Angle_Rotation84', 'Param_Angle_Rotation85', 'Param_Angle_Rotation86'];
    for (var i = 0; i < 3; i++) {
      var a = Math.pow(s[i], 1.4) * this.tailAmp;  // 超线性:根部微、梢部甩
      var w = Math.sin(this.tailPhase - s[i] * 4) * a;  // 相位延迟波
      this.setRaw(ids[i], w);
    }
  };

  /* 轨迹应用：头/身体/位置一起走。动作期间也要继续推进，否则动作一停轨迹会「跳一下」 */
  NonoBehavior.prototype.applyTrajectoryFrame = function (dt, now) {
    var tr = this.advanceTrajectory(now);
    if (!tr) return false;
    this.setSigned('ParamEyeBallX', clamp((tr.AngleX || 0) / 30, -1, 1) * 0.55);
    this.setSigned('ParamEyeBallY', clamp((tr.AngleY || 0) / 24, -1, 1) * 0.45);
    this.applyHead(dt, tr.AngleX || 0, tr.AngleY || 0, tr.AngleZ || 0, tr.LeanInput || -2);
    if (this.exists('PositionX')) this.setRaw('PositionX', clamp(tr.PositionX || 0, -50, 50));
    return true;
  };
  /* 动作期间的小幅跟随：只写头角，幅度 40%，让动作看起来不是定格 */
  NonoBehavior.prototype.lightLook = function (dt) {
    if (this.applyTrajectoryFrame(dt, performance.now())) return;
    var ex = clamp((this.mouseSX - 0.5) * 2, -1, 1) * 0.82;
    var ey = clamp((0.5 - this.mouseSY) * 2, -1, 1) * 0.82;
    this.applyHead(dt, ex * 6, ey * 4, ex * -3, -2);
  };

  /* ---------- 主循环 ---------- */
  NonoBehavior.prototype.update = function (dt) {
    dt = Math.min(dt, 0.05);
    this.frameTime += dt * 1000;
    // 2026-11-07 小海反馈：启动瞬间手在裙子后面、然后跑到前面。
    // 原因是启动时手臂靠 settleArms 慢慢插值到基线。这里第一帧直接把基线姿态拍上去，从第一眼就是最终姿势。
    if (!this.booted) {
      this.booted = true;
      this.setRaw('Movement2', IDLE_HAND_M2);
      for (var bk in LEFT_HAND_BASE) {
        if (LEFT_HAND_BASE.hasOwnProperty(bk)) this.setRaw(bk, LEFT_HAND_BASE[bk]);
      }
      for (var rk in RIGHT_HAND_BASE) {
        if (RIGHT_HAND_BASE.hasOwnProperty(rk)) this.setRaw(rk, RIGHT_HAND_BASE[rk]);
      }
    }
    if (this.expr && !this.holdExpr && performance.now() > this.expr.until) {
      this.clearExpression();
      if (this.presetActive) this.resetPreset();
    }
    if (this.presetActive && this.presetUntil && performance.now() > this.presetUntil) {
      this.resetPreset();
    }
    // 彩蛋：偷偷打了个小嗝（稀有：50-150 分钟一次；打嗝的音效和气泡由渲染层接）
    var nowMs = performance.now();
    if (nowMs > this.hiccupNextAt) {
      this.hiccupNextAt = nowMs + rand(50 * 60000, 150 * 60000);
      this.setExpression('surprised', 0.45, false, 900);
      this.idleAction = { name: '打嗝一缩', dur: 0.4, t0: nowMs,
        targets: { AngleY: -4, ParamBodyAngleX: 5 } };
      if (this.onHiccup) { try { this.onHiccup(); } catch (e) {} }
    }
    // 3-5 分钟来一次大幅全身摇摆（脱捕那种「整体在动」的感觉）
    if (performance.now() > this.bigSwayNextAt && !this.motionOn) {
      this.bigSwayUntil = performance.now() + 2600;
      this.bigSwayNextAt = performance.now() + rand(180000, 300000);
    }
    this.tickMotion();
    this.settleArms();   // 动作没在演时，把残留的举手过渡/胳膊形变慢慢收回默认
    // 连点队列：上一个戳的反应演完了，接下一个
    if (this.pokeQueue && this.pokeQueue.length && performance.now() > this.pokeBusyUntil) {
      var pz = this.pokeQueue.shift();
      if (this.onQueuedPoke) { try { this.onQueuedPoke(pz); } catch (ep) {} }
    }
    var motionOwns = this.motionOn;
    var isTuobo = motionOwns && this.motionGroup === '脱捕';
    this.updateBreath(dt);
    // 鼠标低通每帧都走：动作期间头也在微跟（lightLook），不能等他回到待机才补
    this.smoothCursor(dt);
    // 动作演着也眨眼、也小声呼吸——以前一刀切全停，她一举手就像木头人
    if (!isTuobo) this.updateBlink(dt);
    if (!motionOwns) this.updateLook(dt);
    else if (!isTuobo) this.lightLook(dt);   // 动作期间头也跟着鼠标微动，幅度小，不抢动作
    this.updateAction(dt);                   // 只写 targets，动作独占的参数会被挡掉
    this.updateTimeSense(dt);
    // petbox 同款·待机摇摆(小海要的「更流畅灵巧」):肩/身/头各自相位的正弦,幅度很小——像在水里
    this.updateSway(dt);
    // 0号 Task-E-02 选项A:尾巴行波——根→梢相位延迟的正弦波,弧长超线性
    this.tickTail(dt);
    this.updateMouth();   // 口型 targets，动作独占的嘴部参数会自动让位
    // 0号第三轮任务二：时间轴先走（它产生的 targets 会被 activity/情绪正常覆盖接力）
    this.tickPlan();
    // 0号想法①③c：activity身体语言 + 凌晨入睡（都在表情叠加前，让位给情绪）
    if (!motionOwns) {
      this.updateDawnSleep();
      this.updateActivity();
    }
    // 表情最后叠加：情绪优先于眼珠跟随 / 空闲动作，否则歪头会被每帧拉回
    if (!motionOwns) for (var eid in this.exprTargets) this.targets[eid] = this.exprTargets[eid];
    // 真说话时：用音频算出来的开合盖掉旧口型（比随机音节准）
    if (!motionOwns && this.voiceLevel !== null && this.voiceLevel !== undefined) {
      this.targets['ParamMouthOpenY'] = this.voiceLevel;
    }
    for (var id in this.targets) {
      // 动作演着，别拽她；但 trajectory 是更高优先级：头/身体/位置归它，手臂仍归动作
      if (motionOwns && MOTION_OWNED.indexOf(id) >= 0 && !(this.traj && TRAJ_OWNED.indexOf(id) >= 0)) continue;
      this.lerpTo(id, dt);
    }
    this.applyOverlays(dt);
    this.applyAppearance();
  };

  /* ---------- 鼠标 / 互动层 ---------- */
  NonoBehavior.prototype.attachMouseEvents = function () {
    var self = this;
    var lastX = null, lastY = null, lastT = 0;
    document.addEventListener('mousemove', function (e) {
      var now = performance.now();
      var nx = e.clientX / window.innerWidth, ny = e.clientY / window.innerHeight;
      if (lastX !== null && lastT) {
        var d = Math.abs(nx - lastX) + Math.abs(ny - lastY);
        var secs = Math.max((now - lastT) / 1000, 0.001);
        self.lastMouseSpeed = d / secs;
        // 快速划过她：眨一下，像被吓到
        if (self.lastMouseSpeed > 2.5 && d > 0.15) self.triggerBlink(false);
      }
      lastX = nx; lastY = ny; lastT = now;
      self.mouseX = nx; self.mouseY = ny;
      self.lastMouseMove = now;
      self.pointerInside = true;

      // 彩蛋：眼神追着画圈的鼠标（像猫）。0.9 秒窗口内累计转角够大就追 2 秒
      var cnow = performance.now();
      self.circleBuf.push({ x: nx, y: ny, t: cnow });
      while (self.circleBuf.length && cnow - self.circleBuf[0].t > 900) self.circleBuf.shift();
      if (cnow > self.circleCoolUntil && self.circleBuf.length >= 6) {
        var acc = 0;
        for (var ci = 2; ci < self.circleBuf.length; ci++) {
          var a0 = self.circleBuf[ci - 1], a1 = self.circleBuf[ci - 2], a2 = self.circleBuf[ci];
          var v1x = a0.x - a1.x, v1y = a0.y - a1.y;
          var v2x = a2.x - a0.x, v2y = a2.y - a0.y;
          var m1 = Math.sqrt(v1x * v1x + v1y * v1y), m2 = Math.sqrt(v2x * v2x + v2y * v2y);
          if (m1 > 0.01 && m2 > 0.01) {
            var cosA = clamp((v1x * v2x + v1y * v2y) / (m1 * m2), -1, 1);
            acc += Math.abs(Math.acos(cosA));
          }
        }
        if (acc > 11) {   // 约两整圈
          var span = cnow - self.circleBuf[0].t;
          self.circleCoolUntil = cnow + 60000;
          self.circleBuf.length = 0;
          if (span < 620) {
            /* 2026-11-07 参考 petbox「绕圈生气」：绕得又快又急 = 把她绕晕了，
             * 眩晕 → 嫌弃 → 黑脸 + 手放胸前那种气鼓鼓，进 60 秒冷却。 */
            self.setExpression('surprised', 0.75, false, 900);
            self.idleAction = { name: '被绕晕', dur: 1.3, t0: cnow,
              targets: { AngleZ: 14, AngleX: -6, ParamEyeBallY: -0.35 } };
            if (self.onCircleAngry) { try { self.onCircleAngry(); } catch (e) {} }
            var s2 = self;
            setTimeout(function () {
              s2.setExpression('angry', 0.85, false, 3600);
              if (s2.flashPreset) s2.flashPreset('黑脸', 2600);
              s2.idleAction = { name: '嫌弃', dur: 1.1, t0: performance.now(),
                targets: { AngleZ: -10, AngleY: 8, ParamBodyAngleX: 4 } };
            }, 900);
          } else {
            self.circleUntil = cnow + 2000;
            self.setExpression('excited', 0.5, false, 1800);
          }
        }
      }
      if (cnow < self.circleUntil) {
        // 追圈中：眼珠全速跟着，头也摆起来
        self.setSigned('ParamEyeBallX', clamp((nx - 0.5) * 2, -1, 1) * 0.95);
        self.setSigned('ParamEyeBallY', clamp((0.5 - ny) * 2, -1, 1) * 0.95);
        self.headZ = clamp((nx - 0.5) * 2, -1, 1) * -9;   // 追圈时头也跟着摆
      }
    });
    document.addEventListener('mouseleave', function () { self.pointerInside = false; });
    // 点击 / 摸头 / 拖动已移交 js/interact.js（互动层），这里只管视线和快速划过
    document.addEventListener('mouseenter', function () { self.hoverSince = performance.now(); });
  };

  // 桌面版：主进程每帧推全局光标。只有坐标真的变了才刷新「最后移动时间」，
  // 否则每 16ms 一推会让「停住 2 秒回正」永远触发不了。
  NonoBehavior.prototype.setCursorAbsolute = function (x, y, w, h) {
    var nx = x / w, ny = y / h;
    if (Math.abs(nx - this.mouseX) > 0.001 || Math.abs(ny - this.mouseY) > 0.001) {
      this.mouseX = nx; this.mouseY = ny;
      this.lastMouseMove = performance.now();
    }
  };

  /* ---------- 拖动的身体感（0号 3.3：滞后感 + 放下站稳） ----------
   * 窗口本身是硬跟手的，弹性做在她身上：拖着走时身体往反方向歪一点，
   * 松手时轻轻弹一下站稳。lean 是 -1~1（interact 层按拖动速度算）。
   */
  NonoBehavior.prototype.startDrag = function () {
    this.dragging = true;
  };
  NonoBehavior.prototype.dragLean = function (lean) {
    if (!this.dragging) return;
    this.headZ = clamp(lean, -1, 1) * -14;    // 直接改头的侧倾状态，由 applyHead 写出去
    this.setRaw('ParamBodyAngleX', clamp(lean, -1, 1) * -10);
  };
  NonoBehavior.prototype.endDrag = function () {
    if (!this.dragging) return;
    this.dragging = false;
    this.idleAction = { name: '站稳', dur: 0.6, t0: performance.now(),
      targets: { AngleZ: 5, ParamBodyAngleX: 6 } };
  };

  window.NonoBehavior = NonoBehavior;
})();
