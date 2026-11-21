#!/usr/bin/env bash
# 一键：把 frida-server 推进设备/模拟器，起好，挂上快对，开始抓答案。
#
#   ./run_capture.sh                 # 默认输出 kd_capture.log
#   ./run_capture.sh out.log         # 指定日志
#   ABI=arm64-v8a ./run_capture.sh   # 手动指定架构
#
# 需要：adb 通路（真机 USB 调试 / Waydroid 网络 adb），设备已 root。
set -euo pipefail

PKG="com.kuaiduizuoye.scan"
OUT="${1:-kd_capture.log}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMPDIR_LOCAL="${TMPDIR:-/tmp}/kd-frida"

say() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$*"; }

# ---------- 1. 设备 ----------
say "查找设备"
if ! adb get-state >/dev/null 2>&1; then
  if command -v waydroid >/dev/null 2>&1 && waydroid status 2>/dev/null | grep -q RUNNING; then
    IP=$(waydroid status 2>/dev/null | awk -F':\t' '/IP address/{print $2}' | tr -d ' ')
    say "检测到 Waydroid（$IP），尝试网络 adb"
    adb connect "${IP}:5555" >/dev/null 2>&1 || true
    sleep 2
  fi
fi

if ! adb get-state >/dev/null 2>&1; then
  cat <<'EOF'
没有可用的 adb 设备。两条路：
  1) Waydroid：先开 adbd，再重跑本脚本
       sudo waydroid shell setprop service.adb.tcp.port 5555
       sudo waydroid shell stop adbd
       sudo waydroid shell start adbd
       adb connect 192.168.240.112:5555
  2) 真机：打开「开发者选项 → USB 调试」，插上数据线，adb devices 能看到就行。
EOF
  exit 1
fi
adb devices | sed -n '2,10p'

ABI="${ABI:-$(adb shell getprop ro.product.cpu.abi 2>/dev/null | tr -d '\r')}"
say "设备架构：$ABI"

# ---------- 2. root ----------
ROOT_CMD=""
if adb shell id 2>/dev/null | grep -q "uid=0"; then
  ROOT_CMD=""
elif adb root >/dev/null 2>&1 && adb wait-for-device && adb shell id 2>/dev/null | grep -q "uid=0"; then
  ROOT_CMD=""
elif adb shell "su -c id" 2>/dev/null | grep -q "uid=0"; then
  ROOT_CMD="su -c"
else
  warn "拿不到 root，frida-server 起不来。Waydroid 用 sudo waydroid shell；真机请 Magisk/KernelSU 授权 adb shell 的 su。"
  exit 1
fi

run_root() {
  if [ -z "$ROOT_CMD" ]; then
    adb shell "$@"
  else
    adb shell "su -c '$*'"
  fi
}

# ---------- 3. frida-server ----------
mkdir -p "$TMPDIR_LOCAL"
BIN="$TMPDIR_LOCAL/frida-server-$ABI"

if ! adb shell "ps -A 2>/dev/null | grep -q frida-server" ; then
  if [ ! -f "$BIN" ]; then
    say "下载 frida-server（$ABI）"
    VER=$(curl -fsSL https://api.github.com/repos/frida/frida/releases/latest | grep -m1 '"tag_name"' | sed -E 's/.*"([^"]+)".*/\1/')
    [ -n "$VER" ] || { warn "查不到 frida 版本，可手动设置 FRIDA_VER=16.5.9"; exit 1; }
    URL="https://github.com/frida/frida/releases/download/${VER}/frida-server-${VER}-android-${ABI}.xz"
    say "版本 $VER"
    curl -fL --progress-bar "$URL" -o "$BIN.xz"
    xz -dc "$BIN.xz" > "$BIN"
    chmod +x "$BIN"
  fi

  say "推送 frida-server"
  adb push "$BIN" /data/local/tmp/frida-server >/dev/null
  run_root chmod 755 /data/local/tmp/frida-server
  say "启动 frida-server"
  adb shell "nohup /data/local/tmp/frida-server >/dev/null 2>&1 &" || run_root "nohup /data/local/tmp/frida-server >/dev/null 2>&1 &"
  sleep 2
else
  say "frida-server 已在运行"
fi

if ! command -v frida >/dev/null 2>&1; then
  warn "没装 frida 客户端：pip install frida-tools"
  exit 1
fi
say "frida 能看到：$(frida-ps -U 2>/dev/null | wc -l) 个进程"

# ---------- 4. 挂上去 ----------
say "启动快对并注入（Ctrl+C 结束）"
cat <<EOF

  接下来在设备上操作：
    1) 打开那本书 → 查看答案
    2) 从第 1 页翻到最后一页（不用每页都停，慢慢翻一遍就行）
    3) 日志里出现 [KD] {...} 就表示抓到了

  抓完导出：
    python3 kd_export.py --log "$OUT" --pdf

EOF

frida -U -f "$PKG" -l "$HERE/kd_capture.js" -o "$OUT" --runtime=v8 2>/dev/null \
  || frida -U -f "$PKG" -l "$HERE/kd_capture.js" -o "$OUT"
