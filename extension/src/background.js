/* 快对答案下载器 —— 后台（service worker）
 * 负责：抓页面 -> 解析 -> 取原图 -> 打包 ZIP / 合成 PDF -> chrome.downloads
 */
importScripts('lib.js', 'zip.js', 'pdf.js');

var ORIGIN = 'https://m.kuaiduizuoye.com';
var UA_HINT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';
var IMG_CONCURRENCY = 4;
var IMG_RETRY = 3;

var cancelled = false;

/* ---------------- 公共 ---------------- */

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

function broadcast(msg) {
  try {
    chrome.runtime.sendMessage(msg, function () { void chrome.runtime.lastError; });
  } catch (e) { /* 没有接收端时忽略 */ }
}

function progress(jobId, text, pct) {
  broadcast({ type: 'KD_PROGRESS', jobId: jobId, text: text, pct: pct });
}

async function getText(url) {
  var lastErr;
  for (var attempt = 0; attempt < 3; attempt++) {
    try {
      // 站点有反爬：不带浏览器 UA 时直接回 "OK"。Chrome 的 fetch 会自动带 UA，
      // 这里显式写一份，方便在 node 里跑同一套逻辑（浏览器会忽略这个头）。
      var res = await fetch(url, {
        headers: {
          'User-Agent': UA_HINT,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'zh-CN,zh;q=0.9'
        },
        credentials: 'include',
        cache: 'no-store'
      });
      if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + url);
      var text = await res.text();
      if (text.length < 500 || text.indexOf('<html') < 0) throw new Error('返回内容异常（' + text.length + ' 字节）');
      return text;
    } catch (e) {
      lastErr = e;
      await sleep(500 * (attempt + 1));
    }
  }
  throw lastErr || new Error('请求失败 ' + url);
}

