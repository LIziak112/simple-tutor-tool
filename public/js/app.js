/* app.js —— 学生端全部页面行为（契约 §7），判分规范化按契约 §5 逐条实现。
 * 数据来源：GET /api/content（lectures + units）；交卷：POST /api/submit（§2 submission record）。
 * CDN（marked / KaTeX / perfect-freehand）全部有降级：不可用时显示转义后的纯文本，页面不崩溃。
 * 后端不可达：顶栏显示"离线模式"，禁止交卷，并给出明确中文提示。
 */
(function (global) {
  'use strict';

  /* ================= 小工具 ================= */

  function $(sel, root) { return (root || document).querySelector(sel); }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\x22/g, '&quot;')
      .replace(/\x27/g, '&#39;');
  }

  var toastTimer = null;
  function toast(msg, ms) {
    var t = $('#toast');
    if (!t) return;
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, ms || 2600);
  }

  function fmtDur(sec) {
    sec = Math.max(0, Math.floor(Number(sec) || 0));
    var h = Math.floor(sec / 3600);
    var m = Math.floor((sec % 3600) / 60);
    var s = sec % 60;
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return h > 0 ? p(h) + ':' + p(m) + ':' + p(s) : p(m) + ':' + p(s);
  }

  /* ================= 富文本渲染管线 =================
   * 流程：公式保护（占位符）→ 例题解析折叠（可选）→ marked → 公式还原（含自动多行化）→ KaTeX → 目录（可选）
   * 关键点：$...$ 必须先从文本中抽出再过 marked，否则公式里的 _ * < > 会被当 Markdown 语法破坏
   *（下标被吃成斜体、< 被当 HTML 标签开头等，导致公式渲染失败）。
   */

  function hasMarked() {
    try {
      return !!(global.marked && (typeof global.marked.parse === 'function' || typeof global.marked === 'function'));
    } catch (e) { return false; }
  }

  function hasKatex() {
    try {
      return typeof global.renderMathInElement === 'function' && typeof global.katex !== 'undefined';
    } catch (e) { return false; }
  }

  var MATH_TOKEN = 'zKaTeXSpanz';   // 词元形式，marked 不会碰它

  /* 公式保护：跳过代码围栏，$$..$$ 与 $..$ 换成占位符。返回 {text, displayMath[], inlineMath[]} */
  function protectMath(src) {
    var displayMath = [], inlineMath = [];
    var lines = String(src).split('\n');
    var out = [], inFence = false;
    for (var li = 0; li < lines.length; li++) {
      var line = lines[li];
      if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; out.push(line); continue; }
      if (inFence) { out.push(line); continue; }
      line = line.replace(/\$\$([^$]+)\$\$/g, function (_, tex) {
        displayMath.push(tex);
        return MATH_TOKEN + 'D' + (displayMath.length - 1) + MATH_TOKEN;
      });
      line = line.replace(/\$([^$\n]+?)\$/g, function (_, tex) {
        if (!tex.trim()) return _;
        inlineMath.push(tex);
        return MATH_TOKEN + 'I' + (inlineMath.length - 1) + MATH_TOKEN;
      });
      out.push(line);
    }
    return { text: out.join('\n'), displayMath: displayMath, inlineMath: inlineMath };
  }

  /* 顶层（花括号深度 0）按 = 切分公式；任一段为空返回 null（放弃变换） */
  function splitTopLevelEquals(tex) {
    var parts = [], depth = 0, cur = '', i = 0;
    while (i < tex.length) {
      var ch = tex[i];
      if (ch === '\\') { cur += ch + (tex.charAt(i + 1) || ''); i += 2; continue; }
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      if (ch === '=' && depth === 0) {
        if (cur.trim() === '') return null;
        parts.push(cur); cur = ''; i++; continue;
      }
      cur += ch; i++;
    }
    if (cur.trim() === '') return null;
    parts.push(cur);
    return parts;
  }

  /* 行内公式自动整理：
   *  a) 含 \begin{环境}（如 cases）→ 独立展示公式（行内会挤成一条还要横向滚动）；
   *  b) 长链式等式（>=3 段、去空白 >=18 字符、无对齐符）→ aligned 多行，解决"一行排到底"。
   */
  function transformInlineMath(tex) {
    try {
      if (tex.indexOf('\\begin{') >= 0 && tex.length >= 30) {
        return { tex: tex, display: true };
      }
      if (tex.indexOf('\\begin{') < 0 && tex.indexOf('\\\\') < 0 && tex.indexOf('&') < 0
          && tex.replace(/\s/g, '').length >= 18) {
        var parts = splitTopLevelEquals(tex);
        if (parts && parts.length >= 3) {
          var body = parts[0].trim() + ' &= ' + parts.slice(1).map(function (p) { return p.trim(); }).join(' \\\\ &= ');
          return { tex: '\\begin{aligned}' + body + '\\end{aligned}', display: true };
        }
      }
    } catch (e) { /* 任何异常都按原样返回 */ }
    return { tex: tex, display: false };
  }

  /* 例题解析折叠：**【解】** 起的段落包进 <details>，到块级边界（标题 / --- / 下一个 **【）为止 */
  function collapseSolutions(text) {
    var lines = text.split('\n');
    var out = [], i = 0;
    var solHead = /^\*\*【[^】]*解[^】]*】\*\*\s*$/;
    while (i < lines.length) {
      if (solHead.test(lines[i].trim())) {
        var j = i + 1, buf = [lines[i]];
        while (j < lines.length) {
          var l = lines[j];
          if (/^#{1,6}\s/.test(l) || /^\s*(-{3,}|\*{3,})\s*$/.test(l) || solHead.test(l.trim())) break;
          buf.push(l); j++;
        }
        while (buf.length && !buf[buf.length - 1].trim()) buf.pop();
        out.push('<details class="lec-sol">');
        out.push('');
        out.push('<summary>查看解析</summary>');
        out.push('');
        out.push(buf.join('\n'));
        out.push('');
        out.push('</details>');
        out.push('');
        i = j;
        continue;
      }
      out.push(lines[i]); i++;
    }
    return out.join('\n');
  }

  function splitJoin(s, token, rep) { return s.split(token).join(rep); }

  /* markdown → HTML（公式占位符还原在后）。marked 不可用时整体降级为转义纯文本 */
  function mdToHtml(mdText, opts) {
    opts = opts || {};
    var src = String(mdText == null ? '' : mdText);
    var prot = protectMath(src);
    var prepared = opts.solutions ? collapseSolutions(prot.text) : prot.text;
    var html = null;
    if (hasMarked()) {
      try {
        html = String(global.marked.parse ? global.marked.parse(prepared) : global.marked(prepared));
      } catch (e) { html = null; }
    }
    if (html == null) {
      return '<div class="plain-md">' + esc(src).replace(/\r?\n/g, '<br>') + '</div>';
    }
    for (var d = 0; d < prot.displayMath.length; d++) {
      html = splitJoin(html, MATH_TOKEN + 'D' + d + MATH_TOKEN, '$$' + prot.displayMath[d] + '$$');
    }
    for (var n = 0; n < prot.inlineMath.length; n++) {
      var t = transformInlineMath(prot.inlineMath[n]);
      html = splitJoin(html, MATH_TOKEN + 'I' + n + MATH_TOKEN,
        t.display ? '$$' + t.tex + '$$' : '$' + t.tex + '$');
    }
    return html;
  }

  /* 讲义阅读页目录：由渲染后的 H2/H3 生成，锚点平滑滚动 */
  function buildToc(node) {
    var heads = node.querySelectorAll('h2, h3');
    if (heads.length < 2) return;
    var nav = document.createElement('nav');
    nav.className = 'lec-toc-nav';
    var count = 0;
    for (var i = 0; i < heads.length; i++) {
      var h = heads[i];
      var txt = (h.textContent || '').trim();
      if (!txt) continue;
      var id = 'lec-sec-' + (++count);
      h.id = id;
      var a = document.createElement('a');
      a.href = '#' + id;
      a.textContent = txt;
      a.className = (h.tagName === 'H2') ? 'toc-h2' : 'toc-h3';
      a.addEventListener('click', function (ev) {
        ev.preventDefault();
        var t = document.getElementById(this.getAttribute('href').slice(1));
        if (t) {
          try { t.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
          catch (e) { t.scrollIntoView(); }
        }
      });
      nav.appendChild(a);
    }
    if (!nav.childNodes.length) return;
    var box = document.createElement('details');
    box.className = 'lec-toc';
    box.open = true;
    var sum = document.createElement('summary');
    sum.textContent = '本讲目录';
    box.appendChild(sum);
    box.appendChild(nav);
    node.insertBefore(box, node.firstChild);
  }

  /* markdown + KaTeX 公式渲染；opts: {solutions:bool 折叠例题解析, toc:bool 生成目录} */
  function renderRich(node, mdText, opts) {
    if (!node) return;
    node.innerHTML = mdToHtml(mdText, opts);
    if (hasKatex()) {
      try {
        global.renderMathInElement(node, {
          delimiters: [
            { left: '$$', right: '$$', display: true },
            { left: '$', right: '$', display: false }
          ],
          throwOnError: false
        });
      } catch (e) { /* 公式渲染失败时保留原文 */ }
    }
    if (opts && opts.toc) buildToc(node);
  }

  /* ================= 判分规范化（契约 §5，逐条实现） ================= */

  /* normalize：NFKC → 去全部空白 → 形近负号统一为半角 - → 去 $ 与 \left \right → 首尾 trim */
  function normalize(s) {
    var t = String(s == null ? '' : s);
    try { t = t.normalize('NFKC'); } catch (e) { /* 老环境无 normalize，跳过 */ }
    t = t.replace(/\s+/g, '');
    t = t.replace(/[﹣－–—−]/g, '-');
    t = t.split('$').join('');
    t = t.split('\\left').join('').split('\\right').join('');
    return t.trim();
  }

  var JUDGE_TRUE = ['正确', '对', '√', '✔', 'T', 'TRUE', '是'];
  var JUDGE_FALSE = ['错误', '错', '×', '✘', 'F', 'FALSE', '否'];

  /* 判断题答案归一化：返回 '正确' | '错误' | null（无法识别） */
  function judgeOf(text) {
    var n = normalize(text).toUpperCase();
    if (!n) return null;
    if (JUDGE_TRUE.indexOf(n) >= 0) return '正确';
    if (JUDGE_FALSE.indexOf(n) >= 0) return '错误';
    return null;
  }

  /* 文本逐空判分：逐空 normalize 后全等，全部空对才 correct=true（契约 §5） */
  function gradeTextAll(textAnswer, answers) {
    if (!answers || !answers.length) return null;   // 无标准答案 → 不自动判分
    var parts = String(textAnswer || '').split(';;');
    for (var i = 0; i < answers.length; i++) {
      var a = normalize(answers[i]);
      var s = normalize(parts.length > i ? parts[i] : '');
      if (s !== a) return false;
    }
    return true;
  }

  /* 按题型判分：返回 { correct: true|false|null, autoGraded: bool } */
  function gradeQuestion(q, entry) {
    var answers = (q && q.answers) || [];
    var type = q && q.type;

    if (type === '判断') {
      var picked = entry.choice || '';
      var expect = judgeOf(answers[0]);
      return { correct: picked !== '' && expect !== null && expect === picked, autoGraded: true };
    }

    if (type === '选择') {
      if (!answers.length) return { correct: null, autoGraded: false };
      var pk = normalize(entry.choice).toUpperCase();
      var ex = normalize(answers[0]).toUpperCase();
      return { correct: pk !== '' && pk === ex, autoGraded: true };
    }

    if (type === '填空') {
      var r = gradeTextAll((entry.texts || []).join(';;'), answers);
      return r == null ? { correct: null, autoGraded: false } : { correct: r, autoGraded: true };
    }

    /* 计算 / 应用 / 找错（含未知类型）＝手写题：
       填了"最终答案"文本 → 按契约 §5 文本填法自动判分；只手写未填文本 → correct=null 待老师批注 */
    var text = String(entry.finalText || '').trim();
    if (text) {
      var r2 = gradeTextAll(text, answers);
      return r2 == null ? { correct: null, autoGraded: false } : { correct: r2, autoGraded: true };
    }
    return { correct: null, autoGraded: false };
  }

  /* ================= 设备检测（§2 device：ipad | pc | other） ================= */

  function detectDevice() {
    try {
      var ua = global.navigator.userAgent || '';
      var touch = (global.navigator.maxTouchPoints || 0) > 1;
      var isIpad = /iPad/i.test(ua) || (/Macintosh/i.test(ua) && touch);   // iPadOS 13+ 伪装成 Mac
      if (isIpad) return 'ipad';
      if (/Windows NT|Macintosh|X11|Linux/i.test(ua) && !/Mobi|Android|iPhone/i.test(ua)) return 'pc';
      return 'other';
    } catch (e) { return 'other'; }
  }

  /* ================= HTTP（契约 §3） ================= */

  function apiGet(path, timeoutMs) {
    var ctrl = (typeof global.AbortController === 'function') ? new global.AbortController() : null;
    var opts = { method: 'GET', cache: 'no-store', headers: { 'Accept': 'application/json' } };
    var tid = null;
    if (ctrl) {
      opts.signal = ctrl.signal;
      tid = setTimeout(function () { try { ctrl.abort(); } catch (e) { /* 忽略 */ } }, timeoutMs || 12000);
    }
    return fetch(path, opts).then(
      function (res) {
        if (tid) clearTimeout(tid);
        return res.json().catch(function () { return null; }).then(function (data) {
          return { status: res.status, ok: res.ok, data: data };
        });
      },
      function (err) {
        if (tid) clearTimeout(tid);
        throw err;
      }
    );
  }

  function apiPost(path, bodyObj, timeoutMs) {
    var ctrl = (typeof global.AbortController === 'function') ? new global.AbortController() : null;
    var opts = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(bodyObj)
    };
    var tid = null;
    if (ctrl) {
      opts.signal = ctrl.signal;
      tid = setTimeout(function () { try { ctrl.abort(); } catch (e) { /* 忽略 */ } }, timeoutMs || 60000);
    }
    return fetch(path, opts).then(
      function (res) {
        if (tid) clearTimeout(tid);
        return res.json().catch(function () { return null; }).then(function (data) {
          return { status: res.status, ok: res.ok, data: data };
        });
      },
      function (err) {
        if (tid) clearTimeout(tid);
        throw err;
      }
    );
  }

  function checkHealth() {
    return apiGet('/api/health', 6000).then(function (r) {
      return !!(r && r.ok && r.data && r.data.ok);
    }).catch(function () { return false; });
  }

  /* ================= 全局状态 ================= */

  var LS_NAME = 'xs_student_name';
  var LS_HISTORY = 'xs_student_names';

  var state = {
    name: '',
    content: null,        // GET /api/content 的返回
    online: false,        // 后端是否可达
    checked: false,       // 是否完成过一次连通性检查
    tab: 'lecture',       // 'lecture' | 'practice'
    readingLecture: null, // 正在阅读的讲义
    unit: null,           // 正在作答的单元
    entries: {},          // qid -> { choice, texts, finalText, hw, firstSeen, card }
    quizStart: 0,         // 进答题页时刻
    submitted: false,
    timerId: null
  };
  var observer = null;
  var contentLoading = false;

  var TYPE_CLASS = { '判断': 'judge', '选择': 'choice', '填空': 'blank', '计算': 'calc', '应用': 'apply', '找错': 'finderr' };
  function typeClass(t) { return TYPE_CLASS[t] || 'other'; }
  /* 判断/选择/填空之外（计算、应用、找错、未知类型）一律按手写题渲染（契约 §4/§7.3） */
  function isHwType(t) { return t !== '判断' && t !== '选择' && t !== '填空'; }

  /* ================= 连接状态 ================= */

  function updateNetBadge() {
    var b = $('#netBadge');
    if (!state.checked) {
      b.textContent = '连接中…';
      b.className = 'chip chip-warn';
    } else if (state.online) {
      b.textContent = '已连接';
      b.className = 'chip chip-ok';
    } else {
      b.textContent = '离线模式';
      b.className = 'chip chip-bad';
    }
    updateSubmitBtn();
  }

  function refreshOnline() {
    return checkHealth().then(function (on) {
      var changed = on !== state.online;
      state.online = on;
      state.checked = true;
      updateNetBadge();
      if (changed && !on) toast('网络连接已断开，进入离线模式');
      if (changed && on) toast('已连接到服务器');
      return on;
    });
  }

  function updateSubmitBtn() {
    var footer = $('#quizFooter');
    var btn = $('#submitBtn');
    var show = state.tab === 'practice' && !!state.unit && !state.submitted;
    footer.hidden = !show;
    if (!show) return;
    if (!state.online) {
      btn.disabled = true;
      btn.textContent = '离线模式，无法交卷';
    } else {
      btn.disabled = false;
      btn.textContent = '交卷';
    }
  }

  /* ================= 姓名屏（§7.1） ================= */

  function loadHistory() {
    try {
      var a = JSON.parse(global.localStorage.getItem(LS_HISTORY) || '[]');
      return Object.prototype.toString.call(a) === '[object Array]' ? a : [];
    } catch (e) { return []; }
  }

  function saveName(name) {
    try {
      global.localStorage.setItem(LS_NAME, name);
      var h = loadHistory().filter(function (n) { return n !== name; });
      h.unshift(name);
      global.localStorage.setItem(LS_HISTORY, JSON.stringify(h.slice(0, 10)));
    } catch (e) { /* 存储不可用时忽略 */ }
  }

  function enterWithName() {
    var inp = $('#nameInput');
    var v = String(inp.value || '').trim();
    if (!v) { toast('请先输入姓名'); inp.focus(); return; }
    state.name = v;
    saveName(v);
    $('#nameChip').textContent = '姓名：' + v;
    $('#nameChip').hidden = false;
    $('#nameView').hidden = true;
    $('#appView').hidden = false;
    loadContent();
  }

  /* ================= 内容加载 ================= */

  function loadContent() {
    if (contentLoading) return;
    contentLoading = true;
    if (!state.online) {
      contentLoading = false;
      showOfflineBox();
      return;
    }
    apiGet('/api/content', 15000).then(function (r) {
      contentLoading = false;
      if (r && r.ok && r.data && r.data.version != null) {
        state.content = r.data;
        renderLectureList();
        renderUnitList();
      } else if (r && r.status === 404) {
        state.content = { lectures: [], units: [] };
        renderLectureList();
        renderUnitList();
        toast('题库为空：请老师在教师端导入讲义或练习');
      } else if (r) {
        showOfflineBox('服务器返回异常（HTTP ' + r.status + '），请稍后重试。');
      } else {
        showOfflineBox('服务器响应格式异常，请稍后重试。');
      }
    }).catch(function () {
      contentLoading = false;
      state.online = false;
      state.checked = true;
      updateNetBadge();
      showOfflineBox();
    });
  }

  function emptyBox(msg) {
    var b = el('div', 'card empty-card');
    b.appendChild(el('div', 'muted', msg));
    return b;
  }

  function showOfflineBox(extra) {
    var msg = extra || '无法连接服务器，当前为离线模式。请检查网络后点击下方"重试"。';
    var boxes = [$('#lectureList'), $('#unitList')];
    for (var i = 0; i < boxes.length; i++) {
      var box = boxes[i];
      box.innerHTML = '';
      var b = el('div', 'card empty-card');
      b.appendChild(el('div', 'empty-title', '离线模式'));
      b.appendChild(el('div', 'muted', msg));
      var retry = el('button', 'btn primary', '重试');
      retry.type = 'button';
      retry.addEventListener('click', function () {
        refreshOnline().then(function (on) { if (on) loadContent(); });
      });
      b.appendChild(retry);
      box.appendChild(b);
    }
  }

  /* ================= 视图切换 / Tab（§7.2） ================= */

  function switchTab(tab) {
    state.tab = tab;
    $('#tabLecture').classList.toggle('active', tab === 'lecture');
    $('#tabPractice').classList.toggle('active', tab === 'practice');
    syncViews();
  }

  function syncViews() {
    var inLecture = state.tab === 'lecture';
    var inPractice = state.tab === 'practice';
    var reading = !!state.readingLecture;
    var inQuiz = !!state.unit;
    $('#lectureListView').hidden = !(inLecture && !reading);
    $('#lectureView').hidden = !(inLecture && reading);
    $('#unitListView').hidden = !(inPractice && !inQuiz);
    $('#quizView').hidden = !(inPractice && inQuiz);
    $('#quizFooter').hidden = !(inPractice && inQuiz && !state.submitted);
    document.body.classList.toggle('quiz-mode', inPractice && inQuiz);
    try { global.scrollTo(0, 0); } catch (e) { /* 忽略 */ }
  }

  /* ================= 讲义 ================= */

  function renderLectureList() {
    var box = $('#lectureList');
    box.innerHTML = '';
    var lectures = (state.content && state.content.lectures) || [];
    if (!lectures.length) {
      box.appendChild(emptyBox('暂无讲义。请老师在教师端导入讲义后再来阅读。'));
      return;
    }
    for (var i = 0; i < lectures.length; i++) {
      (function (lec) {
        var item = el('button', 'card item-card');
        item.type = 'button';
        item.appendChild(el('div', 'item-title', lec.title || lec.id || '未命名讲义'));
        item.appendChild(el('div', 'item-sub muted', '点击阅读'));
        item.addEventListener('click', function () { openLecture(lec); });
        box.appendChild(item);
      })(lectures[i]);
    }
  }

  function openLecture(lec) {
    state.readingLecture = lec;
    var art = $('#lectureContent');
    art.innerHTML = '';
    art.appendChild(el('h1', 'lecture-title', lec.title || '讲义'));
    var body = el('div', 'md-body');
    art.appendChild(body);
    renderRich(body, lec.markdown || '（讲义内容为空）', { solutions: true, toc: true });
    syncViews();
  }

  /* ================= 练习列表 ================= */

  function renderUnitList() {
    var box = $('#unitList');
    box.innerHTML = '';
    var units = (state.content && state.content.units) || [];
    if (!units.length) {
      box.appendChild(emptyBox('暂无练习。请老师在教师端导入练习后再来作答。'));
      return;
    }
    for (var i = 0; i < units.length; i++) {
      (function (u) {
        var n = (u.questions && u.questions.length) || 0;
        var item = el('button', 'card item-card');
        item.type = 'button';
        item.appendChild(el('div', 'item-title', u.unit || u.id || '未命名练习'));
        item.appendChild(el('div', 'item-sub muted', (u.topic ? '主题：' + u.topic + '　·　' : '') + '共 ' + n + ' 题'));
        item.addEventListener('click', function () { startQuiz(u); });
        box.appendChild(item);
      })(units[i]);
    }
  }

  /* ================= 答题页（§7.3 / §7.4） ================= */

  function startQuiz(unit) {
    /* 释放旧题目的手写板实例 */
    var oldIds = Object.keys(state.entries);
    for (var i = 0; i < oldIds.length; i++) {
      var e0 = state.entries[oldIds[i]];
      if (e0 && e0.hw && typeof e0.hw.destroy === 'function') {
        try { e0.hw.destroy(); } catch (err) { /* 忽略 */ }
      }
    }
    state.unit = unit;
    state.submitted = false;
    state.quizStart = Date.now();
    state.entries = {};

    var qs = (unit && unit.questions) || [];
    var head = $('#quizHead');
    head.innerHTML = '';
    var headCard = el('div', 'card quiz-head-card');
    headCard.appendChild(el('div', 'item-title', unit.unit || unit.id || '练习'));
    headCard.appendChild(el('div', 'muted',
      (unit.topic ? '主题：' + unit.topic + '　·　' : '') + '共 ' + qs.length + ' 题　·　完成后点击底部"交卷"'));
    head.appendChild(headCard);

    var list = $('#questionList');
    list.innerHTML = '';
    for (var k = 0; k < qs.length; k++) list.appendChild(buildQuestionCard(qs[k], k));

    setupObserver();
    startTimer();
    updateSubmitBtn();
    syncViews();
  }

  function buildQuestionCard(q, idx) {
    var card = el('section', 'card q-card');
    if (q && q.id != null) card.dataset.qid = String(q.id);

    /* 题卡头部：题号 + 题型徽章 + 难度★ + 考点 */
    var headRow = el('div', 'q-head');
    headRow.appendChild(el('span', 'q-no', '第 ' + (q.number != null ? q.number : idx + 1) + ' 题'));
    headRow.appendChild(el('span', 'type-badge type-' + typeClass(q.type), q.type || '未知'));
    var diff = Math.max(0, Math.min(3, q.difficulty | 0));
    if (diff > 0) headRow.appendChild(el('span', 'q-stars', '★★★★★'.slice(0, diff)));
    if (q.knowledge) headRow.appendChild(el('span', 'q-knowledge', q.knowledge));
    card.appendChild(headRow);

    /* 题干（markdown + KaTeX） */
    var stem = el('div', 'q-stem');
    card.appendChild(stem);
    renderRich(stem, q.stem || '');

    /* 作答区 */
    var entry = { choice: '', texts: [], finalText: '', hw: null, firstSeen: 0, card: card, q: q };
    if (q && q.id != null) state.entries[q.id] = entry;
    var body = el('div', 'q-body');
    card.appendChild(body);

    var type = q.type;
    if (type === '判断') buildJudge(body, entry);
    else if (type === '选择') buildChoice(body, q, entry);
    else if (type === '填空') buildBlanks(body, q, entry);
    else buildHandwrite(body, q, entry);

    /* 结果区（交卷后填充） */
    card.appendChild(el('div', 'q-result'));
    return card;
  }

  /* 判断题：正确 / 错误 两个按钮 */
  function buildJudge(body, entry) {
    var wrap = el('div', 'opt-group judge-group');
    var vals = ['正确', '错误'];
    for (var i = 0; i < vals.length; i++) {
      (function (val) {
        var b = el('button', 'opt-btn', val);
        b.type = 'button';
        b.addEventListener('click', function () {
          entry.choice = val;
          var all = wrap.querySelectorAll('.opt-btn');
          for (var j = 0; j < all.length; j++) all[j].classList.toggle('selected', all[j] === b);
        });
        wrap.appendChild(b);
      })(vals[i]);
    }
    body.appendChild(wrap);
  }

  /* 选择题：A~D 单选按钮 */
  function buildChoice(body, q, entry) {
    var opts = (q.options && q.options.length) ? q.options
      : [{ key: 'A', text: '' }, { key: 'B', text: '' }, { key: 'C', text: '' }, { key: 'D', text: '' }];
    var wrap = el('div', 'opt-group opt-list');
    for (var i = 0; i < opts.length; i++) {
      (function (op) {
        var key = (op && op.key != null) ? String(op.key) : '';
        var b = el('button', 'opt-btn');
        b.type = 'button';
        b.appendChild(el('span', 'opt-key', key));
        var tx = el('span', 'opt-text');
        renderRich(tx, (op && op.text != null) ? String(op.text) : '');
        b.appendChild(tx);
        b.addEventListener('click', function () {
          entry.choice = key;
          var all = wrap.querySelectorAll('.opt-btn');
          for (var j = 0; j < all.length; j++) all[j].classList.toggle('selected', all[j] === b);
        });
        wrap.appendChild(b);
      })(opts[i]);
    }
    body.appendChild(wrap);
  }

  /* 填空题：按 answers.length 给 N 个输入框 */
  function buildBlanks(body, q, entry) {
    var n = (q.answers && q.answers.length) || 1;
    entry.texts = [];
    var wrap = el('div', 'blank-group');
    for (var i = 0; i < n; i++) {
      (function (i) {
        entry.texts.push('');
        var row = el('div', 'blank-row');
        row.appendChild(el('label', 'blank-label', '第 ' + (i + 1) + ' 空'));
        var inp = el('input', 'blank-input');
        inp.type = 'text';
        inp.placeholder = '请输入第 ' + (i + 1) + ' 空的答案';
        inp.autocomplete = 'off';
        inp.addEventListener('input', function () { entry.texts[i] = inp.value; });
        row.appendChild(inp);
        wrap.appendChild(row);
      })(i);
    }
    body.appendChild(wrap);
  }

  /* 计算 / 应用 / 找错（及未知类型）：可折叠手写板 + 可选"最终答案"输入框 */
  function buildHandwrite(body, q, entry) {
    var canHw = !!(global.Handwrite && typeof global.Handwrite.create === 'function');

    var details = el('details', 'hw-details');
    details.appendChild(el('summary', 'hw-summary', '手写作答区（点击展开 / 收起）'));
    var mount = el('div', 'hw-mount');
    details.appendChild(mount);
    if (!canHw) {
      mount.appendChild(el('div', 'muted hw-fallback', '手写板组件未能加载（可能是网络问题），请在下方"最终答案"中用文字作答。'));
    }
    var opened = false;
    /* 平板才默认"仅笔"（Apple Pencil 防手掌误触）；电脑（含触屏笔记本、桌面 Chromium）默认可写。
       注意 maxTouchPoints>0 不等于平板——桌面 Chromium/Electron 也可能报 10。 */
    function tabletDefault() {
      var ua = navigator.userAgent || '';
      var mtp = navigator.maxTouchPoints || 0;
      var isPad = /iPad/.test(ua) || (/Macintosh/.test(ua) && mtp > 1);   // iPadOS 13+ 桌面模式 UA 伪装成 Mac
      var isAndroidTablet = /Android/.test(ua) && !/Mobile/.test(ua);
      return isPad || isAndroidTablet;
    }
    details.addEventListener('toggle', function () {
      /* 展开时才创建手写板（懒加载，题多时不卡） */
      if (details.open && !opened && canHw) {
        opened = true;
        try {
          entry.hw = global.Handwrite.create(mount, {
            caption: buildCaption(q),
            penOnly: tabletDefault(),
            height: 320
          });
        } catch (e) {
          opened = false;
          mount.appendChild(el('div', 'muted hw-fallback', '手写板初始化失败，请在下方"最终答案"中用文字作答。'));
        }
      }
    });
    body.appendChild(details);

    var row = el('div', 'final-row');
    row.appendChild(el('label', 'final-label', '最终答案（选填，填写后可自动判分）'));
    var inp = el('input', 'final-input');
    inp.type = 'text';
    inp.placeholder = '例如：8';
    inp.autocomplete = 'off';
    inp.addEventListener('input', function () { entry.finalText = inp.value; });
    row.appendChild(inp);
    body.appendChild(row);
  }

  /* 手写板 PNG 题注：姓名 + 题号 + 题型 + 纯文本题干 */
  function plainText(md) {
    return String(md || '')
      .replace(/\$\$?/g, '')
      .replace(/\\left|\\right/g, '')
      .replace(/[#>*_\x60~]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function buildCaption(q) {
    var no = (q.number != null) ? '第 ' + q.number + ' 题' : '';
    var t = q.type ? '（' + q.type + '）' : '';
    return ('姓名：' + state.name + '　' + no + t + '　' + plainText(q.stem || '')).trim();
  }

  /* 每题独立计时（§7.7）：题目首次可见时记 firstSeen */
  function setupObserver() {
    if (observer) { try { observer.disconnect(); } catch (e) { /* 忽略 */ } observer = null; }
    var cards = document.querySelectorAll('#questionList .q-card');
    var i;
    if (typeof global.IntersectionObserver !== 'function') {
      for (i = 0; i < cards.length; i++) {
        var e0 = state.entries[cards[i].dataset.qid];
        if (e0 && !e0.firstSeen) e0.firstSeen = state.quizStart;
      }
      return;
    }
    observer = new global.IntersectionObserver(function (entries) {
      for (var k = 0; k < entries.length; k++) {
        if (!entries[k].isIntersecting) continue;
        var e1 = state.entries[entries[k].target.dataset.qid];
        if (e1 && !e1.firstSeen) e1.firstSeen = Date.now();
      }
    }, { threshold: 0.25 });
    for (i = 0; i < cards.length; i++) observer.observe(cards[i]);
  }

  /* ================= 计时（durationSec） ================= */

  function startTimer() {
    stopTimer();
    var chip = $('#timeChip');
    chip.hidden = false;
    chip.textContent = '已用时 00:00';
    state.timerId = setInterval(function () {
      chip.textContent = '已用时 ' + fmtDur((Date.now() - state.quizStart) / 1000);
    }, 1000);
  }

  function stopTimer() {
    if (state.timerId) { clearInterval(state.timerId); state.timerId = null; }
    $('#timeChip').hidden = true;
  }

  /* ================= 交卷（§7.5，body 结构见契约 §2） ================= */

  function countUnanswered() {
    var n = 0;
    var qs = (state.unit && state.unit.questions) || [];
    for (var i = 0; i < qs.length; i++) {
      var q = qs[i];
      var e = state.entries[q.id] || {};
      var has = false;
      if (q.type === '判断' || q.type === '选择') has = !!e.choice;
      else if (q.type === '填空') {
        var ts = e.texts || [];
        for (var j = 0; j < ts.length; j++) {
          if (String(ts[j]).trim() !== '') { has = true; break; }
        }
      } else {
        has = String(e.finalText || '').trim() !== '' || (e.hw ? !e.hw.isEmpty() : false);
      }
      if (!has) n++;
    }
    return n;
  }

  function buildRecord() {
    var unit = state.unit;
    var qs = (unit && unit.questions) || [];
    var now = Date.now();
    var list = [];
    for (var i = 0; i < qs.length; i++) {
      var q = qs[i];
      var e = state.entries[q.id] || {};
      var hw = isHwType(q.type);
      var textAnswer = '';
      if (q.type === '判断' || q.type === '选择') textAnswer = e.choice || '';
      else if (q.type === '填空') textAnswer = (e.texts || []).join(';;');
      else textAnswer = String(e.finalText || '').trim();

      var g = gradeQuestion(q, e);
      var png = null;
      if (hw && e.hw) {
        try { png = e.hw.getPNG(); } catch (err) { png = null; }
      }
      var firstSeen = e.firstSeen || state.quizStart;
      list.push({
        id: q.id,
        number: (q.number != null) ? q.number : null,
        type: q.type || '',
        textAnswer: textAnswer,
        correct: g.correct,
        autoGraded: g.autoGraded,
        strokesPng: png,
        timeSec: Math.max(0, Math.round((now - firstSeen) / 1000)),
        teacherMark: null,
        teacherComment: null
      });
    }
    return {
      version: 1,
      student: state.name,
      unitId: unit.id || '',
      unitName: unit.topic || unit.unit || unit.id || '',
      submittedAt: new Date().toISOString(),
      durationSec: Math.max(0, Math.round((now - state.quizStart) / 1000)),
      device: detectDevice(),
      questions: list
    };
  }

  function onSubmit() {
    if (state.submitted || !state.unit) return;
    if (!state.online) {
      toast('当前为离线模式，无法交卷。请等待网络恢复后再试。');
      refreshOnline();
      return;
    }
    var un = countUnanswered();
    var msg = un > 0 ? ('还有 ' + un + ' 题未作答，确认交卷？') : '确认交卷？交卷后将显示批改结果。';
    if (!global.confirm(msg)) return;

    var btn = $('#submitBtn');
    btn.disabled = true;
    btn.textContent = '正在交卷…';
    var record = buildRecord();
    apiPost('/api/submit', record, 60000).then(function (r) {
      if (r && r.ok && r.data && r.data.ok) {
        state.submitted = true;
        stopTimer();
        showResults(record);
        updateSubmitBtn();
        syncViews();
        toast('交卷成功！');
      } else {
        var em = (r && r.data && r.data.error) ? String(r.data.error) : ('HTTP ' + (r ? r.status : '?'));
        toast('交卷失败：' + em + '，请重试');
        updateSubmitBtn();
      }
    }).catch(function () {
      toast('交卷失败：无法连接服务器，请检查网络后重试');
      refreshOnline();
      updateSubmitBtn();
    });
  }

  /* 交卷后锁定作答区 */
  function lockAnswers() {
    var list = $('#questionList');
    var inputs = list.querySelectorAll('input');
    for (var i = 0; i < inputs.length; i++) inputs[i].disabled = true;
    var btns = list.querySelectorAll('button');
    for (var j = 0; j < btns.length; j++) btns[j].disabled = true;
    var ids = Object.keys(state.entries);
    for (var k = 0; k < ids.length; k++) {
      var e = state.entries[ids[k]];
      if (e && e.card) e.card.classList.add('locked');
    }
  }

  /* 交卷成功后：逐题显示 ✓/✗（客观题）并给出可展开的详解折叠块 */
  function showResults(record) {
    lockAnswers();
    var qs = (state.unit && state.unit.questions) || [];
    var nTrue = 0, nFalse = 0, nPending = 0, i;
    for (i = 0; i < record.questions.length; i++) {
      var c = record.questions[i].correct;
      if (c === true) nTrue++;
      else if (c === false) nFalse++;
      else nPending++;
    }
    var sumCard = el('div', 'card quiz-head-card result-summary');
    sumCard.appendChild(el('div', 'item-title', '已交卷'));
    var line = '自动判分：答对 ' + nTrue + ' 题，答错 ' + nFalse + ' 题';
    if (nPending > 0) line += '，待老师批改 ' + nPending + ' 题（含手写题）';
    sumCard.appendChild(el('div', 'muted', line + '。手写内容与老师批注请在老师端查看。'));
    $('#quizHead').appendChild(sumCard);

    for (i = 0; i < record.questions.length; i++) {
      var r = record.questions[i];
      var q = qs[i];
      var e = state.entries[r.id];
      if (!e || !e.card) continue;
      var box = e.card.querySelector('.q-result');
      if (!box) continue;
      box.innerHTML = '';
      if (r.correct === true) box.appendChild(el('div', 'result-banner ok', '✓ 回答正确'));
      else if (r.correct === false) box.appendChild(el('div', 'result-banner bad', '✗ 回答错误'));
      else box.appendChild(el('div', 'result-banner pending', '待老师批改（手写内容老师会查看）'));
      if (r.correct === false && q && q.answers && q.answers.length) {
        box.appendChild(el('div', 'correct-ans', '参考答案：' + q.answers.join('；')));
      }
      box.appendChild(el('div', 'q-time muted', '本题用时约 ' + fmtDur(r.timeSec)));
      if (q && q.solutionMd && String(q.solutionMd).trim()) {
        var det = el('details', 'solution');
        det.appendChild(el('summary', null, '查看详解'));
        var body = el('div', 'solution-body');
        det.appendChild(body);
        renderRich(body, q.solutionMd);
        box.appendChild(det);
      }
    }
  }

  /* ================= 初始化 ================= */

  function init() {
    /* 提示哪些 CDN 资源加载失败（已自动降级，不影响使用） */
    try {
      var miss = global.__cdnMissing || {};
      var keys = Object.keys(miss);
      if (keys.length && global.console && console.warn) {
        console.warn('以下 CDN 资源加载失败，已启用降级方案：' + keys.join(', '));
      }
    } catch (e) { /* 忽略 */ }

    /* 姓名：localStorage 记住 + 历史姓名下拉（datalist） */
    var history = loadHistory();
    var saved = '';
    try { saved = global.localStorage.getItem(LS_NAME) || ''; } catch (e) { /* 忽略 */ }
    var inp = $('#nameInput');
    inp.value = saved;
    var dl = $('#nameHistoryList');
    for (var i = 0; i < history.length; i++) {
      var o = document.createElement('option');
      o.value = String(history[i]);
      dl.appendChild(o);
    }
    $('#nameEnterBtn').addEventListener('click', enterWithName);
    inp.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') { ev.preventDefault(); enterWithName(); }
    });

    /* Tab / 返回 / 交卷 */
    $('#tabLecture').addEventListener('click', function () { switchTab('lecture'); });
    $('#tabPractice').addEventListener('click', function () { switchTab('practice'); });
    $('#lectureBackBtn').addEventListener('click', function () {
      state.readingLecture = null;
      syncViews();
    });
    $('#submitBtn').addEventListener('click', onSubmit);

    /* 连接检测：立即 + 每 20 秒轮询 + 系统网络事件 */
    refreshOnline();
    setInterval(function () { refreshOnline(); }, 20000);
    global.addEventListener('online', function () { refreshOnline(); });
    global.addEventListener('offline', function () {
      state.online = false;
      state.checked = true;
      updateNetBadge();
      toast('网络连接已断开，进入离线模式');
    });

    updateNetBadge();
    syncViews();
  }

  init();
})(window);
