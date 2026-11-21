#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""kd_full.py —— 用 App 接口拿「整本教辅答案」的全部页图片。

用法::

    python3 kd_full.py --book cee9bcf902dcb3ba990f58d7b7d82efe --out ~/下载/快对答案 --pdf

    python3 kd_full.py --book <bookId> --list            # 只打印直链，不下载
    python3 kd_full.py --book <bookId> --mode web        # 退回网页端（只有前 3 页）
    python3 kd_full.py --book <bookId> --bridge http://127.0.0.1:8710   # 用真机桥签名

两种取数通道
------------
1. ``api``（默认，能拿全书）::

       POST https://www.kuaiduizuoye.com/kdtools/book/downloadanswer
            ?bookId=<32位>&pageNo=<0 起>&appId=scancode&cuid=...&_t_=...&sign=...

   这是 App 里 BookCompleteDetailsPictureBrowseActivity 逐页下载原图用的接口，
   一页一次请求，返回 {"imageUrl": "..."}。**必须带 native 签名**，签名由
   libbaseutil.so 产生；本脚本不内置算法，而是通过 SignCore 取：
     --bridge  → app/kd_bridge_server.py + app/kd_bridge.js（真机 frida RPC）
     默认       → app/kd_native_emu.py（unicorn 跑 .so，实验性）

2. ``web``（不需要签名，但每本书只有前 3 页原图）::

       GET https://m.kuaiduizuoye.com/bookid<32位>

   页面里 oriAnswers 只给 3 条，answerCount 是全书页数。这是保底通道。
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import kd_sign  # noqa: E402

API_HOST = "https://www.kuaiduizuoye.com"
DOWNLOAD_ANSWER = "/kdtools/book/downloadanswer"
UA_APP = ("Mozilla/5.0 (Linux; Android 13; SM-G986B Build/TP1A.220624.014; wv) "
          "AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/116.0.0.0 "
          "Mobile Safari/537.36 kuaiduizuoye/5.14.0")
UA_WEB = ("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) "
          "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1")
UA_IMG = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
          "(KHTML, like Gecko) Chrome/120.0 Safari/537.36")

BOOK_ID_RE = re.compile(r"^[0-9a-f]{32}$")


class KdError(RuntimeError):
    """带中文说明的失败。"""


# --------------------------------------------------------------------------- #
# HTTP
# --------------------------------------------------------------------------- #
def http(url, data=None, headers=None, timeout=30, method=None):
    h = {"User-Agent": UA_APP}
    if headers:
        h.update(headers)
    req = urllib.request.Request(url, data=data, headers=h,
                                 method=method or ("POST" if data is not None else "GET"))
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.read(), r.headers
    except urllib.error.HTTPError as e:
        raise KdError("请求 %s 失败：HTTP %s %s" % (url.split("?")[0], e.code, e.reason))
    except urllib.error.URLError as e:
        raise KdError("连不上 %s：%s（检查网络/代理）" % (url.split("?")[0], e.reason))


def get_json(url, data=None, headers=None, timeout=30):
    body, _ = http(url, data=data, headers=headers, timeout=timeout)
    txt = body.decode("utf-8", "replace")
    try:
        return json.loads(txt)
    except ValueError:
        raise KdError("接口返回的不是 JSON（前 200 字）：%r" % txt[:200])


# --------------------------------------------------------------------------- #
# 通道 A：App 接口
# --------------------------------------------------------------------------- #
def api_page_url(book_id, page_no, core, common, cuid):
    """拼一次 downloadanswer 请求，返回 (url, body)。"""
    biz = {"bookId": book_id, "pageNo": page_no}
    full = dict(common)
    full.update(biz)
    full["cuid"] = cuid
    try:
        sign = core.sign(full)
    except Exception as e:  # SignCore 不可用
        raise KdError("拿不到签名，无法调用 App 接口：%s\n"
                      "  → 用 --bridge http://127.0.0.1:8710 接真机桥，"
                      "或 --mode web 走网页端（只有前 3 页）" % e)
    q = kd_sign.build_query(full, sign=sign, tips=True)
    url = API_HOST + DOWNLOAD_ANSWER + "?" + q
    body = urllib.parse.urlencode(biz).encode()
    return url, body


ERR_HINT = {
    5115: "缺少/不认识 appId（服务端 antispam 没登记这个 appId）",
    5109: "缺少 cuid",
    5110: "缺少 _t_ 时间戳",
    5103: "缺少 sign 参数",
    6: "antispam 令牌校验失败：服务端按 cuid 找不到登记的令牌。\n"
       "      这条链路要求先跑 nativeInitBaseUtil → POST /pluto/app/antispam → "
       "nativeSetToken，\n      也就是必须有能产出合法 signA 的 App 环境（真机桥或可用的模拟器）。",
    7: "antispam 数据非法（signA 没通过服务端解密/校验）",
}


