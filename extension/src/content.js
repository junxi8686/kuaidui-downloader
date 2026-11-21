/* 快对答案下载器 —— 页面内面板
 * 只在快对站点跑。书本页 -> 单本导出；列表/搜索页 -> 抓本页所有书批量导出。
 * UI 放在 shadow DOM 里，避免被站点样式影响。
 */
(function () {
  'use strict';
  if (window.__KD_PANEL_LOADED__) return;
  window.__KD_PANEL_LOADED__ = true;

  var state = {
    detail: null,
    images: [],
    ids: [],
    running: false,
    lastUrl: location.href
  };

  /* ---------- 解析当前页 ---------- */

  // 页面上能看到的图 + 服务端页面里的图，合成一份（封面不算答案页）
  function mergeImages(detail, domImages) {
    var cover = detail.cover || '';
    var out = (detail.images || []).slice();
    (domImages || []).forEach(function (u) {
      if (!u || u === cover) return;
      if (out.indexOf(u) < 0) out.push(u);
    });
    return out;
  }

  // 以服务端渲染的页面为准：SPA 跳转过来的页面里根本没有 __NUXT__，
  // 页面上又只有「封面 + 第 1 页」两张图，只看 DOM 会漏掉后面的页。
  function applyDetail(detail, domImages) {
    if (!detail) return false;
    state.detail = detail;
    state.images = mergeImages(detail, domImages);
    return true;
  }

  function scan() {
    var html = document.documentElement.innerHTML;
    var bookId = KD.bookIdFromUrl(location.href);
    state.detail = null;
    state.images = [];
    state.ids = [];

    if (!bookId) {
      state.ids = KD.bookIdsFromDom(document);
      render();
      return;
    }

    var local = KD.extractDetail(html, location.href);
    if (!local.bookId) local.bookId = bookId;
    var domImages = KD.imagesFromDom(document, bookId);

    // 先用本地能读到的顶上，界面不空着
    applyDetail(local, domImages);
    render();

    // 再向后台要一次服务端页面，拿完整的 oriAnswers
    setStatus(state.images.length ? '核对服务端页面…' : '从服务端页面取答案…');
    send({ type: 'KD_FETCH_BOOK', bookId: bookId }).then(function (res) {
      if (!res || !res.ok || !res.detail) {
        setStatus(state.images.length
          ? '只读到页面上这 ' + state.images.length + ' 页（服务端没取到）'
          : '这本书没取到答案图', true);
        render();
        return;
      }
      applyDetail(res.detail, domImages);
      var d = state.detail;
      var extra = (d.answerCount && d.answerCount > state.images.length)
        ? '，全书 ' + d.answerCount + ' 页'
        : '';
      setStatus('已取到 ' + state.images.length + ' 页' + extra);
      render();
    });
  }

  /* ---------- 批量：把 id 解析成详情 ---------- */

  async function resolveDetails(ids, onProgress) {
    var out = [];
    for (var i = 0; i < ids.length; i++) {
      onProgress('读取第 ' + (i + 1) + '/' + ids.length + ' 本…');
      try {
        var res = await send({ type: 'KD_FETCH_BOOK', bookId: ids[i] });
        if (res && res.ok && res.detail && res.detail.images.length) out.push(res.detail);
      } catch (e) { /* 跳过这本 */ }
    }
    return out;
  }

  function send(msg) {
    return new Promise(function (resolve) {
      chrome.runtime.sendMessage(msg, function (resp) {
        if (chrome.runtime.lastError) { resolve(null); return; }
        resolve(resp);
      });
    });
  }

  /* ---------- UI ---------- */

  var host = document.createElement('div');
  host.style.cssText = 'position:fixed;z-index:2147483000;right:18px;bottom:18px;';
  var root = host.attachShadow({ mode: 'open' });

  // 样式表：tokens.css（设计变量）+ panel.css（组件），都走扩展资源，
  // shadow root 里用 <link> 引入，改 tokens.css 面板就跟着变。
  function sheet(path) {
    var l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = base + path;
    return l;
  }

  var base = (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL)
    ? chrome.runtime.getURL('src/')
    : '../extension/src/';

  root.appendChild(sheet('tokens.css'));
  root.appendChild(sheet('panel.css'));

  var card = document.createElement('div');
  card.className = 'card kd-theme';
  card.innerHTML = [
    '<div class="head" id="head">',
    '  <button class="dot" id="theme" title="外观：跟随系统（点击切换）"></button><span class="title">快对答案下载器</span>',
    '  <button class="iconbtn" id="toggle" title="收起/展开">–</button>',
    '</div>',
    '<div class="body">',
    '  <div class="book" id="book">扫描中…</div>',
    '  <div class="meta" id="meta"></div>',
    '  <div class="row" id="actions"></div>',
    '  <div class="bar"><i id="bar"></i></div>',
    '  <div class="status" id="status">准备就绪</div>',
    '  <div class="hint" id="hint"></div>',
    '</div>'
  ].join('');

  root.appendChild(card);

  var $ = function (id) { return root.getElementById(id); };

  /* ---------- 浅色 / 深色 ---------- */

  var THEME_ORDER = ['auto', 'light', 'dark'];
  var THEME_LABEL = { auto: '跟随系统', light: '浅色', dark: '深色' };

  function readTheme() {
    var t = null;
    try { t = localStorage.getItem('kd_theme'); } catch (e) { t = null; }
    return THEME_ORDER.indexOf(t) >= 0 ? t : 'auto';
  }

  function applyTheme(t) {
    if (t === 'auto') card.removeAttribute('data-theme');
    else card.setAttribute('data-theme', t);
    var dot = $('theme');
    dot.title = '外观：' + THEME_LABEL[t] + '（点击切换）';
    try { localStorage.setItem('kd_theme', t); } catch (e) { /* 无痕模式忽略 */ }
    try { chrome.storage.local.set({ kd_theme: t }); } catch (e) { /* 忽略 */ }
  }

  var theme = readTheme();
  applyTheme(theme);

  $('theme').addEventListener('click', function (e) {
    e.stopPropagation();
    theme = THEME_ORDER[(THEME_ORDER.indexOf(theme) + 1) % THEME_ORDER.length];
    applyTheme(theme);
  });

  // 系统切换深浅色时，auto 模式跟着变（变量本身就吃媒体查询，这里只是让标题提示刷新）
  if (window.matchMedia) {
    var mq = window.matchMedia('(prefers-color-scheme: dark)');
    var onSystemTheme = function () { applyTheme(theme); };
    if (mq.addEventListener) mq.addEventListener('change', onSystemTheme);
    else if (mq.addListener) mq.addListener(onSystemTheme);
  }

  var collapsed = localStorage.getItem('kd_panel_collapsed') === '1';
  if (collapsed) card.classList.add('collapsed');

  $('toggle').addEventListener('click', function () {
    collapsed = !collapsed;
    card.classList.toggle('collapsed', collapsed);
    $('toggle').textContent = collapsed ? '+' : '–';
    localStorage.setItem('kd_panel_collapsed', collapsed ? '1' : '0');
  });
  $('toggle').textContent = collapsed ? '+' : '–';

  // 拖动
  (function makeDraggable() {
    var dragging = false, ox = 0, oy = 0;
    var head = $('head');
    head.addEventListener('pointerdown', function (e) {
      if (e.target.id === 'toggle' || e.target.id === 'theme') return;
      dragging = true;
      var r = host.getBoundingClientRect();
      ox = e.clientX - r.left;
      oy = e.clientY - r.top;
      head.setPointerCapture(e.pointerId);
    });
    head.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      var x = Math.max(4, Math.min(window.innerWidth - 60, e.clientX - ox));
      var y = Math.max(4, Math.min(window.innerHeight - 40, e.clientY - oy));
      host.style.left = x + 'px';
      host.style.top = y + 'px';
      host.style.right = 'auto';
      host.style.bottom = 'auto';
    });
    head.addEventListener('pointerup', function () { dragging = false; });
  })();

  function setStatus(text, isError) {
    var el = $('status');
    el.textContent = text || '';
    el.classList.toggle('err', !!isError);
  }

  function setPct(pct) {
    $('bar').style.width = Math.max(0, Math.min(100, pct || 0)) + '%';
  }

  function btn(label, cls) {
    var b = document.createElement('button');
    b.className = 'act' + (cls ? ' ' + cls : '');
    b.textContent = label;
    return b;
  }

  /* ---------- 渲染 ---------- */

  function render() {
    var actions = $('actions');
    var meta = $('meta');
    var hint = $('hint');
    actions.innerHTML = '';
    meta.innerHTML = '';
    hint.textContent = '';

    if (state.detail) {
      var d = state.detail;
      $('book').textContent = d.name || ('书籍 ' + d.bookId);
      var tags = [];
      if (d.subject) tags.push(['', d.subject]);
      if (d.grade) tags.push(['', d.grade]);
      if (d.term) tags.push(['', d.term]);
      if (d.version) tags.push(['', d.version]);
      tags.push(['', '可下载 ' + state.images.length + ' 页']);
      if (d.answerCount && d.answerCount > state.images.length) {
        tags.push(['warn', '全书 ' + d.answerCount + ' 页']);
      }
      tags.forEach(function (t) {
        var s = document.createElement('span');
        s.className = 'tag' + (t[0] ? ' ' + t[0] : '');
        s.textContent = t[1];
        meta.appendChild(s);
      });

      var bZip = btn('下载 ZIP', 'primary');
      var bPdf = btn('下载 PDF');
      var bImg = btn('逐张');
      [bZip, bPdf, bImg].forEach(function (b) { b.disabled = state.running || !state.images.length; });
      bZip.onclick = function () { runSingle('zip'); };
      bPdf.onclick = function () { runSingle('pdf'); };
      bImg.onclick = function () { runSingle('images'); };
      actions.appendChild(bZip); actions.appendChild(bPdf); actions.appendChild(bImg);

      if (d.answerCount && d.answerCount > state.images.length) {
        hint.textContent = '网页端每本书只放出前 ' + state.images.length + ' 页（这本书官方共 ' + d.answerCount +
          ' 页），这是快对自己的限制。要整本只能在快对 App 里看。';
      }
    } else if (state.ids.length) {
      $('book').textContent = '本页检测到 ' + state.ids.length + ' 本书';
      var t = document.createElement('span');
      t.className = 'tag';
      t.textContent = '批量抓取';
      meta.appendChild(t);

      var bAll = btn('批量 ZIP', 'primary');
      bAll.disabled = state.running;
      bAll.onclick = runBatch;
      actions.appendChild(bAll);

      var bOne = btn('只抓第 1 本');
      bOne.disabled = state.running;
      bOne.onclick = function () { runBatch(true); };
      actions.appendChild(bOne);
      hint.textContent = '批量会逐本打开网页抓图，每本都有 1~2 秒间隔，书多会慢一点。';
    } else {
      $('book').textContent = '当前页面没有识别到书籍';
      hint.textContent = '打开一本教辅的答案页，或在搜索结果页使用批量功能。';
    }
  }

  /* ---------- 执行 ---------- */

  async function runSingle(format) {
    if (state.running) return;
    state.running = true;
    render();
    setPct(3);
    setStatus('开始…');
    var jobId = 'job-' + Date.now();
    var options = await getOptions();
    var res = await send({
      type: 'KD_RUN',
      jobId: jobId,
      mode: 'single',
      format: format,
      detail: state.detail,
      images: state.images,
      options: options
    });
    state.running = false;
    render();
    if (!res || !res.ok) {
      setPct(0);
      setStatus('失败：' + ((res && res.error) || '后台无响应'), true);
    } else {
      setPct(100);
      setStatus('已保存：' + res.filename);
    }
  }

  async function runBatch(onlyFirst) {
    if (state.running) return;
    state.running = true;
    render();
    setPct(2);
    setStatus('读取书目…');
    var ids = onlyFirst ? state.ids.slice(0, 1) : state.ids;
    var details = await resolveDetails(ids, function (t) { setStatus(t); });
    if (!details.length) {
      state.running = false;
      render();
      setStatus('一本书都没读到（可能有反爬或需要登录）', true);
      return;
    }
    setStatus('共 ' + details.length + ' 本，开始下载…');
    var options = await getOptions();
    var res = await send({
      type: 'KD_RUN',
      jobId: 'batch-' + Date.now(),
      mode: 'multi',
      format: 'zip',
      tasks: details.map(function (d) { return { bookId: d.bookId, detail: d, images: d.images }; }),
      options: options
    });
    state.running = false;
    render();
    if (!res || !res.ok) { setPct(0); setStatus('失败：' + ((res && res.error) || '后台无响应'), true); }
    else { setPct(100); setStatus('已保存：' + res.filename); }
  }

  function getOptions() {
    return new Promise(function (resolve) {
      chrome.storage.local.get({ imageWidth: 'origin' }, function (v) {
        resolve({ width: v.imageWidth });
      });
    });
  }

  /* ---------- 后台进度 ---------- */

  chrome.runtime.onMessage.addListener(function (msg) {
    if (!msg || msg.type !== 'KD_PROGRESS') return;
    setPct(msg.pct);
    setStatus(msg.text);
  });

  /* ---------- 挂载 + 路由变化 ---------- */

  function mount() {
    if (!document.body) { setTimeout(mount, 300); return; }
    document.body.appendChild(host);
    scan();
  }

  function watchUrl() {
    setInterval(function () {
      if (location.href !== state.lastUrl) {
        state.lastUrl = location.href;
        setTimeout(scan, 900);
      }
    }, 1200);
  }

  mount();
  watchUrl();
})();
