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
/* 鲸诺海 · 桌面窗口（Electron 主进程）
 * 依据：《施工说明书-live2d.md》二·五 / 五 · 第二阶段
 *
 * 透明、无边框、置顶、鼠标穿透、全局光标跟随、托盘、开机自启。
 * 自带静态服务器 + WebSocket :3757，不依赖外部 python / ws-server.js。
 */
'use strict';

const { app, BrowserWindow, screen, ipcMain, Tray, Menu, nativeImage, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');
const WebSocket = require('ws');
const { createMcp } = require('./mcp-server');
const loadStrings = require('./load-strings');
const EDITION = require('./edition');   // 自用版 / 开源版开关（私有路径都从这里读）

const S = loadStrings();
const ROOT = path.resolve(__dirname, '..');
const WIN_W = 420, WIN_H = 620;
const HTTP_PORTS = [3759, 3763];
const WS_PORTS = [3757, 3761];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.moc3': 'application/octet-stream',
  '.exp3': 'application/octet-stream',
  '.motion3': 'application/octet-stream'
};

let win = null;
let tray = null;
let cursorTimer = null;
let httpServer = null;
let wss = null;
let httpPort = HTTP_PORTS[0];
let wsPort = WS_PORTS[0];
let visible = true;
let interactive = false; // 默认穿透：不挡小海操作桌面
let dragging = false;    // 渲染进程说「按住她了」期间，窗口跟着全局光标走
let dragOffset = { x: 0, y: 0 };
let mcp = null;          // 0 号要的 MCP server，内嵌在本进程（不另起进程）
let latestState = {};    // 渲染层每 500ms 回传的状态（右键菜单「动作」的圆圈勾选靠它）
let peekTimer = null;    // 轻探针：前台窗口（只读进程名/标题，不截图）
let dockTimer = null;    // 贴身跟随目标窗口
let dockHwnd = 0;        // 0 = 没贴
let quitting = false;    // 已经确认退出，别再拦 close
let fatalShown = false;  // 致命错误只弹一次窗，别刷屏
let alwaysTop = true;    // 0号第三轮任务三：总在最前（右键菜单可切）
let hotzoneOn = false;   // 0号裁决·方案B：头顶热区（穿透时唯一可点区，双击弹菜单）
let lastCursorMoveAt = Date.now();  // 一小时没人碰 → 托盘换「诺诺在等你」
let tooltipWaiting = false;
let lastPt = { x: -1, y: -1 };
let forceInteractive = false; // 0号督办任务2:回复卡开着时压过像素穿透

/* 运行日志：GUI 模式下 stdout 常常看不到，落一份文件方便排错。
 * 打包后 __dirname 在 app.asar 里（只读），所以统一写到 userData：
 *   %APPDATA%\鲸诺海\last-run.log
 */
const USER_DATA = app.getPath('userData');
try { fs.mkdirSync(USER_DATA, { recursive: true }); } catch (e) {}
const LOG_FILE = path.join(USER_DATA, 'last-run.log');
function log(s) {
  const line = '[' + new Date().toISOString() + '] ' + s + '\n';
  try {
    // 简单轮转：超过 256KB 砍掉前半，只留最近 64KB
    try {
      const st = fs.statSync(LOG_FILE);
      if (st.size > 262144) {
        const buf = fs.readFileSync(LOG_FILE);
        fs.writeFileSync(LOG_FILE, buf.subarray(buf.length - 65536));
      }
    } catch (e2) {}
    fs.appendFileSync(LOG_FILE, line);
  } catch (e) {}
  try { process.stdout.write(line); } catch (e) {}
}
function err(s) {
  const line = '[' + new Date().toISOString() + '] ERROR ' + s + '\n';
  try { fs.appendFileSync(LOG_FILE, line); } catch (e) {}
  try { process.stderr.write(line); } catch (e) {}
}
/* 2026-11-07 最后一轮：主进程以前没有兜底。
 * `_shot` 里 win.capturePage() 失败时 Promise 没人 catch，Electron 33 的 Node 20
 * 对未处理 rejection 默认直接退出进程——表现就是「截一次图桌宠自己没了」，日志里
 * 还什么崩溃记录都没有。这里统一兜住，只记日志，不退出。 */
process.on('unhandledRejection', function (e) {
  err('[未处理的 Promise] ' + ((e && e.stack) || e));
});
process.on('uncaughtException', function (e) {
  err('[未捕获异常] ' + ((e && e.stack) || e));
});

/* ---------------- 用户配置（音效开关 / first_run）---------------- */
const CFG_FILE = path.join(USER_DATA, 'config.json');
function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CFG_FILE, 'utf8')); } catch (e) { return {}; }
}
function saveConfig(c) {
  try { fs.writeFileSync(CFG_FILE, JSON.stringify(c, null, 2)); } catch (e) {}
}
let cfg = loadConfig();
let sfxOn = cfg.sfx !== false;   // 默认开
let ttsOn = cfg.tts !== false;   // 任务3：说话出声，默认开
// 轻探针：自用版默认开；开源版默认关（别人的机器，不主动读前台标题）
if (cfg.peek === undefined) cfg.peek = !EDITION.openSource;

/* ---------------- 任务3：真 TTS ----------------
 * 语音合成目录由 edition.js 提供（自用版是本机私有 TTS，开源版为空 = 跳过）。
 * 同一个句子合成一次就缓存到 userData\tts\<hash>.mp3，不重复花时间。
 */