def api_collect(book_id, core, common, cuid, max_pages=60, list_only=False, verbose=True):
    """逐页拉 imageUrl，直到服务端不再返回。返回 [(page_no, url), ...]。"""
    out = []
    for pno in range(max_pages):
        url, body = api_page_url(book_id, pno, core, common, cuid)
        try:
            j = get_json(url, data=body,
                         headers={"Content-Type": "application/x-www-form-urlencoded"})
        except urllib.error.HTTPError as e:
            raise KdError("请求失败 HTTP %s：%s" % (e.code, e.reason))
        errno = j.get("errNo", j.get("errno", -1))
        if errno not in (0, 200):
            if pno == 0:
                hint = ERR_HINT.get(errno, "")
                raise KdError("接口返回 errNo=%s errstr=%s%s"
                              % (errno, j.get("errstr", ""),
                                 ("\n      " + hint) if hint else ""))
            if verbose:
                print("  第 %d 页起服务端不再返回数据（errNo=%s），到此为止" % (pno, errno))
            break
        data = j.get("data") or {}
        img = data.get("imageUrl") or ""
        if not img:
            if verbose:
                print("  第 %d 页没有 imageUrl，停止" % pno)
            break
        out.append((pno, img))
        if verbose:
            print("  第 %02d 页 %s" % (pno + 1, img))
    return out


# --------------------------------------------------------------------------- #
# 通道 B：网页端（保底）
# --------------------------------------------------------------------------- #
def _unescape_nuxt(s):
    """payload 里 URL 是 https:\\u002F\\u002F... 这种转义。"""
    if "\\u" in s:
        s = s.encode("utf-8").decode("unicode_escape", "replace")
    return s.replace("\\/", "/")


def web_collect(book_id, verbose=True):
    """抓 bookid 页面，返回 (书名, answerCount, [图片直链...])。"""
    url = "https://m.kuaiduizuoye.com/bookid" + book_id
    try:
        body, _ = http(url, headers={"User-Agent": UA_WEB})
    except KdError as e:
        raise KdError("取书页失败（bookId 可能不存在）：%s" % e)
    html = body.decode("utf-8", "replace")

    m = re.search(r"answerCount\s*:\s*(\d+)", html) or re.search(r'"answerCount"\s*:\s*(\d+)', html)
    total = int(m.group(1)) if m else 0

    imgs = []
    mo = re.search(r"oriAnswers\s*:\s*\[(.*?)\]", html, re.S)
    if mo:
        for u in re.findall(r'"(https[^"]+?)"', mo.group(1)):
            u = _unescape_nuxt(u)
            if u not in imgs:
                imgs.append(u)
    if not imgs:  # 退路：全文扫 scanimg
        for u in re.findall(r'https?://kd-book\.cdnjtzy\.com/scanimg/scan_[0-9a-f]{32}\.jpg', html):
            if u not in imgs:
                imgs.append(u)

    if not imgs and not total:
        raise KdError("这个 bookId 在网页端没有任何答案数据（可能不存在或已下架）：%s" % book_id)
    name = _resolve_book_name(html, book_id)
    if verbose:
        print("  网页端：answerCount=%d，oriAnswers=%d 张" % (total, len(imgs)))
    return name, total, imgs


def _resolve_book_name(html, book_id):
    """Nuxt payload 里书名可能是 name:"xxx" 也可能是 name:i（形参别名）。

    这里只做够用的两层：
      1) 在 bookId 附近找 name:"字面量"；
      2) 若是别名，用 __NUXT__(function(a,b,...){...}(实参...)) 的形参表还原。
    拿不到就退回 bookId 前 8 位（不影响下载）。
    """
    idx = html.find(book_id)
    win = html[max(0, idx - 2500): idx + 2500] if idx >= 0 else html

    for m in re.finditer(r'name\s*:\s*"([^"]{2,80})"', win):
        cand = _unescape_nuxt(m.group(1))
        if re.search(r"[\u4e00-\u9fa5]", cand):
            return cand

    alias = re.search(r'name\s*:\s*([a-zA-Z_$][\w$]*)', win)
    if alias:
        val = _nuxt_param(html, alias.group(1))
        if val and re.search(r"[\u4e00-\u9fa5]", val):
            return val
    return "快对_" + book_id[:8]


