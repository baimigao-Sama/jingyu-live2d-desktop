/* 鲸诺海 · MCP server（内嵌在 Electron 主进程，不另起进程）
 * 依据 0 号《MCP接口规格-live2d.md》
 *
 * 传输：本地 HTTP + SSE，默认 http://127.0.0.1:8768/mcp
 * 协议：JSON-RPC 2.0 / MCP（initialize、tools/list、tools/call、ping…）
 * 兼容两种接法：
 *   新版 Streamable HTTP —— POST /mcp（JSON 或 SSE 响应）、GET /mcp（SSE 通道）、DELETE /mcp
 *   旧版 HTTP+SSE     —— GET /sse、POST /messages?sessionId=…
 *
 * 三条硬规矩：
 *   1. 一切可打断：工具调用直接转成覆盖式指令，不排队（行为层本身也是覆盖式）
 *   2. 不机器人：随机眨眼/不匀速口型都在 behavior.js，MCP 只下意图
 *   3. 安全默认值：DELETE / 连接断开 / 3 分钟无调用且状态非默认 → 自动复位
 *
 * 无第三方依赖，纯 Node http 实现，方便以后开源。
 */
'use strict';

const http = require('http');
const crypto = require('crypto');

const PORTS = [8768, 8769, 8770];
const IDLE_RESET_MS = 3 * 60 * 1000;   // 断线 watchdog
const HEARTBEAT_MS = 15000;

const SERVER_INFO = {
  name: 'nono-live2d-body',
  version: '1.0.0',
  displayName: '鲸诺海 的身体'
};
const PROTOCOL_VERSION = '2024-11-05';

