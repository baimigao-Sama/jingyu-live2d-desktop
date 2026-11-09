/* 鲸诺海 · 控制桥（两条通道，自动选）
 *  桌面版（Electron）：主进程收到 ws://127.0.0.1:3757 的指令 → IPC → 这里
 *  网页调试版：浏览器不能开 ws server，改轮询 http://127.0.0.1:3758/last
 * 指令格式见 ws-server.js 头部注释。
 */
(function () {
  'use strict';
  var URL = 'http://127.0.0.1:3758/last';
  var lastSeen = null;
  var handler = null;
  var stateEl = null;

  var bridge = {
    init: function (cb) {
      handler = cb;
      stateEl = document.getElementById('wsstate');

      if (window.NonoDesktop && window.NonoDesktop.onCommand) {
        window.NonoDesktop.onCommand(function (cmd) {
          if (handler) handler(cmd);
        });
        bridge.setState('IPC 已连');
        return;
      }
      setInterval(poll, 800);
      poll();
    },
    setState: function (txt) {
      if (stateEl && !window.NONO_DESKTOP) stateEl.textContent = '控制：' + txt;
    }
  };

  async function poll() {
    try {
      var r = await fetch(URL, { cache: 'no-store' });
      var data = await r.json();
      if (!data || data.seq === undefined) return;
      if (data.seq !== lastSeen) {
        lastSeen = data.seq;
        bridge.setState('已连 ' + data.seq);
        if (data.cmd && handler) handler(data.cmd);
      }
    } catch (e) {
      bridge.setState('桥未启动');
    }
  }

  window.NonoControlBridge = bridge;
})();
