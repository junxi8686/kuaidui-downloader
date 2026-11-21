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
    return sign_core_from_secret_md5(md5hex(secret), param_str)


def sign_core_from_secret_md5(secret_md5: str, param_str: str) -> str:
    """直接吃 md5(SECRET) 这 32 位 hex —— 离线的关键。

    SECRET 本身取不到，但公式里只用到它的 md5；只要从真机 hook 一次
    （app/kd_bridge.js 的 secretMd5()），以后任何参数都能纯 Python 签。
    """
    if not secret_md5 or len(secret_md5) != 32:
        raise ValueError("secret_md5 必须是 32 位 hex")
    return md5hex(f"{SIGN_PREFIX}[{secret_md5}]@{param_str}")


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
    """把业务参数 + 公共参数 + sign 拼成 query string。

    注意 sign 是**原样拼接**的：App 里 `Net.appendSign` 直接
        sb.append("&sign="); sb.append(str);
    而 str = "<core>&_t_=<秒>&kakorrhaphiophobia=<毫秒>"，所以 `_t_` 和
    `kakorrhaphiophobia` 会以**独立顶层参数**的形式出现在 URL 上
    （服务端缺了它们会回 5110）。这一点用 urlencode 编码 sign 会出错。
    """
    q = dict(pairs)
    if tips:
        q["__tips__"] = "1"     # HWNetwork.TIPS_PARAM，由 o.java 的 UrlRewriter 追加
    qs = urllib.parse.urlencode(q, quote_via=urllib.parse.quote)
    if sign:
        qs += "&sign=" + str(sign)
    return qs


# --------------------------------------------------------------------------- #
# signA（= nativeInitBaseUtil 的输出）的结构 —— 第二轮逆出来的
# --------------------------------------------------------------------------- #
# 明文是 4 段用 "##" 拼起来（.rodata 0x686d 的 "%s##%s##%s##%s"，在
# nativeInitBaseUtil 0xd64 处调用）：
#   1) "8&%d*"                常量
#   2) 10 位随机码            time(0)+clock() 种 srand48，循环 10 次 lrand48()%62
#                             查 .rodata 0x6eaa 的 A-Za-z0-9 表（0x3c6c）
#   3) md5(签名证书 DER 的 hex)   ← 已用真证书验证：md5(cert.der.hex()) 完全对上
#   4) cuid                  设备号原样
# 然后 DES(明文) → 再按「每 nibble 反转 4 位、低半字节在前」编码成 hex。
SIGA_PREFIX = "8&%d*"
SIGA_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"


def signa_plaintext(cuid, cert_der=None, cert_hex=None, nonce=None) -> str:
    """拼出 signA 的明文（DES 之前）。

    cert_der / cert_hex 二选一：APK 里的签名证书（META-INF/*.RSA 解出来的 X.509 DER）。
    nonce 不给就随机生成 10 位（真机就是这么做的）。
    """
    import random
    if cert_hex is None:
        if cert_der is None:
            raise ValueError("要给 cert_der 或 cert_hex")
        cert_hex = cert_der.hex()
    if nonce is None:
        nonce = "".join(random.choice(SIGA_ALPHABET) for _ in range(10))
    return f"{SIGA_PREFIX}##{nonce}##{md5hex(cert_hex)}##{cuid}"


def _rev4(n: int) -> int:
    """反转低 4 位：0b1011 -> 0b1101"""
    r = 0
    for i in range(4):
        if n >> i & 1:
            r |= 1 << (3 - i)
    return r


def signa_encode(blob: bytes) -> str:
    """signA 的最终编码：每个字节拆两个 nibble，各自反转 4 位、低半字节在前。

    已验证：仿真器里 56 字节密文 → 224 字符，和这里的输出逐字符相同。
    """
    out = []
    for b in blob:
        out.append("%02x%02x" % (_rev4(b & 0xF), _rev4((b >> 4) & 0xF)))
    return "".join(out)


def signa_decode(text: str) -> bytes:
    """signa_encode 的逆运算（拿到别人的 signA 想还原密文时用）。"""
    if len(text) % 4:
        raise ValueError("signA 长度应该是 4 的倍数")
    out = bytearray()
    for i in range(0, len(text), 4):
        lo = _rev4(int(text[i:i + 2], 16))
        hi = _rev4(int(text[i + 2:i + 4], 16))
        out.append(lo | (hi << 4))
    return bytes(out)


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


class LocalCore:
    """纯离线签名：只要一个 md5(SECRET)（32 位 hex），不需要设备、不需要 .so。

    这个值由 sign 公式决定，和 paramString 无关；拿到后可以长期复用
    （前提是服务端给该 cuid 的令牌没被换掉）。
    """

    def __init__(self, secret_md5=None, token_file=None, cuid=None):
        self.path = token_file or os.path.join(
            os.path.dirname(os.path.abspath(__file__)), "token.json")
        data = {}
        if secret_md5 is None and os.path.exists(self.path):
            try:
                data = json.load(open(self.path, encoding="utf-8"))
            except ValueError:
                data = {}
            secret_md5 = data.get("secret_md5") or data.get("md5_secret")
        if not secret_md5:
            raise RuntimeError(
                "没有 md5(SECRET)：先把真机的 %s 填进去（见 REVERSE.md §6.5.5）" % self.path)
        self.secret_md5 = secret_md5.strip()
        self.cuid = cuid or data.get("cuid") or ""

    def __call__(self, param_str: str) -> str:
        return sign_core_from_secret_md5(self.secret_md5, param_str)

    def sign(self, pairs) -> str:
        return sign_value(pairs, native_sign_core=self.__call__)


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
    if kind == "local":
        return LocalCore(**{k: v for k, v in kw.items()
                            if k in ("secret_md5", "token_file", "cuid")})
    raise ValueError(f"未知的 SignCore: {kind}")


def fetch_token(bridge="http://127.0.0.1:8710", token_file=None, cuid=None):
    """一次性握手：从真机桥取 md5(SECRET) 并写进 token.json。

    之后就可以 `LocalCore(token_file=...)` 纯离线签名，不再需要设备。
    """
    br = BridgeCore(bridge)
    info = br.health()
    secret_md5 = info.get("secret_md5")
    if not secret_md5:
        res = br._post("/secret", {})
        secret_md5 = (res or {}).get("secret_md5")
    if not secret_md5:
        raise RuntimeError("桥没有返回 secret_md5：确认 kd_bridge.js 是新版且 App 已完成握手")
    path = token_file or os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "token.json")
    payload = {"secret_md5": secret_md5,
               "cuid": cuid or info.get("cuid") or "",
               "fetched_at": time.strftime("%Y-%m-%d %H:%M:%S")}
    with open(path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    return payload


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