def _nuxt_param(html, ident):
    """从 __NUXT__(function(a,b,c){...}(v1,v2,v3)) 里取形参 ident 的实参值。"""
    m = re.search(r"__NUXT__\s*=\s*\(?\s*function\s*\(([^)]*)\)", html)
    if not m:
        return None
    names = [x.strip() for x in m.group(1).split(",") if x.strip()]
    if ident not in names:
        return None
    pos = names.index(ident)

    start = m.end()
    call = html.find("}(", start)
    if call < 0:
        return None
    # 找到与之配对的右括号
    depth, i = 1, call + 2
    while i < len(html) and depth:
        c = html[i]
        if c == "(":
            depth += 1
        elif c == ")":
            depth -= 1
        elif c in "\"'":
            q = c
            i += 1
            while i < len(html) and html[i] != q:
                i += 2 if html[i] == "\\" else 1
        i += 1
    args_src = html[call + 2: i - 1]

    args, cur, depth, quote, esc = [], "", 0, None, False
    for c in args_src:
        if esc:
            cur += c; esc = False; continue
        if quote:
            cur += c
            if c == "\\":
                esc = True
            elif c == quote:
                quote = None
            continue
        if c in "\"'`":
            quote = c; cur += c; continue
        if c in "([{":
            depth += 1
        elif c in ")]}":
            depth -= 1
        if c == "," and depth == 0:
            args.append(cur); cur = ""
            continue
        cur += c
    args.append(cur)
    if pos >= len(args):
        return None
    raw = args[pos].strip()
    if raw.startswith(("'", '"')):
        return _unescape_nuxt(raw[1:-1])
    return None


# --------------------------------------------------------------------------- #
# 下载 / 输出
# --------------------------------------------------------------------------- #
def safe_name(s, fallback="未命名"):
    s = re.sub(r'[\\/:*?"<>|\r\n\t]+', "_", (s or "").strip()).strip(". ")
    return s[:120] or fallback


def download(url, path, referer="https://m.kuaiduizuoye.com/"):
    req = urllib.request.Request(url, headers={"User-Agent": UA_IMG, "Referer": referer})
    with urllib.request.urlopen(req, timeout=60) as r:
        data = r.read()
    if not data or len(data) < 512:
        raise KdError("图片内容异常（%d 字节）：%s" % (len(data), url))
    with open(path, "wb") as f:
        f.write(data)
    return len(data)


def make_pdf(images, pdf_path):
    try:
        from PIL import Image
    except ImportError:
        raise KdError("合成 PDF 需要 Pillow：pip install pillow")
    pages = []
    for p in images:
        im = Image.open(p)
        if im.mode != "RGB":
            im = im.convert("RGB")
        pages.append(im)
    if not pages:
        raise KdError("没有图片，无法合成 PDF")
    first, rest = pages[0], pages[1:]
    first.save(pdf_path, "PDF", resolution=150.0, save_all=True, append_images=rest)
    return pdf_path


def write_info(path, book_id, name, total, images, mode):
    lines = [
        "书名：%s" % name,
        "bookId：%s" % book_id,
        "全书页数（服务端 answerCount）：%s" % (total or "未知"),
        "实际拿到：%d 页" % len(images),
        "取数通道：%s" % mode,
        "取数时间：%s" % time.strftime("%Y-%m-%d %H:%M:%S"),
        "来源：https://www.kuaiduizuoye.com/kdtools/book/downloadanswer（App 接口）"
        if mode == "api" else
        "来源：https://m.kuaiduizuoye.com/bookid%s（网页端，只放前 3 页）" % book_id,
        "",
        "图片直链：",
    ]
    lines += ["  %02d. %s" % (i + 1, u) for i, u in enumerate(images)]
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")


