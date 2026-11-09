/* 构建前同步文案：外层\鲸诺海桌面版\文本 → live2d\strings\
 * 一份源，两份构建输入。别手改 strings\，改 文本\。
 */
'use strict';

const path = require('path');
const fs = require('fs');

const SRC = path.join(__dirname, '..', '..', '鲸诺海桌面版', '文本');
const DST = path.join(__dirname, '..', 'strings');

fs.mkdirSync(DST, { recursive: true });
['strings.json', 'strings.open.json'].forEach(function (name) {
  const from = path.join(SRC, name);
  const to = path.join(DST, name);
  if (!fs.existsSync(from)) {
    console.error('[文案] 缺 ' + from);
    process.exit(1);
  }
  fs.copyFileSync(from, to);
  console.log('[文案] ' + name + ' 已同步');
});
