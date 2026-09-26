/* handwrite.js —— 学生端手写板组件（契约 §6）
 * 全局暴露：Handwrite.create(container, opts)
 *   opts: { caption:string 题注, penOnly:boolean 默认 true 仅笔, height:number 画布高, onChange:fn }
 *   返回：{ getPNG(), isEmpty(), clear(), undo(), redo(), destroy() }
 * 实现要点：
 *   1) Pointer Events + touch-action:none；"仅笔"模式只接受 pointerType==='pen'（Apple Pencil，
 *      防手掌误触），工具栏可切换"仅笔 / 笔·手指·鼠标"；被拒输入在画布上弹醒目提示条，
 *      支持一键切换；模式选择在同一页面内跨题目记忆；状态行实时显示最近 pointerType 与 pressure。
 *   2) perfect-freehand（CDN UMD，全局 perfectFreehand.getStroke）做压感平滑与宽度变化；
 *      CDN 加载失败时自动降级为普通折线，任何情况下不抛错。
 *   3) Canvas 按 devicePixelRatio 缩放；创建 2D 上下文时尝试 desynchronized:true（特性检测包裹）。
 *   4) 笔迹按 CSS 像素坐标存储；resize / 旋转屏幕后按新尺寸整体重绘，笔迹不丢失。
 *   5) getPNG()：合成白底 + opts.caption 题注文字，导出 PNG data URL。
 */
