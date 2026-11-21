# mitmproxy addon：把 App 取答案图（CDN 上的 scanimg）的请求记下来
#
#   mitmdump -p 8080 -s harvest_addon.py --set confdir=/tmp/mitm
#
# App 会把 RC4 密文里的地址解出来再去取图，所以这里看到的就是明文地址。
import json
import os

OUT = "/tmp/mitm/harvest.jsonl"

def request(flow):
    url = flow.request.pretty_url
    if "scanimg" not in url:
        return
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    rec = {"url": url, "book": flow.request.headers.get("x-kd-book", ""), "ts": flow.request.timestamp_start}
    with open(OUT, "a", encoding="utf-8") as f:
        f.write(json.dumps(rec, ensure_ascii=False) + "\n")