# --------------------------------------------------------------------------- #
# 主流程
# --------------------------------------------------------------------------- #
def run_one(book_id, args, core, common, cuid):
    print("== bookId %s" % book_id)
    mode = args.mode
    name, total, images, used = None, 0, [], None

    if mode in ("api", "auto"):
        try:
            pairs = api_collect(book_id, core, common, cuid,
                                max_pages=args.max_pages, list_only=args.list, verbose=True)
            images = [u for _, u in pairs]
            used = "api"
            try:
                name, total, _ = web_collect(book_id, verbose=False)
            except Exception:
                pass
        except KdError as e:
            if mode == "api":
                raise
            print("  ! App 接口不可用：%s" % str(e).splitlines()[0])
            print("  ! 退回网页端（只能拿前 3 页）")
            mode = "web"

    if mode == "web" or used is None:
        name, total, images = web_collect(book_id)
        used = "web"
        if total and len(images) < total:
            print("  ! 网页端只放出 %d/%d 页；整本要用 App 接口（见 --bridge）"
                  % (len(images), total))

    name = safe_name(name or ("快对_" + book_id[:8]))
    print("  书名：%s" % name)
    print("  拿到 %d 页%s" % (len(images), ("／全书 %d 页" % total) if total else ""))

    if args.list:
        for i, u in enumerate(images):
            print("%02d\t%s" % (i + 1, u))
        return {"book": book_id, "name": name, "total": total,
                "images": images, "mode": used, "saved": None}

    if not images:
        raise KdError("没有拿到任何图片链接")

    book_dir = os.path.join(os.path.expanduser(args.out), name)
    os.makedirs(book_dir, exist_ok=True)
    saved = []
    width = max(2, len(str(len(images))))
    for i, u in enumerate(images):
        dst = os.path.join(book_dir, ("答案_第%0*d页.jpg" % (width, i + 1)))
        try:
            n = download(u, dst)
            saved.append(dst)
            print("  ✓ %s (%d KB)" % (os.path.basename(dst), n // 1024))
        except Exception as e:
            print("  ✗ 第 %d 页下载失败：%s" % (i + 1, e))

    write_info(os.path.join(book_dir, "信息.txt"), book_id, name, total, images, used)
    print("  已保存到 %s" % book_dir)

    pdf_path = None
    if args.pdf and saved:
        pdf_path = os.path.join(os.path.dirname(book_dir), name + ".pdf")
        make_pdf(saved, pdf_path)
        print("  PDF: %s" % pdf_path)

    return {"book": book_id, "name": name, "total": total, "images": images,
            "mode": used, "saved": book_dir, "pdf": pdf_path}


def main(argv=None):
    ap = argparse.ArgumentParser(
        description="拿快对整本教辅答案的全部页图片（App 接口 / 网页端保底）")
    ap.add_argument("--book", action="append", default=[], metavar="BOOKID",
                    help="32 位 bookId，可重复")
    ap.add_argument("--out", default="~/下载/快对答案", help="输出目录（默认 ~/下载/快对答案）")
    ap.add_argument("--pdf", action="store_true", help="额外合成 PDF")
    ap.add_argument("--list", action="store_true", help="只打印直链，不下载")
    ap.add_argument("--mode", choices=["auto", "api", "web"], default="auto",
                    help="auto=先试 App 接口，失败退回网页端（默认）")
    ap.add_argument("--bridge", default=None, metavar="URL",
                    help="真机签名桥地址，如 http://127.0.0.1:8710")
    ap.add_argument("--cuid", default=os.environ.get("KD_CUID", ""), help="设备 cuid")
    ap.add_argument("--max-pages", type=int, default=60, help="最多翻多少页（默认 60）")
    ap.add_argument("--so", default=os.environ.get("KD_SO"), help="libbaseutil.so 路径（模拟器用）")
    ap.add_argument("--cert", default=os.environ.get("KD_CERT"), help="签名证书 DER（模拟器用）")
    ap.add_argument("--common", action="append", default=[], metavar="k=v",
                    help="覆盖公共参数，可重复")
    a = ap.parse_args(argv)

    if not a.book:
        ap.error("至少给一个 --book <32位 bookId>")
    for b in a.book:
        if not BOOK_ID_RE.match(b):
            ap.error("bookId 必须是 32 位小写 hex：%s" % b)

    common = dict(kd_sign.DEFAULT_COMMON)
    for kv in a.common:
        if "=" not in kv:
            ap.error("--common 需要 k=v 形式：%s" % kv)
        k, v = kv.split("=", 1)
        common[k] = v
    cuid = a.cuid or common.get("cuid") or ("c" + format(int(time.time()), "x").rjust(12, "0"))

    core = None
    if a.mode in ("api", "auto"):
        try:
            if a.bridge:
                core = kd_sign.BridgeCore(a.bridge)
                core.health()
                print("签名源：真机桥 %s" % a.bridge)
            else:
                core = kd_sign.get_core("emu", so_path=a.so, cuid=cuid)
                print("签名源：libbaseutil.so 模拟器（实验性）")
        except Exception as e:
            if a.mode == "api":
                raise KdError("签名源初始化失败：%s" % e)
            print("! 签名源不可用（%s），本次走网页端" % e)
            a.mode = "web"

    results = []
    for b in a.book:
        try:
            results.append(run_one(b, a, core, common, cuid))
        except KdError as e:
            print("✗ %s：%s" % (b, e), file=sys.stderr)
            results.append({"book": b, "error": str(e)})
        print()

    ok = [r for r in results if "error" not in r]
    print("完成：%d/%d 本成功" % (len(ok), len(results)))
    for r in results:
        if "error" in r:
            print("  失败 %s：%s" % (r["book"], r["error"].splitlines()[0]))
    return 0 if ok else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KdError as e:
        print("错误：%s" % e, file=sys.stderr)
        sys.exit(2)
    except KeyboardInterrupt:
        sys.exit(130)
