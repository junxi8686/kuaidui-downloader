#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""kd_bridge_server.py —— 本地签名桥。

背景：快对 App 的 `sign` 参数由 libbaseutil.so 的 native 方法产生，且必须先跟
`/pluto/app/antispam` 完成一次 signA/signB 握手（详见 REVERSE.md）。如果手上有一台
能跑快对的安卓设备（真机 / Waydroid / 模拟器，root + frida），最省事、最可靠的做法
是「让 App 自己算」：用 frida 把 com.zuoyebang.baseutil.a.a(List) 暴露成 RPC，
再由这个小 HTTP 服务转给浏览器/脚本用。

启动::

    # 1) 设备上跑 frida-server，然后
    frida -U -f com.kuaiduizuoye.scan -l kd_bridge.js
    # 2) 本机起桥
    python3 kd_bridge_server.py --port 8710
    # 3) 调用
    curl -s localhost:8710/health
    curl -s -XPOST localhost:8710/sign -d '{"pairs":["bookId=xxx","pageNo=0","appId=scancode"]}'

协议（给浏览器扩展用，CORS 全开）
---------------------------------
GET  /health                      -> {"ok":true,"ready":bool,"cuid":"..."}
GET  /init                        -> {"ok":true,"ready":bool,"signA":"..."}   （触发 antispam 握手）
POST /sign        {"pairs":[...]} -> {"ok":true,"sign":"<core>&_t_=..&kakorrhaphiophobia=.."}
                                     等价 baseutil.a.a(List<String>)，Java 内部自己补 _t_ / kak
POST /sign_raw    {"param":"b64"} -> {"ok":true,"sign":"<32位>"}  等价 nativeGetSign(String)
POST /downloadanswer {"bookId":"..","pageNo":0}
                                  -> {"ok":true,"imageUrl":"..."}  （顺手代理一次业务请求）
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import threading
import time
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import kd_sign  # noqa: E402


class FridaClient:
    """极简 frida RPC 客户端：用 frida CLI 的 ptrace 模式太重，这里直接跑
    `frida -U -l kd_bridge.js -q --runtime=v8 target` 太重也不适合常驻。

    实际部署时推荐 frida-python：``pip install frida``，然后用
    ``frida.get_usb_device().attach(...)``。没装 frida 时本类给出清晰报错，
    也可以把 sdk 目录里的 kd_agent.js 交给别的宿主（Objection 等）后自己转发。
    """

    def __init__(self, target="com.kuaiduizuoye.scan", script_path=None):
        self.target = target
        self.script_path = script_path or os.path.join(
            os.path.dirname(os.path.abspath(__file__)), "kd_bridge.js")
        self.session = None
        self.script = None
        self._lock = threading.Lock()

    def connect(self):
        try:
            import frida
        except ImportError:
            raise RuntimeError("没装 frida-python：pip install frida（本机调试也可以 "
                               "用 `frida -U -f %s -l kd_bridge.js` 后自己转发）" % self.target)
        dev = frida.get_usb_device(timeout=10)
        self.session = dev.attach(self.target)
        src = open(self.script_path, encoding="utf-8").read()
        self.script = self.session.create_script(src)
        self.script.on("message", lambda m, d: None)
        self.script.load()
        return self

    def call(self, method, *args):
        with self._lock:
            if self.script is None:
                self.connect()
            return self.script.exports_sync.__getattr__(method)(*args)


class Agent:
    """把桥的几种调用映射到 frida 导出的方法；桥没连上时给出统一错误。"""

    def __init__(self, client=None, cuid=None):
        self.client = client
        self.cuid = cuid
        self.last_error = None

    def _call(self, method, *args):
        if self.client is None:
            raise RuntimeError("frida 未连接（-U 设备没插 / App 没起 / frida-server 没跑）")
        try:
            return self.client.call(method, *args)
        except Exception as e:
            self.last_error = str(e)
            raise

    def health(self):
        info = {"ok": True, "ready": False, "cuid": self.cuid}
        try:
            info.update(self._call("state") or {})
            try:
                info["secret_md5"] = self._call("secretMd5")
            except Exception:
                pass
        except Exception as e:
            info["error"] = str(e)
        return info

    def init(self):
        return {"ok": True, "ready": bool(self._call("initToken"))}

    def sign(self, pairs):
        return {"ok": True, "sign": self._call("sign", pairs)}

    def sign_raw(self, param):
        return {"ok": True, "sign": self._call("signRaw", param)}

    def secret(self):
        """md5(SECRET) —— 拿到它就能纯离线签名，见 REVERSE.md §6.5.5。"""
        return {"ok": True, "secret_md5": self._call("secretMd5")}