/* ---------------- 工具清单（0 号规格 §三） ---------------- */
const TOOLS = [
  {
    name: 'set_expression',
    description: '换表情。几乎所有情绪都走它。可被打断：再次调用直接盖掉上一次。',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          enum: ['idle', 'happy', 'shy', 'sad', 'serious', 'sleepy', 'excited', 'surprised', 'thinking', 'angry', 'smile', 'typing'],
          description: '表情名'
        },
        intensity: { type: 'number', minimum: 0, maximum: 1, description: '强度 0-1，默认 1' },
        duration_ms: { type: 'number', minimum: 0, description: '0 = 一直保持；>0 = 多少毫秒后自动回 idle' }
      },
      required: ['name']
    }
  },
  {
    name: 'set_blink',
    description: '眨眼控制。日常不用调，只在说到关键处让她睁大眼不眨时用。stop 最多保持 3 秒，会自动恢复。',
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['auto', 'stop', 'slow', 'one'], description: 'auto 自动 / stop 停止 / slow 变慢 / one 眨一次' }
      },
      required: ['mode']
    }
  },
  {
    name: 'look_at',
    description: '让她看哪儿。duration_ms 之后自动回 cursor（看鼠标）。',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', enum: ['cursor', 'user', 'away', 'down'], description: 'cursor 看鼠标 / user 看屏幕中心偏左（小海坐的位置）/ away 看向别处 / down 低头' },
        duration_ms: { type: 'number', minimum: 0, description: '0 = 一直保持；>0 = 多少毫秒后回 cursor' }
      },
      required: ['target']
    }
  },
  {
    name: 'say',
    description: '说话时的口型（不负责 TTS 播放）。按文本字数做不匀速开合，逗号句号处停顿，说完嘴回到 0。',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要说的句子' },
        duration_ms: { type: 'number', minimum: 0, description: '总时长，默认按字数估算' }
      },
      required: ['text']
    }
  },
  {
    name: 'get_state',
    description: '现在是什么状态。鲸诺调之前先看一眼，省得盲目覆盖。',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'play_motion',
    description: '播模型自带的动作。group 可用：Idle、举手切默认手、默认手切举手、竖手指切出来动画、竖手指切回默认、脱捕、狗尾草切换出来、狗尾草切回默认手。',
    inputSchema: {
      type: 'object',
      properties: {
        group: { type: 'string', description: '动作组名' },
        index: { type: 'number', description: '组内序号，默认 0' }
      },
      required: ['group']
    }
  },
  {
    name: 'stage_bubble',
    description: '在她上半身随机位置冒一颗小圆泡（想事情/干活时用）。跟 say 的区别：say 是说话的大气泡，stage_bubble 是小泡泡飘。',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '气泡文字' },
        ms: { type: 'number', description: '持续毫秒,默认随机2-4秒' }
      },
      required: ['text']
    }
  },
  {
    name: 'set_activity',
    description: '告诉她「你正在做什么」——她不是摆姿势，是有正事在干。reading=读东西(眼睛左右扫)/waiting=跑命令等结果(撑下巴歪头)/done=写完了(伸懒腰)/error=出错了(先皱眉,然后抬眼看他一眼)/idle=闲了。出错那条最像人:不闷头重试,先看你。',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          enum: ['idle', 'reading', 'waiting', 'done', 'error'],
          description: '活动名'
        },
        duration_ms: { type: 'number', minimum: 0, description: '持续多久,默认 0=一直保持到下次调用(3分钟无调用watchdog兜底)' }
      },
      required: ['name']
    }
  },
  {
    name: 'get_capabilities',
    description: '先问她有什么——返回模型真实的表情列表、动作组和参数范围。发 set_expression / play_plan 之前先看这里，别发模型做不到的动作。',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'play_plan',
    description: '表演一条时间线(复杂动作)。steps 按 at(毫秒,相对起点) 依次触发;同类型自动排队,不同类型(表情+转头)可并行;interruptible=true 可被新计划打断。会先校验:at递增/类型认识/表情与动作真实存在/角度自动夹紧,不合法整条拒绝。',
    inputSchema: {
      type: 'object',
      properties: {
        steps: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              at: { type: 'number', description: '相对起点的毫秒' },
              type: { type: 'string', enum: ['look', 'expression', 'angle', 'motion', 'preset', 'trajectory'], description: '动作类型' },
              name: { type: 'string', description: 'expression/preset 用:名字(preset 是模型自带中文名,如「爱心眼」)' },
              target: { type: 'string', description: 'look用: cursor/user/away/down' },
              name: { type: 'string', description: 'expression用: 表情名(先get_capabilities查)' },
              group: { type: 'string', description: 'motion用: 动作组名' },
              x: { type: 'number', description: 'angle用: 偏航/左右转头(度,自动夹紧)' },
              y: { type: 'number', description: 'angle用: 俯仰/上下点头' },
              z: { type: 'number', description: 'angle用: 侧倾/歪头' },
              dur: { type: 'number', description: 'expression/angle 的持续时间(毫秒),0=保持' },
              duration: { type: 'number', description: 'trajectory 用: 总时长(秒),默认取最后一帧' },
              frames: {
                type: 'array',
                description: 'trajectory 用: 关键帧 [{time(秒), values:{AngleX,AngleY,AngleZ,PositionX,LeanInput}}],点间 smoothstep 插值',
                items: { type: 'object', properties: { time: { type: 'number' }, values: { type: 'object' } }, required: ['time', 'values'] }
              }
            },
            required: ['at', 'type']
          }
        },
        interruptible: { type: 'boolean', description: '默认 true。false=演完才接新计划' }
      },
      required: ['steps']
    }
  },
  {
    name: 'stop',
    description: '表演结束的「收」——平滑回到待机(表情淡出、目标回正),不是硬切。硬切很惊悚。',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'play_recipe',
    description: '按名字播动作库里的现成配方(被夸了/害羞/生气了/困了/想你了/干活中/出错了/被吓一跳/摸摸头/害羞侧目/左顾右盼/打招呼/被发现偷看/困到点头/凑近偷看/追着尾巴看/听到声音回头/害羞抚胸)。比手写 play_plan 稳——配方都校验过。名字列表见 get_capabilities 的 recipes。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '配方名,如「被夸了」' }
      },
      required: ['name']
    }
  }
];

