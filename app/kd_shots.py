#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""无 root 兜底：adb 截图翻页，把 App 里的答案页存成图片/PDF

不需要 root、不需要 frida，只要有 adb。缺点是拿到的是屏幕分辨率（不如原图清晰）。

用法：
    python3 kd_shots.py --out ~/下载/快对答案截图             # 默认翻 30 页
    python3 kd_shots.py --pages 60 --dy 0.72 --pdf
    python3 kd_shots.py --mode swipe --dy -900               # 反向翻（上一页/下一页方向不对时）

流程：先手动把 App 停在答案第 1 页，然后按提示回车开始。
"""

import argparse
import hashlib
import os
import subprocess
import sys
import time


def adb(*args, binary=False, timeout=60):
    cmd = ["adb"] + list(args)
    out = subprocess.run(cmd, capture_output=True, timeout=timeout)
    if out.returncode != 0 and not binary:
        raise RuntimeError(out.stderr.decode("utf-8", "ignore").strip() or "adb 执行失败")
    return out.stdout


def screen_size():
    raw = adb("shell", "wm", "size").decode("utf-8", "ignore")
    for line in raw.splitlines():
        if "size:" in line:
            size = line.split("size:")[-1].strip().split()[0]
            w, h = size.split("x")
            return int(w), int(h)
    return 1080, 1920


def tap(x, y):
    adb("shell", "input", "tap", str(x), str(y))


def swipe(x1, y1, x2, y2, ms):
    adb("shell", "input", "swipe", str(x1), str(y1), str(x2), str(y2), str(ms))


def screenshot():
    return adb("exec-out", "screencap", "-p", binary=True)


def main():
    ap = argparse.ArgumentParser(description="快对答案截图导出（无 root 兜底）")
    ap.add_argument("--out", default=os.path.expanduser("~/下载/快对答案截图"))
    ap.add_argument("--pages", type=int, default=30, help="最多截多少页")
    ap.add_argument("--dy", type=float, default=0.72, help="每次滑动高度占屏高比例（负值反向）")
    ap.add_argument("--wait", type=float, default=0.9, help="滑动后等待秒数")
    ap.add_argument("--pdf", action="store_true", help="截完合成 PDF")
    ap.add_argument("--yes", action="store_true", help="不等回车直接开始")
    args = ap.parse_args()

    os.makedirs(args.out, exist_ok=True)
    w, h = screen_size()
    print(f"屏幕 {w}x{h}，输出到 {args.out}")

    if not args.yes:
        input("先把 App 停在答案第 1 页，然后回车开始…")

    seen = set()
    saved = 0
    prev = None
    for i in range(1, args.pages + 1):
        png = screenshot()
        digest = hashlib.md5(png).hexdigest()
        if digest in seen:
            print(f"  第 {i} 页：和前面重复，可能已经到底，停止")
            break
        seen.add(digest)
        # 去掉顶部状态栏，避免时间/电量变化干扰
        path = os.path.join(args.out, f"截图_第{i:02d}页.png")
        with open(path, "wb") as f:
            f.write(png)
        saved += 1
        print(f"\r  已存 {saved} 页", end="", flush=True)

        cx = w // 2
        y1 = int(h * 0.78)
        y2 = int(y1 - h * abs(args.dy)) if args.dy > 0 else int(y1 + h * abs(args.dy))
        if args.dy > 0:
            swipe(cx, y1, cx, y2, 320)     # 上滑 = 下一页
        else:
            swipe(cx, int(h * 0.3), cx, int(h * 0.3 + h * abs(args.dy)), 320)
        time.sleep(args.wait)

    print()
    if args.pdf and saved:
        from PIL import Image
        files = sorted(os.path.join(args.out, f) for f in os.listdir(args.out)
                       if f.endswith(".png") and f.startswith("截图_"))
        pages = []
        for p in files:
            im = Image.open(p)
            if im.mode != "RGB":
                im = im.convert("RGB")
            pages.append(im)
        dest = os.path.join(args.out, "快对答案截图.pdf")
        pages[0].save(dest, "PDF", resolution=200.0, save_all=True, append_images=pages[1:])
        print(f"PDF → {dest}")
    print(f"共 {saved} 张，目录：{args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
