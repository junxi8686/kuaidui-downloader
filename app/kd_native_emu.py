#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""libbaseutil.so（快对 5.14.0，armeabi-v7a）的 ARM32 用户态模拟器。

用途：在没有 root / 没有 adb 设备的情况下，把快对 native 的签名函数跑起来：
    nativeInitBaseUtil(ctx, cuid) -> signA
    POST /pluto/app/antispam?data=signA  -> signB
    nativeSetToken(ctx, cuid, signA, signB) -> 建内部密钥
    nativeGetSign(base64(paramString))      -> sign

实现要点（详见 REVERSE.md）：
  * 只加载两个 PT_LOAD 段，手工处理 R_ARM_RELATIVE；
  * 30 个导入符号用 Python 打桩（malloc/strlen/sprintf/...），GOT 槽位指向桩地址；
  * unicorn 自带的 ARM 没编 NEON，文本段里 60 多条 vld1/vst1/vmov 由
    钩子逐条模拟（_hook_neon）；
  * md5 与变参拼串两个热点函数直接在 Python 里实现（_hook_md5 / _hook_asprintf），
    既能跑，也方便把入参打印出来当证据；
  * JNIEnv 是一张 300 项的假函数表，按索引分发；Context / PackageManager /
    PackageInfo / Signature 全部返回预设对象（包名、证书 SHA 用 APK 里真实的那份）。

⚠️ 现状（2026-11）：init/setToken/getSign 三段都能在模拟器里跑完并返回值，
   但服务端对 signA 的校验没有通过（errNo 7 "antispam data error"），
   所以本文件目前是「研究/对照」工具，不是可用的生产签名源。
