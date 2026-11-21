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

  /* ---------- 密钥来源 ---------- */

  var keyMode = 'unset';

  function readStorage(keys) {
    return new Promise(function (r) { chrome.storage.local.get(keys, r); });
  }

  function setModeUI(mode) {
    keyMode = mode;
    Array.prototype.forEach.call(document.querySelectorAll('.mode-btn'), function (b) {
      b.classList.toggle('active', b.getAttribute('data-mode') === mode);
    });
    $('sharedBlock').classList.toggle('hidden', mode !== 'shared');
    $('ownBlock').classList.toggle('hidden', mode !== 'own');
    $('resetRow').classList.toggle('hidden', mode === 'unset');
    if (mode === 'unset') $('keyState').textContent = '先选一种';
  }

  function refreshStatus(force) {
    send({ type: 'KD_SIGN_STATUS', force: !!force }).then(function (r) {
      var st = r || {};
      if (st.mode && keyMode === 'unset') setModeUI(st.mode);
      if (st.configured) {
        $('keyState').textContent = st.mode === 'shared'
          ? '共享密钥已就绪' + (st.from === 'cache' ? '（缓存）' : '')
          : '自己的密钥已就绪';
      } else {
        $('keyState').textContent = st.mode === 'shared' ? '共享密钥暂不可用'
          : st.mode === 'own' ? '自己的密钥未填'
          : '未选择';
        if (st.mode === 'shared' && st.error) $('sharedHint').textContent = '共享密钥：' + st.error;
      }
    });
  }

  function chooseMode(mode) {
    chrome.storage.local.set({ keyMode: mode }, function () {
      setModeUI(mode);
      refreshStatus(mode === 'shared');
    });
  }

  Array.prototype.forEach.call(document.querySelectorAll('.mode-btn'), function (b) {
    b.onclick = function () { chooseMode(b.getAttribute('data-mode')); };
  });

  $('resetMode').onclick = function () {
    chrome.storage.local.set({ keyMode: 'unset' }, function () {
      setModeUI('unset');
      $('keyState').textContent = '未选择';
    });
  };

  $('refreshShared').onclick = function () {
    $('sharedHint').textContent = '共享密钥：拉取中…';
    refreshStatus(true);
  };

  function loadOwnKeys() {
    chrome.storage.local.get({ secretMd5: '', cuid: '' }, function (v) {
      $('secret').value = v.secretMd5 || '';
      $('cuid').value = v.cuid || '';
      updateOwnState(v.secretMd5, v.cuid);
    });
  }

  function updateOwnState(secret, cuid) {
    var ok = /^[0-9a-fA-F]{32}$/.test((secret || '').trim()) && (cuid || '').trim();
    $('ownState').textContent = ok ? '已填好' : '未填';
  }

  $('saveKey').onclick = function () {
    var secret = $('secret').value.trim().toLowerCase();
    var cuid = $('cuid').value.trim();
    if (secret && !/^[0-9a-f]{32}$/.test(secret)) {
      $('ownState').textContent = 'secret_md5 必须是 32 位十六进制';
      return;
    }
    chrome.storage.local.set({ secretMd5: secret, cuid: cuid }, function () {
      updateOwnState(secret, cuid);
      setStatus(secret && cuid ? '自己的密钥已保存' : '已清空');
      refreshStatus(false);
    });
  };

  /* ---------- 初始化 ---------- */

  if (chrome.runtime && chrome.runtime.getManifest) {
    $('ver').textContent = 'v' + chrome.runtime.getManifest().version;
  }
  loadOwnKeys();
  chrome.storage.local.get({ keyMode: 'unset', imageWidth: 'origin', kd_theme: 'auto' }, function (v) {
    setModeUI(v.keyMode || 'unset');
    refreshStatus(false);

    $('width').value = v.imageWidth;
    // 面板里点过「外观」的话，弹窗跟着走；auto 就交给系统媒体查询
    if (v.kd_theme === 'light' || v.kd_theme === 'dark') {
      document.body.setAttribute('data-theme', v.kd_theme);
    }
  });
})();
