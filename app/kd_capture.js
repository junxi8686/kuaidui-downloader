/*
 * 快对答案抓取插件（Frida）
 *
 * 原理：不去复刻 App 的 native 签名，而是坐在 App 里面，等它自己把
 *      "整本答案" 的 JSON 解出来时顺手抄一份。所以只要你在 App 里把
 *      那本书的答案页翻一遍，这里就能拿到全书图片直链。
 *
 * 挂的点：fastjson / gson / org.json 的 JSON 解析入口
 *   —— 无论 App 走哪个接口、加什么签名，最终都要过这一步。
 *
 * 用法：
 *   frida -U -f com.kuaiduizuoye.scan -l kd_capture.js -o kd_capture.log
 *   然后在手机上把要下载的那本书打开、翻几页。日志里 [KD] 开头的行就是结果。
 *
 * 输出（每行）：
 *   [KD] {"bookId":"...","name":"...","pageCount":18,"images":["https://...jpg", ...]}
 */

'use strict';

var SEEN = {};          // bookId -> 已导出的图片集合指纹
var EMITTED = 0;

function normalize(s) {
  // JSON 里的 URL 可能是 https:\/\/ 转义过的
  return s.replace(/\\\//g, '/').replace(/\\u002F/gi, '/').replace(/\\u0026/gi, '&');
}

function pick(re, s, idx) {
  var m = s.match(re);
  return m ? m[idx || 1] : '';
}

function extract(text, source) {
  if (!text || text.length < 30) return null;
  var s = normalize(text);
  if (s.indexOf('scanimg') < 0 && s.indexOf('oriAnswers') < 0) return null;

  // 图片直链（去重、去缩略图参数）
  var imgRe = /https?:\/\/[^\s"'\\<>]+?\.(?:jpg|jpeg|png|webp)/gi;
  var found = [];
  var seen = {};
  var m;
  while ((m = imgRe.exec(s)) !== null) {
    var u = m[0].split('?')[0];
    if (seen[u]) continue;
    seen[u] = 1;
    found.push(u);
  }
  if (!found.length) return null;

  var bookId = pick(/"bookId"\s*:\s*"([0-9a-fA-F]{32})"/, s) ||
               pick(/"book_id"\s*:\s*"([0-9a-fA-F]{32})"/, s) ||
               'unknown';
  var name = pick(/"name"\s*:\s*"([^"]{2,100})"/, s) ||
             pick(/"title"\s*:\s*"([^"]{2,100})"/, s) ||
             pick(/"bookName"\s*:\s*"([^"]{2,100})"/, s) || '';
  var pageCount = parseInt(pick(/"answerCount"\s*:\s*(\d+)/, s) ||
                           pick(/"pageCount"\s*:\s*(\d+)/, s) || '0', 10) || found.length;

  return {
    bookId: bookId.toLowerCase(),
    name: name,
    pageCount: pageCount,
    images: found,
    source: source,
    time: Math.floor(Date.now() / 1000)
  };
}

function handle(text, source) {
  var info;
  try { info = extract(text, source); } catch (e) { info = null; }
  if (!info) return;

  var key = info.bookId + '|' + info.images.length + '|' + info.images[0];
  if (SEEN[key]) return;
  SEEN[key] = 1;
  EMITTED++;

  var line = '[KD] ' + JSON.stringify(info);
  console.log(line);
  try { send({ type: 'kd_answer', data: info }); } catch (e) { /* 没人接就只打日志 */ }
}

function hookFastjson() {
  try {
    var JSON = Java.use('com.alibaba.fastjson.JSON');
    JSON.parseObject.overload('java.lang.String').implementation = function (s) {
      handle(s, 'fastjson.JSON.parseObject');
      return this.parseObject(s);
    };
    JSON.parse.overload('java.lang.String').implementation = function (s) {
      handle(s, 'fastjson.JSON.parse');
      return this.parse(s);
    };
  } catch (e) { console.log('[KD] fastjson 未命中: ' + e); }

  try {
    var JSONObject = Java.use('com.alibaba.fastjson.JSONObject');
    JSONObject.parseObject.overload('java.lang.String').implementation = function (s) {
      handle(s, 'fastjson.JSONObject.parseObject');
      return this.parseObject(s);
    };
  } catch (e) { /* 有版本没有这个重载，忽略 */ }
}

function hookGson() {
  try {
    var Gson = Java.use('com.google.gson.Gson');
    Gson.fromJson.overload('java.lang.String', 'java.lang.Class').implementation = function (s, c) {
      handle(s, 'gson.fromJson(String,Class)');
      return this.fromJson(s, c);
    };
    Gson.fromJson.overload('java.lang.String', 'java.lang.reflect.Type').implementation = function (s, t) {
      handle(s, 'gson.fromJson(String,Type)');
      return this.fromJson(s, t);
    };
  } catch (e) { console.log('[KD] gson 未命中: ' + e); }
}

function hookOrgJson() {
  try {
    var JO = Java.use('org.json.JSONObject');
    JO.$init.overload('java.lang.String').implementation = function (s) {
      handle(s, 'org.json.JSONObject');
      return this.$init(s);
    };
  } catch (e) { /* 忽略 */ }
}

function hookOkHttpBody() {
  // 兜底：直接看 OkHttp 响应体（JSON 解析器没命中时还能抓到）
  var candidates = [];
  try {
    Java.enumerateLoadedClassesSync().forEach(function (n) {
      if (n.indexOf('okhttp3.') === 0 && n.indexOf('ResponseBody') >= 0) candidates.push(n);
    });
  } catch (e) { return; }
  candidates.forEach(function (name) {
    try {
      var K = Java.use(name);
      if (K.string) {
        K.string.implementation = function () {
          var s = this.string();
          handle(s, 'okhttp:' + name);
          return s;
        };
      }
    } catch (e) { /* 忽略单个类 */ }
  });
}

function main() {
  console.log('[KD] 快对答案抓取已挂上，版本 ' + (typeof Frida !== 'undefined' ? Frida.version : '?'));
  hookFastjson();
  hookGson();
  hookOrgJson();
  setTimeout(hookOkHttpBody, 1500);
  console.log('[KD] 现在去 App 里打开那本书的答案页，翻一遍；日志里出现 [KD] {...} 就是拿到了。');
}

Java.perform(main);