/* ---------------- server ---------------- */
function createMcp(opts) {
  const onCommand = opts.onCommand || function () {};
  const onReset = opts.onReset || function () {};
  const log = opts.log || function () {};

  let server = null;
  let port = PORTS[0];
  const sseClients = new Map();      // sessionId -> res
  let stateCache = {
    expression: 'idle', blinking: 'auto', looking: 'cursor', talking: false,
    activity: 'idle',
    last_interaction_ms: 0
  };
  // 模型能力（0号第三轮任务一）：get_capabilities 的数据源
  // 主进程从 model3.json 填 expressions/motions，渲染进程回传真实参数范围
  let capabilities = { expressions: [], motions: [], parameters: {} };
  // 动作配方库（0号第四轮项目03）：主进程从 recipes\ 读进来的现成表演
  const recipes = opts.recipes || {};
  let lastCallAt = Date.now();      // 任何调用（含 get_state），用于 watchdog
  let lastActionAt = Date.now();    // 真正的「动作」调用，用于 get_state 的 last_interaction_ms
  let hadSession = false;
  let watchdog = null;

  function updateState(s) {
    if (s && typeof s === 'object') stateCache = Object.assign({}, stateCache, s);
  }

  function updateCapabilities(c) {
    if (c && typeof c === 'object') {
      capabilities = Object.assign({}, capabilities, c);
      if (!capabilities.recipes) capabilities.recipes = Object.keys(recipes);
      log('[MCP] 能力表更新：表情' + capabilities.expressions.length +
          ' / 动作组' + capabilities.motions.length +
          ' / 参数' + Object.keys(capabilities.parameters).length +
          ' / 配方' + capabilities.recipes.length);
    }
  }

  /* 0号第三轮任务二：play_plan 校验。不合法整条拒绝，不默默改 */
  function validatePlan(steps) {
    if (!Array.isArray(steps) || steps.length === 0) return 'steps 不能为空';
    let lastAt = -1;
    const exprAt = {};   // 同一时刻不允许两个表情
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i] || {};
      if (typeof s.at !== 'number' || s.at < 0) return '第' + i + '步: at 必须是非负毫秒数';
      if (s.at < lastAt) return '第' + i + '步: at 必须递增或相等（' + s.at + ' < ' + lastAt + '）';
      lastAt = s.at;
      if (['look', 'expression', 'angle', 'motion', 'preset', 'trajectory'].indexOf(s.type) < 0) {
        return '第' + i + '步: 不认识的 type "' + s.type + '"（可用 look/expression/angle/motion/preset/trajectory）';
      }
      if (s.type === 'trajectory') {
        // 鲸语引擎式关键帧：time 秒 + values（AngleX/Y/Z、PositionX、LeanInput）
        if (!Array.isArray(s.frames) || !s.frames.length) return '第' + i + '步: trajectory 需要非空 frames';
        let lastT = -1;
        for (const f of s.frames) {
          if (!f || typeof f.time !== 'number' || f.time < 0) return '第' + i + '步: frame.time 必须是非负秒数';
          if (f.time < lastT) return '第' + i + '步: frame.time 必须递增';
          lastT = f.time;
          if (!f.values || typeof f.values !== 'object') return '第' + i + '步: frame 缺少 values';
        }
      }
      if (s.type === 'preset') {
        // 0号第六轮①:模型自带预设表情(中文名),按 capabilities.presets 验名,找不到就报错
        if (capabilities.presets && capabilities.presets.length && capabilities.presets.indexOf(s.name) < 0) {
          return '第' + i + '步: 模型没有预设表情 "' + s.name + '"（先 get_capabilities 查 presets）';
        }
      }
      if (s.type === 'expression') {
        if (capabilities.expressions.length &&
            capabilities.expressions.indexOf(s.name) < 0 &&
            ['idle','happy','shy','sad','serious','sleepy','excited','surprised','thinking','angry','smile','typing'].indexOf(s.name) < 0) {
          return '第' + i + '步: 模型没有表情 "' + s.name + '"（先 get_capabilities 查）';
        }
        if (exprAt[s.at]) return '第' + i + '步: 同一时刻(' + s.at + ')有两个 expression，冲突';
        exprAt[s.at] = true;
      }
      if (s.type === 'motion' && capabilities.motions.length &&
          capabilities.motions.indexOf(s.group) < 0) {
        return '第' + i + '步: 模型没有动作组 "' + s.group + '"（先 get_capabilities 查）';
      }
      if (s.type === 'angle' && capabilities.parameters) {
        // 角度自动夹紧（0号：别让她眼珠飞出眼眶）
        [['x', 'AngleX'], ['y', 'AngleY'], ['z', 'AngleZ']].forEach(function (pair) {
          const r = capabilities.parameters[pair[1]];
          if (r && typeof s[pair[0]] === 'number') {
            s[pair[0]] = Math.max(r[0], Math.min(r[1], s[pair[0]]));
          }
        });
      }
    }
    return null;
  }

  function safeReset(reason) {
    // 4.3 安全默认值：表情 idle / 眨眼 auto / 视线 cursor / 嘴闭合 / 活动 idle
    log('[MCP] 复位（' + reason + '）');
    onReset();
    stateCache = { expression: 'idle', blinking: 'auto', looking: 'cursor', talking: false, activity: 'idle', last_interaction_ms: 0 };
    lastCallAt = Date.now();
    lastActionAt = lastCallAt;
  }

  function sendSse(res, event, data) {
    if (res.writableEnded) return;
    try {
      if (event) res.write('event: ' + event + '\n');
      res.write('data: ' + JSON.stringify(data) + '\n\n');
    } catch (e) {}
  }

  function toolResult(text, isError) {
    return { content: [{ type: 'text', text: String(text) }], isError: !!isError };
  }

  /* 工具 → 覆盖式指令。所有状态都带自动过期，不排队 */
  function callTool(name, args) {
    args = args || {};
    lastCallAt = Date.now();
    if (name !== 'get_state') lastActionAt = lastCallAt;
    hadSession = true;
    switch (name) {
      case 'set_expression': {
        const expr = String(args.name || 'idle');
        const cmd = { action: 'expression', name: expr,
          intensity: args.intensity === undefined ? 1 : Number(args.intensity) };
        const ms = Number(args.duration_ms) || 0;
        if (ms > 0) cmd.duration_ms = ms;
        else cmd.hold = true;                   // 0 = 一直保持，靠 watchdog 兜底
        onCommand(cmd);
        return toolResult('{"ok":true,"expression":' + JSON.stringify(expr) + ',"duration_ms":' + ms + '}');
      }
      case 'set_blink': {
        const mode = String(args.mode || 'auto');
        onCommand({ action: 'blink', mode: mode });
        return toolResult('{"ok":true,"blinking":' + JSON.stringify(mode) + '}');
      }
      case 'look_at': {
        const target = String(args.target || 'cursor');
        const ms = Number(args.duration_ms) || 0;
        onCommand({ action: 'look', target: target, duration_ms: ms });
        return toolResult('{"ok":true,"looking":' + JSON.stringify(target) + ',"duration_ms":' + ms + '}');
      }
      case 'say': {
        const text = String(args.text || '');
        const ms = Number(args.duration_ms) || 0;
        onCommand({ action: 'say', text: text, duration_ms: ms });
        return toolResult('{"ok":true,"talking":true,"chars":' + text.length + '}');
      }
      case 'get_state': {
        return toolResult(JSON.stringify(Object.assign({}, stateCache, {
          last_interaction_ms: Math.max(0, Date.now() - lastActionAt)
        })));
      }
      case 'play_motion': {
        const group = String(args.group || 'Idle');
        onCommand({ action: 'motion', group: group, index: Number(args.index) || 0 });
        return toolResult('{"ok":true,"group":' + JSON.stringify(group) + '}');
      }
      case 'set_activity': {
        const act = String(args.name || 'idle');
        const ms = Number(args.duration_ms) || 0;
        const cmd = { action: 'activity', name: act };
        if (ms > 0) cmd.duration_ms = ms; else cmd.hold = true;
        onCommand(cmd);
        return toolResult('{"ok":true,"activity":' + JSON.stringify(act) + '}');
      }
      case 'get_capabilities':
        return toolResult(JSON.stringify(capabilities));
      case 'play_plan': {
        const steps = Array.isArray(args.steps) ? args.steps : [];
        const bad = validatePlan(steps);
        if (bad) return toolResult('{"ok":false,"error":' + JSON.stringify(bad) + '}', true);
        onCommand({ action: 'plan', steps: steps, interruptible: args.interruptible !== false });
        return toolResult('{"ok":true,"steps":' + steps.length + ',"interruptible":' + (args.interruptible !== false) + '}');
      }
      case 'stage_bubble': {
        const text = String(args.text || '');
        const ms = Number(args.ms) || 3000;
        onCommand({ action: 'stage_bubble', text: text, ms: ms });
        return toolResult('{"ok":true,"text":' + JSON.stringify(text) + ',"ms":' + ms + '}');
      }
      case 'stop':
        onCommand({ action: 'plan_stop' });
        return toolResult('{"ok":true,"stopped":true}');
      case 'play_recipe': {
        const rn = String(args.name || '');
        const r = recipes[rn];
        if (!r) {
          const names = Object.keys(recipes).join('/');
          return toolResult('{"ok":false,"error":' + JSON.stringify('没有配方「' + rn + '」，可用：' + names) + '}', true);
        }
        const bad = validatePlan(r.steps || []);
        if (bad) return toolResult('{"ok":false,"error":' + JSON.stringify('配方本身坏了:' + bad) + '}', true);
        onCommand({ action: 'plan', steps: r.steps, interruptible: true });
        return toolResult('{"ok":true,"recipe":' + JSON.stringify(rn) + ',"steps":' + (r.steps || []).length + '}');
      }
      default:
        return toolResult('未知工具：' + name, true);
    }
  }

  function rpcError(id, code, message) {
    return { jsonrpc: '2.0', id: id === undefined ? null : id,
      error: { code: code, message: String(message) } };
  }

  function handleRpc(msg) {
    if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0') {
      return rpcError(msg && msg.id, -32600, 'Invalid Request');
    }
    const id = msg.id;
    const method = msg.method;
    const params = msg.params || {};
    const isNotification = id === undefined || id === null;

    if (method === 'initialize') {
      return { jsonrpc: '2.0', id: id, result: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false }, resources: {}, prompts: {} },
        serverInfo: SERVER_INFO
      } };
    }
    if (method === 'notifications/initialized' || method === 'notifications/cancelled') return null;
    if (method === 'ping') return { jsonrpc: '2.0', id: id, result: {} };
    if (method === 'tools/list') return { jsonrpc: '2.0', id: id, result: { tools: TOOLS } };
    if (method === 'tools/call') {
      const name = params.name;
      const res = callTool(name, params.arguments);
      return { jsonrpc: '2.0', id: id, result: res };
    }
    if (method === 'resources/list') return { jsonrpc: '2.0', id: id, result: { resources: [] } };
    if (method === 'resources/templates/list') return { jsonrpc: '2.0', id: id, result: { resourceTemplates: [] } };
    if (method === 'prompts/list') return { jsonrpc: '2.0', id: id, result: { prompts: [] } };
    if (isNotification) return null;
    return rpcError(id, -32601, 'Method not found: ' + method);
  }

  function processBody(body, res, sseMode, sessionId) {
    let msg;
    try { msg = JSON.parse(body); }
    catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(rpcError(null, -32700, 'Parse error')));
      return;
    }
    const list = Array.isArray(msg) ? msg : [msg];
    const out = list.map(handleRpc).filter(Boolean);
    if (out.length === 0) {                   // 纯通知
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end('');
      return;
    }
    const payload = Array.isArray(msg) ? out : out[0];
    if (sseMode) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache', 'Connection': 'keep-alive'
      });
      sendSse(res, 'message', payload);
      res.end();
    } else {
      // 旧版 SSE 客户端：结果同时推一份到它的 SSE 通道
      if (sessionId && sseClients.has(sessionId)) sendSse(sseClients.get(sessionId), 'message', payload);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(payload));
    }
  }

  function handler(req, res) {
    const u = new URL(req.url, 'http://127.0.0.1');
    const path = u.pathname;
    /* 安全（2026-11-10）：
     * 1) 不开 CORS（原来这里是对 * 放行）——本地 MCP 客户端不走 CORS，
     *    浏览器里任何网页没有 CORS 就读不到响应、也过不了预检。
     * 2) 即使读不到响应，「简单请求」仍能把副作用发过来。所以再有两条硬拦截：
     *    · 带 Origin 且不是本机页面 → 403（MCP 客户端/CLI 不带 Origin）
     *    · POST 只认 application/json（text/plain 等跨源简单请求类型直接拒）
     */
    const origin = req.headers.origin;
    if (origin && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(String(origin))) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('forbidden origin');
      return;
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, Mcp-Session-Id, MCP-Protocol-Version');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    if (path === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, name: SERVER_INFO.name, port: port,
        sessions: sseClients.size, state: stateCache }));
      return;
    }

    // 新版 Streamable HTTP：GET /mcp 建立 SSE 通知通道
    if (path === '/mcp' && req.method === 'GET') {
      const sid = crypto.randomUUID();
      hadSession = true;
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache', 'Connection': 'keep-alive',
        'Mcp-Session-Id': sid
      });
      res.write(': connected\n\n');
      sseClients.set(sid, res);
      const hb = setInterval(function () {
        if (res.writableEnded) { clearInterval(hb); return; }
        res.write(': ping\n\n');
      }, HEARTBEAT_MS);
      req.on('close', function () {
        clearInterval(hb);
        sseClients.delete(sid);
        if (sseClients.size === 0 && hadSession) safeReset('所有 MCP 连接已断开');
      });
      return;
    }

    // 旧版：GET /sse
    if (path === '/sse' && req.method === 'GET') {
      const sid = crypto.randomUUID();
      hadSession = true;
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache', 'Connection': 'keep-alive'
      });
      sseClients.set(sid, res);
      res.write('event: endpoint\ndata: /messages?sessionId=' + sid + '\n\n');
      const hb = setInterval(function () {
        if (res.writableEnded) { clearInterval(hb); return; }
        res.write(': ping\n\n');
      }, HEARTBEAT_MS);
      req.on('close', function () {
        clearInterval(hb);
        sseClients.delete(sid);
        if (sseClients.size === 0 && hadSession) safeReset('所有 MCP 连接已断开');
      });
      return;
    }

    if ((path === '/mcp' || path === '/messages') && req.method === 'POST') {
      // 只收 JSON：挡掉 text/plain / form 这类可绕预检的简单请求
      const ctype = String(req.headers['content-type'] || '').toLowerCase();
      if (ctype.indexOf('application/json') < 0) {
        res.writeHead(415, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('unsupported media type');
        return;
      }
      let body = '';
      req.on('data', function (c) { body += c; });
      req.on('end', function () {
        const sid = u.searchParams.get('sessionId');
        const sseMode = String(req.headers.accept || '').indexOf('text/event-stream') >= 0;
        processBody(body, res, sseMode, sid);
      });
      return;
    }

    if (path === '/mcp' && req.method === 'DELETE') {
      safeReset('客户端主动关闭会话');
      res.writeHead(200); res.end('');
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not found');
  }

  function start() {
    return new Promise(function (resolve, reject) {
      let i = 0;
      function attempt() {
        server = http.createServer(handler);
        server.once('error', function (e) {
          i += 1;
          if (i < PORTS.length) {
            log('[MCP] ' + PORTS[i - 1] + ' 被占，换 ' + PORTS[i]);
            attempt();
          } else reject(e);
        });
        server.listen(PORTS[i], '127.0.0.1', function () {
          port = PORTS[i];
          server.removeAllListeners('error');
          log('[MCP] http://127.0.0.1:' + port + '/mcp 就绪（七个工具）');
          watchdog = setInterval(function () {
            if (!hadSession) return;
            const dirty = stateCache.expression !== 'idle' || stateCache.blinking !== 'auto' ||
                          stateCache.looking !== 'cursor' || stateCache.talking ||
                          stateCache.activity !== 'idle';
            if (dirty && Date.now() - lastCallAt > IDLE_RESET_MS) safeReset('长时间无调用 watchdog');
          }, 10000);
          resolve(port);
        });
      }
      attempt();
    });
  }

  function stop() {
    if (watchdog) clearInterval(watchdog);
    sseClients.forEach(function (r) { try { r.end(); } catch (e) {} });
    sseClients.clear();
    if (server) { try { server.close(); } catch (e) {} }
  }

  return { start: start, stop: stop, updateState: updateState, updateCapabilities: updateCapabilities, get port() { return port; } };
}

module.exports = { createMcp: createMcp, TOOLS: TOOLS, SERVER_INFO: SERVER_INFO };