"""
import struct, hashlib, os, sys, math, json, urllib.request, urllib.parse
import unicorn.arm_const as armc
from unicorn import *
from unicorn.arm_const import *

SO = os.environ.get('KD_SO', '')
BASE = 0x40000000
HEAP = 0x70000000
STUB = 0x60000000
JTBL = 0x68000000      # 假 java 对象表
ENV = 0x69000000       # 假 JNIEnv
IMG = b''


def load_image(path):
    """把 .so 读进内存镜像；所有地址都按 path 里的这份文件算。"""
    global IMG, SO
    SO = path
    IMG = open(path, 'rb').read()
    return IMG

FIND_CLASS, GET_OBJECT_CLASS, GET_METHOD_ID = 6, 31, 33
CALL_OBJECT_METHOD = 34
GET_FIELD_ID, GET_OBJECT_FIELD = 94, 95
GET_STATIC_FIELD_ID, GET_STATIC_INT_FIELD = 144, 150
CALL_INT_METHOD = 49
NEW_STRING_UTF, GET_STRING_UTFCHARS, RELEASE_STRING_UTFCHARS = 167, 169, 170
GET_ARRAY_LENGTH, GET_OBJECT_ARRAY_ELEMENT = 171, 173
GET_INT_FIELD = 100
CALL_STATIC_OBJECT_METHOD = 116

NAMES = {FIND_CLASS: 'FindClass', GET_OBJECT_CLASS: 'GetObjectClass', GET_METHOD_ID: 'GetMethodID',
         CALL_OBJECT_METHOD: 'CallObjectMethod', GET_FIELD_ID: 'GetFieldID',
         GET_OBJECT_FIELD: 'GetObjectField', CALL_INT_METHOD: 'CallIntMethod',
         GET_STATIC_FIELD_ID: 'GetStaticFieldID', GET_STATIC_INT_FIELD: 'GetStaticIntField',
         NEW_STRING_UTF: 'NewStringUTF', GET_STRING_UTFCHARS: 'GetStringUTFChars',
         RELEASE_STRING_UTFCHARS: 'ReleaseStringUTFChars', GET_ARRAY_LENGTH: 'GetArrayLength',
         GET_OBJECT_ARRAY_ELEMENT: 'GetObjectArrayElement', GET_INT_FIELD: 'GetIntField'}


class KDSo:
    def _load_sig(self):
        """签名证书：Android 的 Signature.toCharsString() 就是 DER 的小写 hex。"""
        cands = []
        if self.cert_path:
            cands.append(self.cert_path)
        cands += [os.path.join(os.path.dirname(os.path.abspath(__file__)), 'cert.der'),
                  os.environ.get('KD_CERT', '')]
        for p in cands:
            if p and os.path.exists(p):
                return open(p, 'rb').read().hex()
        # 退路：用一份固定长度的占位 DER（服务端会因此拒绝，但流程能跑通）
        return ('30' * 775)

    def __init__(self, so_path=None, cert_path=None, verbose=False):
        if so_path:
            load_image(so_path)
        elif not IMG:
            load_image(SO or os.environ.get(
                'KD_SO', '/tmp/kdapk/lib/lib/armeabi-v7a/libbaseutil.so'))
        self.cert_path = cert_path
        self.sig_hex = self._load_sig()
        self.verbose = verbose
        self.uc = Uc(UC_ARCH_ARM, UC_MODE_THUMB)
        self.lastpc = []
        try:
            from unicorn.arm_const import UC_CPU_ARM_CORTEX_A15
            self.uc.ctl_set_cpu_model(UC_CPU_ARM_CORTEX_A15)
        except Exception as e:
            print('cpu model:', e)
        self.heap = HEAP
        self.mlog = []
        self.jlog = []
        self._load()
        self._jni_setup()

    # ---------- memory ----------
    def w32(self, a, v): self.uc.mem_write(a, struct.pack('<I', v & 0xffffffff))
    def r32(self, a): return struct.unpack('<I', self.uc.mem_read(a, 4))[0]
    def rdstr(self, a, maxlen=1 << 16):
        if not a:
            return b''
        out = bytearray()
        while len(out) < maxlen:
            try:
                ch = self.uc.mem_read(a + len(out), 1)
            except UcError:
                print(f'[!] rdstr bad ptr {a:#x} len={len(out)}')
                return bytes(out)
            if ch == b'\0': break
            out += ch
        return bytes(out)
    def xmalloc(self, n):
        n = max(8, (n + 7) & ~7)
        p = self.heap
        self.heap += n
        return p
    def wrstr(self, s):
        if isinstance(s, str): s = s.encode()
        p = self.xmalloc(len(s) + 1)
        self.uc.mem_write(p, s + b'\0')
        return p

    # ---------- ELF ----------
    def _load(self):
        uc = self.uc
        uc.mem_map(BASE, 0x200000)
        uc.mem_write(BASE, IMG[0:0x8360])
        uc.mem_write(BASE + 0x9dbc, IMG[0x8dbc:0x8dbc + 0x288])
        uc.mem_map(HEAP, 0x8000000)
        uc.mem_map(STUB, 0x4000)
        uc.mem_map(JTBL, 0x2000)
        uc.mem_map(ENV, 0x2000)
        for i in range(43):
            off = 0x824 + 8 * i
            r_offset, r_info = struct.unpack('<II', IMG[off:off + 8])
            typ = r_info & 0xff
            if typ == 0x17:
                val = struct.unpack('<I', uc.mem_read(BASE + r_offset, 4))[0]
                self.w32(BASE + r_offset, val + BASE)
        # imports
        self.stubs = {}
        n = 0
        for i in range(30):
            off = 0x97c + 8 * i
            r_offset, r_info = struct.unpack('<II', IMG[off:off + 8])
            name = self._dynsym(r_info >> 8)
            thunk = STUB + 0x100 + 4 * n; n += 1
            self.w32(BASE + r_offset, thunk | 1)
            self.stubs[thunk | 1] = name
        for off, name in ((0x9f54, '__stack_chk_guard'), (0x9f50, 'free'), (0x9f60, 'strlen'), (0x9f6c, '__sF')):
            if name == '__stack_chk_guard':
                p = self.xmalloc(4); self.w32(p, 0x12345678); self.w32(BASE + off, p)
            elif name == '__sF':
                p = self.xmalloc(8); self.w32(BASE + off, p)
            else:
                thunk = STUB + 0x100 + 4 * n; n += 1
                self.w32(BASE + off, thunk | 1)
                self.stubs[thunk | 1] = name
        uc.hook_add(UC_HOOK_CODE, self._hook_stub, begin=STUB + 0x100, end=STUB + 0x400)
        uc.hook_add(UC_HOOK_CODE, self._hook_md5, begin=BASE + 0x1c18, end=BASE + 0x1c18)
        uc.hook_add(UC_HOOK_CODE, self._hook_asprintf, begin=BASE + 0x1ef0, end=BASE + 0x1ef0)
        self._neon_prescan()
        uc.hook_add(UC_HOOK_CODE, self._hook_neon_next, begin=BASE + 0xbe8, end=BASE + 0x5d60)
        uc.hook_add(UC_HOOK_CODE, self._trace, begin=BASE + 0xbe8, end=BASE + 0x5d60)

    def _dynsym(self, idx):
        st_name = struct.unpack('<I', IMG[0x1f0 + 16 * idx:0x1f4 + 16 * idx])[0]
        end = IMG.index(b'\0', 0x450 + st_name)
        return IMG[0x450 + st_name:end].decode()

    # ---------- libc ----------
    def _fmt(self, fmt, regargs, sp):
        args = list(regargs) + [self.r32(sp + 4 * k) for k in range(12)]
        out = bytearray(); i = 0; ai = 0
        while i < len(fmt):
            c = fmt[i:i + 1]
            if c != b'%':
                out += c; i += 1; continue
            i += 1
            if i < len(fmt) and fmt[i:i + 1] == b'%':
                out += b'%'; i += 1; continue
            spec = ''
            while i < len(fmt) and chr(fmt[i]) in '-+ #0':
                spec += chr(fmt[i]); i += 1
            width = ''
            while i < len(fmt) and chr(fmt[i]).isdigit():
                width += chr(fmt[i]); i += 1
            prec = ''
            if i < len(fmt) and fmt[i:i + 1] == b'.':
                i += 1
                while i < len(fmt) and chr(fmt[i]).isdigit():
                    prec += chr(fmt[i]); i += 1
            while i < len(fmt) and chr(fmt[i]) in 'lh':
                i += 1
            if i >= len(fmt): break
            conv = chr(fmt[i]); i += 1
            w = int(width) if width else 0
            p = int(prec) if prec else None
            txt = ''
            if conv == 's':
                ap = args[ai]; ai += 1
                txt = (self.rdstr(ap) if ap else b'(null)').decode('utf-8', 'replace')
                if p is not None: txt = txt[:p]
            elif conv in 'di':
                v = args[ai]; ai += 1
                if v >= 0x80000000: v -= 0x100000000
                txt = str(v)
            elif conv == 'u':
                txt = str(args[ai]); ai += 1
            elif conv in 'xX':
                v = args[ai]; ai += 1
                txt = format(v, 'x' if conv == 'x' else 'X')
            elif conv == 'c':
                txt = chr(args[ai] & 0xff); ai += 1
            elif conv == 'p':
                txt = '0x%08x' % args[ai]; ai += 1
            if conv in 'diuxX':
                if p is not None:
                    if conv in 'di' and txt.startswith('-'):
                        txt = '-' + txt[1:].rjust(p, '0')
                    else:
                        txt = txt.rjust(p, '0')
                if w > len(txt):
                    txt = txt.rjust(w, '0') if '0' in spec else txt.rjust(w)
            elif conv == 's' and w > len(txt):
                txt = txt.ljust(w) if '-' in spec else txt.rjust(w)
            out += txt.encode('latin-1', 'replace')
        return bytes(out)

    def _ret(self, v):
        lr = self.uc.reg_read(UC_ARM_REG_LR)
        self.uc.reg_write(UC_ARM_REG_R0, v & 0xffffffff)
        self.uc.reg_write(UC_ARM_REG_PC, lr)

    def _hook_stub(self, uc, addr, size, user):
        name = self.stubs.get(addr) or self.stubs.get(addr | 1) or self.stubs.get(addr & ~1)
        r0, r1, r2, r3 = (uc.reg_read(x) for x in (UC_ARM_REG_R0, UC_ARM_REG_R1, UC_ARM_REG_R2, UC_ARM_REG_R3))
        sp = uc.reg_read(UC_ARM_REG_SP)
        if self.verbose: print(f'  libc {name}({r0:#x},{r1:#x},{r2:#x})')
        if name == 'malloc': self._ret(self.xmalloc(r0)); return
        if name == 'calloc':
            n = (r0 or 1) * (r1 or 1); p = self.xmalloc(n)
            uc.mem_write(p, b'\0' * n); self._ret(p); return
        if name == 'free': self._ret(0); return
        if name == 'strlen': self._ret(len(self.rdstr(r0)) if r0 else 0); return
        if name == 'strcmp':
            a, b = self.rdstr(r0) if r0 else b'', self.rdstr(r1) if r1 else b''
            self._ret((a > b) - (a < b)); return
        if name in ('__aeabi_memcpy', '__aeabi_memmove', 'memcpy', 'memmove'):
            uc.mem_write(r0, bytes(uc.mem_read(r1, r2))); self._ret(r0); return
        if name == '__aeabi_memclr':
            uc.mem_write(r0, b'\0' * r1); self._ret(r0); return
        if name == 'strcpy':
            s = self.rdstr(r1); uc.mem_write(r0, s + b'\0'); self._ret(r0); return
        if name == 'strncpy':
            s = self.rdstr(r1)[:r2]; uc.mem_write(r0, s + b'\0' * (r2 - len(s))); self._ret(r0); return
        if name == 'sprintf':
            out = self._fmt(self.rdstr(r1), [r2, r3], sp); uc.mem_write(r0, out + b'\0'); self._ret(len(out)); return
        if name == 'snprintf':
            out = self._fmt(self.rdstr(r2), [r3], sp)[:max(0, r1 - 1)]
            uc.mem_write(r0, out + b'\0'); self._ret(len(out)); return
        if name == 'vsnprintf':
            out = self._fmt(self.rdstr(r2), [], 0); uc.mem_write(r0, out + b'\0'); self._ret(len(out)); return
        if name == '__system_property_get':
            key = self.rdstr(r0).decode('utf-8', 'replace')
            v = {'ro.serialno': b'EMUSERIAL01', 'ro.build.version.sdk': b'33',
                 'ro.product.name': b'emuproduct'}.get(key, b'')
            uc.mem_write(r1, v + b'\0'); self._ret(len(v)); return
        if name in ('time', 'clock'): self._ret(1700000000); return
        if name == 'lrand48': self._ret(0x12345678); return
        if name == 'pow': self._ret(int(math.pow(r0, r1)) & 0xffffffff); return
        if name in ('abort', 'exit', '__stack_chk_fail'):
            print(f'[!] {name} @ lr={uc.reg_read(UC_ARM_REG_LR):#x}')
            uc.emu_stop(); return
        self._ret(0)

    def _hook_md5(self, uc, addr, size, user):
        p = uc.reg_read(UC_ARM_REG_R0)
        s = self.rdstr(p) if p else b''
        self.mlog.append(s)
        if self.verbose: print(f'  md5({s!r})')
        self._ret(self.wrstr(hashlib.md5(s).hexdigest()))

    def _hook_asprintf(self, uc, addr, size, user):
        fmt = self.rdstr(uc.reg_read(UC_ARM_REG_R0))
        r = [uc.reg_read(x) for x in (UC_ARM_REG_R1, UC_ARM_REG_R2, UC_ARM_REG_R3)]
        out = self._fmt(fmt, r, uc.reg_read(UC_ARM_REG_SP))
        if self.verbose: print(f'  sprintf({fmt!r}) -> {out!r}')
        self._ret(self.wrstr(out))



    def _hook_neon_next(self, uc, addr, size, user):
        info = self.neon.get(addr)
        if info is None:
            return
        r = self._hook_neon(uc, addr, size, user)
        if r == 'skip':
            uc.reg_write(UC_ARM_REG_PC, (addr + info[2]) | 1)

    # ---------- NEON ----------
    def _neon_prescan(self):
        import capstone, re
        self.neon = {}
        md = capstone.Cs(capstone.CS_ARCH_ARM, capstone.CS_MODE_THUMB)
        md.skipdata = True
        data = IMG[0xbe8:0xbe8 + 0x5178]
        for ins in md.disasm(data, 0xbe8):
            if ins.id and ins.mnemonic.startswith('v'):
                self.neon[BASE + ins.address] = (ins.mnemonic, ins.op_str, ins.size)
        self.vregs = {}

    def _vget(self, name):
        # returns bytearray of 8 bytes for dN
        if name not in self.vregs:
            self.vregs[name] = bytearray(8)
        return self.vregs[name]

    def _qbytes(self, q, n):
        # bytes for d(n), d(n+1) .. for q index (q8 -> d16,d17)
        out = bytearray()
        d0 = q * 2
        for k in range(n * 2 if n == 1 else n * 2):
            pass
        return out

    def _hook_neon(self, uc, addr, size, user):
        info = self.neon.get(addr)
        if info is None:
            return
        mn, ops, isz = info
        import re
        sp = uc.reg_read(UC_ARM_REG_SP)
        def rd(rn):
            return uc.reg_read(getattr(armc, 'UC_ARM_REG_' + rn.upper()))
        def dregs(m):
            names = re.findall(r'd\d+', m)
            return names
        if mn == 'vmov.i32':
            qn = re.search(r'q(\d+)', ops).group(1)
            n = int(qn) * 2
            if '#0' in ops:
                for i in range(2):
                    self.vregs['d%d' % (n + i)] = bytearray(8)
            return 'skip'
        m = re.match(r'\{(d\d+)(?:, (d\d+))?\}, \[(r\d+|sp|sl|fp|ip)\](!?)(?:, (r\d+|sp|sl|fp|ip))?$', ops)
        if m and mn.startswith(('vst1', 'vld1')):
            regs = [m.group(1)] + ([m.group(2)] if m.group(2) else [])
            base = rd(m.group(3))
            wb_bang = m.group(4) == '!'
            wb_reg = m.group(5)
            ln = 8 * len(regs)
            if mn.startswith('vst1'):
                buf = b''.join(bytes(self._vget(r)) for r in regs)
                uc.mem_write(base, buf)
            else:
                buf = bytes(uc.mem_read(base, ln))
                for i, r in enumerate(regs):
                    self.vregs[r] = bytearray(buf[8 * i:8 * i + 8])
            if wb_bang:
                uc.reg_write(getattr(armc, 'UC_ARM_REG_' + m.group(3).upper()), base + ln)
            elif wb_reg:
                uc.reg_write(getattr(armc, 'UC_ARM_REG_' + m.group(3).upper()), base + rd(wb_reg))
            return 'skip'
        m = re.match(r'(d\d+), \[(r\d+|sp|sl|fp|ip)(?:, #(\d+))?\]$', ops)
        if m and mn in ('vstr', 'vldr'):
            base = rd(m.group(2)) + int(m.group(3) or 0)
            if mn == 'vstr':
                uc.mem_write(base, bytes(self._vget(m.group(1))))
            else:
                self.vregs[m.group(1)] = bytearray(bytes(uc.mem_read(base, 8)))
            return 'skip'
        m = re.match(r'\{(d\d+), (d\d+)\}$', ops)
        if m and mn in ('vpush', 'vpop'):
            rs = [m.group(1), m.group(2)]
            sp = uc.reg_read(UC_ARM_REG_SP)
            if mn == 'vpush':
                sp -= 16
                for i, r in enumerate(rs):
                    uc.mem_write(sp + 8 * i, bytes(self._vget(r)))
                uc.reg_write(UC_ARM_REG_SP, sp)
            else:
                for i, r in enumerate(rs):
                    self.vregs[r] = bytearray(bytes(uc.mem_read(sp + 8 * i, 8)))
                uc.reg_write(UC_ARM_REG_SP, sp + 16)
            return 'skip'
        print(f'[neon?] {addr:#x} {mn} {ops}')
        return None

    # ---------- fake JNIEnv ----------
    def _jni_setup(self):
        uc = self.uc
        self.jhandles = {}
        self.jclasses = {}
        self.methods = {}
        self.next_h = [0x7f000000]
        # env table: 300 function pointers, each unique thunk in STUB+0x800..
        self.jtable = ENV + 0x100
        for i in range(300):
            thunk = STUB + 0x800 + 4 * i
            if thunk + 4 > ENV:
                raise RuntimeError('thunk space too small')
            self.w32(self.jtable + 4 * i, thunk | 1)
        self.jstubs = {STUB + 0x800 + 4 * i: i for i in range(300)}
        self.w32(ENV, self.jtable)      # env -> table
        self.env_ptr = ENV
        uc.hook_add(UC_HOOK_CODE, self._hook_jni, begin=STUB + 0x800, end=STUB + 0xd00)

    def newhandle(self, kind, val=None):
        h = self.next_h[0]; self.next_h[0] += 4
        self.jhandles[h] = (kind, val)
        return h

    def _hook_jni(self, uc, addr, size, user):
        idx = self.jstubs.get(addr) or self.jstubs.get(addr | 1) or self.jstubs.get(addr & ~1)
        r0, r1, r2, r3 = (uc.reg_read(x) for x in (UC_ARM_REG_R0, UC_ARM_REG_R1, UC_ARM_REG_R2, UC_ARM_REG_R3))
        sp = uc.reg_read(UC_ARM_REG_SP)
        name = NAMES.get(idx, f'jni#{idx}')
        def s(reg):
            try: return self.rdstr(reg).decode('utf-8', 'replace') if reg else ''
            except Exception: return '<bad>'
        if idx == FIND_CLASS:
            cn = s(r1); self.jlog.append(('FindClass', cn))
            h = self.newhandle('class', cn); self.jclasses[cn] = h; self._ret(h); return
        if idx == GET_OBJECT_CLASS:
            k, v = self.jhandles.get(r1, ('obj', '?'))
            h = self.newhandle('class', v if k == 'class' else 'Object')
            self.jlog.append(('GetObjectClass', k, v)); self._ret(h); return
        if idx == GET_METHOD_ID:
            cl = self.jhandles.get(r1, ('?', '?'))[1]; mn = s(r2)
            h = self.newhandle('mid', (cl, mn)); self.methods[h] = (cl, mn)
            self.jlog.append(('GetMethodID', cl, mn, s(r3))); self._ret(h); return
        if idx == CALL_OBJECT_METHOD:
            mid = self.jhandles.get(r2, ('?', ('?', '?')))[1]
            mn = mid[1] if isinstance(mid, tuple) else '?'
            self.jlog.append(('CallObjectMethod', r1, mn))
            self._ret(self._serve_method(r1, mn))
            return
        if idx == GET_FIELD_ID:
            cl = self.jhandles.get(r1, ('?', '?'))[1]; fn = s(r2)
            self.jlog.append(('GetFieldID', cl, fn, s(r3)))
            h = self.newhandle('fid', (cl, fn)); self._ret(h); return
        if idx == GET_OBJECT_FIELD:
            fid = self.jhandles.get(r2, ('?', ('?', '?')))[1]
            fn = fid[1] if isinstance(fid, tuple) else '?'
            self.jlog.append(('GetObjectField', r1, fn))
            self._ret(self._serve_field(r1, fn)); return
        if idx == GET_STATIC_FIELD_ID:
            cl = self.jhandles.get(r1, ('?', '?'))[1]; fn = s(r2)
            self.jlog.append(('GetStaticFieldID', cl, fn, s(r3)))
            h = self.newhandle('sfid', (cl, fn)); self._ret(h); return
        if idx == GET_STATIC_INT_FIELD:
            fid = self.jhandles.get(r2, ('?', ('?', '?')))[1]
            self.jlog.append(('GetStaticIntField', fid[1] if isinstance(fid, tuple) else '?'))
            self._ret(64); return
        if idx == CALL_INT_METHOD:
            mid = self.jhandles.get(r2, ('?', ('?', '?')))[1]
            mn = mid[1] if isinstance(mid, tuple) else '?'
            self.jlog.append(('CallIntMethod', mn))
            self._ret(0x11223344 if mn == 'hashCode' else 1); return
        if idx == GET_INT_FIELD:
            fid = self.jhandles.get(r2, ('?', ('?', '?')))[1]
            self.jlog.append(('GetIntField', r1, fid[1] if isinstance(fid, tuple) else '?'))
            self._ret(1); return
        if idx == GET_ARRAY_LENGTH:
            self.jlog.append(('GetArrayLength', r1)); self._ret(1); return
        if idx == GET_OBJECT_ARRAY_ELEMENT:
            self.jlog.append(('GetObjectArrayElement', r1, r2))
            self._ret(self.newhandle('obj', 'signature')); return
        if idx == NEW_STRING_UTF:
            sv = s(r1)
            self.jlog.append(('NewStringUTF', sv))
            self._ret(self.newhandle('str', sv)); return
        if idx == GET_STRING_UTFCHARS:
            k, v = self.jhandles.get(r1, ('str', ''))
            self._ret(self.wrstr(v if k == 'str' else 'x')); return
        if idx == RELEASE_STRING_UTFCHARS:
            self._ret(0); return
        if self.verbose or True:
            self.jlog.append(('UNHANDLED', name, hex(r1), hex(r2), hex(r3)))
        self._ret(0)

    def _serve_method(self, obj, mn):
        """Canned values for the reflection the native lib performs."""
        if mn == 'getPackageManager':
            return self.newhandle('obj', 'PackageManager')
        if mn == 'getPackageInfo':
            return self.newhandle('obj', 'PackageInfo')
        if mn == 'getPackageName':
            return self.newhandle('str', 'com.kuaiduizuoye.scan')
        if mn == 'hashCode':
            return 12345
        if mn == 'toChars':
            return self.newhandle('obj', 'char[]')
        if mn == 'toCharsString':
            return self.newhandle('str', self.sig_hex)
        return self.newhandle('obj', mn)

    def _serve_field(self, obj, fn):
        if fn == 'signatures':
            return self.newhandle('obj', 'Signature[]')
        return self.newhandle('obj', fn)

    # ---------- native calls ----------
    def _memfault(self, uc, access, address, size, value, user):
        print(f'[!] memfault access={access} addr={address:#x} size={size} pc={uc.reg_read(UC_ARM_REG_PC):#x}')
        print('    recent pc:', [hex(x) for x in self.lastpc[-12:]])
        print('    lr=', hex(uc.reg_read(UC_ARM_REG_LR)), 'r0=', hex(uc.reg_read(UC_ARM_REG_R0)))
        return False

    def _trace(self, uc, addr, size, user):
        self.lastpc.append(addr)
        if len(self.lastpc) > 12:
            self.lastpc.pop(0)

    def _call(self, addr, args, ret_is_str=False):
        uc = self.uc
        sp = self.xmalloc(0x2000) + 0x1000
        uc.reg_write(UC_ARM_REG_SP, sp)
        done = STUB + 0xfc0
        uc.mem_write(done, struct.pack('<H', 0xe7fe))
        uc.reg_write(UC_ARM_REG_LR, done)
        regs = (UC_ARM_REG_R0, UC_ARM_REG_R1, UC_ARM_REG_R2, UC_ARM_REG_R3)
        for i, a in enumerate(args[:4]):
            uc.reg_write(regs[i], a)
        # AAPCS: 第 5 个及以后的参数放栈上（sp+0, sp+4, ...）
        for k, a in enumerate(args[4:]):
            self.w32(sp + 4 * k, a)
        uc.hook_add(UC_HOOK_MEM_READ_UNMAPPED | UC_HOOK_MEM_WRITE_UNMAPPED | UC_HOOK_MEM_FETCH_UNMAPPED, self._memfault)
        uc.emu_start(addr | 1, done, count=40000000)
        r0 = uc.reg_read(UC_ARM_REG_R0)
        if ret_is_str and r0:
            if r0 in self.jhandles and self.jhandles[r0][0] == 'str':
                return self.jhandles[r0][1]
            if r0 in self.jhandles:
                return '<%s>' % (self.jhandles[r0],)
            return self.rdstr(r0).decode('utf-8', 'replace')
        return r0

    def init_baseutil(self, cuid, ctx_obj=None):
        """nativeInitBaseUtil 是 **static** native：
        (JNIEnv*, jclass, Context, String) → r0=env, r1=jclass, r2=ctx, r3=cuid。

        之前按实例方法只传了三个参数，cuid 落到 Context 槽、r3 是未初始化值，
        于是 signA 里第 4 段恒为空、且完全不随 cuid 变化（这也解释了服务端
        为什么一直判 data error）。
        """
        ctx = ctx_obj if ctx_obj is not None else self.newhandle('obj', 'android.content.Context')
        jcuid = self.newhandle('str', cuid)
        jclass = self.newhandle('class', 'com/zuoyebang/baseutil/NativeHelper')
        r = self._call(BASE + 0xd14, [self.env_ptr, jclass, ctx, jcuid], ret_is_str=True)
        return r

    def set_token(self, cuid, signA, signB, ctx_obj=None):
        ctx = ctx_obj if ctx_obj is not None else self.newhandle('obj', 'android.content.Context')
        return self._call(BASE + 0x0e90, [self.env_ptr, ctx, self.newhandle('str', cuid),
                                   self.newhandle('str', signA), self.newhandle('str', signB)])

    def get_sign(self, b64):
        return self._call(BASE + 0x1054, [self.env_ptr, self.newhandle('obj', 'thiz'),
                                   self.newhandle('str', b64)], ret_is_str=True)


    # ---------- 便捷 API ----------
    def default_cuid(self):
        return os.environ.get('KD_CUID', 'EMUCUID0001')

    def request_signB(self, cuid, signA, timeout=20):
        """POST /pluto/app/antispam?data=signA —— 拿 signB（和 App 的握手一致）。"""
        import kd_sign
        q = dict(kd_sign.DEFAULT_COMMON)
        q.update({'cuid': cuid, 'data': signA})
        url = 'https://www.kuaiduizuoye.com/pluto/app/antispam?' + urllib.parse.urlencode(q)
        req = urllib.request.Request(url, data=b'', method='POST', headers={
            'User-Agent': 'kuaiduizuoye/5.14.0 (Linux; Android 13; SM-G986B)'})
        body = urllib.request.urlopen(req, timeout=timeout).read().decode('utf-8', 'replace')
        try:
            j = json.loads(body)
        except ValueError:
            raise RuntimeError('antispam 返回不是 JSON: %r' % body[:200])
        data = j.get('data')
        if not data:
            raise RuntimeError('antispam 拒绝: errNo=%s errstr=%s'
                               % (j.get('errNo'), j.get('errstr')))
        if isinstance(data, list):
            data = data[0] if data else ''
        return str(data)


if __name__ == '__main__':
    import argparse
    ap = argparse.ArgumentParser(description='libbaseutil.so 模拟器（研究用）')
    ap.add_argument('--so', default=os.environ.get('KD_SO'))
    ap.add_argument('--cert', default=None, help='签名证书 DER（真实值才能过服务端）')
    ap.add_argument('--cuid', default=None)
    ap.add_argument('--param', default='QUJDMTIz', help='给 nativeGetSign 的 base64 串')
    ap.add_argument('-v', '--verbose', action='store_true')
    a = ap.parse_args()
    so = KDSo(so_path=a.so, cert_path=a.cert, verbose=a.verbose)
    cuid = a.cuid or so.default_cuid()
    signA = so.init_baseutil(cuid)
    print('signA =', signA[:64], '... len=%d' % len(signA))
    try:
        signB = so.request_signB(cuid, signA)
        print('signB =', signB[:64], '...')
        print('set_token ->', so.set_token(cuid, signA, signB))
    except Exception as e:
        print('拿 signB 失败:', e)
    print('get_sign ->', so.get_sign(a.param))
    if a.verbose:
        print('md5 输入:', so.mlog)
