/* 鲸诺海 · 自绘右键菜单的桥
 * 菜单窗口只做渲染，所有动作都回主进程执行（菜单项里没有函数可序列化）。
 */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('NonoMenu', {
  ready: function () { ipcRenderer.send('nono-menu-ready'); },
  click: function (id, nextOn) { ipcRenderer.send('nono-menu-click', { id: id, nextOn: nextOn }); },
  resize: function (h) { ipcRenderer.send('nono-menu-resize', h); },
  close: function () { ipcRenderer.send('nono-menu-close'); },
  onModel: function (cb) {
    ipcRenderer.on('nono-menu-model', function (_e, model) { cb(model); });
  }
});