const TTS_DIR = EDITION.ttsDir || '';
const TTS_PY = TTS_DIR ? path.join(TTS_DIR, 'venv', 'Scripts', 'python.exe') : '';
const TTS_VOICE = TTS_DIR ? path.join(TTS_DIR, 'voice.json') : '';
const TTS_CACHE = path.join(USER_DATA, 'tts');
const FEIYU_LOG = path.join(USER_DATA, 'feiyu-server.log');
let feiyuProc = null;
function ttsConfig() {
  if (!TTS_VOICE) {
    return { voice: 'zh-CN-XiaoxiaoNeural', rate: '-14%', pitch: '+25Hz', name: '默认', feiyu: null };
  }
  try {
    const v = JSON.parse(fs.readFileSync(TTS_VOICE, 'utf8').replace(/^\uFEFF/, ''));
    return { voice: v.voice || 'zh-CN-XiaoxiaoNeural', rate: v.rate || '-14%',
      pitch: v.pitch || '+25Hz', name: v['选定'] || '默认', feiyu: v.feiyu || null };
  } catch (e) {
    return { voice: 'zh-CN-XiaoxiaoNeural', rate: '-14%', pitch: '+25Hz', name: '默认', feiyu: null };
  }
}
function feiyuKey(style, text) {
  return crypto.createHash('md5').update(style + '|' + text).digest('hex');
}
/* 飞鱼本地服务：固定台词优先读预生成缓存；命中就秒出，没命中走 HTTP 现场合成。 */
function feiyuRun(text, fc) {
  return new Promise(function (resolve) {
    text = String(text || '').trim().slice(0, 260);
    if (!text) return resolve({ ok: false, error: '空句子' });
    const style = fc.style || 'cute';
    // 缓存目录由配置给；没配就落到本程序的 userData，不再写死别人的盘符
    const cacheDir = fc.cache || path.join(USER_DATA, 'feiyu-cache');
    const out = path.join(cacheDir, feiyuKey(style, text) + '.wav');
    const readBack = function (cached) {
      try {
        if (fs.existsSync(out) && fs.statSync(out).size > 500) {
          const b = fs.readFileSync(out);
          return resolve({ ok: true, audio: b.toString('base64'), cached: cached, voice: '飞鱼-' + style });
        }
      } catch (e) {}
      resolve({ ok: false, error: '飞鱼缓存读失败' });
    };
    if (fs.existsSync(out)) return readBack(true);
    try { fs.mkdirSync(cacheDir, { recursive: true }); } catch (e) {}
    const port = Number(fc.port) || 3765;
    const url = '/tts?style=' + encodeURIComponent(style) + '&text=' + encodeURIComponent(text);
    const req = http.request({ host: '127.0.0.1', port: port, path: url, method: 'GET', timeout: 180000 }, function (res) {
      if (res.statusCode !== 200) { res.resume(); return resolve({ ok: false, error: '飞鱼服务 ' + res.statusCode }); }
      const chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () {
        const buf = Buffer.concat(chunks);
        if (buf.length < 500) return resolve({ ok: false, error: '飞鱼音频为空' });
        try { fs.writeFileSync(out, buf); } catch (e) {}
        resolve({ ok: true, audio: buf.toString('base64'), cached: false, voice: '飞鱼-' + style });
      });
    });
    req.on('timeout', function () { req.destroy(); resolve({ ok: false, error: '飞鱼合成超时' }); });
    req.on('error', function (e) { resolve({ ok: false, error: '飞鱼服务没起来: ' + e.message }); });
    req.end();
  });
}
/* 桌宠启动时顺手把飞鱼服务拉起来；已经有人在跑就不重复起。 */
function ensureFeiyuServer() {
  if (!ttsOn) return;   // 说话出声关掉时不占 CPU 加载模型
  const fc = ttsConfig().feiyu;
  if (!fc || fc.enabled === false || !fc.server || !fc.python) return;
  if (!fs.existsSync(fc.python) || !fs.existsSync(fc.server)) { err('[飞鱼] 缺 python 或 server 文件，跳过'); return; }
  const port = Number(fc.port) || 3765;
  const health = http.request({ host: '127.0.0.1', port: port, path: '/health', method: 'GET', timeout: 1500 }, function (res) {
    res.resume();
    if (res.statusCode === 200) log('[飞鱼] 服务已在运行');
    else spawnFeiyu(fc, port);
  });
  health.on('timeout', function () { health.destroy(); spawnFeiyu(fc, port); });
  health.on('error', function () { spawnFeiyu(fc, port); });
  health.end();
}
function spawnFeiyu(fc, port) {
  try {
    const outFd = fs.openSync(FEIYU_LOG, 'a');
    feiyuProc = spawn(fc.python, [fc.server, '--port', String(port),
      '--style', fc.style || 'cute', '--cache', fc.cache || path.join(USER_DATA, 'feiyu-cache')], {
      windowsHide: true, detached: false,
      stdio: ['ignore', outFd, outFd],
      env: Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8' })
    });
    feiyuProc.on('exit', function (code) { log('[飞鱼] 服务退出 code=' + code); feiyuProc = null; });
    log('[飞鱼] 正在启动本地语音服务 :' + port);
  } catch (e) { err('[飞鱼] 启动失败：' + e.message); }
}
function edgeRun(text, vc) {
  return new Promise(function (resolve) {
    text = String(text || '').trim().slice(0, 260);
    if (!text) return resolve({ ok: false, error: '空句子' });
    if (!fs.existsSync(TTS_PY)) return resolve({ ok: false, error: '没找到 tools\\tts 的 python' });
    const hash = crypto.createHash('md5')
      .update(vc.voice + '|' + vc.rate + '|' + vc.pitch + '|' + text).digest('hex');
    const out = path.join(TTS_CACHE, hash + '.mp3');
    const readBack = function (cached) {
      try {
        if (fs.existsSync(out) && fs.statSync(out).size > 500) {
          const b = fs.readFileSync(out);
          return resolve({ ok: true, audio: b.toString('base64'), cached: cached, voice: vc.name });
        }
      } catch (e) {}
      resolve({ ok: false, error: '合成失败' });
    };
    if (fs.existsSync(out)) return readBack(true);
    try { fs.mkdirSync(TTS_CACHE, { recursive: true }); } catch (e) {}
    execFile(TTS_PY, ['-m', 'edge_tts', '--voice', vc.voice, '--text', text,
      '--rate=' + vc.rate, '--pitch=' + vc.pitch, '--write-media', out],
      { timeout: 30000, windowsHide: true }, function (e2, so, se) {
        if (e2) err('[TTS] ' + String(se || e2.message).slice(0, 200));
        readBack(false);
      });
  });
}
function ttsRun(text) {
  const vc = ttsConfig();
  if (vc.feiyu && vc.feiyu.enabled !== false) {
    return feiyuRun(text, vc.feiyu).then(function (r) {
      if (r && r.ok) return r;
      return edgeRun(text, vc);     // 飞鱼服务没起来/超时，退回 Edge
    });
  }
  return edgeRun(text, vc);
}

