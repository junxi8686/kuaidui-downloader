#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""快对答案导出器

把 kd_capture.js 抓到的日志（或 JSON）变成图片 + PDF。

用法：
    python3 kd_export.py --log kd_capture.log
    python3 kd_export.py --dumps ./dumps            # 一堆 .json
    python3 kd_export.py --json answers.json        # 单个 JSON
    python3 kd_export.py --log kd_capture.log --pdf --merge

输出默认在 ~/下载/快对答案/<书名>/ 下：答案_第01页.jpg … + 信息.txt；加 --pdf 再生成 <书名>.pdf。
"""

import argparse
import io
import json
import os
import re
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from urllib.request import Request, urlopen

UA = ("Mozilla/5.0 (Linux; Android 13; SM-X700) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126 Mobile Safari/537.36")

BAD_CHARS = re.compile(r'[\\/:*?"<>|\r\n\t]+')


def safe_name(s, fallback="kuaidui"):
    s = BAD_CHARS.sub("_", str(s or "")).replace("\u3000", " ").strip()
    s = re.sub(r"\s+", " ", s)[:80]
    return s or fallback


# ---------------- 解析抓包结果 ----------------

def iter_entries_from_log(path):
    """从 frida 日志里抠出 [KD] {...} 行"""
    with open(path, "r", encoding="utf-8", errors="ignore") as f:
        for line in f:
            i = line.find("[KD] {")
            if i < 0:
                continue
            payload = line[i + 5:].strip()
            try:
                yield json.loads(payload)
            except json.JSONDecodeError:
                continue


def iter_entries_from_json(path):
    with open(path, "r", encoding="utf-8", errors="ignore") as f:
        data = json.load(f)
    if isinstance(data, dict):
        data = [data]
    for item in data:
        if isinstance(item, dict) and item.get("images"):
            yield item


def iter_entries_from_dir(path):
    for name in sorted(os.listdir(path)):
        if not name.lower().endswith(".json"):
            continue
        try:
            for e in iter_entries_from_json(os.path.join(path, name)):
                yield e
        except Exception as exc:  # noqa: BLE001
            print(f"  跳过 {name}: {exc}", file=sys.stderr)


def collect(entries):
    """按 bookId 合并，同一本取页数最多的那份；不同来源取并集"""
    books = {}
    for e in entries:
        bid = (e.get("bookId") or "unknown").lower()
        imgs = [u for u in (e.get("images") or []) if u.startswith("http")]
        if not imgs:
            continue
        b = books.setdefault(bid, {"bookId": bid, "name": e.get("name") or "", "images": [],
                                   "pageCount": e.get("pageCount") or 0, "sources": set()})
        if e.get("name") and not b["name"]:
            b["name"] = e["name"]
        if e.get("pageCount"):
            b["pageCount"] = max(b["pageCount"], int(e["pageCount"]))
        if e.get("source"):
            b["sources"].add(str(e["source"]))
        for u in imgs:
            if u not in b["images"]:
                b["images"].append(u)
    return list(books.values())


# ---------------- 下载 ----------------

def fetch(url, retries=3):
    last = None
    for attempt in range(retries):
        try:
            req = Request(url, headers={"User-Agent": UA, "Referer": "https://m.kuaiduizuoye.com/"})
            with urlopen(req, timeout=45) as resp:
                data = resp.read()
            if data:
                return data
            last = RuntimeError("空响应")
        except Exception as exc:  # noqa: BLE001
            last = exc
    raise last or RuntimeError("下载失败")


def download_book(book, out_root, workers=8, pdf=False, force=False):
    name = safe_name(book["name"] or book["bookId"])
    folder = os.path.join(out_root, name)
    os.makedirs(folder, exist_ok=True)

    total = len(book["images"])
    print(f"\n▶ {name}  （{total} 页）")
    paths = [None] * total
    failed = []
    done = 0

    def one(idx):
        path = os.path.join(folder, f"答案_第{idx + 1:02d}页.jpg")
        if os.path.exists(path) and os.path.getsize(path) > 1024 and not force:
            return idx, path
        data = fetch(book["images"][idx])
        with open(path, "wb") as f:
            f.write(data)
        return idx, path

    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {pool.submit(one, i): i for i in range(total)}
        for fut in as_completed(futures):
            idx = futures[fut]
            try:
                _, path = fut.result()
                paths[idx] = path
            except Exception as exc:  # noqa: BLE001
                failed.append(idx + 1)
                print(f"   第 {idx + 1} 页失败：{exc}", file=sys.stderr)
            done += 1
            print(f"\r   {done}/{total}", end="", flush=True)
    print()

    info_path = os.path.join(folder, "信息.txt")
    with open(info_path, "w", encoding="utf-8") as f:
        f.write(f"书名：{book['name'] or '-'}\n")
        f.write(f"bookId：{book['bookId']}\n")
        f.write(f"官方页数：{book.get('pageCount') or '-'}\n")
        f.write(f"已下载：{len([p for p in paths if p])} 页\n")
        if failed:
            f.write(f"失败页：{','.join(map(str, failed))}\n")
        f.write(f"来源：抓包（{', '.join(sorted(book['sources'])) or 'kd_capture'})\n")
        f.write("抓取时间：" + __import__("datetime").datetime.now().strftime("%Y-%m-%d %H:%M:%S") + "\n")

    pdf_path = None
    if pdf:
        pdf_path = os.path.join(out_root, name + ".pdf")
        make_pdf([p for p in paths if p], pdf_path)
        print(f"   PDF → {pdf_path}")
    return folder, pdf_path, [p for p in paths if p]


def make_pdf(images, dest):
    from PIL import Image
    pages = []
    for p in images:
        try:
            im = Image.open(p)
            if im.mode != "RGB":
                im = im.convert("RGB")
            pages.append(im)
        except Exception as exc:  # noqa: BLE001
            print(f"   PDF 跳过 {p}: {exc}", file=sys.stderr)
    if not pages:
        return None
    pages[0].save(dest, "PDF", resolution=150.0, save_all=True, append_images=pages[1:])
    return dest


def main():
    ap = argparse.ArgumentParser(description="快对答案导出器")
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--log", help="frida 输出日志（含 [KD] 行）")
    src.add_argument("--dumps", help="存放抓包 JSON 的目录")
    src.add_argument("--json", help="单个抓包 JSON 文件")
    ap.add_argument("--out", default=os.path.expanduser("~/下载/快对答案"), help="输出目录")
    ap.add_argument("--pdf", action="store_true", help="同时生成 PDF")
    ap.add_argument("--merge", action="store_true", help="多本合并成一个 PDF（需 --pdf）")
    ap.add_argument("--workers", type=int, default=8, help="下载并发数")
    ap.add_argument("--force", action="store_true", help="覆盖已存在的图片")
    ap.add_argument("--list", action="store_true", help="只列出抓到的书，不下载")
    args = ap.parse_args()

    if args.log:
        entries = list(iter_entries_from_log(args.log))
    elif args.dumps:
        entries = list(iter_entries_from_dir(args.dumps))
    else:
        entries = list(iter_entries_from_json(args.json))

    if not entries:
        print("没找到可用的抓包数据。先在 App 里打开那本书的答案页翻一遍，让 kd_capture.js 抓到内容。",
              file=sys.stderr)
        return 2

    books = collect(entries)
    print(f"抓到 {len(books)} 本书：")
    for b in books:
        print(f"  - {b['name'] or b['bookId']}  页数 {len(b['images'])}/{b.get('pageCount') or '?'}")
    if args.list:
        return 0

    os.makedirs(args.out, exist_ok=True)
    all_images, pdfs = [], []
    for b in books:
        folder, pdf_path, images = download_book(b, args.out, args.workers, args.pdf, args.force)
        all_images.extend(images)
        if pdf_path:
            pdfs.append(pdf_path)
        print(f"   图片 → {folder}")

    if args.pdf and args.merge and all_images:
        dest = os.path.join(args.out, "快对答案_合并.pdf")
        make_pdf(all_images, dest)
        print(f"\n合并 PDF → {dest}")

    print(f"\n完成，输出目录：{args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
