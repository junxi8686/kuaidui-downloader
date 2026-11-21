/* 快对答案下载器 —— 弹窗
 * 关键词搜索 -> 勾选书目 -> 批量下载（ZIP）
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var state = { books: [], selected: {}, busy: false };

  function send(msg) {
    return new Promise(function (resolve) {
      chrome.runtime.sendMessage(msg, function (resp) {
        if (chrome.runtime.lastError) { resolve(null); return; }
        resolve(resp);
      });
    });
  }

  function setStatus(text, isError) {
    var el = $('status');
    el.textContent = text || '';
    el.classList.toggle('err', !!isError);
  }

  function setPct(p) { $('bar').style.width = Math.max(0, Math.min(100, p || 0)) + '%'; }

  function updateCount() {
    $('count').textContent = Object.keys(state.selected).filter(function (k) { return state.selected[k]; }).length + ' 本已选';
  }

  function renderList() {
    var list = $('list');
    list.innerHTML = '';
    if (!state.books.length) {
      list.innerHTML = '<div class="empty">没搜到书，换个关键词试试（书名、系列名都行）</div>';
      return;
    }
    state.books.forEach(function (b) {
      var row = document.createElement('div');
      row.className = 'item';
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !!state.selected[b.bookId];
      cb.onchange = function () { state.selected[b.bookId] = cb.checked; updateCount(); };
      var img = document.createElement('img');
      img.src = b.cover || '';
      img.onerror = function () { img.style.visibility = 'hidden'; };
      var box = document.createElement('div');
      var t = document.createElement('div');
      t.className = 't';
      t.textContent = b.title || b.bookId;
      var s = document.createElement('div');
      s.className = 's';
      s.textContent = [b.subject, b.grade, b.year].filter(Boolean).join(' · ');
      box.appendChild(t); box.appendChild(s);
      row.appendChild(cb); row.appendChild(img); row.appendChild(box);
      list.appendChild(row);
    });
  }

  function render(list) {
    state.books = list.books || [];
    state.selected = {};
    state.books.forEach(function (b) { state.selected[b.bookId] = true; });
    $('all').checked = state.books.length > 0;
    renderList();
    updateCount();
    setStatus('共 ' + (list.total || state.books.length) + ' 本，已勾选前 ' + state.books.length + ' 本');
  }

  async function doSearch() {
    var kw = $('kw').value.trim();
    if (!kw) { $('kw').focus(); return; }
    if (state.busy) return;
    state.busy = true; $('go').disabled = true;
    setPct(8);
    setStatus('搜索中…');
    var res = await send({ type: 'KD_SEARCH', keyword: kw, page: 1 });
    state.busy = false; $('go').disabled = false;
    setPct(0);
    if (!res || !res.ok) { setStatus('搜索失败：后台没有响应', true); return; }
    render(res.result);
  }

  async function doDownload() {
    if (state.busy) return;
    var ids = state.books.filter(function (b) { return state.selected[b.bookId]; }).map(function (b) { return b.bookId; });
    if (!ids.length) { setStatus('先勾选至少一本', true); return; }

    state.busy = true;
    ['go'].forEach(function (id) { $(id).disabled = true; });

    var details = [];
    for (var i = 0; i < ids.length; i++) {
      setStatus('读取书目 ' + (i + 1) + '/' + ids.length + '…');
      setPct(Math.round((i + 1) / ids.length * 30));
      var r = await send({ type: 'KD_FETCH_BOOK', bookId: ids[i] });
      if (r && r.ok && r.detail && r.detail.images.length) details.push(r.detail);
    }
    if (!details.length) {
      state.busy = false; $('go').disabled = false;
      setStatus('书目信息都没读到（可能被限流，稍等几秒再试）', true);
      return;
    }

    var width = $('width').value;
    await new Promise(function (res) { chrome.storage.local.set({ imageWidth: width }, res); });

    setStatus('下载 ' + details.length + ' 本的答案…');
    var res = await send({
      type: 'KD_RUN',
      jobId: 'popup-' + Date.now(),
      mode: 'multi',
      format: 'zip',
      tasks: details.map(function (d) { return { bookId: d.bookId, detail: d, images: d.images }; }),
      options: { width: width }
    });
    state.busy = false; $('go').disabled = false;
    if (!res || !res.ok) { setPct(0); setStatus('失败：' + ((res && res.error) || '后台无响应'), true); }
    else { setPct(100); setStatus('已保存：' + res.filename); }
  }

  /* ---------- 事件 ---------- */

  $('go').onclick = doSearch;
  $('kw').addEventListener('keydown', function (e) { if (e.key === 'Enter') doSearch(); });
  $('all').onchange = function () {
    var v = $('all').checked;
    state.books.forEach(function (b) { state.selected[b.bookId] = v; });
    renderList(); updateCount();
  };
  $('width').onchange = function () { chrome.storage.local.set({ imageWidth: $('width').value }); };
  $('openPage').onclick = function () {
    chrome.tabs.create({ url: 'https://m.kuaiduizuoye.com/' });
  };

  chrome.runtime.onMessage.addListener(function (msg) {
    if (!msg || msg.type !== 'KD_PROGRESS') return;
    setPct(msg.pct);
    setStatus(msg.text);
  });

  /* ---------- 本地密钥 ---------- */

  function loadKeys() {
    chrome.storage.local.get({ secretMd5: '', cuid: '' }, function (v) {
      $('secret').value = v.secretMd5 || '';
      $('cuid').value = v.cuid || '';
      updateKeyState(v.secretMd5, v.cuid);
    });
  }

  function updateKeyState(secret, cuid) {
    var ok = /^[0-9a-fA-F]{32}$/.test((secret || '').trim()) && (cuid || '').trim();
    $('keyState').textContent = ok ? '已配置，可用整本下载' : '未配置（整本下载不可用）';
  }

  $('saveKey').onclick = function () {
    var secret = $('secret').value.trim().toLowerCase();
    var cuid = $('cuid').value.trim();
    if (secret && !/^[0-9a-f]{32}$/.test(secret)) {
      $('keyState').textContent = 'secret_md5 必须是 32 位十六进制';
      return;
    }
    chrome.storage.local.set({ secretMd5: secret, cuid: cuid }, function () {
      updateKeyState(secret, cuid);
      setStatus(secret && cuid ? '密钥已保存' : '密钥已清空');
    });
  };

  /* ---------- 初始化 ---------- */

  if (chrome.runtime && chrome.runtime.getManifest) {
    $('ver').textContent = 'v' + chrome.runtime.getManifest().version;
  }
  loadKeys();
  chrome.storage.local.get({ imageWidth: 'origin', kd_theme: 'auto' }, function (v) {
    $('width').value = v.imageWidth;
    // 面板里点过「外观」的话，弹窗跟着走；auto 就交给系统媒体查询
    if (v.kd_theme === 'light' || v.kd_theme === 'dark') {
      document.body.setAttribute('data-theme', v.kd_theme);
    }
  });
})();