async function getBytes(url) {
  var lastErr;
  for (var attempt = 0; attempt < IMG_RETRY; attempt++) {
    try {
      var res = await fetch(url, { credentials: 'omit', cache: 'force-cache' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var buf = await res.arrayBuffer();
      if (!buf.byteLength) throw new Error('空文件');
      return new Uint8Array(buf);
    } catch (e) {
      lastErr = e;
      await sleep(400 * (attempt + 1));
    }
  }
  throw lastErr || new Error('下载失败');
}

function sizeVariant(url, width) {
  if (!width || width === 'origin') return url;
  return url + '?imageView2/2/w/' + width;
}

function pad(n, len) { var s = String(n); while (s.length < len) s = '0' + s; return s; }

/* ---------------- 本地桥（App 签名代理） ----------------
 * 快对整本答案要 App 的 antispam 令牌 + native 签名，纯浏览器算不出来。
 * 有一台能跑快对的安卓设备（root + frida）时，跑 app/kd_bridge_server.py，
 * 这里就通过它让「App 自己」签一次名，把整本图片直链拿回来。
 * 协议见 app/REVERSE.md §7。
 */

var BRIDGE_DEFAULT = 'http://127.0.0.1:8710';

function bridgeBase() {
  return new Promise(function (resolve) {
    chrome.storage.local.get({ bridgeUrl: BRIDGE_DEFAULT }, function (v) {
      resolve((v.bridgeUrl || BRIDGE_DEFAULT).replace(/\/+$/, ''));
    });
  });
}

async function bridgeFetch(path, body, timeoutMs) {
  var base = await bridgeBase();
  var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  var timer = controller ? setTimeout(function () { controller.abort(); }, timeoutMs || 4000) : null;
  try {
    var res = await fetch(base + path, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller ? controller.signal : undefined
    });
    if (!res.ok) throw new Error('桥返回 HTTP ' + res.status);
    return await res.json();
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function bridgeHealth() {
  try {
    var j = await bridgeFetch('/health', null, 2500);
    return { ok: !!j.ok, ready: !!j.ready, cuid: j.cuid || '', base: await bridgeBase() };
  } catch (e) {
    return { ok: false, ready: false, error: String(e && e.message || e) };
  }
}

// 逐页向桥要直链，直到拿不到为止
async function bridgePull(jobId, bookId, maxPages) {
  var images = [];
  var limit = Math.max(1, Math.min(maxPages || 200, 200));
  for (var p = 0; p < limit; p++) {
    if (cancelled) break;
    progress(jobId, '桥接取第 ' + (p + 1) + ' 页…', Math.round((p + 1) / limit * 80));
    var j;
    try {
      j = await bridgeFetch('/downloadanswer', { bookId: bookId, pageNo: p });
    } catch (e) {
      if (!images.length) throw e;
      break;
    }
    if (!j || !j.ok || !j.imageUrl) break;
    if (images.indexOf(j.imageUrl) < 0) images.push(j.imageUrl);
    await sleep(120);
  }
  return images;
}

/* ---------------- 抓书 ---------------- */

async function fetchBook(bookId) {
  var url = ORIGIN + '/bookid' + bookId;
  var html = await getText(url);
  return KD.extractDetail(html, url);
}

async function fetchSearch(keyword, page) {
  var urls = [];
  var q = encodeURIComponent(keyword);
  urls.push('https://www.kuaiduizuoye.com/kd-home/pc/searchResult?inputWord=' + q + (page > 1 ? '&page=' + page : ''));
  urls.push('https://www.kuaiduizuoye.com/kd-home/pc/searchresult?inputWord=' + q + (page > 1 ? '&page=' + page : ''));

  for (var i = 0; i < urls.length; i++) {
    try {
      var html = await getText(urls[i]);
      var list = KD.extractBookList(html);
      if (list.books.length) return list;
      // 兜底：从 DOM 链接提
      var ids = (html.match(/bookid[0-9a-f]{32}/gi) || []).map(KD.bookIdFromUrl);
      var uniq = [];
      ids.forEach(function (id) { if (id && uniq.indexOf(id) < 0) uniq.push(id); });
      if (uniq.length) {
        return { books: uniq.map(function (id) { return { bookId: id, title: '' }; }), total: uniq.length, hasMore: false };
      }
    } catch (e) { /* 试下一个 */ }
  }
  return { books: [], total: 0, hasMore: false };
}

/* ---------------- 任务 ---------------- */

async function downloadImages(jobId, urls, opts, label) {
  var files = [];
  var failed = [];
  var done = 0;
  var idx = 0;

  async function worker() {
    while (idx < urls.length) {
      if (cancelled) return;
      var my = idx++;
      var url = urls[my];
      try {
        var bytes = await getBytes(sizeVariant(url, opts.width));
        files[my] = { name: label(my + 1) + '.jpg', data: bytes };
      } catch (e) {
        failed.push(my + 1);
        files[my] = null;
      }
      done++;
      progress(jobId, '下载图片 ' + done + '/' + urls.length, Math.round(done / urls.length * 90));
    }
  }

  var workers = [];
  for (var w = 0; w < Math.min(IMG_CONCURRENCY, urls.length); w++) workers.push(worker());
  await Promise.all(workers);
  return { files: files.filter(Boolean), failed: failed };
}

function buildInfoText(detail, got, failed) {
  var lines = [];
  lines.push('书名：' + (detail.name || detail.bookId));
  lines.push('学科：' + (detail.subject || '-'));
  lines.push('年级：' + (detail.grade || '-'));
  lines.push('册别：' + (detail.term || '-'));
  lines.push('版本：' + (detail.version || '-'));
  lines.push('年份：' + (detail.year || '-'));
  lines.push('官方页数：' + (detail.answerCount || '-'));
  lines.push('已下载页数：' + got);
  if (failed && failed.length) lines.push('失败页：' + failed.join(','));
  if (detail.answerCount && got < detail.answerCount) {
    lines.push('');
    lines.push('说明：网页端每本书只放出前 ' + got + ' 页答案原图，其余页需在快对 App 内查看。');
    lines.push('要整本导出，见 app/ 目录的抓包脚本（走 App 自己的接口）。');
  }
  lines.push('');
  lines.push('来源：' + (detail.sourceUrl || ('https://m.kuaiduizuoye.com/bookid' + detail.bookId)));
  lines.push('时间：' + new Date().toLocaleString('zh-CN'));
  return lines.join('\n');
}

async function makeZip(jobId, detail, images, opts) {
  var base = KD.safeName((detail.name || detail.bookId) + (detail.subject ? ' ' + detail.subject : ''), 'kuaidui');
  var res = await downloadImages(jobId, images, opts, function (n) {
    return base + '/答案_第' + pad(n, 2) + '页';
  });
  var files = res.files;
  files.push({ name: base + '/信息.txt', data: KDZIP.utf8(buildInfoText(detail, files.length, res.failed)) });
  progress(jobId, '打包 ZIP…', 95);
  var zipBytes = KDZIP.zip(files);
  return { bytes: zipBytes, filename: base + '.zip', mime: 'application/zip' };
}

async function makePdf(jobId, detail, images, opts) {
  var res = await downloadImages(jobId, images, opts, function (n) { return String(n); });
  progress(jobId, '合成 PDF…', 93);
  var pdfBytes = KDPDF.imagesToPdf(res.files.map(function (f) { return { data: f.data }; }), {
    title: detail.name || detail.bookId
  });
  var base = KD.safeName(detail.name || detail.bookId, 'kuaidui');
  return { bytes: pdfBytes, filename: base + '.pdf', mime: 'application/pdf' };
}

async function makeMultiZip(jobId, tasks, opts) {
  // tasks: [{ bookId, images }]
  var all = [];
  for (var i = 0; i < tasks.length; i++) {
    if (cancelled) break;
    var t = tasks[i];
    var detail = t.detail || { bookId: t.bookId, name: t.bookId };
    var base = KD.safeName((detail.name || detail.bookId), 'kuaidui');
    progress(jobId, '[' + (i + 1) + '/' + tasks.length + '] ' + base, Math.round(i / tasks.length * 85));
    var res = await downloadImages(jobId, t.images, opts, function (n) {
      return base + '/答案_第' + pad(n, 2) + '页';
    });
    res.files.forEach(function (f) { all.push(f); });
    all.push({ name: base + '/信息.txt', data: KDZIP.utf8(buildInfoText(detail, res.files.length, res.failed)) });
    if (i < tasks.length - 1) await sleep(400);   // 本与本之间歇一下，别把站点点着了
  }
  progress(jobId, '打包 ZIP…', 92);
  var zipBytes = KDZIP.zip(all);
  return { bytes: zipBytes, filename: '快对答案_' + timestamp() + '.zip', mime: 'application/zip' };
}

function timestamp() {
  var d = new Date();
  return d.getFullYear() + pad(d.getMonth() + 1, 2) + pad(d.getDate(), 2) + '_' +
         pad(d.getHours(), 2) + pad(d.getMinutes(), 2);
}

function toBase64(bytes) {
  var chunk = 0x8000, parts = [];
  for (var i = 0; i < bytes.length; i += chunk) {
    parts.push(String.fromCharCode.apply(null, bytes.subarray(i, i + chunk)));
  }
  return btoa(parts.join(''));
}

function saveBytes(result) {
  var blob = new Blob([result.bytes], { type: result.mime });

  function start(url, revoke) {
    return new Promise(function (resolve, reject) {
      chrome.downloads.download({ url: url, filename: '快对答案/' + result.filename, saveAs: false }, function (id) {
        if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; }
        if (revoke) setTimeout(function () { URL.revokeObjectURL(url); }, 5 * 60 * 1000);
        resolve(id);
      });
    });
  }

  // 首选 blob URL；某些 Chrome 版本在 service worker 里拿不到 createObjectURL，
  // 退回 data: URL（体积大约 4/3，但一定能下载）。
  if (typeof URL.createObjectURL === 'function') {
    try {
      return start(URL.createObjectURL(blob), true);
    } catch (e) { /* 落到 data: 分支 */ }
  }
  try {
    return start('data:' + result.mime + ';base64,' + toBase64(result.bytes), false);
  } catch (e) {
    return Promise.reject(e);
  }
}

/* ---------------- 消息入口 ---------------- */

async function downloadOneByOne(detail, images, opts) {
  var base = KD.safeName((detail.name || detail.bookId), 'kuaidui');
  for (var i = 0; i < images.length; i++) {
    var name = '快对答案/' + base + '/答案_第' + pad(i + 1, 2) + '页.jpg';
    await new Promise(function (resolve) {
      chrome.downloads.download({ url: sizeVariant(images[i], opts.width), filename: name, saveAs: false }, function () {
        void chrome.runtime.lastError;
        resolve();
      });
    });
    await sleep(120);
  }
}

async function handle(msg) {
  switch (msg.type) {
    case 'KD_PING':
      return { ok: true, version: chrome.runtime.getManifest().version };

    case 'KD_FETCH_BOOK':
      return { ok: true, detail: await fetchBook(msg.bookId) };

    case 'KD_BRIDGE_HEALTH':
      return { ok: true, health: await bridgeHealth() };

    case 'KD_BRIDGE_FETCH': {
      cancelled = false;
      var jobId2 = msg.jobId || String(Date.now());
      var imgs = await bridgePull(jobId2, msg.bookId, msg.maxPages);
      progress(jobId2, imgs.length ? ('桥接取到 ' + imgs.length + ' 页') : '桥没返回图片', 85);
      return { ok: imgs.length > 0, images: imgs, error: imgs.length ? null : '桥没返回图片（在 App 里打开过这本书吗？）' };
    }

    case 'KD_SEARCH':
      return { ok: true, result: await fetchSearch(msg.keyword, msg.page || 1) };

    case 'KD_CANCEL':
      cancelled = true;
      return { ok: true };

    case 'KD_RUN': {
      cancelled = false;
      var jobId = msg.jobId || String(Date.now());
      var opts = msg.options || {};
      try {
        var result;
        if (msg.mode === 'multi') {
          result = await makeMultiZip(jobId, msg.tasks, opts);
        } else {
          var detail = msg.detail || await fetchBook(msg.bookId);
          var images = (msg.images && msg.images.length) ? msg.images : detail.images;
          if (!images.length) throw new Error('这本书没抓到答案图');
          if (msg.format === 'images') {
            progress(jobId, '逐张保存 ' + images.length + ' 页…', 20);
            await downloadOneByOne(detail, images, opts);
            progress(jobId, '已交给浏览器下载（' + images.length + ' 页）', 100);
            return { ok: true, filename: (detail.name || detail.bookId) + '（' + images.length + ' 张图片）' };
          }
          if (msg.format === 'pdf') result = await makePdf(jobId, detail, images, opts);
          else result = await makeZip(jobId, detail, images, opts);
        }
        progress(jobId, '保存文件…', 98);
        await saveBytes(result);
        progress(jobId, '完成：' + result.filename, 100);
        return { ok: true, filename: result.filename };
      } catch (e) {
        progress(jobId, '出错：' + (e && e.message ? e.message : e), 100);
        return { ok: false, error: String(e && e.message || e) };
      }
    }

    default:
      return { ok: false, error: '未知消息 ' + msg.type };
  }
}

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || typeof msg.type !== 'string' || msg.type.indexOf('KD_') !== 0) return;
  handle(msg).then(sendResponse, function (e) {
    sendResponse({ ok: false, error: String(e && e.message || e) });
  });
  return true;   // 异步响应
});
