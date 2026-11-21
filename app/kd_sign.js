/* kd_sign.js —— 快对签名链路的 JS 版（给浏览器扩展 / Node 用）
 *
 * 只实现已经用反编译 + .so 追踪确认过的层：
 *   1) paramString = base64_utf8( "".join(sorted(["k=v", ...])) )   ← 无分隔符
 *   2) sign_core   = md5hex( "8&%d*[" + md5hex(SECRET) + "]@" + paramString )
 *   3) sign        = sign_core + "&_t_=" + 秒 + "&kakorrhaphiophobia=" + 毫秒
 *
 * SECRET 来自 nativeInitBaseUtil + /pluto/app/antispam + nativeSetToken 的握手，
 * 浏览器里拿不到，所以真要用就调本地桥（app/kd_bridge_server.py）：
 *     const bridge = new KdBridge('http://127.0.0.1:8710');
 *     const sign = await bridge.sign({bookId, pageNo: 0, appId: 'scancode', ...});
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.kdSign = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var SIGN_PREFIX = '8&%d*';

  /* ---------------- md5 ---------------- */
  function md5(bytes) {
    function rl(n, c) { return (n << c) | (n >>> (32 - c)); }
    function au(x, y) { var l = (x & 0xFFFF) + (y & 0xFFFF); return (((x >> 16) + (y >> 16) + (l >> 16)) << 16) | (l & 0xFFFF); }
    function cmn(q, a, b, x, s, t) { return au(rl(au(au(a, q), au(x, t)), s), b); }
    function ff(a, b, c, d, x, s, t) { return cmn((b & c) | (~b & d), a, b, x, s, t); }
    function gg(a, b, c, d, x, s, t) { return cmn((b & d) | (c & ~d), a, b, x, s, t); }
    function hh(a, b, c, d, x, s, t) { return cmn(b ^ c ^ d, a, b, x, s, t); }
    function ii(a, b, c, d, x, s, t) { return cmn(c ^ (b | ~d), a, b, x, s, t); }
    function sb(n) { return String.fromCharCode(n & 0xFF, (n >>> 8) & 0xFF, (n >>> 16) & 0xFF, (n >>> 24) & 0xFF); }
    var i, j, n = bytes.length, ws = [];
    var lenBits = n * 8;
    for (i = 0; i < n; i++) ws[i >> 2] = (ws[i >> 2] || 0) | (bytes[i] << ((i % 4) * 8));
    ws[lenBits >> 5] = (ws[lenBits >> 5] || 0) | (0x80 << (lenBits % 32));
    ws[(((lenBits + 64) >>> 9) << 4) + 14] = lenBits;
    ws[(((lenBits + 64) >>> 9) << 4) + 15] = 0;
    var a = 1732584193, b = -271733879, c = -1732584194, d = 271733878;
    for (i = 0; i < ws.length; i += 16) {
      var oa = a, ob = b, oc = c, od = d;
      a = ff(a, b, c, d, ws[i] | 0, 7, -680876936); d = ff(d, a, b, c, ws[i + 1] | 0, 12, -389564586);
      c = ff(c, d, a, b, ws[i + 2] | 0, 17, 606105819); b = ff(b, c, d, a, ws[i + 3] | 0, 22, -1044525330);
      a = ff(a, b, c, d, ws[i + 4] | 0, 7, -176418897); d = ff(d, a, b, c, ws[i + 5] | 0, 12, 1200080426);
      c = ff(c, d, a, b, ws[i + 6] | 0, 17, -1473231341); b = ff(b, c, d, a, ws[i + 7] | 0, 22, -45705983);
      a = ff(a, b, c, d, ws[i + 8] | 0, 7, 1770035416); d = ff(d, a, b, c, ws[i + 9] | 0, 12, -1958414417);
      c = ff(c, d, a, b, ws[i + 10] | 0, 17, -42063); b = ff(b, c, d, a, ws[i + 11] | 0, 22, -1990404162);
      a = ff(a, b, c, d, ws[i + 12] | 0, 7, 1804603682); d = ff(d, a, b, c, ws[i + 13] | 0, 12, -40341101);
      c = ff(c, d, a, b, ws[i + 14] | 0, 17, -1502002290); b = ff(b, c, d, a, ws[i + 15] | 0, 22, 1236535329);
      a = gg(a, b, c, d, ws[i + 1] | 0, 5, -165796510); d = gg(d, a, b, c, ws[i + 6] | 0, 9, -1069501632);
      c = gg(c, d, a, b, ws[i + 11] | 0, 14, 643717713); b = gg(b, c, d, a, ws[i] | 0, 20, -373897302);
      a = gg(a, b, c, d, ws[i + 5] | 0, 5, -701558691); d = gg(d, a, b, c, ws[i + 10] | 0, 9, 38016083);
      c = gg(c, d, a, b, ws[i + 15] | 0, 14, -660478335); b = gg(b, c, d, a, ws[i + 4] | 0, 20, -405537848);
      a = gg(a, b, c, d, ws[i + 9] | 0, 5, 568446438); d = gg(d, a, b, c, ws[i + 14] | 0, 9, -1019803690);
      c = gg(c, d, a, b, ws[i + 3] | 0, 14, -187363961); b = gg(b, c, d, a, ws[i + 8] | 0, 20, 1163531501);
      a = gg(a, b, c, d, ws[i + 13] | 0, 5, -1444681467); d = gg(d, a, b, c, ws[i + 2] | 0, 9, -51403784);
      c = gg(c, d, a, b, ws[i + 7] | 0, 14, 1735328473); b = gg(b, c, d, a, ws[i + 12] | 0, 20, -1926607734);
      a = hh(a, b, c, d, ws[i + 5] | 0, 4, -378558); d = hh(d, a, b, c, ws[i + 8] | 0, 11, -2022574463);
      c = hh(c, d, a, b, ws[i + 11] | 0, 16, 1839030562); b = hh(b, c, d, a, ws[i + 14] | 0, 23, -35309556);
      a = hh(a, b, c, d, ws[i + 1] | 0, 4, -1530992060); d = hh(d, a, b, c, ws[i + 4] | 0, 11, 1272893353);
      c = hh(c, d, a, b, ws[i + 7] | 0, 16, -155497632); b = hh(b, c, d, a, ws[i + 10] | 0, 23, -1094730640);
      a = hh(a, b, c, d, ws[i + 13] | 0, 4, 681279174); d = hh(d, a, b, c, ws[i] | 0, 11, -358537222);
      c = hh(c, d, a, b, ws[i + 3] | 0, 16, -722521979); b = hh(b, c, d, a, ws[i + 6] | 0, 23, 76029189);
      a = hh(a, b, c, d, ws[i + 9] | 0, 4, -640364487); d = hh(d, a, b, c, ws[i + 12] | 0, 11, -421815835);
      c = hh(c, d, a, b, ws[i + 15] | 0, 16, 530742520); b = hh(b, c, d, a, ws[i + 2] | 0, 23, -995338651);
      a = ii(a, b, c, d, ws[i] | 0, 6, -198630844); d = ii(d, a, b, c, ws[i + 7] | 0, 10, 1126891415);
      c = ii(c, d, a, b, ws[i + 14] | 0, 15, -1416354905); b = ii(b, c, d, a, ws[i + 5] | 0, 21, -57434055);
      a = ii(a, b, c, d, ws[i + 12] | 0, 6, 1700485571); d = ii(d, a, b, c, ws[i + 3] | 0, 10, -1894986606);
      c = ii(c, d, a, b, ws[i + 10] | 0, 15, -1051523); b = ii(b, c, d, a, ws[i + 1] | 0, 21, -2054922799);
      a = ii(a, b, c, d, ws[i + 8] | 0, 6, 1873313359); d = ii(d, a, b, c, ws[i + 15] | 0, 10, -30611744);
      c = ii(c, d, a, b, ws[i + 6] | 0, 15, -1560198380); b = ii(b, c, d, a, ws[i + 13] | 0, 21, 1309151649);
      a = ii(a, b, c, d, ws[i + 4] | 0, 6, -145523070); d = ii(d, a, b, c, ws[i + 11] | 0, 10, -1120210379);
      c = ii(c, d, a, b, ws[i + 2] | 0, 15, 718787259); b = ii(b, c, d, a, ws[i + 9] | 0, 21, -343485551);
      a = au(a, oa); b = au(b, ob); c = au(c, oc); d = au(d, od);
    }
    var out = sb(a) + sb(b) + sb(c) + sb(d);
    var hex = '';
    for (i = 0; i < out.length; i++) hex += ('0' + out.charCodeAt(i).toString(16)).slice(-2);
    return hex;
  }

  function utf8(s) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(s);
    var out = [];
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xC0 | (c >> 6), 0x80 | (c & 63));
      else out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return out;
  }

  function md5hex(s) { return md5(utf8(s)); }

  function b64(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    // Java: Base64.encodeToString(bytes, Base64.NO_WRAP) —— NO_WRAP 只是不换行，
    // 结尾的 '=' 补齐是保留的，这里不能去掉。
    if (typeof btoa === 'function') return btoa(s);
    if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
    throw new Error('没有 base64 实现');
  }

  /* ---------------- 1) paramString ---------------- */
  function paramString(pairs) {
    var items = [];
    if (Array.isArray(pairs)) {
      for (var i = 0; i < pairs.length; i++) items.push(pairs[i]);
    } else {
      for (var k in pairs) if (Object.prototype.hasOwnProperty.call(pairs, k)) items.push(k + '=' + pairs[k]);
    }
    items.sort();
    return b64(utf8(items.join('')));
  }

  /* ---------------- 2) sign_core ---------------- */
  function signCore(secret, paramStr) {
    return md5hex(SIGN_PREFIX + '[' + md5hex(secret) + ']@' + paramStr);
  }

  /* ---------------- 3) 完整 sign 值 ---------------- */
  function signValue(secret, pairs, tSeconds, kakMs) {
    var t = tSeconds || Math.floor(Date.now() / 1000);
    var kak = kakMs || Date.now();
    var list = [];
    if (Array.isArray(pairs)) list = pairs.slice();
    else for (var k in pairs) if (Object.prototype.hasOwnProperty.call(pairs, k)) list.push(k + '=' + pairs[k]);
    list.push('_t_=' + t);
    list.push('kakorrhaphiophobia=' + kak);
    var core = signCore(secret, paramString(list));
    return core + '&_t_=' + t + '&kakorrhaphiophobia=' + kak;
  }

  /* ---------------- 本地桥客户端 ---------------- */
  function KdBridge(base) {
    this.base = (base || 'http://127.0.0.1:8710').replace(/\/+$/, '');
  }
  KdBridge.prototype.health = function () {
    return fetch(this.base + '/health').then(function (r) { return r.json(); });
  };
  KdBridge.prototype.init = function () {
    return fetch(this.base + '/init', { method: 'POST', body: '{}' }).then(function (r) { return r.json(); });
  };
  /** pairs: {k:v} 或 ["k=v"] -> 完整 sign 值 */
  KdBridge.prototype.sign = function (pairs) {
    var items = Array.isArray(pairs) ? pairs : Object.keys(pairs).map(function (k) {
      return k + '=' + pairs[k];
    });
    return fetch(this.base + '/sign', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pairs: items })
    }).then(function (r) { return r.json(); }).then(function (j) {
      if (!j.ok) throw new Error(j.error || 'bridge 失败');
      return j.sign;
    });
  };
  /** 只算 nativeGetSign(paramString) */
  KdBridge.prototype.signRaw = function (param) {
    return fetch(this.base + '/sign_raw', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ param: param })
    }).then(function (r) { return r.json(); }).then(function (j) {
      if (!j.ok) throw new Error(j.error || 'bridge 失败');
      return j.sign;
    });
  };
  /** 直接拿某一页的图片直链 */
  KdBridge.prototype.downloadAnswer = function (bookId, pageNo) {
    return fetch(this.base + '/downloadanswer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bookId: bookId, pageNo: pageNo })
    }).then(function (r) { return r.json(); });
  };

  return {
    SIGN_PREFIX: SIGN_PREFIX,
    md5hex: md5hex,
    paramString: paramString,
    signCore: signCore,
    signValue: signValue,
    KdBridge: KdBridge
  };
}));
