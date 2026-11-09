/* 阶段气泡系统(0号《督办》任务1,petbox 同款)
 * 上半身随机位冒小圆泡，上飘+左右晃+淡出，最多5颗，不挡脸，config能关
 * 坐标系:归一化(0~1),渲染时乘窗口宽高
 */
(function () {
  'use strict';

  var MAX_BUBBLES = 5;
  var SPOTS = [
    { x: 0.42, y: 0.22 },  // 头边左
    { x: 0.58, y: 0.25 },  // 头边右
    { x: 0.38, y: 0.35 },  // 左肩
    { x: 0.62, y: 0.38 },  // 右肩
    { x: 0.50, y: 0.45 }   // 胸口
  ];
  var FACE = { x0: 0.45, x1: 0.55, y0: 0.28, y1: 0.42 };

  var bubbles = [];
  var layer = null;
  var enabled = true;

  function nearFace(x, y) {
    return x > FACE.x0 && x < FACE.x1 && y > FACE.y0 && y < FACE.y1;
  }

  function tooClose(x, y) {
    for (var i = 0; i < bubbles.length; i++) {
      var dx = (bubbles[i].nx - x) * 400;
      var dy = (bubbles[i].ny - y) * 600;
      if (Math.sqrt(dx * dx + dy * dy) < 30) return true;
    }
    return false;
  }

  function pickSpot() {
    var avail = [];
    for (var i = 0; i < SPOTS.length; i++) {
      if (!nearFace(SPOTS[i].x, SPOTS[i].y) && !tooClose(SPOTS[i].x, SPOTS[i].y)) {
        avail.push(SPOTS[i]);
      }
    }
    return avail.length ? avail[Math.floor(Math.random() * avail.length)] : SPOTS[0];
  }

  function spawn(text, ms) {
    if (!enabled || !layer) return;
    if (bubbles.length >= MAX_BUBBLES) {
      var oldest = bubbles.shift();
      if (oldest.el && oldest.el.parentNode) oldest.el.parentNode.removeChild(oldest.el);
    }
    var spot = pickSpot();
    var el = document.createElement('div');
    el.className = 'stage-bubble';
    el.textContent = text;
    layer.appendChild(el);
    bubbles.push({
      nx: spot.x, ny: spot.y,
      el: el,
      age: 0,
      life: ms || (2000 + Math.random() * 2000),
      vy: -0.018,
      driftX: (Math.random() - 0.5) * 0.003
    });
  }

  function tick(dtMs) {
    var dt = dtMs / 1000;
    for (var i = bubbles.length - 1; i >= 0; i--) {
      var b = bubbles[i];
      b.age += dtMs;
      b.ny += b.vy * dt;
      b.nx += Math.sin(b.age / 300) * 0.0003 + b.driftX * dt * 0.01;
      if (b.el) {
        b.el.style.left = (b.nx * window.innerWidth) + 'px';
        b.el.style.top = (b.ny * window.innerHeight) + 'px';
        var alpha = Math.max(0, Math.min(1, 1 - b.age / b.life));
        b.el.style.opacity = alpha;
      }
      if (b.age >= b.life) {
        if (b.el && b.el.parentNode) b.el.parentNode.removeChild(b.el);
        bubbles.splice(i, 1);
      }
    }
  }

  function init() {
    // index.html 里已有静态层,别再造第二个重复 id 的
    layer = document.getElementById('stage-bubble-layer');
    if (!layer) {
      layer = document.createElement('div');
      layer.id = 'stage-bubble-layer';
      layer.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:8;overflow:hidden;';
      document.body.appendChild(layer);
    }
  }

  function setEnabled(v) {
    enabled = !!v;
    if (!enabled) {
      for (var i = 0; i < bubbles.length; i++) {
        if (bubbles[i].el && bubbles[i].el.parentNode) bubbles[i].el.parentNode.removeChild(bubbles[i].el);
      }
      bubbles = [];
    }
  }

  window.NonoStageBubbles = {
    spawn: spawn,
    tick: tick,
    init: init,
    setEnabled: setEnabled,
    get count() { return bubbles.length; }
  };
})();