class Handler(BaseHTTPRequestHandler):
    server_version = "kd-bridge/1.0"
    agent: Agent = None
    verbose = False

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Max-Age", "86400")

    def _json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        try:
            if u.path == "/health":
                return self._json(self.agent.health())
            if u.path == "/init":
                return self._json(self.agent.init())
            if u.path == "/secret":
                return self._json(self.agent.secret())
            if u.path == "/sign":
                # 便于浏览器直接 GET：?pairs=bookId=x&pageNo=0（会按 & 切开）
                q = urllib.parse.parse_qs(u.query, keep_blank_values=True)
                pairs = [p for p in q.get("pairs", [])]
                if not pairs and u.query:
                    pairs = [seg for seg in u.query.split("&") if "=" in seg]
                return self._json(self.agent.sign(pairs))
            if u.path == "/sign_raw":
                q = urllib.parse.parse_qs(u.query)
                return self._json(self.agent.sign_raw((q.get("param") or [""])[0]))
            return self._json({"ok": False, "error": "未知路径 %s" % u.path}, 404)
        except Exception as e:
            return self._json({"ok": False, "error": str(e)}, 500)

    def do_POST(self):
        u = urllib.parse.urlparse(self.path)
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n) if n else b""
        try:
            payload = json.loads(raw or b"{}")
        except ValueError:
            payload = {k: v[0] for k, v in urllib.parse.parse_qs(raw.decode()).items()}
        try:
            if u.path == "/sign":
                return self._json(self.agent.sign(payload.get("pairs") or []))
            if u.path == "/sign_raw":
                return self._json(self.agent.sign_raw(payload.get("param") or ""))
            if u.path == "/secret":
                return self._json(self.agent.secret())
            if u.path == "/init":
                return self._json(self.agent.init())
            if u.path == "/downloadanswer":
                return self._json(proxy_downloadanswer(
                    payload.get("bookId") or "", int(payload.get("pageNo") or 0),
                    self.agent))
            return self._json({"ok": False, "error": "未知路径 %s" % u.path}, 404)
        except Exception as e:
            return self._json({"ok": False, "error": str(e)}, 500)

    def log_message(self, fmt, *args):
        if self.verbose:
            sys.stderr.write("%s - %s\n" % (time.strftime("%H:%M:%S"), fmt % args))


def proxy_downloadanswer(book_id, page_no, agent, common=None):
    """顺手把业务请求也代理掉：浏览器扩展就不用自己拼签名。"""
    common = dict(common or kd_sign.DEFAULT_COMMON)
    common.update({"bookId": book_id, "pageNo": page_no,
                   "cuid": agent.cuid or "bridge"})
    sign = agent.sign([f"{k}={v}" for k, v in common.items()])["sign"]
    q = kd_sign.build_query(common, sign=sign, tips=True)
    url = "https://www.kuaiduizuoye.com/kdtools/book/downloadanswer?" + q
    req = urllib.request.Request(
        url, data=urllib.parse.urlencode({"bookId": book_id, "pageNo": page_no}).encode(),
        headers={"User-Agent": "kuaiduizuoye/5.14.0 (Linux; Android 13)",
                 "Content-Type": "application/x-www-form-urlencoded"})
    body = urllib.request.urlopen(req, timeout=30).read().decode("utf-8", "replace")
    j = json.loads(body)
    if j.get("errNo") not in (0, 200):
        return {"ok": False, "errNo": j.get("errNo"), "errstr": j.get("errstr"), "raw": body[:400]}
    return {"ok": True, "imageUrl": (j.get("data") or {}).get("imageUrl", "")}


def main():
    ap = argparse.ArgumentParser(description="快对签名桥（frida RPC → 本地 HTTP）")
    ap.add_argument("--port", type=int, default=8710)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--target", default="com.kuaiduizuoye.scan")
    ap.add_argument("--cuid", default=os.environ.get("KD_CUID"))
    ap.add_argument("--no-attach", action="store_true",
                    help="只起 HTTP 服务，不自动连 frida（App 还没起时用）")
    ap.add_argument("-v", "--verbose", action="store_true")
    a = ap.parse_args()

    client = None
    if not a.no_attach:
        client = FridaClient(target=a.target)
        try:
            client.connect()
            print("[bridge] 已挂上 %s" % a.target)
        except Exception as e:
            print("[bridge] 挂 frida 失败：%s" % e)
            print("[bridge] HTTP 服务照常起，调用 /sign 时会再试")
            client = None

    Handler.agent = Agent(client=client, cuid=a.cuid)
    Handler.verbose = a.verbose
    srv = ThreadingHTTPServer((a.host, a.port), Handler)
    print("[bridge] http://%s:%d  (GET /health, POST /sign, POST /sign_raw, "
          "POST /downloadanswer)" % (a.host, a.port))
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n[bridge] bye")


if __name__ == "__main__":
    main()
