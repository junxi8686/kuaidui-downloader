#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""翻页收割：App 里翻一遍，把答案原图直链收下来

背景：整本答案的接口能调通（见 REVERSE.md §9），但响应里的 imageUrl 是 RC4 密文，
密钥来自 nativeGetKey，目前没有离线复现出来。绕开它的办法是——让 App 自己解密：

    App 解密后去 CDN 取图 → 那个 GET 请求里就是明文的 scanimg 地址

所以只要在 App 翻页时抓一次包，就能把整本原图收齐。不需要 frida，也不需要改 App。

用法
----
1) 设备侧（一次性）：把 mitmproxy 的 CA 装进系统证书、挂上代理
       python3 kd_harvest.py --setup          # 自动做完这两步（需要 root）
2) 本机起抓包
       mitmdump -p 8080 -s harvest_addon.py --set confdir=/tmp/mitm
3) 在 App 里打开那本书，从第 1 页翻到最后一页
4) 收工导出
       python3 kd_harvest.py --out ~/下载/快对答案 --pdf

抓到的地址会写在 /tmp/mitm/harvest.jsonl，一行一个。
"""

import argparse
import json
import os
import re
import subprocess
import sys
import time
from urllib.request import Request, urlopen

UA = "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/126 Mobile Safari/537.36"
CACHE = "/tmp/mitm/harvest.jsonl"


def adb(*args, **kw):
    return subprocess.run(["adb"] + list(args), capture_output=True, text=True, **kw)


def su(cmd, timeout=60):
    return subprocess.run(["adb", "shell", f"su -c '{cmd}'"], capture_output=True, text=True, timeout=timeout)


def do_setup(cert_pem, host, port):
    """把 CA 装成系统证书 + 设置全局代理"""
    h = subprocess.run(["openssl", "x509", "-inform", "PEM", "-subject_hash_old", "-in", cert_pem],
                       capture_output=True, text=True).stdout.split("\n")[0].strip()
    if not h:
        sys.exit("算不出证书 hash，检查 --cert 路径")
    local = f"/tmp/{h}.0"
    with open(local, "wb") as f:
        f.write(open(cert_pem, "rb").read())
    print(f"证书 hash: {h}")
    adb("push", local, "/data/local/tmp/")
    print(su(f"mount -o rw,remount /system 2>/dev/null || mount -o rw,remount / 2>/dev/null; "
             f"cp /data/local/tmp/{h}.0 /system/etc/security/cacerts/{h}.0 && "
             f"chmod 644 /system/etc/security/cacerts/{h}.0 && chown root:root /system/etc/security/cacerts/{h}.0").stdout)
    adb("shell", "settings", "put", "global", "http_proxy", f"{host}:{port}")
    print(f"代理已设为 {host}:{port}")
    print("现在启动 mitmdump，然后在 App 里翻页。")


def collect():
    if not os.path.exists(CACHE):
        return []
    seen, out = set(), []
    for line in open(CACHE, encoding="utf-8", errors="ignore"):
        try:
            rec = json.loads(line)
        except ValueError:
            continue
        u = rec.get("url", "")
        m = re.search(r"/scanimg/(scan_[0-9a-f]+\.jpg)", u)
        if not m or m.group(1) in seen:
            continue
        seen.add(m.group(1))
        out.append(rec)
    return out


def strip_query(url):
    return url.split("?")[0]


def download(url, path, retries=3):
    for i in range(retries):
        try:
            req = Request(url, headers={"User-Agent": UA, "Referer": "https://kd-book.cdnjtzy.com/"})
            with urlopen(req, timeout=45) as r:
                data = r.read()
            if data:
                open(path, "wb").write(data)
                return len(data)
        except Exception:
            time.sleep(0.6 * (i + 1))
    return 0


def main():
    ap = argparse.ArgumentParser(description="翻页收割：抓 App 解密后的答案图直链")
    ap.add_argument("--setup", action="store_true", help="自动装 CA + 设代理（需要 root）")
    ap.add_argument("--cert", default="/tmp/mitm/mitmproxy-ca-cert.pem")
    ap.add_argument("--host", default="192.168.240.1")
    ap.add_argument("--port", default="8080")
    ap.add_argument("--list", action="store_true", help="只列出抓到的页，不下载")
    ap.add_argument("--out", default=os.path.expanduser("~/下载/快对答案"))
    ap.add_argument("--pdf", action="store_true")
    args = ap.parse_args()

    if args.setup:
        return do_setup(args.cert, args.host, args.port)

    recs = collect()
    if not recs:
        sys.exit(f"没抓到东西：{CACHE} 为空。先按 --setup 装好证书和代理，再在 App 里翻页。")

    print(f"抓到 {len(recs)} 张答案图：")
    by_book = {}
    for r in recs:
        book = r.get("book") or "unknown"
        by_book.setdefault(book, []).append(r)

    for book, items in by_book.items():
        print(f"\n▶ {book}  {len(items)} 页")
        for i, it in enumerate(items, 1):
            print(f"   {i:02d}  {strip_query(it['url']).split('/')[-1]}")
        if args.list:
            continue

        folder = os.path.join(args.out, re.sub(r'[\\/:*?"<>|]+', "_", book)[:80])
        os.makedirs(folder, exist_ok=True)
        paths = []
        for i, it in enumerate(items, 1):
            p = os.path.join(folder, f"答案_第{i:02d}页.jpg")
            if os.path.exists(p) and os.path.getsize(p) > 1024:
                paths.append(p)
                continue
            n = download(strip_query(it["url"]), p)
            print(f"   {i:02d} -> {'OK ' + str(n // 1024) + 'KB' if n else '失败'}")
            if n:
                paths.append(p)
        print(f"   图片目录：{folder}")

        if args.pdf and paths:
            from PIL import Image
            pages = []
            for p in paths:
                im = Image.open(p)
                pages.append(im.convert("RGB") if im.mode != "RGB" else im)
            dest = os.path.join(args.out, re.sub(r'[\\/:*?"<>|]+', "_", book)[:80] + ".pdf")
            pages[0].save(dest, "PDF", resolution=150.0, save_all=True, append_images=pages[1:])
            print(f"   PDF：{dest}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
