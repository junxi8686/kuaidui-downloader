/* 端到端测试：在 node 里模拟 chrome.* / service worker，真跑一遍后台逻辑
 *   node tests/harness.js zip      单本 ZIP
 *   node tests/harness.js pdf      单本 PDF
 *   node tests/harness.js search   搜索解析
 *   node tests/harness.js multi    两本合并 ZIP
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', 'extension', 'src');
const OUT = path.join(__dirname, 'out');
fs.mkdirSync(OUT, { recursive: true });

const bookId = process.argv[3] || 'cee9bcf902dcb3ba990f58d7b7d82efe';
const mode = process.argv[2] || 'zip';

/* ---- 假 chrome API ---- */
const blobs = new Map();
let blobSeq = 0;
const saved = [];

const realCreateObjectURL = URL.createObjectURL;
URL.createObjectURL = function (blob) {
  const u = 'blob:kd-' + (++blobSeq);
  blobs.set(u, blob);
  return u;
};
URL.revokeObjectURL = function (u) { blobs.delete(u); };

const chrome = {
  runtime: {
    lastError: null,
    getManifest: () => ({ version: '1.0.0' }),
    onMessage: { addListener(fn) { chrome.__listener = fn; } },
    sendMessage(msg, cb) {
      if (msg && msg.type === 'KD_PROGRESS' && !process.env.QUIET) {
        process.stderr.write(`  [progress ${String(msg.pct).padStart(3)}%] ${msg.text}\n`);
      }
      cb && cb({ ok: true });
    }
  },
  downloads: {
    download(opts, cb) {
      const blob = blobs.get(opts.url);
      const target = path.join(OUT, path.basename(opts.filename));
      if (!blob) {
        console.error('!! download 没有对应 blob:', opts.url);
        cb && cb(-1);
        return;
      }
      blob.arrayBuffer().then(buf => {
        fs.writeFileSync(target, Buffer.from(buf));
        saved.push({ target, bytes: buf.byteLength, filename: opts.filename });
        cb && cb(saved.length);
      });
    }
  },
  storage: { local: { get: (d, cb) => cb(Object.assign({}, d, process.env.FAKE_SECRET ? { secretMd5: process.env.FAKE_SECRET, cuid: process.env.FAKE_CUID || '0123456789abcdef0123456789abcdef' } : {})), set: (v, cb) => cb && cb() } }
};

/* ---- 模拟 importScripts（同一全局作用域） ---- */
const sandbox = {
  chrome,
  URL, Blob, TextEncoder, TextDecoder, Buffer, btoa: (str) => Buffer.from(str, 'binary').toString('base64'), Uint8Array, Int32Array, Promise, Date, Math, JSON,
  setTimeout, clearTimeout, console, fetch: globalThis.fetch,
  location: { href: 'https://m.kuaiduizuoye.com/' },
  self: null
};
sandbox.globalThis = sandbox;
sandbox.self = sandbox;
vm.createContext(sandbox);

function loadScript(file) {
  const code = fs.readFileSync(path.join(SRC, file), 'utf8');
  vm.runInContext(code, sandbox, { filename: file });
}

sandbox.importScripts = (...files) => files.forEach(loadScript);

loadScript('background.js');

async function call(msg) {
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('超时')), 180000);
    chrome.__listener(msg, {}, res => { clearTimeout(timer); resolve(res); });
  });
}

(async () => {
  const t0 = Date.now();
  try {
    if (mode === 'local') {
      const st = await call({ type: 'KD_SIGN_STATUS' });
      console.log('签名状态:', JSON.stringify(st));
      const f = await call({ type: 'KD_LOCAL_FETCH', jobId: 'l', bookId, maxPages: 3 });
      console.log('本地签名取页:', f.ok, (f.images || []).length, '页', f.error || '');
    } else if (mode === 'bridge') {
      const h = await call({ type: 'KD_BRIDGE_HEALTH' });
      console.log('桥 /health:', JSON.stringify(h));
      const f = await call({ type: 'KD_BRIDGE_FETCH', jobId: 'b', bookId, maxPages: 5 });
      console.log('桥取页:', f.ok, (f.images || []).length, '页');
      if (!f.ok) throw new Error(f.error);
      const r = await call({ type: 'KD_FETCH_BOOK', bookId });
      const detail = r.detail;
      detail.images = f.images;
      const res = await call({
        type: 'KD_RUN', jobId: 'b2', mode: 'single', format: process.env.FMT || 'zip',
        detail, images: f.images, options: { width: 'origin' }
      });
      console.log('结果:', JSON.stringify(res));
    } else if (mode === 'search') {
      const res = await call({ type: 'KD_SEARCH', keyword: '练习与测试', page: 1 });
      console.log('搜索结果:', res.result.books.length, '本 / total', res.result.total);
      console.log(JSON.stringify(res.result.books.slice(0, 3), null, 2));
    } else if (mode === 'multi') {
      const ids = ['cee9bcf902dcb3ba990f58d7b7d82efe', '938438f14ee22cafa656a284acfdb234'];
      const details = [];
      for (const id of ids) {
        const r = await call({ type: 'KD_FETCH_BOOK', bookId: id });
        if (r.ok && r.detail.images.length) details.push(r.detail);
      }
      console.log('读到', details.length, '本');
      const res = await call({
        type: 'KD_RUN', jobId: 't-multi', mode: 'multi', format: 'zip',
        tasks: details.map(d => ({ bookId: d.bookId, detail: d, images: d.images })),
        options: { width: 'origin' }
      });
      console.log('结果:', JSON.stringify(res));
    } else {
      const r = await call({ type: 'KD_FETCH_BOOK', bookId });
      if (!r.ok) throw new Error(r.error);
      console.log('书:', r.detail.name, '| 可得页:', r.detail.images.length, '| 官方页数:', r.detail.answerCount);
      const res = await call({
        type: 'KD_RUN', jobId: 't-single', mode: 'single', format: mode,
        detail: r.detail, images: r.detail.images,
        options: { width: process.env.WIDTH || 'origin' }
      });
      console.log('结果:', JSON.stringify(res));
    }
  } catch (e) {
    console.error('测试失败:', e.message);
    process.exitCode = 1;
  }
  saved.forEach(s => console.log('  保存 ->', path.basename(s.target), (s.bytes / 1024).toFixed(0) + 'KB', '|', s.filename));
  console.log('耗时', ((Date.now() - t0) / 1000).toFixed(1), 's');
  process.exit(process.exitCode || 0);
})();
