#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""快对（com.kuaiduizuoye.scan）请求签名模块 —— 逆向结论的代码化。

这里只实现**已经用证据确认过**的几层（证据见 REVERSE.md 的「签名链路」一节）：

  1. paramString = Base64_NO_WRAP( "".join(sorted(["k=v", ...])) )
     —— 对应反编译的 com/zuoyebang/baseutil/a.java:131-136：
        list.add("_t_=<秒>"); list.add("kakorrhaphiophobia=<毫秒>");
        Collections.sort(list); TextUtils.join("", list)   ← 注意没有分隔符

  2. sign_core = nativeGetSign(paramString)
     从 libbaseutil.so 反汇编 + 运行时追踪确认的形态：
        sprintf(buf, "%s[%s]@%s", "8&%d*", md5hex(SECRET), paramString)
        sign_core = md5hex(buf)
     其中 "8&%d*" 是 .rodata 0x687c 附近的常量（运行时从 libbaseutil+0xa0dc 读取，
     已在模拟器里实测到该字符串作为 asprintf 的第 1 个参数）。

  3. HTTP 上真正带的 sign 参数值不是 sign_core 本身：
        sign = sign_core + "&_t_=<秒>" + "&kakorrhaphiophobia=<毫秒>"
     —— com/zuoyebang/baseutil/a.java:140

  4. SECRET（上面的 md5hex(SECRET)）不是常量：它由
        nativeInitBaseUtil(context, cuid)  → signA
        POST /pluto/app/antispam?data=signA → signB
        nativeSetToken(context, cuid, signA, signB) → 内部生成 SECRET
     三步握手后才存在。所以纯算法复刻必须有办法跑 nativeSetToken。
     本模块把这个能力抽象成 SignCore，附两种实现：
        BridgeCore —— 连一台真机/模拟器上的 frida RPC（app/kd_bridge.js）
        EmuCore    —— 用 unicorn 跑 libbaseutil.so（实验性，见 kd_native_emu.py）
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import time
import urllib.parse
import urllib.request

# libbaseutil.so 里 nativeGetSign 拼串用的固定前缀（.rodata 偏移 0x687c 处）
SIGN_PREFIX = "8&%d*"

# 快对 App 的网络公共参数（com/kuaiduizuoye/scan/base/h.java: e() + Net.init）
APP_ID = "scancode"          # base/e.java:14  a() -> "scancode"
PKG_NAME = "com.kuaiduizuoye.scan"

DEFAULT_COMMON = {
    "appId": APP_ID,
    "pkgName": PKG_NAME,
    "os": "android",
    "sdk": "33",
    "vc": "5140",
    "vcname": "5.14.0",
    "channel": "APKPure",
    "device": "SM-G986B",
    "brand": "samsung",
    "osVersion": "13",
    "abis": "1",
    "appBit": "64",
    "operatorid": "0",
    "province": "",
    "city": "",
    "area": "",
}


# --------------------------------------------------------------------------- #
# 第 1 层：paramString
# --------------------------------------------------------------------------- #
def param_string(pairs) -> str:
    """把 "k=v" 列表按字典序排序、无缝拼接、再 Base64(NO_WRAP)。

    pairs 可以是 dict 或 [(k, v), ...]；None/空值的项会被跳过（和 Java 侧一致：
    COMMON_PARAMS 里只会塞入非空值）。
    """
    if isinstance(pairs, dict):
        items = [f"{k}={v}" for k, v in pairs.items() if v is not None]
    else:
        items = [f"{k}={v}" for k, v in pairs if v is not None]
    joined = "".join(sorted(items))
    return base64.b64encode(joined.encode("utf-8")).decode("ascii")


def md5hex(s) -> str:
    if isinstance(s, str):
        s = s.encode("utf-8")
    return hashlib.md5(s).hexdigest()


# --------------------------------------------------------------------------- #
# 第 2/3 层：签名值组装
# --------------------------------------------------------------------------- #
def sign_core_from_secret(secret: str, param_str: str) -> str:
    """sign_core = md5( "8&%d*[" + md5hex(SECRET) + "]@" + paramString )"""
    buf = f"{SIGN_PREFIX}[{md5hex(secret)}]@{param_str}"
    return md5hex(buf)


def sign_value(pairs, t_seconds=None, kak_ms=None, native_sign_core=None) -> str:
    """本地复算：返回要放进 URL 的 sign 参数**值**。

    native_sign_core(paramString) -> sign_core。
    这就是 com/zuoyebang/baseutil/a.java:131-140 的完整等价实现。
    """
    t = int(time.time()) if t_seconds is None else int(t_seconds)
    kak = int(time.time() * 1000) if kak_ms is None else int(kak_ms)
    full = list(pairs.items()) if isinstance(pairs, dict) else list(pairs)
    full += [("_t_", t), ("kakorrhaphiophobia", kak)]
    ps = param_string(full)
    core = native_sign_core(ps)
    return f"{core}&_t_={t}&kakorrhaphiophobia={kak}"


