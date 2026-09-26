/* =========================================================
 * 线上答题系统 · 教师端脚本（T3b）
 * 三个 Tab：内容管理 / 提交记录 / 导出
 * 说明：外部库（marked、KaTeX auto-render）仅用于题目预览渲染，
 *       CDN 加载失败时自动降级为纯文本展示，页面功能不受影响。
 * ========================================================= */
(function () {
  'use strict';

  /* ---------------- 常量 ---------------- */

  var ERR_CONN = '无法连接服务，请确认已在教师电脑上运行 python server.py';
  var API_TIMEOUT_MS = 15000;

  var ERROR_TEXT = {
    CONTENT_NOT_FOUND: '题库为空：服务器上还没有 content.json，请先在「内容管理」页导入内容。',
    FILE_TOO_LARGE: '内容超过 25MB 上限，请拆分后再试。',
    NOT_FOUND: '未找到对应记录，可能已被移动或删除，请刷新后重试。'
  };

  var DEVICE_TEXT = { ipad: 'iPad', pc: '电脑', other: '其他' };

  var CSV_HEADERS = ['学生', '单元', '提交时间', '用时秒', '题号', '题型', '学生答案', '自动判分', '教师批注', '评语', '有无手写'];

  /* ---------------- 运行状态 ---------------- */

  var state = {
    submissions: [],   // [{ file: "...", record: {...} }]
    expanded: {},      // file -> 是否展开详情
    studentFilter: '',
    exportScope: '',   // '' 表示全部学生
    subsLoaded: false
  };

  var pendingContent = null; // 整库导入：已读取、待确认上传的 content.json 对象
  var toastTimer = null;

  /* ---------------- DOM 小工具 ---------------- */

  function $(sel) { return document.querySelector(sel); }

  function $all(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }

  function el(tag, className, text) {
    var n = document.createElement(tag);
    if (className) n.className = className;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function fmtTime(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
      ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  }

  function fileStamp() {
    var d = new Date();
    return '' + d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) +
      '-' + pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds());
  }

  function fmtDuration(sec) {
    if (sec === null || sec === undefined || sec === '' || isNaN(Number(sec))) return '—';
    var n = Number(sec);
    if (n < 60) return n + ' 秒';
    var m = Math.floor(n / 60);
    var r = n % 60;
    return m + ' 分' + (r ? ' ' + r + ' 秒' : '');
  }

  function unitText(rec) {
    var t = rec.unitId || rec.unitName || '未知单元';
    if (rec.unitName && rec.unitId && rec.unitName !== rec.unitId) t += '（' + rec.unitName + '）';
    return t;
  }

  /* ---------------- 轻提示（toast） ---------------- */

  function flash(msg, isError) {
    var t = $('#toast');
    if (!t) return;
    t.textContent = msg;
    t.className = 'toast show' + (isError ? ' toast-error' : '');
    if (toastTimer) window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(function () {
      t.className = 'toast';
    }, 3200);
  }

  /* ---------------- 连接状态与全局错误条 ---------------- */

  function setConn(online) {
    var box = $('#connStatus');
    var txt = $('#connText');
    if (!box || !txt) return;
    box.classList.remove('on', 'off', 'checking');
    if (online === true) { box.classList.add('on'); txt.textContent = '已连接'; }
    else if (online === false) { box.classList.add('off'); txt.textContent = '未连接'; }
    else { box.classList.add('checking'); txt.textContent = '连接检测中…'; }
  }

  function showGlobalError(msg) {
    var g = $('#globalError');
    if (!g) return;
    g.textContent = msg;
    g.hidden = false;
  }

  function hideGlobalError() {
    var g = $('#globalError');
    if (g) g.hidden = true;
  }

  function checkHealth() {
    setConn(null);
    request('GET', '/api/health').then(function () {
      setConn(true);
      hideGlobalError();
    }).catch(function (err) {
      setConn(false);
      showGlobalError(err.message + '。页面仍可浏览，网络恢复后可点击右上角状态或「刷新」重试。');
    });
  }

  /* ---------------- API 请求封装 ---------------- */

  function friendlyApiError(status, data) {
    var code = data && data.error ? String(data.error) : '';
    if (code && ERROR_TEXT[code]) return ERROR_TEXT[code];
    if (status === 400) return '请求被拒绝（400）：' + (code || '请求参数有误');
    if (status === 404) return '接口不存在（404），请确认服务端为最新版本。';
    if (status === 413) return '内容超过 25MB 上限（413）。';
    if (status >= 500) return '服务端出错（' + status + '），请查看服务端控制台。';
    return '请求失败（HTTP ' + status + '）。';
  }

  function request(method, url, bodyObj) {
    return new Promise(function (resolve, reject) {
      var opts = { method: method };
      var timer = null;
      var ctrl = null;
      if (typeof window.AbortController === 'function') {
        ctrl = new AbortController();
        opts.signal = ctrl.signal;
      }
      if (bodyObj !== undefined && bodyObj !== null) {
        opts.headers = { 'Content-Type': 'application/json; charset=utf-8' };
        opts.body = JSON.stringify(bodyObj);
      }
      timer = window.setTimeout(function () {
        if (ctrl) ctrl.abort();
        reject(new Error('请求超时：' + ERR_CONN));
      }, API_TIMEOUT_MS);

      window.fetch(url, opts).then(function (res) {
        window.clearTimeout(timer);
        res.text().then(function (txt) {
          var data = null;
          try { data = txt ? JSON.parse(txt) : null; } catch (e) { data = null; }
          if (!res.ok) {
            reject(new Error(friendlyApiError(res.status, data)));
          } else if (data && data.ok === false) {
            reject(new Error(friendlyApiError(res.status, data)));
          } else {
            resolve(data);
          }
        }, function () {
          reject(new Error('读取响应失败，请重试。'));
        });
      }, function () {
        window.clearTimeout(timer);
        reject(new Error(ERR_CONN));
      }).catch(function () {
        window.clearTimeout(timer);
        reject(new Error(ERR_CONN));
      });
    });
  }

  /* ---------------- Markdown / 公式渲染（CDN 降级） ---------------- */

  function markdownToHtml(md) {
    var m = window.marked;
    if (m && typeof m.parse === 'function') {
      try { return m.parse(md); } catch (e) { /* 降级为纯文本 */ }
    } else if (typeof m === 'function') {
      try { return m(md); } catch (e) { /* 降级为纯文本 */ }
    }
    return null;
  }

  function renderMathIn(root) {
    try {
      if (typeof window.renderMathInElement === 'function') {
        window.renderMathInElement(root, {
          delimiters: [
            { left: '$$', right: '$$', display: true },
            { left: '\\[', right: '\\]', display: true },
            { left: '\\(', right: '\\)', display: false },
            { left: '$', right: '$', display: false }
          ],
          throwOnError: false
        });
      }
    } catch (e) { /* 渲染失败保持原样，不影响功能 */ }
  }

  function fillMarkdown(target, md) {
    var html = markdownToHtml(md);
    if (html !== null) {
      target.innerHTML = html; // 渲染教师自己导入的内容，与学生端策略一致
    } else {
      var pre = el('div', 'plain-text');
      pre.textContent = md;
      target.appendChild(pre);
    }
  }

  /* ================= Tab 1：内容管理 ================= */

  function setImportBusy(busy) {
    $('#btnImportPractice').disabled = busy;
    $('#btnImportLecture').disabled = busy;
  }

  function showImportMessage(msg) {
    var box = $('#importResult');
    box.textContent = '';
    box.appendChild(el('p', 'muted', msg));
  }

  function showImportError(msg) {
    var box = $('#importResult');
    box.textContent = '';
    box.appendChild(el('p', 'error-msg', '操作失败：' + msg));
  }

  function onMdFileChosen() {
    var f = this.files && this.files[0];
    if (!f) return;
    var reader = new FileReader();
    reader.onload = function () {
      $('#mdText').value = reader.result === null || reader.result === undefined ? '' : String(reader.result);
      var nameInput = $('#mdFileNameInput');
      if (!nameInput.value) nameInput.value = f.name;
      $('#mdFileName').textContent = '已选择：' + f.name;
      flash('文件已读入下方文本框，可编辑后导入');
    };
    reader.onerror = function () {
      flash('读取文件失败，请重试', true);
    };
    reader.readAsText(f, 'utf-8');
  }

  function importMarkdown(kind) {
    var md = $('#mdText').value;
    if (!md.trim()) {
      flash('请先选择 .md 文件或粘贴 Markdown 文本', true);
      return;
    }
    var body;
    if (kind === 'practice') {
      var filename = $('#mdFileNameInput').value.trim() || '未命名练习.md';
      body = { kind: 'practice', filename: filename, markdown: md };
    } else {
      var title = $('#lectureTitle').value.trim();
      if (!title) {
        flash('导入为讲义必须先填写讲义标题', true);
        $('#lectureTitle').focus();
        return;
      }
      body = { kind: 'lecture', title: title, markdown: md };
    }
    setImportBusy(true);
    showImportMessage('正在导入，请稍候…');
    request('POST', '/api/import', body).then(function (data) {
      setImportBusy(false);
      showImportResult(data && data.content);
      flash(kind === 'practice' ? '练习导入成功' : '讲义导入成功');
    }).catch(function (err) {
      setImportBusy(false);
      showImportError(err.message);
    });
  }

  function countTypes(units) {
    var typeCount = {};
    units.forEach(function (u) {
      (u.questions || []).forEach(function (q) {
        var t = q.type || '未知';
        typeCount[t] = (typeCount[t] || 0) + 1;
      });
    });
    return typeCount;
  }

  function showImportResult(content) {
    var box = $('#importResult');
    box.textContent = '';
    if (typeof content === 'string') {
      try { content = JSON.parse(content); } catch (e) { /* 保持原值走下方校验 */ }
    }
    if (!content || typeof content !== 'object' || !Array.isArray(content.units)) {
      box.appendChild(el('p', 'error-msg', '服务器未返回有效的题库数据，请确认服务端为最新版本。'));
      return;
    }
    var units = content.units;
    var lectures = Array.isArray(content.lectures) ? content.lectures : [];
    var qCount = 0;
    units.forEach(function (u) { qCount += (u.questions || []).length; });

    // 统计：单元数 / 题数 / 题型分布
    var chips = el('div', 'stat-chips');
    chips.appendChild(el('span', 'chip', '讲义 ' + lectures.length + ' 篇'));
    chips.appendChild(el('span', 'chip', '单元 ' + units.length + ' 个'));
    chips.appendChild(el('span', 'chip', '题目 ' + qCount + ' 道'));
    var typeCount = countTypes(units);
    var parts = Object.keys(typeCount).map(function (t) { return t + ' ' + typeCount[t] + ' 道'; });
    if (parts.length) chips.appendChild(el('span', 'chip', '题型分布：' + parts.join('，')));
    box.appendChild(chips);

    if (lectures.length) {
      var lecBox = el('details', 'lecture-list');
      lecBox.appendChild(el('summary', '', '讲义列表（' + lectures.length + ' 篇）'));
      var ul = el('ul', 'lecture-ul');
      lectures.forEach(function (l) {
        ul.appendChild(el('li', '', (l && (l.title || l.id)) || '未命名讲义'));
      });
      lecBox.appendChild(ul);
      box.appendChild(lecBox);
    }

    if (!units.length) {
      box.appendChild(el('p', 'muted', '当前题库中还没有练习单元，可导入 Markdown 生成。'));
      return;
    }

    // 题目预览（Markdown + KaTeX，CDN 失败时为纯文本）
    units.forEach(function (u) {
      var qs = u.questions || [];
      var d = el('details', 'unit-block');
      d.open = true;
      var head = u.unit || u.id || '未命名单元';
      if (u.topic) head += ' · ' + u.topic;
      if (u.lecture) head += '（' + u.lecture + '）';
      head += ' —— ' + qs.length + ' 题';
      d.appendChild(el('summary', '', head));
      if (!qs.length) {
        d.appendChild(el('p', 'muted', '该单元暂无题目。'));
        box.appendChild(d);
        return;
      }
      var wrap = el('div', 'table-wrap');
      var table = el('table', 'preview-table');
      var thead = el('thead');
      var hr = el('tr');
      ['题号', '题型', '难度', '考点', '题干预览'].forEach(function (h) { hr.appendChild(el('th', '', h)); });
      thead.appendChild(hr);
      table.appendChild(thead);
      var tbody = el('tbody');
      qs.forEach(function (q) {
        q = q || {};
        var tr = el('tr');
        tr.appendChild(el('td', '', q.number === null || q.number === undefined ? (q.id || '—') : String(q.number)));
        var tdType = el('td');
        tdType.appendChild(el('span', 'type-badge', q.type || '未知'));
        tr.appendChild(tdType);
        var diff = Number(q.difficulty) || 0;
        tr.appendChild(el('td', '', diff > 0 ? new Array(diff + 1).join('★') : '—'));
        tr.appendChild(el('td', '', q.knowledge || '—'));
        var tdStem = el('td', 'stem-cell');
        fillMarkdown(tdStem, q.stem || '');
        tr.appendChild(tdStem);
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      wrap.appendChild(table);
      d.appendChild(wrap);
      box.appendChild(d);
    });

    renderMathIn(box);
  }

  function downloadContent() {
    var btn = $('#btnDownloadContent');
    btn.disabled = true;
    request('GET', '/api/content').then(function (data) {
      btn.disabled = false;
      downloadText('content.json', JSON.stringify(data, null, 2), 'application/json');
      flash('content.json 已开始下载');
    }).catch(function (err) {
      btn.disabled = false;
      flash(err.message, true);
    });
  }

  function previewContent() {
    var btn = $('#btnPreviewContent');
    btn.disabled = true;
    showImportMessage('正在获取当前题库…');
    request('GET', '/api/content').then(function (data) {
      btn.disabled = false;
      showImportResult(data);
    }).catch(function (err) {
      btn.disabled = false;
      showImportError(err.message);
    });
  }

  function onJsonFileChosen() {
    var f = this.files && this.files[0];
    if (!f) return;
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var obj = JSON.parse(reader.result === null || reader.result === undefined ? '' : String(reader.result));
        if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('结构不符');
        pendingContent = obj;
        $('#jsonFileName').textContent = '已选择：' + f.name;
        flash('JSON 已读取，点击「导入整库」确认覆盖');
      } catch (e) {
        pendingContent = null;
        flash('所选文件不是合法的 content.json，请检查后重试', true);
      }
    };
    reader.onerror = function () {
      flash('读取文件失败，请重试', true);
    };
    reader.readAsText(f, 'utf-8');
  }

  function importWholeLibrary() {
    if (!pendingContent) {
      flash('请先选择 content.json 文件', true);
      return;
    }
    if (!window.confirm('导入整库将覆盖服务器上的全部题库与讲义，确定继续吗？')) return;
    var btn = $('#btnImportContent');
    btn.disabled = true;
    showImportMessage('正在导入整库，请稍候…');
    request('POST', '/api/import', { kind: 'content', content: pendingContent }).then(function (data) {
      btn.disabled = false;
      showImportResult(data && data.content);
      flash('整库导入成功');
    }).catch(function (err) {
      btn.disabled = false;
      showImportError(err.message);
    });
  }

  /* ================= Tab 2：提交记录 ================= */

  function loadSubmissions(manual) {
    var status = $('#subsStatus');
    status.textContent = '正在加载提交记录…';
    request('GET', '/api/submissions').then(function (data) {
      state.submissions = (data && data.submissions) || [];
      state.subsLoaded = true;
      setConn(true);
      hideGlobalError();
      renderSubmissions();
      renderExport();
      status.textContent = '共 ' + state.submissions.length + ' 份提交（按学生分组，组内按提交时间倒序）';
    }).catch(function (err) {
      state.subsLoaded = true;
      var list = $('#submissionsList');
      list.textContent = '';
      list.appendChild(el('p', 'error-msg', '提交记录加载失败：' + err.message));
      status.textContent = '加载失败';
      renderExport();
      if (manual) flash(err.message, true);
    });
  }

  function judgeState(q) {
    if (q.autoGraded) return q.correct ? 'right' : 'wrong';
    if (q.correct === true) return 'right';
    if (q.correct === false) return 'wrong';
    return 'pending';
  }

  function judgeBadge(q) {
    var s = judgeState(q);
    var cls = s === 'right' ? 'badge badge-ok' : s === 'wrong' ? 'badge badge-bad' : 'badge badge-pending';
    var b = el('span', cls);
    b.textContent = s === 'right' ? '✓ 正确' : s === 'wrong' ? '✗ 错误' : '待批改';
    return b;
  }

  function markBadge(q) {
    var cls = q.teacherMark === '正确' ? 'badge mark-badge badge-ok'
      : q.teacherMark === '错误' ? 'badge mark-badge badge-bad'
        : 'badge mark-badge badge-pending';
    var b = el('span', cls);
    b.textContent = q.teacherMark ? '教师批注：' + q.teacherMark : '未批注';
    return b;
  }

  function renderSubmissions() {
    var list = $('#submissionsList');
    list.textContent = '';
    var filter = state.studentFilter.trim().toLowerCase();
    var subs = state.submissions.filter(function (s) {
      if (!filter) return true;
      var name = String((s.record && s.record.student) || '').toLowerCase();
      return name.indexOf(filter) !== -1;
    });
    if (!subs.length) {
      list.appendChild(el('p', 'empty', filter
        ? '没有匹配「' + state.studentFilter.trim() + '」的学生提交。'
        : '暂无提交记录，可点击「刷新」重新加载。'));
      return;
    }
    // 按学生分组，组内按 submittedAt 倒序
    var groups = {};
    var order = [];
    subs.forEach(function (s) {
      var name = (s.record && s.record.student) || '未知学生';
      if (!groups[name]) { groups[name] = []; order.push(name); }
      groups[name].push(s);
    });
    order.sort(function (a, b) { return a.localeCompare(b, 'zh-CN'); });
    order.forEach(function (name) {
      var arr = groups[name].slice().sort(function (a, b) {
        var ta = new Date((a.record && a.record.submittedAt) || 0).getTime();
        var tb = new Date((b.record && b.record.submittedAt) || 0).getTime();
        return tb - ta;
      });
      var sec = el('section', 'student-group');
      sec.appendChild(el('h3', 'student-name', name + '（' + arr.length + ' 份提交）'));
      arr.forEach(function (s) { sec.appendChild(buildSubmissionCard(s)); });
      list.appendChild(sec);
    });
  }

  function buildSubmissionCard(item) {
    var rec = item.record || {};
    var card = el('div', 'sub-card');
    var head = el('div', 'sub-head');
    var info = el('div', 'sub-info');
    info.appendChild(el('div', 'sub-line', '单元：' + unitText(rec)));
    info.appendChild(el('div', 'sub-line',
      '提交时间：' + fmtTime(rec.submittedAt) + '　用时：' + fmtDuration(rec.durationSec) +
      '　设备：' + (DEVICE_TEXT[rec.device] || rec.device || '—') +
      '　题数：' + (rec.questions || []).length));
    info.appendChild(el('div', 'sub-file', '记录文件：' + (item.file || '—')));
    var isOpen = !!state.expanded[item.file];
    var toggle = el('button', 'btn small toggle-btn');
    toggle.type = 'button';
    toggle.textContent = isOpen ? '收起详情' : '展开详情';
    toggle.addEventListener('click', function () {
      state.expanded[item.file] = !state.expanded[item.file];
      renderSubmissions();
    });
    head.appendChild(info);
    head.appendChild(toggle);
    card.appendChild(head);
    if (isOpen) card.appendChild(buildDetailTable(rec, item.file));
    return card;
  }

  function buildDetailTable(rec, file) {
    var qs = rec.questions || [];
    var box = el('div', 'detail-box');
    if (!qs.length) {
      box.appendChild(el('p', 'muted', '该提交没有题目数据。'));
      return box;
    }
    var wrap = el('div', 'table-wrap');
    var table = el('table', 'detail-table');
    var thead = el('thead');
    var hr = el('tr');
    ['题号', '题型', '学生答案', '自动判分', '手写图', '评语（选填）', '教师批注'].forEach(function (h) {
      hr.appendChild(el('th', '', h));
    });
    thead.appendChild(hr);
    table.appendChild(thead);
    var tbody = el('tbody');
    qs.forEach(function (q) { tbody.appendChild(buildQuestionRow(file, q || {})); });
    table.appendChild(tbody);
    wrap.appendChild(table);
    box.appendChild(wrap);
    box.appendChild(el('p', 'hint', '点击缩略图可放大手写图；选择「正确 / 错误」后立即保存，可同时填写评语。'));
    return box;
  }

  function buildQuestionRow(file, q) {
    var tr = el('tr');

    // 题号
    var tdNo = el('td', 'cell-no', q.number === null || q.number === undefined ? (q.id || '—') : String(q.number));
    if (q.id) tdNo.title = q.id;
    tr.appendChild(tdNo);

    // 题型
    var tdType = el('td', 'cell-type');
    tdType.appendChild(el('span', 'type-badge', q.type || '未知'));
    tr.appendChild(tdType);

    // 学生答案（多空按 ;; 拆行显示）
    var tdAns = el('td', 'cell-answer');
    if (q.textAnswer) {
      var partsArr = String(q.textAnswer).split(';;');
      partsArr.forEach(function (part, idx) {
        tdAns.appendChild(el('div', 'ans-part', partsArr.length > 1 ? (idx + 1) + '. ' + part : part));
      });
    } else if (q.strokesPng) {
      tdAns.appendChild(el('div', 'ans-part', '（手写作答）'));
    } else {
      tdAns.appendChild(el('span', 'muted', '—'));
    }
    tr.appendChild(tdAns);

    // 自动判分
    var tdJudge = el('td', 'cell-judge');
    tdJudge.appendChild(judgeBadge(q));
    tr.appendChild(tdJudge);

    // 手写图缩略（点击放大）
    var tdImg = el('td', 'cell-img');
    if (q.strokesPng) {
      var img = el('img', 'thumb');
      img.src = q.strokesPng;
      img.alt = '手写图，点击放大';
      img.addEventListener('click', function () { openLightbox(q.strokesPng); });
      tdImg.appendChild(img);
    } else {
      tdImg.appendChild(el('span', 'muted', '—'));
    }
    tr.appendChild(tdImg);

    // 评语（选填）
    var tdCmt = el('td', 'cell-comment');
    var cmt = document.createElement('input');
    cmt.type = 'text';
    cmt.className = 'comment-input';
    cmt.placeholder = '选填评语';
    cmt.value = q.teacherComment || '';
    tdCmt.appendChild(cmt);
    tr.appendChild(tdCmt);

    // 教师批注：当前标记 + 【正确】【错误】按钮
    var tdMark = el('td', 'cell-mark');
    var btnOk = el('button', 'btn small grade-btn grade-ok');
    btnOk.type = 'button';
    btnOk.textContent = '正确';
    var btnBad = el('button', 'btn small grade-btn grade-bad');
    btnBad.type = 'button';
    btnBad.textContent = '错误';
    var syncBtnState = function () {
      btnOk.classList.toggle('active', q.teacherMark === '正确');
      btnBad.classList.toggle('active', q.teacherMark === '错误');
    };
    syncBtnState();
    btnOk.addEventListener('click', function () { doGrade(file, q.id, '正确', tr); });
    btnBad.addEventListener('click', function () { doGrade(file, q.id, '错误', tr); });
    var btns = el('div', 'grade-btns');
    btns.appendChild(btnOk);
    btns.appendChild(btnBad);
    tdMark.appendChild(markBadge(q));
    tdMark.appendChild(btns);
    tr.appendChild(tdMark);

    // 批注成功后就地刷新该行（不整表重绘，保留其他行未保存的评语输入）
    tr.refreshByGrade = function () {
      var jc = tr.querySelector('.cell-judge');
      if (jc) { jc.textContent = ''; jc.appendChild(judgeBadge(q)); }
      var mc = tr.querySelector('.cell-mark');
      if (mc) {
        var old = mc.querySelector('.mark-badge');
        var nb = markBadge(q);
        if (old) mc.replaceChild(nb, old);
        else mc.insertBefore(nb, mc.firstChild);
      }
      syncBtnState();
    };
    return tr;
  }

  // 批注成功后同步本地状态（下次渲染与 CSV 导出立即可见）
  function applyGradeLocal(file, questionId, mark, comment) {
    var target = null;
    state.submissions.forEach(function (s) {
      if (!s.record || s.file !== file) return;
      (s.record.questions || []).forEach(function (q) {
        if (q.id === questionId) target = q;
      });
    });
    if (!target) return null;
    target.teacherMark = mark;
    target.teacherComment = comment ? comment : null;
    if (!target.autoGraded) {
      // 手写题提交时 correct 为 null，教师批注后本地同步
      if (mark === '正确') target.correct = true;
      else if (mark === '错误') target.correct = false;
    }
    return target;
  }

  function doGrade(file, questionId, mark, tr) {
    if (!file || !questionId) {
      flash('该题缺少记录文件或题目标识，无法批注', true);
      return;
    }
    var cmtInput = tr.querySelector('.comment-input');
    var comment = cmtInput ? cmtInput.value.trim() : '';
    var gradeBtns = tr.querySelectorAll('.grade-btn');
    Array.prototype.forEach.call(gradeBtns, function (b) { b.disabled = true; });
    var body = { file: file, questionId: questionId, teacherMark: mark, teacherComment: comment ? comment : null };
    request('POST', '/api/grade', body).then(function () {
      applyGradeLocal(file, questionId, mark, comment);
      if (typeof tr.refreshByGrade === 'function') tr.refreshByGrade();
      Array.prototype.forEach.call(gradeBtns, function (b) { b.disabled = false; });
      flash('已批注为「' + mark + '」');
    }).catch(function (err) {
      Array.prototype.forEach.call(gradeBtns, function (b) { b.disabled = false; });
      flash(err.message, true);
    });
  }

  /* ================= Tab 3：导出 ================= */

  function scopedSubmissions() {
    if (!state.exportScope) return state.submissions.slice();
    return state.submissions.filter(function (s) {
      return ((s.record && s.record.student) || '未知学生') === state.exportScope;
    });
  }

  function renderExport() {
    var sel = $('#exportScope');
    if (!sel) return;
    var current = state.exportScope;
    var names = {};
    state.submissions.forEach(function (s) {
      names[(s.record && s.record.student) || '未知学生'] = true;
    });
    sel.textContent = '';
    var optAll = document.createElement('option');
    optAll.value = '';
    optAll.textContent = '全部学生';
    sel.appendChild(optAll);
    Object.keys(names).sort(function (a, b) { return a.localeCompare(b, 'zh-CN'); }).forEach(function (n) {
      var o = document.createElement('option');
      o.value = n;
      o.textContent = n;
      sel.appendChild(o);
    });
    sel.value = current;
    if (sel.value !== current) { sel.value = ''; state.exportScope = ''; }
    var scoped = scopedSubmissions();
    var qTotal = 0;
    scoped.forEach(function (s) { qTotal += ((s.record && s.record.questions) || []).length; });
    var summary = $('#exportSummary');
    if (summary) {
      if (!state.subsLoaded) {
        summary.textContent = '正在加载提交记录…';
      } else {
        summary.textContent = '当前范围：' + (state.exportScope || '全部学生') +
          '，共 ' + scoped.length + ' 份提交、' + qTotal + ' 道题。';
      }
    }
  }

  function autoGradeText(q) {
    if (q.autoGraded) return q.correct ? '正确' : '错误';
    if (q.correct === true) return '正确';
    if (q.correct === false) return '错误';
    return '待批改';
  }

  function csvCell(v) {
    var s = v === null || v === undefined ? '' : String(v);
    if (/[",\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  function toCsv(header, rows) {
    var lines = [header.map(csvCell).join(',')];
    rows.forEach(function (r) { lines.push(r.map(csvCell).join(',')); });
    return lines.join('\r\n');
  }

  function exportCsv() {
    var scoped = scopedSubmissions();
    if (!scoped.length) {
      flash('当前范围没有可导出的提交记录', true);
      return;
    }
    var rows = [];
    scoped.forEach(function (s) {
      var rec = s.record || {};
      var student = rec.student || '未知学生';
      var when = fmtTime(rec.submittedAt);
      var dur = rec.durationSec === null || rec.durationSec === undefined ? '' : String(rec.durationSec);
      (rec.questions || []).forEach(function (q) {
        q = q || {};
        rows.push([
          student,
          unitText(rec),
          when,
          dur,
          q.number === null || q.number === undefined ? (q.id || '') : String(q.number),
          q.type || '',
          q.textAnswer || '',
          autoGradeText(q),
          q.teacherMark || '',
          q.teacherComment || '',
          q.strokesPng ? '有' : '无'
        ]);
      });
    });
    if (!rows.length) {
      flash('提交记录中没有题目数据，无法导出', true);
      return;
    }
    // 前置 \ufeff BOM，防止 Excel 打开中文乱码
    var csv = '\ufeff' + toCsv(CSV_HEADERS, rows);
    downloadText('提交记录_' + fileStamp() + '.csv', csv, 'text/csv');
    flash('已导出 ' + rows.length + ' 行题目记录');
  }

  /* ---------------- 手写图放大层 ---------------- */

  function openLightbox(src) {
    var box = $('#lightbox');
    var img = $('#lightboxImg');
    if (!box || !img) return;
    img.src = src;
    box.hidden = false;
  }

  function closeLightbox() {
    var box = $('#lightbox');
    if (!box) return;
    box.hidden = true;
    var img = $('#lightboxImg');
    if (img) img.removeAttribute('src');
  }

  /* ---------------- 文件下载 ---------------- */

  function downloadText(filename, text, mime) {
    var blob = new Blob([text], { type: (mime || 'text/plain') + ';charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  }

  /* ---------------- Tab 切换与初始化 ---------------- */

  function switchTab(name) {
    $all('.tab-btn').forEach(function (b) {
      if (b.getAttribute('data-tab') === name) b.classList.add('active');
      else b.classList.remove('active');
    });
    $all('.tab-panel').forEach(function (p) {
      if (p.id === 'tab-' + name) p.classList.add('active');
      else p.classList.remove('active');
    });
    if (name === 'submissions' && !state.subsLoaded) loadSubmissions(false);
    if (name === 'export') renderExport();
  }

  function init() {
    $all('.tab-btn').forEach(function (btn) {
      btn.addEventListener('click', function () { switchTab(btn.getAttribute('data-tab')); });
    });

    $('#connStatus').addEventListener('click', checkHealth);
    $('#btnRefreshSubs').addEventListener('click', function () {
      checkHealth();
      loadSubmissions(true);
    });
    $('#studentFilter').addEventListener('input', function () {
      state.studentFilter = this.value;
      renderSubmissions();
    });

    $('#mdFile').addEventListener('change', onMdFileChosen);
    $('#btnImportPractice').addEventListener('click', function () { importMarkdown('practice'); });
    $('#btnImportLecture').addEventListener('click', function () { importMarkdown('lecture'); });
    $('#btnDownloadContent').addEventListener('click', downloadContent);
    $('#btnPreviewContent').addEventListener('click', previewContent);
    $('#jsonFile').addEventListener('change', onJsonFileChosen);
    $('#btnImportContent').addEventListener('click', importWholeLibrary);

    $('#exportScope').addEventListener('change', function () {
      state.exportScope = this.value;
      renderExport();
    });
    $('#btnExportCsv').addEventListener('click', exportCsv);

    $('#lightbox').addEventListener('click', function (e) {
      if (e.target === this) closeLightbox();
    });
    $('#lightboxClose').addEventListener('click', closeLightbox);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeLightbox();
    });

    checkHealth();
    loadSubmissions(false);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
