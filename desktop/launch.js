/* 一键启动。
 * 有些宿主（WorkBuddy / VS Code 之类）会往子进程注入 ELECTRON_RUN_AS_NODE=1
 * 和 NODE_OPTIONS=--require=...，这会让 electron.exe 退化成纯 Node，
 * app / BrowserWindow 全是 undefined。这里显式清掉，保证双击或 npm start 都能起来。
 */
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const root = path.resolve(__dirname, '..');
const exe = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');

if (!fs.existsSync(exe)) {
  console.error('找不到 Electron：' + exe);
  console.error('先在这个目录跑一次 npm install');
  process.exit(1);
}

const env = Object.assign({}, process.env);
delete env.ELECTRON_RUN_AS_NODE;
delete env.NODE_OPTIONS;

const child = spawn(exe, [root], { env: env, cwd: root, stdio: 'inherit' });
child.on('error', function (e) { console.error('启动失败：', e.message); process.exit(1); });
child.on('exit', function (code) { process.exit(code === null ? 0 : code); });
