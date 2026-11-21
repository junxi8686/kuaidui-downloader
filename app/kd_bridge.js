/*
 * kd_bridge.js —— 快对 App 签名能力的 frida RPC 导出。
 *
 * 目标：com.kuaiduizuoye.scan（快对 / 快对AI，5.x）
 *
 * 用法：
 *     frida -U -f com.kuaiduizuoye.scan -l kd_bridge.js
 *   （配合 app/kd_bridge_server.py 用 frida-python 加载同一份脚本）
 *
 * 为什么这么写：
 *   1. 签名不是纯 Java 算法，最终落到 com.zuoyebang.baseutil.NativeHelper.nativeGetSign，
 *      而它要先由 nativeInitBaseUtil + /pluto/app/antispam + nativeSetToken 建好内部密钥。
 *      这三步都在 App 进程里，所以最省事的做法就是「让 App 自己算」。
 *   2. HTTP 上真正要带的 sign 参数值不是 nativeGetSign 的返回值，而是
 *        com.zuoyebang.baseutil.a.a(List<String>) 的返回值
 *      = "<nativeGetSign 结果>&_t_=<秒>&kakorrhaphiophobia=<毫秒>"
 *      （反编译证据：com/zuoyebang/baseutil/a.java:131-140）
 *      所以对外只暴露 a.a(List) 更贴合，少一处可能算错的地方。
 *   3. 同时保留 signRaw(param)，等价 nativeGetSign(String)，方便做算法对照。
 */

'use strict';

var BASEUTIL = 'com.zuoyebang.baseutil.a';
var NATIVE = 'com.zuoyebang.baseutil.NativeHelper';

function log(s) {
  console.log('[kd-bridge] ' + s);
}

function A() {
  return Java.use(BASEUTIL);
}

function ensureToken() {
  // a.b() = isBaseUtilInitSuccess；没初始化就调一次 a.a() 触发握手
  var a = A();
  var ok = false;
  try { ok = a.b(); } catch (e) { log('b() 失败: ' + e); }
  if (!ok) {
    log('antispam 未就绪，调 a.a() 触发 nativeInitBaseUtil + /pluto/app/antispam');
    try { a.a(); } catch (e) { log('a() 失败: ' + e); }
    try { ok = a.b(); } catch (e) { ok = false; }
  }
  return ok;
}

rpc.exports = {
  /* 当前状态 */
  state: function () {
    var out = { ready: false, cuid: null };
    try {
      var app = Java.use('com.baidu.homework.base.InitApplication');
      out.cuid = app.getCuid();
    } catch (e) { /* 某些版本没有静态 getCuid，忽略 */ }
    try { out.ready = A().b(); } catch (e) { }
    return out;
  },

  /* 显式触发一次握手 */
  initToken: function () {
    return ensureToken();
  },

  /*
   * pairs: ["bookId=xxx", "pageNo=0", "appId=scancode", ...]
   * 返回：完整的 sign 参数值（含 &_t_=.. &kakorrhaphiophobia=..）
   */
  sign: function (pairs) {
    ensureToken();
    var list = Java.use('java.util.ArrayList').$new();
    for (var i = 0; i < pairs.length; i++) list.add(pairs[i]);
    var v = A().a(list);
    log('sign(' + pairs.length + ' 项) -> ' + v);
    return v;
  },

  /* 只算 nativeGetSign(paramString)，用于和本地实现对照 */
  signRaw: function (param) {
    ensureToken();
    var v = Java.use(NATIVE).nativeGetSign(param);
    log('signRaw -> ' + v);
    return v;
  },

  /* 直接看一眼内部参数（调试用） */
  dumpCommon: function () {
    var out = {};
    try {
      var net = Java.use('com.baidu.homework.common.net.Net');
      out.init = net.isInit ? net.isInit() : null;
    } catch (e) { out.net_error = String(e); }
    try {
      out.pkgName = Java.use('com.baidu.homework.base.InitApplication')
        .getApplication().getPackageName();
    } catch (e) { out.pkg_error = String(e); }
    return out;
  }
};

Java.perform(function () {
  log('已注入 ' + Process.id);

  // 把 nativeGetSign 的入参/出参打到 logcat，方便对照 REVERSE.md 里的算法
  try {
    var nh = Java.use(NATIVE);
    nh.nativeGetSign.implementation = function (s) {
      var r = this.nativeGetSign(s);
      log('nativeGetSign(' + s + ') = ' + r);
      return r;
    };
    log('已 hook nativeGetSign');
  } catch (e) {
    log('hook nativeGetSign 失败: ' + e);
  }

  // App 每发一个带签名的请求都会走这里，能顺手看到最终的 sign 参数值
  try {
    var net = Java.use('com.baidu.homework.common.net.Net');
    if (net.appendSign) {
      var orig = net.appendSign;
      net.appendSign.implementation = function (input) {
        var s = orig.call(this, input);
        try {
          var m = /[?&]sign=([^&]*)/.exec(s);
          if (m) log('appendSign -> ' + decodeURIComponent(m[1]));
        } catch (e2) { }
        return s;
      };
      log('已 hook Net.appendSign');
    }
  } catch (e) {
    log('hook appendSign 跳过: ' + e);
  }

  ensureToken();
  log('就绪');
});