def build_query(pairs, sign=None, tips=True) -> str:
    """把业务参数 + 公共参数 + sign 拼成 query string（顺序按传入 dict）。"""
    q = dict(pairs)
    if sign:
        q["sign"] = sign
    if tips:
        q["__tips__"] = "1"     # HWNetwork.TIPS_PARAM，由 o.java 的 UrlRewriter 追加
    return urllib.parse.urlencode(q, quote_via=urllib.parse.quote)


# --------------------------------------------------------------------------- #
# SignCore 实现
# --------------------------------------------------------------------------- #
class BridgeCore:
    """通过本地桥（app/kd_bridge_server.py ← frida → 真机 App）取签名。"""

    def __init__(self, base="http://127.0.0.1:8710", timeout=20):
        self.base = base.rstrip("/")
        self.timeout = timeout

    def _post(self, path, payload):
        req = urllib.request.Request(
            self.base + path,
            data=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=self.timeout) as r:
            return json.loads(r.read().decode())

    def health(self):
        with urllib.request.urlopen(self.base + "/health", timeout=self.timeout) as r:
            return json.loads(r.read().decode())

    def init_token(self, cuid=None):
        return self._post("/init", {"cuid": cuid})

    def __call__(self, param_str: str) -> str:
        """只算 sign_core（等价 nativeGetSign(paramString)）。"""
        res = self._post("/sign_raw", {"param": param_str})
        if not res.get("ok"):
            raise RuntimeError(f"桥返回失败: {res}")
        return res["sign"]

    def sign(self, pairs) -> str:
        """让 App 自己算：把 "k=v" 列表交给 baseutil.a.a(List)，它内部会补
        _t_ / kakorrhaphiophobia 并返回 "<core>&_t_=..&kakorrhaphiophobia=.."。"""
        items = [f"{k}={v}" for k, v in (pairs.items() if isinstance(pairs, dict) else pairs)
                 if v is not None]
        res = self._post("/sign", {"pairs": items})
        if not res.get("ok"):
            raise RuntimeError(f"桥返回失败: {res}")
        return res["sign"]


class EmuCore:
    """用 unicorn 直接跑 libbaseutil.so（实验性）。

    注意：nativeGetSign 依赖 nativeSetToken 建立的状态，而 nativeSetToken 又依赖
    /pluto/app/antispam 下发的 signB。这条链路目前已能在模拟器里跑通到「产出 sign」，
    但服务端对 signA 的校验没有通过（errNo 7 antispam data error），所以这个 core
    目前只适合做研究/对照，不能当生产签名源。详见 REVERSE.md。
    """

    def __init__(self, so_path=None, cuid=None):
        from kd_native_emu import KDSo        # 同目录
        self.so = KDSo(so_path=so_path)
        self.cuid = cuid or self.so.default_cuid()
        self._ready = False

    def _ensure(self):
        if self._ready:
            return
        self.signA = self.so.init_baseutil(self.cuid)
        self.signB = self.so.request_signB(self.cuid, self.signA)
        ok = self.so.set_token(self.cuid, self.signA, self.signB)
        if not ok:
            raise RuntimeError("nativeSetToken 校验失败（signA/signB 不被 so 接受）")
        self._ready = True

    def __call__(self, param_str: str) -> str:
        self._ensure()
        return self.so.get_sign(param_str)

    def sign(self, pairs) -> str:
        self._ensure()
        return sign_value(pairs, native_sign_core=self.__call__)


def get_core(kind="bridge", **kw):
    if kind == "bridge":
        return BridgeCore(kw.get("base", "http://127.0.0.1:8710"))
    if kind == "emu":
        return EmuCore(**{k: v for k, v in kw.items() if k in ("so_path", "cuid")})
    raise ValueError(f"未知的 SignCore: {kind}")


if __name__ == "__main__":
    import sys
    if len(sys.argv) > 1:
        print(param_string({"_t_": sys.argv[1], "abc": "1"}))
    else:
        demo_pairs = {"bookId": "cee9bcf902dcb3ba990f58d7b7d82efe", "pageNo": 0}
        print("paramString =", param_string({**DEFAULT_COMMON, **demo_pairs,
                                             "_t_": 1700000000,
                                             "kakorrhaphiophobia": 123456}))
        print("md5hex('abc') =", md5hex("abc"))
