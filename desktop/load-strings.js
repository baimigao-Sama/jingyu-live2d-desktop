/* 文案加载：主进程和预加载桥共用
 * 优先读构建时同步进来的 strings\，开发时回退到 外层\鲸诺海桌面版\文本\。
 * DSH_FLAVOR=open 时读开源版，其余读我们自己的版本。
 */
'use strict';

const path = require('path');
const fs = require('fs');

const FALLBACK = {
  meta: { name: '鲸诺海', short: '鲸诺', nickname: '诺诺' },
  window: { title: '鲸诺海' },
  loading: { main: '加载中…', slow: '加载中…', very_slow: '加载中…', done: '' },
  error: { model_missing: '没找到模型文件。', model_broken: '模型文件不完整。', model_version: '模型版本不支持。', renderer_crash: '渲染进程出了点问题。', mcp_lost: 'MCP 断开了。', unknown: '出了点小状况。' },
  quit: { title: '要退出吗？', message: '确定要关掉我吗？', confirm: '退出', cancel: '再待会儿' },
  menu: { recenter: '回到中间', settings: '设置', about: '关于', quit: '退出' },
  tray: { tooltip: '鲸诺海', tooltip_waiting: '鲸诺海', quit: '退出' },
  about: { title: '鲸诺海', body: '', birthday_extra: '' }
};

function loadStrings() {
  const flavor = process.env.DSH_FLAVOR === 'open' ? 'open' : 'personal';
  const name = flavor === 'open' ? 'strings.open.json' : 'strings.json';
  const candidates = [
    path.join(__dirname, '..', 'strings', name),
    path.join(__dirname, '..', '..', '鲸诺海桌面版', '文本', name)
  ];
  for (let i = 0; i < candidates.length; i += 1) {
    try {
      if (fs.existsSync(candidates[i])) {
        return JSON.parse(fs.readFileSync(candidates[i], 'utf8'));
      }
    } catch (e) { /* 读不出来就用下一处，最后用兜底 */ }
  }
  return FALLBACK;
}

module.exports = loadStrings;