/* 自检截图只留最近 5 张，别让 %APPDATA% 慢慢堆满 */
function pruneSelfchecks(dir) {
  try {
    const files = fs.readdirSync(dir)
      .filter(f => /^selfcheck-.*\.png$/.test(f))
      .map(f => ({ f: path.join(dir, f), t: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    files.slice(5).forEach(x => { try { fs.unlinkSync(x.f); } catch (e) {} });
  } catch (e) {}
}

/* 0号想法⑥：记住今天——读最新日记最后一句当开场白。
 * 隐私边界（0号定的）：只取最后一个非空行的第一句，不读全文，超60字截断。
 */
function readDiaryTail() {
  const diaryDir = EDITION.diaryDir || '';   // 开源版为空 = 不读日记
  if (!diaryDir) return '';
  try {
    const dir = diaryDir;
    const files = fs.readdirSync(dir).filter(f => /^\d{4}-\d{2}-\d{2}.*\.md$/.test(f)).sort();
    if (!files.length) return '';
    const raw = fs.readFileSync(path.join(dir, files[files.length - 1]), 'utf8');
    const lines = raw.split(/\r?\n/).filter(l => {
      const t = l.trim();
      return t && !t.startsWith('#') && !t.startsWith('>');
    });
    const last = (lines[lines.length - 1] || '').replace(/[*_`]/g, '').trim();
    const first = last.split(/[。！？]/)[0].trim();
    return first.slice(0, 60);
  } catch (e) { return ''; }
}

/* 0号想法②：感知「小诺在不在」——进程表里有 dsh 相关进程就是在线。
 * 开源版不做这项探测（不知道、也不猜用户机器上装了什么）。 */
function dshOnline() {
  if (EDITION.openSource) return null;
  try {
    const { execSync } = require('child_process');
    const out = execSync('tasklist /fo csv /nh', { encoding: 'utf8', timeout: 8000, windowsHide: true });
    return /"dsh/i.test(out);
  } catch (e) { return null; }
}

/* 0号第三轮任务一：get_capabilities 数据源。
 * 表情/动作组来自 model3.json（真名册）；参数范围先给常见默认值，
 * 模型加载后渲染进程会把 behavior 实测范围回传合并（nono-caps）。
 */
let CAPS = null;
let RECIPES = {};   // 0号第六轮③:动作配方表(whenReady 时从 recipes\ 读),右键菜单动态出
function buildCapabilities() {
  const caps = { expressions: [], motions: [], parameters: {
    ParamEyeBallX: [-1, 1], ParamEyeBallY: [-1, 1],
    ParamAngleX: [-30, 30], ParamAngleY: [-30, 30], ParamAngleZ: [-10, 10],
    ParamBodyAngleX: [-10, 10], ParamMouthOpenY: [0, 1], ParamMouthForm: [-1, 1]
  } };
  try {
    const mj = JSON.parse(fs.readFileSync(path.join(ROOT, 'models', 'nono.model3.json'), 'utf8'));
    const fr = mj.FileReferences || {};
    caps.expressions = (fr.Expressions || []).map(function (e) { return e.Name; });
    caps.presets = caps.expressions.slice();   // 0号第六轮①:同一份名册,语义叫 presets(模型自带 .exp3)
    // 2026-11-06：Motions 已经从顶层挪进 FileReferences（否则渲染层一个动作都注册不上）。
    // 脱捕也不再排除——实测逐帧没有黑影，它只是「失去捕捉」时的那段呆站动作。
    caps.motions = Object.keys(fr.Motions || mj.Motions || {});
  } catch (e) { err('[能力表] model3.json 读不到： ' + e.message); }
  return caps;
}

/* 0号第三轮任务三：窗口尺寸档（小/中/大），贴右下角重摆 */
function setPetSize(key) {
  const sizes = { small: [340, 500], mid: [420, 620], big: [520, 760] };
  const s = sizes[key] || sizes.mid;
  cfg.size = key; saveConfig(cfg);
  if (win && !win.isDestroyed()) {
    const area = screen.getPrimaryDisplay().workArea;
    win.setBounds({
      width: s[0], height: s[1],
      x: area.x + area.width - s[0] - 12,
      y: area.y + area.height - s[1] - 12
    });
  }
  rebuildMenu();
}

/* 任务6：形态（模型大小变）。任务5：鞋子。都记在 config.json，下次开还是这样 */
function setForm(key) {
  cfg.form = key; saveConfig(cfg);
  sendToRenderer({ action: 'form', value: key });
  rebuildMenu();
}
function setShoe(state) {
  cfg.shoe = state; saveConfig(cfg);
  sendToRenderer({ action: 'shoe', value: state === 'off' ? 'off' : 'on' });
  rebuildMenu();
}

/* ---------------- 静态服务器 ---------------- */
function startHttp(onReady) {
  httpServer = http.createServer(function (req, res) {
    let rel;
    try { rel = decodeURIComponent(req.url.split('?')[0]); }
    catch (e) { rel = '/'; }
    if (rel === '/' || rel === '') rel = '/index.html';
    const full = path.resolve(ROOT, '.' + rel);
    if (full !== ROOT && !full.startsWith(ROOT + path.sep)) {
      res.writeHead(403); res.end('forbidden'); return;
    }
    /* 安全（2026-11-10）：静态服务只出前端资源。
     * 以前整个项目目录都能读，本机浏览器能拿到 desktop/（主进程源码）、
     * node_modules/、package.json 甚至 tests/。现在白名单之外一律 404。 */
    const allowTop = ['js', 'lib', 'models', 'strings', 'recipes', 'build'];
    const relNorm = full.slice(ROOT.length + 1).split(path.sep);
    const top = relNorm[0] || '';
    const isEntry = relNorm.length === 1 && /^index\.html$/.test(top);
    if (!isEntry && allowTop.indexOf(top) < 0) {
      res.writeHead(404); res.end('not found'); return;
    }
    // 源码映射、日志、点触记录、包配置不通过静态服务暴露
    const baseName = relNorm[relNorm.length - 1] || '';
    if (/\.(map|log|jsonl)$/i.test(baseName) || /^package(-lock)?\.json$/i.test(baseName)) {
      res.writeHead(404); res.end('not found'); return;
    }
    fs.readFile(full, function (err, data) {
      if (err) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-store'
      });
      res.end(data);
    });
  });
  listenWithFallback(httpServer, HTTP_PORTS, '静态服务', function (port) {
    httpPort = port;
    onReady(port);
  });
}

function listenWithFallback(server, ports, label, onReady) {
  let i = 0;
  function onError(e) {
    server.removeListener('error', onError);
    i += 1;
    if (i < ports.length) {
      log('[' + label + '] ' + ports[i - 1] + ' 被占，换 ' + ports[i]);
      attempt();
    } else {
      err('[' + label + '] 端口全被占，服务没起来：', e.message);
    }
  }
  function attempt() {
    server.once('error', onError);
    server.listen(ports[i], '127.0.0.1', function () {
      server.removeListener('error', onError);
      log('[' + label + '] http://127.0.0.1:' + ports[i] + ' 就绪');
      onReady(ports[i]);
    });
  }
  attempt();
}

/* ---------------- 控制 WebSocket ---------------- */
function startWs() {
  let i = 0;
  function attempt() {
    let candidate;
    try {
      candidate = new WebSocket.Server({
        port: WS_PORTS[i], host: '127.0.0.1',
        // 来源校验：只认本机直连（无 Origin 头）或本地页面。
        // 浏览器里随便一个网页发起的跨源 WebSocket 连接拒收。
        verifyClient: function (info) {
          const o = info.req.headers.origin;
          return !o || /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(String(o));
        }
      });
    }
    catch (e) { err('[控制服务] 起不来：', e.message); return; }
    candidate.on('listening', function () {
      wss = candidate;
      wsPort = WS_PORTS[i];
      log('[控制服务] ws://127.0.0.1:' + wsPort + ' 就绪');
    });
    candidate.on('connection', function (ws) {
      ws.on('message', function (raw) {
        let cmd;
        try { cmd = JSON.parse(raw.toString()); }
        catch (e) { log('[控制服务] 不是合法 JSON：', raw.toString().slice(0, 80)); return; }
        // 隐藏指令 _shot：截一张窗口图，方便远程自检画面
        if (cmd && cmd.action === '_shot') {
          if (win && !win.isDestroyed()) {
            win.capturePage().then(function (img) {
              const out = path.join(USER_DATA, 'selfcheck-' + Date.now() + '.png');
              fs.writeFileSync(out, img.toPNG());
              log('[自检] 截图已保存 ' + out);
              pruneSelfchecks(USER_DATA);
            }).catch(function (e) {
              err('[自检] 截图失败 ' + (e && e.message));
            });
          }
          return;
        }
        // 隐藏指令 _interactive：远程切「可交互 / 穿透」，等同托盘开关
        if (cmd && cmd.action === '_interactive') {
          setInteractive(!!cmd.value);
          return;
        }
        // 隐藏指令 _menu：远程弹右键菜单（自检用）
        if (cmd && cmd.action === '_menu') {
          showContextMenu();
          return;
        }
        log('[控制服务] 收到指令 ' + JSON.stringify(cmd));
        if (win && !win.isDestroyed()) win.webContents.send('nono-command', cmd);
      });
    });
    candidate.on('error', function (e) {
      i += 1;
      if (i < WS_PORTS.length) {
        log('[控制服务] ' + WS_PORTS[i - 1] + ' 被占，换 ' + WS_PORTS[i]);
        attempt();
      } else {
        err('[控制服务] 端口全被占，外部控制不可用：', e.message);
      }
    });
  }
  attempt();
}

/* ---------------- 窗口 ---------------- */
function createWindow() {
  const area = screen.getPrimaryDisplay().workArea;
  win = new BrowserWindow({
    title: S.window.title,
    icon: path.join(__dirname, 'assets', 'icon.png'),
    width: WIN_W,
    height: WIN_H,
    x: area.x + area.width - WIN_W - 12,
    y: area.y + area.height + 60, // 入场动画（0号批）：从屏幕底之下缓升
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    resizable: false,
    movable: interactive,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false // 关键：没焦点时别把她冻住
    },
    alwaysOnTop: alwaysTop
  });

  win.setIgnoreMouseEvents(!interactive, { forward: true });
  win.setTitle(S.window.title);
  win.loadURL('http://127.0.0.1:' + httpPort + '/index.html?desktop=1');

  win.once('ready-to-show', function () {
    win.show();
    startCursorLoop();
    // 入场动画（0号批，0.8秒）：屏幕底缓升到右下角落位；落位=兴奋+举手
    const tX = area.x + area.width - WIN_W - 12;
    const tY = area.y + area.height - WIN_H - 12;
    const sY = area.y + area.height + 60;
    const t0 = Date.now();
    const DUR = 800;
    const iv = setInterval(function () {
      if (!win || win.isDestroyed()) { clearInterval(iv); return; }
      const k = Math.min(1, (Date.now() - t0) / DUR);
      const ease = 1 - Math.pow(1 - k, 3); // easeOutCubic
      win.setPosition(tX, Math.round(sY + (tY - sY) * ease));
      if (k >= 1) {
        clearInterval(iv);
        // 注意：落位时模型可能还在加载，命令会丢。问候动作改到 nono-ready 里发。
      }
    }, 16);
  });
  win.webContents.on('console-message', function (_e, level, message) {
    if (level >= 2) err('[渲染进程] ' + message);
  });
  win.webContents.on('render-process-gone', function (_e, details) {
    err('[渲染进程崩了] ' + (details && details.reason));
    if (!fatalShown) {
      fatalShown = true;
      dialog.showMessageBox({
        type: 'error',
        message: (S.error && S.error.renderer_crash) || '诺诺摔了一下，等一下就好。',
        buttons: ['好']
      });
    }
  });
  win.on('close', function (e) {
    if (quitting) return;
    e.preventDefault();
    requestQuit();
  });
  win.on('closed', function () { win = null; });
}

function startCursorLoop() {
  clearInterval(cursorTimer);
  cursorTimer = setInterval(function () {
    if (!win || win.isDestroyed()) return;
    const p = screen.getCursorScreenPoint();
    // 一小时没人碰鼠标 → 托盘提示换「诺诺在等你」；一动就换回来
    if (p.x !== lastPt.x || p.y !== lastPt.y) {
      lastPt = { x: p.x, y: p.y };
      lastCursorMoveAt = Date.now();
      if (tooltipWaiting) {
        tooltipWaiting = false;
        try { tray.setToolTip(S.tray.tooltip); } catch (e) {}
      }
    } else if (!tooltipWaiting && Date.now() - lastCursorMoveAt > 3600000) {
      tooltipWaiting = true;
      try { tray.setToolTip(S.tray.tooltip_waiting || S.tray.tooltip); } catch (e) {}
    }
    if (dragging) {
      // 拖动中：窗口跟手，位置变了再重算相对坐标
      win.setPosition(p.x - dragOffset.x, p.y - dragOffset.y);
    }
    const b = win.getBounds();
    // 热区逻辑已升级为像素级智能穿透(渲染层 readPixels alpha→IPC nono-pixel-hit),此处不再轮询判定
    win.webContents.send('nono-cursor', {
      x: p.x - b.x, y: p.y - b.y, w: b.width, h: b.height
    });
  }, 16); // ~60fps，跟真实鼠标，穿透时也能拿到
}

function setInteractive(v) {
  interactive = !!v;
  hotzoneOn = false;
  if (win && !win.isDestroyed()) {
    win.setIgnoreMouseEvents(!interactive, { forward: true });
    win.setMovable(interactive);
    win.webContents.send('nono-interactive', interactive);
  }
  rebuildMenu();
  log('[窗口] ' + (interactive ? '可拖动 / 能摸她' : '鼠标穿透'));
}

function toggleVisible() {
  visible = !visible;
  if (win && !win.isDestroyed()) visible ? win.show() : win.hide();
  rebuildMenu();
}

/* ---------------- 托盘 ---------------- */
function createTray() {
  const iconPath = path.join(__dirname, 'assets', 'tray.png');
  const icon = nativeImage.createFromPath(iconPath);
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  tray.setToolTip(S.tray.tooltip);
  tray.on('double-click', toggleVisible);
  rebuildMenu();
}

function recenterWindow() {
  if (!win || win.isDestroyed()) return;
  const area = screen.getPrimaryDisplay().workArea;
  win.setPosition(
    Math.round(area.x + (area.width - WIN_W) / 2),
    Math.round(area.y + (area.height - WIN_H) / 2)
  );
}

/* 0号第三轮任务三：右键/托盘同款菜单。
 * 原生菜单第一版（0号定的：能用就行）；穿透模式下画布收不到右键，托盘是备用入口。
 */
function sendToRenderer(cmd) {
  if (win && !win.isDestroyed()) win.webContents.send('nono-command', cmd);
}

/* ---------------- 轻探针（2026-11-07 参考 petbox） ----------------
 * 只读前台窗口的进程名 + 标题：不截图、不 OCR、不上传。
 * PowerShell 脚本从 asar 复制到 userData 再跑（asar 里的路径 PowerShell 打不开）。
 */
const PEEK_PS = path.join(USER_DATA, 'win-peek.ps1');
try { fs.copyFileSync(path.join(__dirname, 'win-peek.ps1'), PEEK_PS); } catch (e) {}

function psPeek(mode, hwnd, cb) {
  execFile('powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PEEK_PS, '-Mode', mode, '-Hwnd', String(hwnd || 0)],
    { windowsHide: true, timeout: 4000, maxBuffer: 16 * 1024 },
    function (e, stdout) { cb(e, String(stdout || '').trim()); });
}

let lastPeekProc = '';
function startPeek() {
  if (peekTimer) return;
  const tick = function () {
    if (!cfg.peek || !win || win.isDestroyed()) return;
    psPeek('foreground', 0, function (err, out) {
      if (err || !out || out === 'none' || out === 'gone') return;
      const p = out.split('\t');
      const proc = p[0] || '', title = p[1] || '';
      if (!proc) return;
      if (/鲸诺海|nono-live2d|electron/i.test(proc + ' ' + title)) return;   // 她自己（含 PowerShell 宿主窗口）不算
      if (proc !== lastPeekProc) { lastPeekProc = proc; log('[探针] 前台 ' + proc + '｜' + title.slice(0, 40)); }
      sendToRenderer({ action: 'peek', proc: proc, title: title });
    });
  };
  peekTimer = setInterval(tick, 45000);
  setTimeout(tick, 8000);
}

/* ---------------- 贴窗口 ----------------
 * 只贴不吸附、不抢焦点：目标窗口动，她跟着挪到右侧外 8px。
 */
function stopDock() {
  dockHwnd = 0;
  if (dockTimer) { clearInterval(dockTimer); dockTimer = null; }
  rebuildMenu();
}

function dockTo(hwnd) {
  dockHwnd = hwnd;
  if (dockTimer) { clearInterval(dockTimer); dockTimer = null; }
  if (!hwnd) { rebuildMenu(); return; }
  const follow = function () {
    if (!dockHwnd || !win || win.isDestroyed()) return;
    psPeek('rect', dockHwnd, function (err, out) {
      if (err || !out || out === 'gone' || out === 'none') { log('[贴窗口] 目标没了，取消'); stopDock(); return; }
      const p = out.split('\t');
      if (p[7] === '1') return;              // 目标最小化时先不动
      const right = +p[5], top = +p[4];
      if (!right) return;
      let dip;
      try { dip = screen.screenToDipPoint({ x: right + 8, y: top + 40 }); }
      catch (e) { dip = { x: right + 8, y: top + 40 }; }
      if (!visible) { visible = true; win.show(); }
      win.setBounds({ x: Math.round(dip.x), y: Math.round(dip.y), width: WIN_W, height: WIN_H });
    });
  };
  dockTimer = setInterval(follow, 2000);
  follow();
  rebuildMenu();
}

/* 帧率档位（2026-11-07）：高刷屏锁一下，CPU 能差三倍 */
function setFps(v) {
  cfg.fps = v; saveConfig(cfg);
  sendToRenderer({ action: 'fps', value: v === 'auto' ? 'auto' : Number(v) });
  rebuildMenu();
}

function moodLabelNow() {
  const m = latestState.mood || 'neutral';
  return { neutral: '平静', happy: '开心', shy: '害羞', annoyed: '不痛快',
    sad: '有点委屈', close: '亲近' }[m] || '平静';
}

/* ---------- 菜单模型（2026-11-10 重写） ----------
 * 一份数据两处用：
 *   · 托盘 → 系统原生菜单（Electron Menu 模板）
 *   · 右键 → 自绘玻璃面板（menu-ui.html，可美化）
 * 项格式：{ label, run(m), kind:'radio'|'check', on, submenu, disabled, sep, icon, badge }
 */
function buildMenuModel() {
  const exprNames = [['笑', 'happy'], ['害羞', 'shy'], ['困', 'sleepy'], ['惊讶', 'surprised'],
    ['气鼓鼓', 'angry'], ['难过', 'sad'], ['认真', 'serious'], ['想事情', 'thinking'],
    ['兴奋', 'excited'], ['微笑', 'smile']];
  const exprSub = exprNames.map(function (p) {
    return { label: p[0], run: function () { sendToRenderer({ action: 'expression', name: p[1] }); } };
  });
  // 模型自带的 .exp3 预设（不是语义表情，直接叠图层）
  const presetNames = ['爱心眼', '圈圈眼', '流泪', '脸红', '黑脸', '黑框眼镜', '兔牙', '＞＜', '流冷汗', '屑屑眼'];
  const presetSub = presetNames.map(function (n) {
    return { label: n, run: function () { sendToRenderer({ action: 'preset', name: n }); } };
  }).concat([
    { label: '眨左眼', run: function () { sendToRenderer({ action: 'wink', side: 'L' }); } },
    { label: '眨右眼', run: function () { sendToRenderer({ action: 'wink', side: 'R' }); } },
    { label: '吐舌头', run: function () { sendToRenderer({ action: 'tongue', ms: 1000 }); } }
  ]);
  // 模型自带的动作组：圆圈勾选，标签用短名
  const motionNames = ['默认手切举手', '举手切默认手', '狗尾草切换出来', '狗尾草切回默认手',
    '竖手指切出来动画', '竖手指切回默认', '脱捕'];
  const motionLabels = {
    '默认手切举手': '举手', '举手切默认手': '放下手',
    '狗尾草切换出来': '拿出狗尾草', '狗尾草切回默认手': '收起狗尾草',
    '竖手指切出来动画': '竖手指', '竖手指切回默认': '收回手指', '脱捕': '脱捕'
  };
  const motionNow = latestState.motion || cfg.lastMotion || '';
  const motionSub = motionNames.map(function (n) {
    return { label: motionLabels[n] || n, kind: 'radio', on: motionNow === n,
      run: function () {
        cfg.lastMotion = n; saveConfig(cfg);
        sendToRenderer({ action: 'motion', group: n });
      } };
  });
  const sizeSub = [
    { label: S.menu.size_small || '小', run: function () { setPetSize('small'); } },
    { label: S.menu.size_mid || '中', run: function () { setPetSize('mid'); } },
    { label: S.menu.size_big || '大', run: function () { setPetSize('big'); } }
  ];
  const formNow = cfg.form || 'big';
  const formSub = [
    { label: '诺诺', kind: 'radio', on: formNow === 'big', run: function () { setForm('big'); } },
    { label: '小诺诺', kind: 'radio', on: formNow === 'mid', run: function () { setForm('mid'); } },
    { label: '诺宝宝', kind: 'radio', on: formNow === 'small', run: function () { setForm('small'); } }
  ];
  const shoeWearing = cfg.shoe !== 'off';
  const shoeSub = [
    { label: '穿着', kind: 'radio', on: shoeWearing, run: function () { setShoe('on'); } },
    { label: '脱掉', kind: 'radio', on: !shoeWearing, run: function () { setShoe('off'); } }
  ];
  const fpsNow = cfg.fps === undefined ? 'auto' : cfg.fps;
  const fpsSub = [
    { label: '自动（空闲 30）', kind: 'radio', on: fpsNow === 'auto', run: function () { setFps('auto'); } },
    { label: '30 帧', kind: 'radio', on: String(fpsNow) === '30', run: function () { setFps(30); } },
    { label: '60 帧', kind: 'radio', on: String(fpsNow) === '60', run: function () { setFps(60); } },
    { label: '90 帧', kind: 'radio', on: String(fpsNow) === '90', run: function () { setFps(90); } }
  ];
  return [
    { sep: true },
    { label: S.menu.recenter, icon: '◎', run: recenterWindow },
    { sep: true },
    { label: S.menu.pat || '摸摸头', icon: '♡', run: function () { sendToRenderer({ action: 'pat_auto' }); } },
    { label: S.menu.say || '说句话', icon: '❝', run: function () { sendToRenderer({ action: 'say_something' }); } },
    { sep: true },
    { submenu: exprSub, label: S.menu.expr || '表情', icon: '◡', open: false },
    { submenu: presetSub, label: '表情预设', icon: '✦', open: false },
    { submenu: motionSub, label: '动作', icon: '✋', open: false },
    { sep: true },
    { label: S.menu.appearance || '外观', icon: '❖', open: false, submenu: [
      { label: '长裙 ⇄ 短裙', badge: cfg.skirt === 'short' ? '短' : '长', run: function () {
        cfg.skirt = cfg.skirt === 'short' ? 'long' : 'short'; saveConfig(cfg);
        sendToRenderer({ action: 'skirt', value: cfg.skirt });
        rebuildMenu();
      } },
      { label: '尾巴 ⇄ 收起', badge: cfg.tail === 'off' ? '收' : '露', run: function () {
        cfg.tail = cfg.tail === 'off' ? 'on' : 'off'; saveConfig(cfg);
        sendToRenderer({ action: 'tail', value: cfg.tail === 'off' ? 'off' : 'on' });
        rebuildMenu();
      } },
      { submenu: shoeSub, label: '鞋子' },
      { submenu: formSub, label: '形态' },
      { submenu: sizeSub, label: '窗口大小' }
    ]},
    { submenu: Object.keys(RECIPES).sort().map(function (n) {
        return { label: n, run: function () {
          sendToRenderer({ action: 'plan', steps: RECIPES[n].steps });
          log('[菜单] 配方 ' + n);
        } };
      }), label: S.menu.recipes || '动作库', icon: '☰', open: false },
    { sep: true },
    { label: visible ? '先藏起来' : '回来', icon: visible ? '◐' : '◑', run: toggleVisible },
    { label: '鼠标穿透（不挡操作）', kind: 'check', on: !interactive,
      run: function () { setInteractive(false); } },
    { label: '能摸她（Alt + 拖动移位）', kind: 'check', on: interactive,
      run: function () { setInteractive(true); } },
    { submenu: [
      { label: S.menu.always_top || '总在最前', kind: 'check', on: alwaysTop,
        run: function (m) {
          alwaysTop = m && typeof m.checked === 'boolean' ? m.checked : !alwaysTop;
          if (win && !win.isDestroyed()) win.setAlwaysOnTop(alwaysTop);
        } },
      { label: '开机自启', kind: 'check', on: app.getLoginItemSettings().openAtLogin,
        run: function (m) { app.setLoginItemSettings({ openAtLogin: m.checked }); } },
      { submenu: fpsSub, label: '帧率' },
      { label: '感知前台窗口（只读标题）', kind: 'check', on: cfg.peek !== false,
        run: function () { cfg.peek = !cfg.peek; saveConfig(cfg); rebuildMenu(); } },
      { label: dockHwnd ? '取消贴身' : '贴到当前前台窗口', run: function () {
          if (dockHwnd) { stopDock(); return; }
          psPeek('foreground', 0, function (err, out) {
            if (err || !out || out === 'none' || out === 'gone') return;
            dockTo((+out.split('\t')[2]) || 0);
          });
        } },
      { label: S.menu.sfx || '音效', kind: 'check', on: sfxOn,
        run: function (m) {
          sfxOn = !!m.checked;
          cfg.sfx = sfxOn; saveConfig(cfg);
          if (win && !win.isDestroyed()) win.webContents.send('nono-sfx', sfxOn);
        } },
      { label: '说话出声（TTS）', kind: 'check', on: ttsOn,
        run: function (m) {
          ttsOn = !!m.checked;
          cfg.tts = ttsOn; saveConfig(cfg);
          if (win && !win.isDestroyed()) win.webContents.send('nono-tts-enabled', ttsOn);
        } }
    ], label: '设置', icon: '⚙', open: false },
    { sep: true },
    { label: S.menu.about, icon: 'ⓘ', run: showAbout },
    { label: S.menu.quit, icon: '⏻', danger: true, run: requestQuit }
  ];
}

/* 模型 → Electron 原生菜单模板（托盘用；原生菜单不能自定义样式） */
function modelToTemplate(items) {
  return items.map(function (it) {
    if (it.sep) return { type: 'separator' };
    const o = { label: it.label };
    if (it.submenu) o.submenu = modelToTemplate(it.submenu);
    if (it.disabled) o.enabled = false;
    if (it.kind === 'radio') { o.type = 'radio'; o.checked = !!it.on; }
    if (it.kind === 'check') { o.type = 'checkbox'; o.checked = !!it.on; }
    if (it.run) o.click = function (mi) { it.run(mi); };
    return o;
  });
}

/* 模型 → 可序列化 JSON（自绘菜单用）；同时把每项的 run 存进 actions[id] */
function modelToJson(items, prefix, actions) {
  const out = [];
  items.forEach(function (it, i) {
    if (it.sep) { out.push({ type: 'sep' }); return; }
    const id = prefix + i;
    if (it.run) actions[id] = it.run;
    if (it.submenu) {
      out.push({ type: 'group', label: it.label, open: it.open !== false,
        items: modelToJson(it.submenu, id + '_', actions) });
    } else {
      out.push({ id: id, label: it.label, kind: it.kind, on: !!it.on,
        icon: it.icon, badge: it.badge, danger: it.danger, disabled: it.disabled });
    }
  });
  return out;
}

function rebuildMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate(modelToTemplate(buildMenuModel())));
}

/* ---------- 自绘右键菜单（2026-11-10） ----------
 * 原生菜单在 Windows 上是系统样式，改不了；右键走独立的透明小窗口。
 * 托盘还是系统菜单——托盘菜单没法自绘。
 */
let menuWin = null;
let menuActions = {};
let menuAt = { x: 0, y: 0 };

function closeCustomMenu() {
  if (menuWin && !menuWin.isDestroyed()) menuWin.destroy();
  menuWin = null;
  menuActions = {};
}

function showCustomMenu() {
  closeCustomMenu();
  const model = buildMenuModel();
  const actions = {};
  const items = modelToJson(model, 'm', actions);
  menuActions = actions;

  const cur = screen.getCursorScreenPoint();
  menuAt = cur;
  menuWin = new BrowserWindow({
    width: MENU_W, height: 420,
    x: Math.round(cur.x - 6), y: Math.round(cur.y - 6),
    frame: false, transparent: true, resizable: false, movable: false,
    skipTaskbar: true, alwaysOnTop: true, hasShadow: false,
    show: false, focusable: true,
    webPreferences: {
      preload: path.join(__dirname, 'menu-preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false,
      backgroundThrottling: false
    }
  });
  menuWin.setAlwaysOnTop(true, 'pop-up-menu');
  menuWin.loadFile(path.join(__dirname, 'menu-ui.html'));
  menuWin.once('ready-to-show', function () {
    if (menuWin && !menuWin.isDestroyed()) { menuWin.show(); menuWin.focus(); }
  });
  menuWin.on('blur', function () {
    // 还没显示出来时的 blur 不算（否则创建瞬间就自己关掉）
    if (menuWin && !menuWin.isDestroyed() && menuWin.isVisible()) closeCustomMenu();
  });
  menuWin.on('closed', function () { menuWin = null; });
  menuWin.webContents.once('did-finish-load', function () {
    if (!menuWin || menuWin.isDestroyed()) return;
    menuWin.webContents.send('nono-menu-model', {
      mood: moodLabelNow(),
      cause: latestState.mood_cause || '',
      items: items
    });
  });
  log('[菜单] 已弹出');
}

/* 菜单窗口按内容高度收缩，并把位置夹进当前显示器。
 * 2026-11-10：鼠标贴屏幕右下角时原来的写法会顶到边上、下半截被切，
 * 改成「右边不够往左开、下面不够往上开」的标准菜单行为。 */
const MENU_W = 248;
function fitMenuWindow(h) {
  if (!menuWin || menuWin.isDestroyed()) return;
  const disp = screen.getDisplayNearestPoint(menuAt);
  const wa = disp.workArea;
  const maxH = Math.max(160, wa.height - 24);
  const panelH = Math.max(80, Math.min(560, Math.round(h || 420), maxH)) + 4;

  let x = menuAt.x - 6;
  if (x + MENU_W > wa.x + wa.width - 6) x = menuAt.x - MENU_W + 6;   // 向左开
  if (x < wa.x + 6) x = wa.x + 6;
  if (x + MENU_W > wa.x + wa.width - 6) x = wa.x + wa.width - MENU_W - 6;

  let y = menuAt.y - 6;
  if (y + panelH > wa.y + wa.height - 6) y = menuAt.y - panelH + 6;  // 向上开
  if (y < wa.y + 6) y = wa.y + 6;
  if (y + panelH > wa.y + wa.height - 6) y = wa.y + wa.height - panelH - 6;

  menuWin.setBounds({ x: Math.round(x), y: Math.round(y), width: MENU_W, height: panelH });
}

function showContextMenu() {
  if (cfg.menuStyle === 'native') {
    const menu = Menu.buildFromTemplate(modelToTemplate(buildMenuModel()));
    if (win && !win.isDestroyed()) menu.popup({ window: win });
    else menu.popup();
    log('[菜单] 已弹出（原生）');
    return;
  }
  showCustomMenu();
}

function showAbout() {
  let detail = [
    S.about.body,
    '',
    '—— 使用条款（详见 LICENSE.txt）——',
    '版权：白米糕-Sama / 鲸诺海，保留所有权利。',
    '开源发行版采用 PolyForm Noncommercial License 1.0.0：',
    '  允许非商业使用、修改、分发（分发须保留本许可与 Required Notice）；',
    '  禁止任何商业用途。',
    '作者自用版见 LICENSE-作者自用版.txt。',
    '',
    '—— 以下为模型作者，非本项目代码作者 ——',
    'Live2D 模型为免费公开配布：',
    '  原画及拆分：神宫凉子',
    '  Live2D 建模：霓虹猫_NeonNeko',
    '',
    '控制接口：ws://127.0.0.1:' + wsPort,
    'MCP 接口：http://127.0.0.1:' + (mcp ? mcp.port : 8768) + '/mcp',
    '源码公开仅供学习参考，不代表授权修改或分发。'
  ].join('\n');
  // 生日彩蛋：10 月 29 日那天，关于里多一行
  const d = new Date();
  if (d.getMonth() === 9 && d.getDate() === 29 && S.about.birthday_extra) {
    detail += '\n\n' + S.about.birthday_extra;
  }
  dialog.showMessageBox({
    type: 'info',
    title: S.about.title,
    message: S.about.title,
    detail: detail,
    buttons: ['好']
  });
}

function requestQuit() {
  if (quitting) return;
  if (!win || win.isDestroyed()) { quitting = true; app.quit(); return; }
  const choice = dialog.showMessageBoxSync(win, {
    type: 'question',
    title: S.quit.title,
    message: S.quit.message || S.quit.title,
    buttons: [S.quit.confirm, S.quit.cancel],
    defaultId: 1,
    cancelId: 1,
    noLink: true
  });
  if (choice === 0) { quitting = true; app.quit(); }
}

/* ---------------- 生命周期 ---------------- */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', function () {
    if (win) { visible = true; win.show(); }
  });

  ipcMain.on('nono-strings', function (e) {
    e.returnValue = S;
  });
  // 任务3：渲染层要一句话的声音 → 主进程合成/取缓存 → base64 回去
  ipcMain.handle('nono-tts', function (_e, text) {
    if (!ttsOn) return { ok: false, error: 'tts off' };
    return ttsRun(text);
  });
  ipcMain.on('nono-ready', function () {
    log('[渲染进程] 鲸诺海已就位，模型加载完成');
    if (win && !win.isDestroyed()) {
      // 第一次见面 / 日记开场白（0号想法⑥，每天一次）/ 时段问候（0号的字）
      if (!cfg.firstRunShown) {
        if (S.first_run) win.webContents.send('nono-command', { action: 'bubble', text: S.first_run, dur: 6500 });
        cfg.firstRunShown = true; saveConfig(cfg);
      } else {
        const today = new Date().toDateString();
        const diaryLine = readDiaryTail();
        if (diaryLine && cfg.lastDiaryGreet !== today) {
          cfg.lastDiaryGreet = today; saveConfig(cfg);
          win.webContents.send('nono-command', { action: 'bubble', text: '昨晚诺诺记下：「' + diaryLine + '」', dur: 6000 });
        } else {
          const h = new Date().getHours();
          const key = h < 5 ? 'dawn' : h < 10 ? 'morning' : h < 14 ? 'noon'
            : h < 17 ? 'evening' : h < 21 ? 'evening' : 'night';
          const line = S.time_greeting && S.time_greeting[key];
          if (line) win.webContents.send('nono-command', { action: 'bubble', text: line, dur: 4200 });
        }
      }
      // 入场问候：只给表情，不再演「举手→放下」——那个回归动作会把左臂参数压到 0，手缩进袖口
      win.webContents.send('nono-command', { action: 'expression', name: 'excited', duration_ms: 1800 });
      // 音效 / 说话出声 / 外观（形态·鞋子）状态同步给渲染层
      win.webContents.send('nono-sfx', sfxOn);
      win.webContents.send('nono-tts-enabled', ttsOn);
      // 帧率档位（config 里存的是 'auto' / 30 / 60 / 90）
      win.webContents.send('nono-command', { action: 'fps', value: cfg.fps || 'auto' });
      win.webContents.send('nono-command', { action: 'form', value: cfg.form || 'big' });
      win.webContents.send('nono-command', { action: 'shoe', value: cfg.shoe === 'off' ? 'off' : 'on' });
      win.webContents.send('nono-command', { action: 'skirt', value: cfg.skirt === 'short' ? 'short' : 'long' });
      win.webContents.send('nono-command', { action: 'tail', value: cfg.tail === 'off' ? 'off' : 'on' });
      // 0号督办任务1:阶段气泡开关(config.stage_bubbles,默认开,能关)
      win.webContents.send('nono-command', { action: 'stage_bubbles_enabled', value: cfg.stage_bubbles !== false });
    }
    // 可选自检：只截自己的窗口，确认模型真的画出来了（不影响正常运行）
    if (process.env.NONO_SELFCHECK && win && !win.isDestroyed()) {
      setTimeout(function () {
        if (!win || win.isDestroyed()) return;
        win.capturePage().then(function (img) {
          const out = path.join(USER_DATA, 'selfcheck.png');
          fs.writeFileSync(out, img.toPNG());
          log('[自检] 窗口截图已保存 ' + out);
        }).catch(function (e) { err('[自检] 截图失败 ' + e.message); });
      }, 3000);
    }
  });
  ipcMain.on('nono-error', function (_e, msg) {
    err('[渲染进程报错] ' + msg);
  });
  // 致命错误（模型缺失/坏了/版本不对）：桌面模式下页面提示都不可见，必须弹窗喊人
  ipcMain.on('nono-fatal-error', function (_e, p) {
    err('[致命] ' + (p && p.key) + ' ' + (p && p.detail));
    if (fatalShown) return;
    fatalShown = true;
    const text = (S.error && S.error[p && p.key]) || (S.error && S.error.unknown) || '出了点小状况。';
    dialog.showMessageBox({
      type: 'warning',
      title: (S.meta && S.meta.name) || '鲸诺海',
      message: text,
      detail: String((p && p.detail) || '').slice(0, 300),
      buttons: ['好']
    });
  });
  ipcMain.on('nono-drag-start', function () {
    if (!win || win.isDestroyed()) return;
    const p = screen.getCursorScreenPoint();
    const b = win.getBounds();
    dragOffset = { x: p.x - b.x, y: p.y - b.y };
    dragging = true;
  });
  ipcMain.on('nono-drag-end', function () { dragging = false; });
  ipcMain.on('nono-mcp-state', function (_e, s) {
    if (s && typeof s === 'object') latestState = Object.assign({}, latestState, s);
    if (mcp) mcp.updateState(s);
  });
  // 0号第三轮任务一：渲染层回传 behavior 实测参数范围，合并进能力表
  ipcMain.on('nono-caps', function (_e, ranges) {
    if (!mcp || !ranges) return;
    CAPS = CAPS || buildCapabilities();
    CAPS.parameters = Object.assign({}, CAPS.parameters, ranges);
    mcp.updateCapabilities(CAPS);
  });
  // 0号第三轮任务三：画布右键 → 弹菜单
  ipcMain.on('nono-context-menu', function () { showContextMenu(); });
  // 自绘菜单（2026-11-10）：菜单窗口只负责画，动作全回主进程执行
  ipcMain.on('nono-menu-ready', function () { /* 等 did-finish-load 之后主进程会推模型 */ });
  ipcMain.on('nono-menu-click', function (_e, d) {
    if (!d || !d.id) return;
    const fn = menuActions[d.id];
    closeCustomMenu();
    if (typeof fn === 'function') {
      try { fn({ checked: !!d.nextOn }); } catch (err) { err('[菜单] 执行失败 ' + (err && err.message)); }
    }
  });
  ipcMain.on('nono-menu-resize', function (_e, h) { fitMenuWindow(h); });
  ipcMain.on('nono-menu-close', function () { closeCustomMenu(); });
  // petbox 同款·像素级智能穿透:渲染层报「摸到她了」→主进程切穿透(只管穿透态;可交互/拖动态不抢)
  ipcMain.on('nono-pixel-hit', function (_e, hit) {
    if (interactive || dragging || forceInteractive) return;
    if (win && !win.isDestroyed()) win.setIgnoreMouseEvents(!hit, { forward: true });
  });
  // petbox 同款:点触记录(touch.jsonl,256KB 轮转)——她和每个诺诺的互动都有据可查
  ipcMain.on('nono-touch-log', function (_e, entry) {
    try {
      const tFile = path.join(USER_DATA, 'touch.jsonl');
      let line = JSON.stringify(Object.assign({ time: new Date().toISOString() }, entry || {})) + '\n';
      if (fs.existsSync(tFile) && fs.statSync(tFile).size > 256 * 1024) {
        const old = fs.readFileSync(tFile, 'utf8').split('\n').filter(Boolean).slice(-500);
        fs.writeFileSync(tFile, old.join('\n') + '\n', 'utf8');
      }
      fs.appendFileSync(tFile, line, 'utf8');
    } catch (e) {}
  });
  // 0号督办任务2:小海在桌宠里打的话→存成文件(先落盘,DSH 后面再接)
  ipcMain.on('nono-write-speak', function (_e, text) {
    // 落盘目录由 edition.js 给；开源版为空 = 不落盘（不碰任何本机私有目录）
    const dir = EDITION.speakOutDir || '';
    if (!dir) { log('[说话] 已收到（当前版本不落盘）：' + String(text || '').slice(0, 40)); return; }
    try {
      fs.mkdirSync(dir, { recursive: true });
      const f = path.join(dir, Date.now() + '.txt');
      fs.writeFileSync(f, String(text || ''), 'utf8');
      log('[说话] 已存 ' + f);
    } catch (e) { err('[说话] 存文件失败: ' + e.message); }
  });
  // 回复卡开着时窗口保持可点(压过像素穿透;关了就还原)
  ipcMain.on('nono-force-interactive', function (_e, v) {
    forceInteractive = !!v;
    if (!interactive && !dragging && win && !win.isDestroyed()) {
      win.setIgnoreMouseEvents(!forceInteractive, { forward: true });
    }
  });

  app.whenReady().then(function () {
    startHttp(function () {
      startWs();
      createWindow();
      startPeek();   // 轻探针：前台窗口（只读进程名/标题）
      /* TTS 保活（2026-11-07 参考 petbox）：本地语音服务空闲久了第一句要等二十多秒，
       * 每 15 分钟合成一句「嗯」把服务热着。结果走正常缓存，不播、不弹气泡。 */
      setInterval(function () {
        if (!ttsOn) return;
        if (new Date().getHours() < 8) return;
        ttsRun('嗯').then(function (r) {
          if (r && r.ok) log('[TTS] 保活完成' + (r.cached ? '（命中缓存）' : ''));
        }).catch(function () {});
      }, 15 * 60 * 1000);
      // 0号第四轮项目03：动作配方库先加载(createMcp 闭包要捕获;菜单也用它)
      RECIPES = {};
      try {
        for (const f of fs.readdirSync(path.join(ROOT, 'recipes'))) {
          if (!f.endsWith('.json')) continue;
          try { const r = JSON.parse(fs.readFileSync(path.join(ROOT, 'recipes', f), 'utf8')); RECIPES[r.name || f.replace('.json', '')] = r; } catch (e) {}
        }
      } catch (e) {}
      // 0 号《MCP接口规格》：让她自己能动。工具调用 → 覆盖式指令 → 渲染进程行为层
      mcp = createMcp({
        recipes: RECIPES,
        onCommand: function (cmd) {
          if (win && !win.isDestroyed()) win.webContents.send('nono-command', cmd);
        },
        onReset: function () {
          if (win && !win.isDestroyed()) win.webContents.send('nono-command', { action: 'reset' });
        },
        log: log
      });
      mcp.start().then(function (p) {
        if (win && !win.isDestroyed()) win.webContents.send('nono-mcp-port', p);
      }).catch(function (e) {
        err('[MCP] 起不来：' + e.message);
        try { if (tray) tray.setToolTip((S.notify && S.notify.mcp_disconnected) || S.tray.tooltip); } catch (e2) {}
      });
      createTray();
      ensureFeiyuServer();   // 本地飞鱼语音服务：已经有人在跑就不重复起
      // 0号第三轮任务一：能力表就位（表情/动作组来自 model3.json，参数范围等渲染层回传合并）
      CAPS = buildCapabilities();
      mcp.updateCapabilities(CAPS);
      // 0号第三轮任务三：恢复上次窗口尺寸档
      setPetSize(cfg.size || 'mid');
      // 0号想法②：每30秒感知一次「小诺在不在」，让她和DSH那边的诺诺连着
      setInterval(function () {
        const on = dshOnline();
        if (on !== null && win && !win.isDestroyed()) {
          win.webContents.send('nono-command', { action: 'companion', online: on });
        }
      }, 30000);
      log('[鲸诺海] 桌面形象已启动。托盘里可以切换穿透 / 退出。');
    });
  });

  app.on('window-all-closed', function () {
    // 有托盘，窗口全关也不退出
  });

  // Windows 关机 / 注销：直接睡，不弹「诺要睡了」拦着系统关机
  app.on('session-end', function () {
    quitting = true;
  });

  app.on('before-quit', function () {
    quitting = true;
    clearInterval(cursorTimer);
    try { if (httpServer) httpServer.close(); } catch (e) {}
    try { if (wss) wss.close(); } catch (e) {}
    if (mcp) mcp.stop();
    try { if (feiyuProc) feiyuProc.kill(); } catch (e) {}
    feiyuProc = null;
  });
}