(function (global) {
  'use strict';

  var INK = '#000000';   // 笔迹颜色：黑色
  var BASE_W = 4;        // 基准线宽（CSS 像素）
  var LINE_H = 20;       // 题注行高
  var CAP_FONT = '14px -apple-system, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif';
  var lastPenOnly = null;   // 模式记忆：同一页面内跨题目共享（null = 学生尚未做过选择）

  /* 取 perfect-freehand 的 getStroke；不可用时返回 null（降级为普通折线） */
  function getStrokeFn() {
    try {
      if (global.perfectFreehand && typeof global.perfectFreehand.getStroke === 'function') {
        return global.perfectFreehand.getStroke;
      }
    } catch (e) { /* 忽略 */ }
    return null;
  }

  /* 创建 2D 上下文：优先尝试 desynchronized 低延迟选项（特性检测包裹，失败回退） */
  function makeCtx(canvas) {
    var ctx = null;
    try {
      ctx = canvas.getContext('2d', { desynchronized: true });
    } catch (e) { ctx = null; }
    if (!ctx) {
      try { ctx = canvas.getContext('2d'); } catch (e2) { ctx = null; }
    }
    return ctx;
  }

  function create(container, opts) {
    if (!container || typeof container.appendChild !== 'function') {
      throw new Error('Handwrite.create：container 参数无效');
    }
    opts = opts || {};
    var caption = (typeof opts.caption === 'string') ? opts.caption : '';
    var height = (typeof opts.height === 'number' && opts.height >= 120) ? opts.height : 300;
    var onChange = (typeof opts.onChange === 'function') ? opts.onChange : null;

    /* ---- 内部状态 ---- */
    var strokes = [];       // 已完成笔迹：{ pen:bool, points:[{x,y,p}] }（CSS 像素坐标）
    var history = [];       // 撤销栈：{ t:'add', stroke } | { t:'clear', items:[...] }
    var redoStack = [];     // 重做栈
    var current = null;     // 正在书写的笔迹
    var activeId = null;    // 正在书写的 pointerId
    var rect = null;        // 落笔时缓存的画布视口矩形（一笔之内不重算）
    var penOnly = (opts.penOnly !== false);   // 默认：仅笔；但若本页学生已切换过模式则沿用其选择
    if (lastPenOnly !== null) penOnly = lastPenOnly;
    var destroyed = false;
    var cssW = 300;
    var cssH = height;
    var dpr = 1;

    /* ---- 构建 DOM ---- */
    container.classList.add('hw');
    container.innerHTML =
      '<div class="hw-toolbar">' +
        '<span class="hw-seg">' +
          '<button type="button" class="hw-btn hw-mode hw-mode-pen" title="只响应触控笔（Apple Pencil），防手掌误触">仅笔</button>' +
          '<button type="button" class="hw-btn hw-mode hw-mode-both" title="触控笔、手指、鼠标都可以书写">笔·手指·鼠标</button>' +
        '</span>' +
        '<span class="hw-flex"></span>' +
        '<button type="button" class="hw-btn hw-undo">撤销</button>' +
        '<button type="button" class="hw-btn hw-redo">重做</button>' +
        '<button type="button" class="hw-btn hw-clear">清空</button>' +
      '</div>' +
      '<div class="hw-wrap">' +
        '<canvas class="hw-canvas"></canvas>' +
        '<div class="hw-hint">在此手写作答</div>' +
        '<div class="hw-reject" hidden>' +
          '<span>仅笔模式：只响应 Apple Pencil（防手掌误触）</span>' +
          '<button type="button" class="hw-btn hw-reject-btn">允许手指/鼠标书写</button>' +
        '</div>' +
      '</div>' +
      '<div class="hw-status">输入源：—　压感：—</div>';

    var modePenBtn = container.querySelector('.hw-mode-pen');
    var modeBothBtn = container.querySelector('.hw-mode-both');
    var undoBtn = container.querySelector('.hw-undo');
    var redoBtn = container.querySelector('.hw-redo');
    var clearBtn = container.querySelector('.hw-clear');
    var wrap = container.querySelector('.hw-wrap');
    var canvas = container.querySelector('.hw-canvas');
    var hint = container.querySelector('.hw-hint');
    var rejectEl = container.querySelector('.hw-reject');
    var rejectBtn = container.querySelector('.hw-reject-btn');
    var status = container.querySelector('.hw-status');
    var ctx = makeCtx(canvas);
    var base = document.createElement('canvas');   // 已完成笔迹的离屏缓存（书写时只重绘当前一笔）
    var baseCtx = makeCtx(base);
    var measureCanvas = null;                      // 题注换行测量用

    /* ---- 尺寸与重绘 ---- */
    function resize() {
      if (destroyed) return;
      cssW = Math.max(120, wrap.clientWidth || 300);
      cssH = height;
      wrap.style.height = cssH + 'px';
      dpr = Math.max(1, global.devicePixelRatio || 1);
      canvas.width = Math.max(1, Math.round(cssW * dpr));
      canvas.height = Math.max(1, Math.round(cssH * dpr));
      canvas.style.width = cssW + 'px';
      canvas.style.height = cssH + 'px';
      if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      redrawAll();
    }

    function clearCtx(c, cv) {
      if (!c) return;
      c.save();
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.clearRect(0, 0, cv.width, cv.height);
      c.restore();
    }

    /* 已完成笔迹渲染到离屏缓存 */
    function renderBase() {
      if (!baseCtx) return;
      base.width = canvas.width;
      base.height = canvas.height;
      baseCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
      for (var i = 0; i < strokes.length; i++) drawStroke(baseCtx, strokes[i], true);
    }

    /* 主画布 = 离屏缓存 + 正在书写的笔迹 */
    function drawCurrent() {
      if (!ctx) return;
      clearCtx(ctx, canvas);
      ctx.drawImage(base, 0, 0, cssW, cssH);
      if (current) drawStroke(ctx, current, false);
      updateHint();
    }

    function redrawAll() {
      renderBase();
      drawCurrent();
      updateButtons();
    }

    /* ---- 笔迹绘制 ---- */
    function dot(c, p) {
      var pr = (typeof p.p === 'number') ? p.p : 0.5;
      var r = Math.max(1.2, BASE_W * (0.4 + 0.6 * pr));
      c.fillStyle = INK;
      c.beginPath();
      c.arc(p.x, p.y, r, 0, Math.PI * 2);
      c.fill();
    }

    /* 降级路径：普通折线，线宽随压力变化 */
    function polyline(c, pts) {
      c.strokeStyle = INK;
      c.lineCap = 'round';
      c.lineJoin = 'round';
      if (!pts || !pts.length) return;
      if (pts.length === 1) { dot(c, pts[0]); return; }
      for (var i = 1; i < pts.length; i++) {
        var a = pts[i - 1];
        var b = pts[i];
        var pr = (typeof a.p === 'number') ? a.p : 0.5;
        c.lineWidth = Math.max(1, BASE_W * (0.45 + 0.95 * pr));
        c.beginPath();
        c.moveTo(a.x, a.y);
        c.lineTo(b.x, b.y);
        c.stroke();
      }
    }

    /* 画一条笔迹：perfect-freehand 可用时按轮廓填充（压感平滑），否则折线降级 */
    function drawStroke(c, stroke, isLast) {
      if (!c || !stroke) return;
      var pts = stroke.points || [];
      if (!pts.length) return;
      var fn = getStrokeFn();
      if (fn) {
        var input = [];
        for (var i = 0; i < pts.length; i++) {
          input.push([pts[i].x, pts[i].y, (typeof pts[i].p === 'number') ? pts[i].p : 0.5]);
        }
        var outline = null;
        try {
          outline = fn(input, {
            size: BASE_W * 2,
            thinning: 0.6,
            smoothing: 0.55,
            streamline: 0.4,
            simulatePressure: !stroke.pen,   // 手指/鼠标无真实压感时用速度模拟
            last: !!isLast
          });
        } catch (e) { outline = null; }
        if (outline && outline.length === 1) { dot(c, pts[0]); return; }
        if (outline && outline.length > 1) {
          c.fillStyle = INK;
          c.beginPath();
          c.moveTo(outline[0][0], outline[0][1]);
          for (var j = 1; j < outline.length; j++) {
            c.lineTo(outline[j][0], outline[j][1]);
          }
          c.closePath();
          c.fill();
          return;
        }
        /* outline 异常 → 落入下方折线降级 */
      }
      polyline(c, pts);
    }

    /* ---- 指针事件 ---- */
    function accept(e) {
      if (penOnly) return e.pointerType === 'pen';
      return true;
    }

    function setStatus(type, pressure, note) {
      var t = (type == null || type === '') ? '—' : String(type);
      var p = (typeof pressure === 'number' && isFinite(pressure)) ? pressure.toFixed(2) : '—';
      status.textContent = '输入源：' + t + '　压感：' + p + '　' +
        (penOnly ? '【仅笔】' : '【笔·手指·鼠标】') + (note ? '　' + note : '');
    }

    /* ---- 仅笔模式下被拒输入的画布内提示条（醒目 + 一键切换，6 秒自动消失） ---- */
    var rejectTid = null;
    function showReject() {
      if (destroyed) return;
      rejectEl.hidden = false;
      clearTimeout(rejectTid);
      rejectTid = setTimeout(hideReject, 6000);
    }
    function hideReject() {
      rejectEl.hidden = true;
      clearTimeout(rejectTid);
    }
    function onRejectBtn() { setMode(false); }

    function ptFromEvent(e) {
      var pr = (e.pointerType === 'pen' && typeof e.pressure === 'number' && e.pressure > 0) ? e.pressure : 0.5;
      return { x: e.clientX - rect.left, y: e.clientY - rect.top, p: pr };
    }

    function onDown(e) {
      if (destroyed) return;
      setStatus(e.pointerType, e.pressure);
      if (!accept(e)) {
        try { e.preventDefault(); } catch (err) { /* 忽略 */ }
        setStatus(e.pointerType, e.pressure, '已忽略（仅笔模式）');
        showReject();
        return;
      }
      if (current) return;
      e.preventDefault();
      rect = canvas.getBoundingClientRect();
      activeId = e.pointerId;
      try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
      current = { pen: e.pointerType === 'pen', points: [ptFromEvent(e)] };
      drawCurrent();
    }

    function appendPoint(p) {
      var pts = current.points;
      var lp = pts[pts.length - 1];
      var dx = p.x - lp.x;
      var dy = p.y - lp.y;
      var dp = Math.abs(p.p - lp.p);
      if ((dx * dx + dy * dy) < 0.5 && dp < 0.02) return;   // 过密的点跳过
      pts.push(p);
    }

    function onMove(e) {
      if (destroyed) return;
      setStatus(e.pointerType, e.pressure);
      if (!current || e.pointerId !== activeId || !rect) return;
      e.preventDefault();
      var evs = null;
      if (typeof e.getCoalescedEvents === 'function') {   // 合并事件取更密的采样点
        try { evs = e.getCoalescedEvents(); } catch (err) { evs = null; }
      }
      if (!evs || !evs.length) evs = [e];
      for (var i = 0; i < evs.length; i++) appendPoint(ptFromEvent(evs[i]));
      drawCurrent();
    }

    function finishStroke(e) {
      if (!current || e.pointerId !== activeId) return;
      if (current.points.length) {
        strokes.push(current);
        history.push({ t: 'add', stroke: current });
        redoStack.length = 0;
        if (onChange) { try { onChange(isEmpty()); } catch (err) { /* 忽略 */ } }
      }
      current = null;
      activeId = null;
      renderBase();
      drawCurrent();
      updateButtons();
    }

    function onUp(e) {
      if (destroyed) return;
      setStatus(e.pointerType, e.pressure);
      finishStroke(e);
    }

    function onCancel(e) {
      if (destroyed) return;
      if (current && e.pointerId === activeId) {   // 系统打断（来电等）：丢弃未完成的一笔
        current = null;
        activeId = null;
        drawCurrent();
        updateButtons();
      }
    }

    function onCtxMenu(e) { e.preventDefault(); }   // iPad 长按禁用右键菜单

    /* ---- 撤销 / 重做 / 清空 ---- */
    function undo() {
      if (destroyed || !history.length || current) return;
      var a = history.pop();
      if (a.t === 'add') strokes.pop();
      else if (a.t === 'clear') strokes = a.items.slice();
      redoStack.push(a);
      redrawAll();
      if (onChange) { try { onChange(isEmpty()); } catch (err) { /* 忽略 */ } }
    }

    function redo() {
      if (destroyed || !redoStack.length || current) return;
      var a = redoStack.pop();
      if (a.t === 'add') strokes.push(a.stroke);
      else if (a.t === 'clear') strokes = [];
      history.push(a);
      redrawAll();
      if (onChange) { try { onChange(isEmpty()); } catch (err) { /* 忽略 */ } }
    }

    function clearAll() {
      if (destroyed || !strokes.length) return;
      history.push({ t: 'clear', items: strokes.slice() });
      redoStack.length = 0;
      strokes = [];
      redrawAll();
      if (onChange) { try { onChange(isEmpty()); } catch (err) { /* 忽略 */ } }
    }

    /* ---- 工具栏 / 状态 ---- */
    function updateHint() {
      hint.hidden = !(strokes.length === 0 && !current);
    }

    function updateButtons() {
      undoBtn.disabled = history.length === 0;
      redoBtn.disabled = redoStack.length === 0;
      clearBtn.disabled = strokes.length === 0;
    }

    function setMode(pen) {
      penOnly = !!pen;
      lastPenOnly = penOnly;
      modePenBtn.classList.toggle('active', penOnly);
      modeBothBtn.classList.toggle('active', !penOnly);
      hideReject();
      setStatus(null, null);
      hint.textContent = '在此手写作答';
    }

    function onModePen() { setMode(true); }
    function onModeBoth() { setMode(false); }

    /* ---- 题注换行（最多 4 行，超出加省略号） ---- */
    function wrapCaption(text, maxW) {
      var t = String(text || '').replace(/\s+/g, ' ').trim();
      if (!t) return [];
      try {
        if (!measureCanvas) measureCanvas = document.createElement('canvas');
        var mc = measureCanvas.getContext('2d');
        if (!mc) return [t];
        mc.font = CAP_FONT;
        var lines = [];
        var line = '';
        var truncated = false;
        for (var i = 0; i < t.length; i++) {
          var ch = t.charAt(i);
          if (line && mc.measureText(line + ch).width > maxW) {
            lines.push(line);
            line = '';
            if (lines.length >= 4) { truncated = true; break; }
          }
          line += ch;
        }
        if (truncated) lines[3] = lines[3] + '…';
        else if (line) lines.push(line);
        return lines;
      } catch (e) { return [t]; }
    }

    /* ---- 导出 PNG：白底 + 题注 + 笔迹，返回 data URL；空板/失败返回 null ---- */
    function getPNG() {
      if (destroyed || !strokes.length) return null;
      try {
        var lines = wrapCaption(caption, Math.max(80, cssW - 16));
        var capH = lines.length ? (lines.length * LINE_H + 12) : 0;
        var scale = Math.min(2, Math.max(1, global.devicePixelRatio || 1));
        var out = document.createElement('canvas');
        out.width = Math.max(1, Math.round(cssW * scale));
        out.height = Math.max(1, Math.round((cssH + capH) * scale));
        var c = makeCtx(out);
        if (!c) return null;
        c.setTransform(scale, 0, 0, scale, 0, 0);
        c.fillStyle = '#ffffff';
        c.fillRect(0, 0, cssW, cssH + capH);
        if (lines.length) {
          c.fillStyle = '#444444';
          c.font = CAP_FONT;
          c.textBaseline = 'alphabetic';
          for (var i = 0; i < lines.length; i++) {
            c.fillText(lines[i], 8, 18 + i * LINE_H);
          }
          c.strokeStyle = '#cccccc';
          c.lineWidth = 1;
          c.beginPath();
          c.moveTo(0, capH - 0.5);
          c.lineTo(cssW, capH - 0.5);
          c.stroke();
        }
        c.save();
        c.translate(0, capH);
        for (var k = 0; k < strokes.length; k++) drawStroke(c, strokes[k], true);
        c.restore();
        return out.toDataURL('image/png');
      } catch (e) {
        return null;   // 导出失败不抛错，交卷时 strokesPng 记为 null
      }
    }

    /* ---- resize / 旋转屏幕（防抖后整体重绘，笔迹不丢） ---- */
    var resizeTid = null;
    function scheduleResize() {
      clearTimeout(resizeTid);
      resizeTid = setTimeout(resize, 120);
    }
    var ro = null;
    if (typeof global.ResizeObserver === 'function') {
      try {
        ro = new global.ResizeObserver(scheduleResize);
        ro.observe(wrap);
      } catch (e) { ro = null; }
    }
    if (!ro) {
      global.addEventListener('resize', scheduleResize);
      global.addEventListener('orientationchange', scheduleResize);
    }

    /* ---- 事件绑定 ---- */
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onCancel);
    canvas.addEventListener('contextmenu', onCtxMenu);
    modePenBtn.addEventListener('click', onModePen);
    modeBothBtn.addEventListener('click', onModeBoth);
    rejectBtn.addEventListener('click', onRejectBtn);
    undoBtn.addEventListener('click', undo);
    redoBtn.addEventListener('click', redo);
    clearBtn.addEventListener('click', clearAll);

    setMode(penOnly);
    resize();

    /* ---- 销毁 ---- */
    function destroy() {
      if (destroyed) return;
      destroyed = true;
      clearTimeout(resizeTid);
      clearTimeout(rejectTid);
      if (ro) {
        try { ro.disconnect(); } catch (e) { /* 忽略 */ }
        ro = null;
      } else {
        global.removeEventListener('resize', scheduleResize);
        global.removeEventListener('orientationchange', scheduleResize);
      }
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onCancel);
      canvas.removeEventListener('contextmenu', onCtxMenu);
      modePenBtn.removeEventListener('click', onModePen);
      modeBothBtn.removeEventListener('click', onModeBoth);
      rejectBtn.removeEventListener('click', onRejectBtn);
      undoBtn.removeEventListener('click', undo);
      redoBtn.removeEventListener('click', redo);
      clearBtn.removeEventListener('click', clearAll);
      container.innerHTML = '';
      container.classList.remove('hw');
    }

    return {
      getPNG: getPNG,
      isEmpty: function () { return strokes.length === 0; },
      clear: clearAll,
      undo: undo,
      redo: redo,
      destroy: destroy
    };
  }

  global.Handwrite = { create: create };
})(window);
