/* 预加载桥：只暴露必要的几个口子，页面里拿不到 node / ipcRenderer */
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const S = ipcRenderer.sendSync('nono-strings');
let _mcpPort = 8768;
ipcRenderer.on('nono-mcp-port', function (_e, p) { _mcpPort = p; });

contextBridge.exposeInMainWorld('NonoStrings', S);

contextBridge.exposeInMainWorld('NonoDesktop', {
  ready: function () { ipcRenderer.send('nono-ready'); },
  onCommand: function (cb) {
    ipcRenderer.on('nono-command', function (_e, cmd) { cb(cmd); });
  },
  onCursor: function (cb) {
    ipcRenderer.on('nono-cursor', function (_e, d) { cb(d); });
  },
  onInteractive: function (cb) {
    ipcRenderer.on('nono-interactive', function (_e, v) { cb(v); });
  },
  dragStart: function () { ipcRenderer.send('nono-drag-start'); },
  dragEnd: function () { ipcRenderer.send('nono-drag-end'); },
  // MCP get_state 用：渲染进程把状态快照报给主进程的 MCP server
  mcpState: function (s) { ipcRenderer.send('nono-mcp-state', s); },
  mcpPort: function () { return _mcpPort; },
  reportError: function (s) { ipcRenderer.send('nono-error', s); },
  // 致命错误（模型缺失/坏了）：主进程弹窗喊人——桌面模式页面提示不可见
  fatalError: function (key, detail) { ipcRenderer.send('nono-fatal-error', { key: key, detail: detail }); },
  // 托盘切音效开关 → 渲染层
  onSfx: function (cb) { ipcRenderer.on('nono-sfx', function (_e, v) { cb(v); }); },
  // 托盘切「说话出声」
  onTts: function (cb) { ipcRenderer.on('nono-tts-enabled', function (_e, v) { cb(v); }); },
  // 0号第三轮任务一：渲染层把真实参数范围报给主进程（get_capabilities 数据源）
  sendCaps: function (ranges) { ipcRenderer.send('nono-caps', ranges); },
  // 0号第三轮任务三：画布上右键 → 主进程弹菜单（可交互模式下才收得到）
  contextMenu: function () { ipcRenderer.send('nono-context-menu'); },
  // petbox 同款·像素级智能穿透:渲染层报「摸到她了」,主进程切穿透
  pixelHit: function (hit) { ipcRenderer.send('nono-pixel-hit', hit); },
  // petbox 同款:点触记录(touch.jsonl,256KB 轮转)
  touchLog: function (entry) { ipcRenderer.send('nono-touch-log', entry); },
  // 0号督办任务2:小海在桌宠里打的话→主进程写 G:\任务中枢\待领\说话\
  writeSpeak: function (text) { ipcRenderer.send('nono-write-speak', text); },
  // 回复卡开着时压过像素穿透,输入框点得到
  forceInteractive: function (v) { ipcRenderer.send('nono-force-interactive', v); },
  // 2026-11-06 任务3：真 TTS。主进程合成 mp3 → 返回 base64 → 渲染层播放并用音量驱动口型
  tts: function (text) { return ipcRenderer.invoke('nono-tts', text); },
});
