/* 快对答案下载器 —— 解析层
 *
 * MV3 不许 eval 远端内容，所以这里不用 eval(window.__NUXT__)，
 * 而是手写一个只认「JSON 子集 + 变量引用」的解析器：
 *   Nuxt 会把长字符串提成 IIFE 的形参，payload 里写 name:i 这种别名，
 *   所以必须把形参表 <-> 实参表对上，才能还原 name / grade 这些字段。
 */
(function (global) {
  'use strict';

  var PARAM_RE = /__NUXT__\s*=\s*\(\s*function\s*\(([^)]*)\)/;

  /* ---------------- 基础工具 ---------------- */

  function unescapeJsString(raw) {
    var out = '';
    for (var i = 0; i < raw.length; i++) {
      var ch = raw[i];
      if (ch !== '\\') { out += ch; continue; }
      var nx = raw[++i];
      if (nx === undefined) break;
      switch (nx) {
        case 'u': {
          var hex = raw.substr(i + 1, 4);
          if (/^[0-9a-fA-F]{4}$/.test(hex)) {
            out += String.fromCharCode(parseInt(hex, 16));
            i += 4;
          } else out += 'u';
          break;
        }
        case 'x': {
          var h2 = raw.substr(i + 1, 2);
          if (/^[0-9a-fA-F]{2}$/.test(h2)) { out += String.fromCharCode(parseInt(h2, 16)); i += 2; }
          else out += 'x';
          break;
        }
        case 'n': out += '\n'; break;
        case 't': out += '\t'; break;
        case 'r': out += '\r'; break;
        case 'b': out += '\b'; break;
        case 'f': out += '\f'; break;
        default: out += nx;
      }
    }
    return out;
  }

  // 按顶层逗号切分，尊重字符串/括号嵌套
  function splitTopLevel(src, sep) {
    sep = sep || ',';
    var out = [], cur = '', depth = 0, quote = null, esc = false;
    for (var i = 0; i < src.length; i++) {
      var ch = src[i];
      if (esc) { cur += ch; esc = false; continue; }
      if (quote) {
        cur += ch;
        if (ch === '\\') { esc = true; continue; }
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') { quote = ch; cur += ch; continue; }
      if (ch === '(' || ch === '[' || ch === '{') depth++;
      else if (ch === ')' || ch === ']' || ch === '}') depth--;
      if (ch === sep && depth === 0) { out.push(cur); cur = ''; continue; }
      cur += ch;
    }
    if (cur.trim() !== '' || out.length) out.push(cur);
    return out;
  }

  /* ---------------- 表达式求值（受限） ---------------- */

  function EvalCtx(env) { this.env = env || Object.create(null); }

  EvalCtx.prototype.value = function (expr) {
    expr = expr.trim();
    if (!expr) return undefined;

    // void 0 / undefined
    if (/^void\s+0$/.test(expr)) return undefined;
    if (expr === 'undefined') return undefined;
    if (expr === 'null') return null;
    if (expr === 'true') return true;
    if (expr === 'false') return false;

    // 字符串
    if (expr[0] === '"' || expr[0] === "'") {
      return unescapeJsString(expr.slice(1, -1));
    }
    // 数字（含负号）
    if (/^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(expr)) return Number(expr);
    // 数组
    if (expr[0] === '[') {
      var inner = expr.slice(1, expr.lastIndexOf(']'));
      if (!inner.trim()) return [];
      var self = this;
      return splitTopLevel(inner).map(function (p) { return self.value(p); });
    }
    // 对象
    if (expr[0] === '{') return this.object(expr);
    // 形参别名
    if (/^[A-Za-z_$][\w$]*$/.test(expr)) {
      return Object.prototype.hasOwnProperty.call(this.env, expr) ? this.env[expr] : undefined;
    }
    // 形如 "a"+"b" 的拼接
    if (expr.indexOf('+') > 0 && expr[0] !== '+' ) {
      var parts = splitTopLevel(expr, '+');
      if (parts.length > 1) {
        var self2 = this;
        return parts.map(function (p) { return self2.value(p); }).join('');
      }
    }
    return undefined;
  };

  // 解析一个对象字面量（不带外层花括号也行）
  EvalCtx.prototype.object = function (expr) {
    expr = expr.trim();
    if (expr[0] === '{') expr = expr.slice(1, expr.lastIndexOf('}'));
    var res = {};
    var self = this;
    splitTopLevel(expr).forEach(function (pair) {
      pair = pair.trim();
      if (!pair) return;
      var idx = -1, depth = 0, quote = null, esc = false;
      for (var i = 0; i < pair.length; i++) {
        var ch = pair[i];
        if (esc) { esc = false; continue; }
        if (quote) { if (ch === '\\') esc = true; else if (ch === quote) quote = null; continue; }
        if (ch === '"' || ch === "'") { quote = ch; continue; }
        if (ch === '(' || ch === '[' || ch === '{') depth++;
        else if (ch === ')' || ch === ']' || ch === '}') depth--;
        else if (ch === ':' && depth === 0) { idx = i; break; }
      }
      if (idx < 0) return;
      var key = pair.slice(0, idx).trim();
      if (key[0] === '"' || key[0] === "'") key = unescapeJsString(key.slice(1, -1));
      res[key] = self.value(pair.slice(idx + 1));
    });
    return res;
  };

  /* ---------------- 主入口 ---------------- */

  // 从 HTML 里取出并还原 window.__NUXT__
  function parseNuxt(html) {
    if (!html) return null;
    var start = html.indexOf('__NUXT__');
    if (start < 0) return null;
    var src = html.slice(start);

    var pm = src.match(PARAM_RE);
    var params = pm ? pm[1].split(',').map(function (s) { return s.trim(); }).filter(Boolean) : [];

    // 去掉 </script> 之后的内容
    var scriptEnd = src.indexOf('</script>');
    if (scriptEnd > 0) src = src.slice(0, scriptEnd);

    // payload 主体： return {...}
    var retIdx = src.indexOf('return');
    if (retIdx < 0) return null;
    var bodyStart = src.indexOf('{', retIdx);
    // 括号配对找主体结束
    var depth = 0, quote = null, esc = false, bodyEnd = -1;
    for (var i = bodyStart; i < src.length; i++) {
      var ch = src[i];
      if (esc) { esc = false; continue; }
      if (quote) { if (ch === '\\') esc = true; else if (ch === quote) quote = null; continue; }
      if (ch === '"' || ch === "'") { quote = ch; continue; }
      if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (depth === 0) { bodyEnd = i; break; } }
    }
    if (bodyEnd < 0) return null;
    var body = src.slice(bodyStart, bodyEnd + 1);

    // 实参表：body 结束后是 }( a, b, c )  这里取 '(' 到匹配的 ')'
    var after = src.slice(bodyEnd + 1);
    var argOpen = after.indexOf('(');
    var args = [];
    if (argOpen >= 0) {
      var d2 = 0, q2 = null, e2 = false, argClose = -1;
      for (var j = argOpen; j < after.length; j++) {
        var c2 = after[j];
        if (e2) { e2 = false; continue; }
        if (q2) { if (c2 === '\\') e2 = true; else if (c2 === q2) q2 = null; continue; }
        if (c2 === '"' || c2 === "'") { q2 = c2; continue; }
        if (c2 === '(') d2++;
        else if (c2 === ')') { d2--; if (d2 === 0) { argClose = j; break; } }
      }
      var argStr = argClose > 0 ? after.slice(argOpen + 1, argClose) : after.slice(argOpen + 1);
      args = splitTopLevel(argStr);
    }

    var env = Object.create(null);
    var primCtx = new EvalCtx(Object.create(null));
    params.forEach(function (name, idx) {
      if (idx < args.length) env[name] = primCtx.value(args[idx]);
    });

    return new EvalCtx(env).object(body);
  }

  /* ---------------- 业务字段 ---------------- */

  // 去掉七牛的缩放参数，拿原图
  function originImage(url) {
    if (!url) return '';
    return String(url).split('?')[0];
  }

  function bookIdFromUrl(url) {
    var m = String(url || '').match(/bookid([0-9a-f]{32})/i);
    return m ? m[1].toLowerCase() : '';
  }

  // 从一个书本页 HTML 里取详情
  function extractDetail(html, pageUrl) {
    var data = parseNuxt(html);
    var dd = data && data.state && data.state.detail && data.state.detail.detailData;
    var out = {
      bookId: bookIdFromUrl(pageUrl) || '',
      name: '',
      subject: '',
      grade: '',
      term: '',
      version: '',
      year: '',
      cover: '',
      answerCount: 0,
      totalPages: 0,
      images: [],
      pages: [],
      sourceUrl: pageUrl || ''
    };
    if (!dd) return out;

    out.bookId = (dd.bookId && String(dd.bookId)) || out.bookId;
    out.name = dd.name || '';
    out.subject = dd.subject || '';
    out.grade = dd.grade || '';
    out.term = dd.term || '';
    out.version = dd.version || dd.versionName || '';
    out.year = (dd.seoInfo && dd.seoInfo.year) || '';
    out.cover = originImage(dd.cover || '');
    out.pages = Array.isArray(dd.catalogs) ? dd.catalogs.slice() : [];
    out.answerCount = Number(dd.answerCount || out.pages.length || 0);

    var list = Array.isArray(dd.oriAnswers) && dd.oriAnswers.length ? dd.oriAnswers : (dd.answers || []);
    var seen = Object.create(null);
    out.images = [];
    (list || []).forEach(function (u) {
      var o = originImage(u);
      if (!o || seen[o]) return;
      seen[o] = 1;
      out.images.push(o);
    });
    out.totalPages = out.images.length;
    return out;
  }

  // 从搜索结果页 HTML 里取书单
  function extractBookList(html) {
    var data = parseNuxt(html);
    var sd = data && data.state && data.state.search && data.state.search.searchData;
    if (!sd) return { books: [], total: 0, hasMore: false };
    var books = (sd.bookList || []).map(function (b) {
      return {
        bookId: b.bookId,
        title: b.title,
        subject: b.subject,
        grade: b.grade,
        year: b.year,
        cover: originImage(b.coverPage || b.cover || '')
      };
    });
    return { books: books, total: Number(sd.total || books.length), hasMore: !!sd.hasMore };
  }

  // 页面 DOM 里的 bookid 链接（兜底，登录态/JS 渲染也吃得到）
  function bookIdsFromDom(doc) {
    var ids = [], seen = Object.create(null);
    var anchors = doc.querySelectorAll('a[href*="bookid"]');
    for (var i = 0; i < anchors.length; i++) {
      var id = bookIdFromUrl(anchors[i].getAttribute('href'));
      if (id && !seen[id]) { seen[id] = 1; ids.push(id); }
    }
    if (!ids.length) {
      var m = String(doc.documentElement ? doc.documentElement.innerHTML : '').match(/bookid[0-9a-f]{32}/gi) || [];
      m.forEach(function (s) {
        var id2 = bookIdFromUrl(s);
        if (id2 && !seen[id2]) { seen[id2] = 1; ids.push(id2); }
      });
    }
    return ids;
  }

  // 页面里所有答案图（含懒加载大图）
  function imagesFromDom(doc, bookId) {
    var out = [], seen = Object.create(null);
    var imgs = doc.querySelectorAll('img');
    for (var i = 0; i < imgs.length; i++) {
      var el = imgs[i];
      var raw = el.getAttribute('data-src') || el.getAttribute('data-original') ||
                el.getAttribute('data-lazy') || el.currentSrc || el.getAttribute('src') || '';
      if (!raw) continue;
      if (raw.indexOf('scanimg') < 0) continue;
      if (bookId && raw.indexOf(bookId) >= 0) continue;
      var o = originImage(raw);
      if (!o || seen[o]) continue;
      seen[o] = 1;
      out.push(o);
    }
    return out;
  }

  // 文件名安全化
  function safeName(s, fallback) {
    s = String(s || '').replace(/[\\/:*?"<>|\r\n\t]+/g, '_').replace(/\s+/g, ' ').trim();
    s = s.replace(/^\.+/, '').slice(0, 80);
    return s || (fallback || 'untitled');
  }

  var KD = {
    parseNuxt: parseNuxt,
    extractDetail: extractDetail,
    extractBookList: extractBookList,
    bookIdsFromDom: bookIdsFromDom,
    imagesFromDom: imagesFromDom,
    bookIdFromUrl: bookIdFromUrl,
    originImage: originImage,
    safeName: safeName,
    splitTopLevel: splitTopLevel,
    unescapeJsString: unescapeJsString
  };

  global.KD = KD;
  if (typeof module !== 'undefined' && module.exports) module.exports = KD;
})(typeof globalThis !== 'undefined' ? globalThis : this);
