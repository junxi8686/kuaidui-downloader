#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""一次性取密钥：secret_md5 + cuid

前置：设备侧跑着 `frida -U -f com.kuaiduizuoye.scan -l kd_bridge.js`，
      本机跑着 `python3 kd_bridge_server.py --port 8710`。

用法：
    python3 kd_secret.py                      # 打印并写入 token.json
    python3 kd_secret.py --bridge http://127.0.0.1:8710 --out token.json

拿到这两个值之后，浏览器插件里填一次（弹窗 → 整本答案 · 本地密钥），
以后就能纯本地签名下载整本，不再需要设备。
"""

import argparse
import json
import sys
import urllib.request


def call(base, path, timeout=15):
    req = urllib.request.Request(base + path, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())


def main():
    ap = argparse.ArgumentParser(description="从本地桥取 secret_md5 / cuid")
    ap.add_argument("--bridge", default="http://127.0.0.1:8710")
    ap.add_argument("--out", default="token.json")
    args = ap.parse_args()
    base = args.bridge.rstrip("/")

    try:
        health = call(base, "/health")
    except Exception as exc:  # noqa: BLE001
        print(f"连不上桥（{base}）：{exc}", file=sys.stderr)
        print("先确认设备侧 frida 在跑、本机 kd_bridge_server.py 已启动。", file=sys.stderr)
        return 1

    cuid = health.get("cuid") or ""
    print(f"桥状态：ok={health.get('ok')} ready={health.get('ready')} cuid={cuid or '(空)'}")
    if not health.get("ready"):
        print("桥还没就绪：先在 App 里随便打开一本书，让它完成 antispam 握手，再重跑本脚本。", file=sys.stderr)
        return 2

    data = call(base, "/secret")
    secret = (data.get("secret_md5") or "").lower()
    if len(secret) != 32:
        print(f"拿到的 secret_md5 不合法：{secret!r}", file=sys.stderr)
        return 3

    out = {"secret_md5": secret, "cuid": cuid}
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)

    print("\n取到了，把下面两个值填进插件弹窗（整本答案 · 本地密钥）：\n")
    print(f"  secret_md5 : {secret}")
    print(f"  cuid       : {cuid}")
    print(f"\n也已写入 {args.out}")
    print("填好保存后，打开任意书本页，面板会出现「下载全书（N 页 · 本地签名）」。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
