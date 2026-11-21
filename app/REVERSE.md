# 快对（com.kuaiduizuoye.scan 5.14.0）整本答案接口逆向

> 目标：不从 App 里点，而是用浏览器/脚本复刻请求，拿到**整本**教辅答案的全部页图片直链。
> 本文只写有证据的东西；推测会明确标成「推测」。所有结论都能用文末的命令复现。

---

## 0. 结论速览

| 问题 | 结论 | 证据强度 |
|---|---|---|
| 之前为什么 404 | **host 找错了**。书相关的这两个接口走的是 `NetConfig.getHost("")` → `h.a()` → **`https://www.kuaiduizuoye.com`**，不是 `apivip.kuaiduizuoye.com`（那是 `h.d.ONLINE`，给 antispam 用的，而且它对任何路径都回 302/404） | 反编译 + 实测 |
| 完整 path | `/kdtools/book/downloadanswer`（单页）、`/kdtools/book/answeranalysis`（整本结构） | 反编译 |
| 方法 | **POST**（GET 一律 404，nginx/zgw 只放 POST） | 实测 |
| 参数 | `bookId`（32 位 hex）、`pageNo`（**从 0 开始**）；其余全是公共参数 | 反编译 + 实测 |
| 要不要签名 | **要**。无 `sign` → `5103`；有 `sign` 但服务端没有该 cuid 的 antispam 令牌 → `errNo 6` | 实测 |
| 签名算法 | 4 层（见 §4）。**第 1 层（paramString）已复刻并 Python/JS 双向交叉验证；第 2 层（nativeGetSign 的 md5 拼串）形态已确认**；第 3 层（SECRET 从 `nativeInitBaseUtil → /pluto/app/antispam → nativeSetToken` 来）只有链路、没拿到值 | 反编译 + .so 反汇编 + 模拟器运行时追踪 |
| 纯算法能不能独立跑 | **目前不能**。卡在 antispam 握手：我们自己造的 `signA` 被服务端判 `errNo 7 antispam data error`（§6） | 实测 |
| 网页端 | 确实只有 3 页（`oriAnswers` 3 条，`answerCount` 18） | 实测 |

**能直接用的东西**：

- `kd_full.py --mode web` —— 现在就能跑，拿网页端那 3 页（有书名/页数/PDF）。
- `kd_full.py --bridge http://127.0.0.1:8710` —— 有一台能跑快对的安卓设备（root+frida）时，用它拿**全书**。桥的实现、协议都在 §7。
- `kd_sign.py` / `kd_sign.js` —— 参数串 + md5 拼串这两层已可独立复算，两者互相校验一致。

---

## 1. 真实接口

### 1.1 请求长什么样

```
POST https://www.kuaiduizuoye.com/kdtools/book/downloadanswer
     ?bookId=<32位hex>&pageNo=<0基>&appId=scancode&cuid=...&vc=5140&vcname=5.14.0
     &os=android&sdk=33&pkgName=com.kuaiduizuoye.scan&device=...
     &_t_=<秒>&kakorrhaphiophobia=<毫秒>&sign=<32hex>&_t_=..&kakorrhaphiophobia=..
     &__tips__=1
Content-Type: application/x-www-form-urlencoded

bookId=<32位hex>&pageNo=0
```

- 业务参数**同时**出现在 query 和 body 里（`HWRequest.getParams()` 从 URL 里再解析一遍），实测两者服务端都收。
- 一页一次请求，响应：`{"errNo":0,...,"data":{"imageUrl":"https://kd-book.cdnjtzy.com/scanimg/scan_<32hex>.jpg"}}`
- 字段来源：`BookDownloadAnswer.java:4`（`public String imageUrl`）。

### 1.2 host 是怎么定的（为什么不是 apivip）

```java
// com/kuaiduizuoye/scan/common/net/model/v1/BookDownloadAnswer.java:20,25-27
return NetConfig.getHost(this.__pid) + "/kdtools/book/downloadanswer?&bookId=" + ...
this.__url    = "/kdtools/book/downloadanswer";
this.__pid    = "";          // ← pid 是空串
this.__method = 1;           // ← 1，即 POST
```

```java
// com/kuaiduizuoye/scan/base/o.java:48-53    NetConfig 的实现类
public String getHost(String str) {
    String host = getHost();
    return (!f20781c.containsKey(str) || ...) ? host : ...;
}
// f20781c = {userinfra:pluto.zuoyebang.com, saas-msg:msg.zybang.com,
//            resource:resourceserver.zybang.com, vip:apivip.kuaiduizuoye.com,
//            zybupsgt:gtactivity.zuoyebang.com}      ← o.java:31-35
```

`pid = ""` 不在那张 map 里 → 直接返回 `getHost()`：

```java
// com/kuaiduizuoye/scan/base/h.java:44-47
public static String a() { return f20719e == h.a.ONLINE ? f20719e.y : a(f20719e.y); }
// f20719e 默认 = h.a.ONLINE，而 h.a.ONLINE(f20717c, f20715a)
// f20717c = "https://" + f20716b，f20716b = e.f()      // h.java:27,30
// com/kuaiduizuoye/scan/base/e.java:35-38  f() -> "www.kuaiduizuoye.com"
```

所以 **书接口的 host = `https://www.kuaiduizuoye.com`**。

`apivip.kuaiduizuoye.com` 出现在 `h.java:227`，那是另一个枚举（`h.d`，antispam 专用），不是书接口的 host。
实测 `GET https://apivip.kuaiduizuoye.com/kdtools/book/downloadanswer...` → `302`（body 是 404 页），
`GET https://www.kuaiduizuoye.com/kdtools/...` → `404`：**GET 本身就不对**，换成 POST 立刻有 JSON 回来。这就是最初「两个 host 都 404」的原因——host 错了一个、方法也错了。

### 1.3 请求方法

```java
// com/baidu/homework/common/net/core/HWRequest.java:67
super(inputBase.__forceMethod ? inputBase.__method : 1,
      NetConfig.getHost() + inputBase.__url, aVar);
```

`__forceMethod` 默认 false，所以方法恒为 `1`；`prepareUrl()` 里 `getMethod() == 1` 的分支才拼 sign（`HWRequest.java:74-83`），
与「POST + 全参数塞 query」的现象一致。

### 1.4 pageNo 是 0 基

```java
// com/kuaiduizuoye/scan/activity/scan/activity/BookCompleteDetailsPictureBrowseActivity.java:1132-1133
int currentItem = this.v.getCurrentItem();      // ViewPager 下标 → 0 起
Net.post(this, BookDownloadAnswer.Input.buildInput(this.m, currentItem), ...);
```

---

## 2. 服务端校验阶梯（全是实测响应）

请求 `POST https://www.kuaiduizuoye.com/kdtools/book/downloadanswer?bookId=cee9bcf902dcb3ba990f58d7b7d82efe&pageNo=1`，
依次补参数，得到一条清晰的校验链：

| 已带的参数 | 响应 |
|---|---|
| （只有 bookId/pageNo） | `{"errNo":5115,"errstr":"antispam not register appId ","data":{}}` |
| `+appId=scancode` | `{"errNo":5109,"errstr":"cuid is empty","data":{}}` |
| `+cuid=...` | `{"errNo":5110,"errstr":"lack time param: _t_","data":{}}` |
| `+_t_=<秒>` | `{"errNo":5103,"errstr":"user params lack sign key words","data":{}}` |
| `+sign=<32hex>&kakorrhaphiophobia=<ms>` | `{"errNo":6,"errstr":"get antispam token fail","data":{}}` |

补充观察（都实测过）：

- `appId` 只有 `scancode` 被 antispam 登记；`kuaiduizuoye/kuaidui/kdtools/zybang/web/...` 全是 5115，
  `appId=college` 会走到 `{"errNo":5000,"errstr":"system internal error"}`（另一个 app 的策略，不是绕过口）。
- **antispam 网关排在参数校验之前**：把 bookId 拿掉、或干脆不传 body，返回的还是 `errNo 6`。
  也就是说，没有合法令牌时，连「参数对不对」都问不出来。
- `/kdtools/book/answeranalysis` 同一个门槛（`5103`）。

---

## 3. 签名参数里到底有哪几个值

`sign` 不是单个哈希，而是**三段拼起来的**：

```java
// com/zuoyebang/baseutil/a.java:131-140  （逐行对应）
String str  = "_t_=" + (DateUtils.getApproximateServerTimeMillis() / 1000);   // 秒
list.add(str);
String str2 = "kakorrhaphiophobia=" + f37880e;   // f37880e = 初始化成功时的 elapsedRealtime()，毫秒
list.add(str2);
Collections.sort(list);
String join = TextUtils.join("", list);          // ← 注意：没有分隔符
String core = NativeHelper.nativeGetSign(
        Base64.encodeToString(join.getBytes("UTF-8"), 2));   // 2 = NO_WRAP（保留 '=' 补齐）
return core + "&" + str + "&" + str2;             // ← 真正塞进 URL 的值
```

于是：

```
sign=<nativeGetSign 的 32 位结果>&_t_=1795248841&kakorrhaphiophobia=123456
```

注意 `_t_` 和 `kakorrhaphiophobia` 会在 query 里出现两次（一次是 sign 里的、一次是普通参数），这是 App 的真实行为，服务端接受。

`com/zuoyebang/baseutil/a.java:87-101` 还有一条：服务端回 `ANTISPAM_SIGNERR` 时，App 会把
`kakorrhaphiophobia` 的值回传给 `baseutil.a.a(long)` 触发重握手——说明这个字段是服务端用来定位令牌的。

---

## 4. 算法四层

### 第 1 层：paramString（**已复现，双向验证过**）

```
paramString = Base64_NO_WRAP( "".join(sorted(["k=v", "k=v", ...])) )
```

- Java 侧：`Collections.sort(list)` + `TextUtils.join("", list)`（`baseutil/a.java:135-136`）。
- 交叉验证：`kd_sign.py` 与 `kd_sign.js` 对同一组参数输出逐字节一致。
- 外部旁证：网上流传的同族样本（作业帮系）里，`nativeGetSign` 的入参长这样：

  ```
  X3RfPTE3MTQ2NTQyMzRhYmlzPTFhZGlkPWEyMDIxZGUz...
  ```

  base64 解出来正是 `_t_=1714654234abis=1adid=...cuid=...`——键值对**无缝拼接、按 key 排序**，
  和我们对 `a.java:135-136` 的读法完全吻合（见 [MT论坛帖子](https://bbs.binmt.cc/forum.php?mod=viewthread&tid=132510)）。

### 第 2 层：nativeGetSign 的拼串形态（**形态已确认，secret 未解**）

`libbaseutil.so` 是 stripped 的，但 `JNI_OnLoad` 里注册的 `JNINativeMethod` 表留在
`.data.rel.ro`（段首 0x9dbc，第一条 `JNINativeMethod` 从 0x9dc0 开始，12 字节一组），三字段一组：

| 名字 | 签名 | 函数 |
|---|---|---|
| 0x68df `nativeInitBaseUtil` | 0x68f2 `(Landroid/content/Context;Ljava/lang/String;)Ljava/lang/String;` | **0x0d15** |
| 0x6932 `nativeSetToken` | 0x6941 `(...;String;String;String;)Z` | **0x0e91** |
| 0x6994 `nativeGetSign` | 0x69a2 `(Ljava/lang/String;)Ljava/lang/String;` | **0x1055** |
| 0x69c9 `nativeGetKey` | 0x69a2 | **0x110d** |

（地址低位 1 = Thumb。表本身在 `readelf -rW` 里都是 `R_ARM_RELATIVE`。）

`nativeGetSign`（0x1054 起）反汇编：

```asm
00001054: push {r4,r5,r6,r7,lr}
0000105e: ldr r0,[pc,#0x9c] / add r0,pc / ldr r0,[r0]   ; 全局 0xa044：初始化标志
00001064: cbz r0, 0x10e4                                ; 没初始化 → 直接返回 "error"
0000106a: ldr r2,[pc,#0x98] / add r2,pc                 ; 全局 0xa0d4
0000106e: ldr r1,[r2] / cbz r1, 0x10e6                  ; 0xa0d4 为空 → "error"
00001072: ldr.w r3,[r0,#0x2a4]                          ; JNIEnv[169] = GetStringUTFChars
00001086: bl  #0x3978                                   ; strdup
00001092: ldr.w r3,[r0,#0x2a8]                          ; JNIEnv[170] = ReleaseStringUTFChars
000010a2: ldr r0,[r5],#8                                ; r0 = *(0xa0d4) = SECRET 指针
000010a6: bl  #0x1c18                                   ; md5_hex(SECRET)  ← 已按 md5 语义替换实现
000010b0: ldr r0,[pc,#0x54] / add r0,pc                 ; .rodata 0x6894 = "%s[%s]@%s"
000010b2: mov r1, r5                                    ; r5 = 0xa0dc = "8&%d*"
000010b4: mov r3, r8                                    ; r8 = 入参（base64 串副本）
000010b8: bl  #0x1ef0                                   ; 变参拼串（malloc+vsnprintf）
000010be: bl  #0x1c18                                   ; md5_hex(拼出来的串)
000010c4: ldr.w r2,[r0,#0x29c]                          ; JNIEnv[167] = NewStringUTF
```

也就是：

```
sign_core = md5hex( sprintf("%s[%s]@%s", "8&%d*", md5hex(SECRET), paramString) )
```

`"8&%d*"` 不是猜的：把 0xa0dc 处的全局读出来就是它（下文模拟器追踪里 `r1=0x4000a0dc str=b'8&%d*'`）。

`.rodata` 里的相关常量（偏移即虚拟地址）：

| 偏移 | 内容 |
|---|---|
| 0x686d | `%s##%s##%s##%s` |
| 0x687c | `@fG2SuLA` |
| 0x6885 / 0x688a | `%s%s` / `#G4` |
| 0x6894 | `%s[%s]@%s` ← nativeGetSign 用的就是它 |
| 0x689e / 0x68a6 | `[%s]@` / `@#AIjd83#@6B` |
| 0x68b3 | `%s%s%s` |
| 0x69d6 / 0x69db | `%02x` / `fda&8^%$#)93hfl_esi.*` |
| 0x6c62 | `../../../../src/main/cpp/des.c`（so 里带了一整套 DES） |

`.so` 里还有标准 MD5 的四常量（0x67452301/0xefcdab89/0x98badcfe/0x10325476，出现在 0x13b8 一带），
和 `nativeGetSign` 里两次 `md5_hex` 的调用对得上。

### 第 3 层：SECRET 从哪来（**只有链路，没拿到真值**）

```java
// baseutil/a.java:56-101  初始化
signA = NativeHelper.nativeInitBaseUtil(application, cuid);
signB = ((PlutoAntispam) Net.postSync(PlutoAntispam.Input.buildInput(signA), PlutoAntispam.class)).data;
NativeHelper.nativeSetToken(application, cuid, signA, signB);   // ← 内部才生成 SECRET
```

- `/pluto/app/antispam?data=signA`：`com/baidu/homework/common/net/model/v1/PlutoAntispam.java`
  （`PATH` 常量、`__pid="antispam"`；注意 `a.java` 用的是 `Net.postSync(input, cls)` 两参版本，
  那条路径**不追加 sign**，所以这个握手请求本身不需要签名）。
- `nativeInitBaseUtil` 产出的 `signA` 长 224 个十六进制字符（我们模拟出来的实例：
  `0d0004050f050701040e070b...`），是把
  `sprintf("%s##%s##%s##%s", "8&%d*", <10位随机码>, <32位md5>, <字段>)`
  拿去跑 so 内那套 DES（`des.c`）再 hex 化得到的——运行时追踪到的实参（模拟器 `--verbose`）：

  ```
  r1=0x4000a0dc str=b'8&%d*'
  r2=0x70000fe0 str=b'WWWWWWWWWW'          ← 10 位随机码（我桩死了 lrand48 所以是常量）
  r3=0x700020f0 str=b'ac2b19a8fa551dd8c208649d0d1e3a73'
  [sp+0]=... str=b''
  → asprintf 结果: '8&%d*##WWWWWWWWWW##ac2b19a8fa551dd8c208649d0d1e3a73##'
  ```

  那 10 位随机码来自 0x3c6c 处的循环：`time(0)`+`clock()` 种 `srand48`，循环 10 次
  `lrand48() % 62` 去查 `.rodata 0x6eaa` 的 `A-Za-z0-9` 表——即**随机 nonce**，不是设备指纹。

### 第 4 层：把 SECRET 变成 md5 输入

需要 SECRET 本身，而它只存在于 so 的全局 0xa0d4（`nativeSetToken` 成功后写入）。
所以纯 Python 复刻必须先有办法跑 `nativeSetToken`。

---

## 5. 模拟器：把 so 跑起来（已能跑通，但过不了服务端）

`app/kd_native_emu.py` 用 unicorn 把 `libbaseutil.so`（armeabi-v7a，38 KB）跑起来：

- 手装两个 `PT_LOAD`、处理 `R_ARM_RELATIVE`、30 个导入符号全打桩（GOT 槽位指向 Python 桩）；
- **unicorn 的 ARM 没编 NEON**，文本段里 60 多条 `vld1/vst1/vmov` 由钩子逐条模拟；
- `md5_hex`（0x1c18）和变参拼串（0x1ef0）直接在 Python 里实现，便于顺手打印入参当证据；
- JNIEnv 是 300 项假函数表，`Context/PackageManager/PackageInfo/Signature` 返回预设对象，
  包名用 `com.kuaiduizuoye.scan`、证书用**从 APK 里抠出来的真证书**的 DER hex
  （`Signature.toCharsString()` 的语义就是 DER 的小写 hex）。

跑出来的东西：

```
$ python3 kd_native_emu.py --so libbaseutil.so --cert cert.der
signA = 0d0004050f050701040e070b050601020e0d060c...  (len=224)
拿 signB 失败: antispam 拒绝: errNo=7 errstr=antispam data error
get_sign -> error
```

JNI 调用序列（证明它真的按 App 的路径走完了设备信息那一段）：

```
FindClass android/content/Context
GetMethodID getPackageManager
CallObjectMethod getPackageManager
FindClass android/content/pm/PackageManager
GetMethodID getPackageInfo (Ljava/lang/String;I)
GetStaticFieldID GET_SIGNATURES / GetStaticIntField
GetMethodID getPackageName / CallObjectMethod getPackageName
GetMethodID getPackageInfo / CallObjectMethod getPackageInfo
GetFieldID signatures / GetObjectField signatures / GetObjectArrayElement 0
GetMethodID hashCode / toChars / toCharsString → CallIntMethod / CallObjectMethod toCharsString
```

**卡点**：我们自己拼出来的 `signA` 被服务端判 `errNo 7 "antispam data error"`。
可能性（未证）：so 里那段 DES 的输入还依赖某个我们在桩里给错的值（例如 4 段拼串的第 4 段，
运行时是空串），或者服务端另有一层与包名/证书/渠道相关的校验。

---

## 6. 已验证 / 未验证

**已验证（可复现）**

1. host + path + 方法：`POST https://www.kuaiduizuoye.com/kdtools/book/downloadanswer`。
2. 参数名与 0 基页码；`appId=scancode`；`cuid`、`_t_`、`sign` 的必需性（§2 的阶梯全是真的响应）。
3. 服务端 antispam 网关在参数校验之前。
4. `sign` 参数值的三段拼法（`<core>&_t_=&kakorrhaphiophobia=`）。
5. `paramString` = 排序无分隔拼接 + Base64(NO_WRAP)，Python/JS 双向一致，且与外部样本同形。
6. `nativeGetSign` 的拼串模板 `"%s[%s]@%s"`、前缀 `"8&%d*"`、两次 md5（反汇编 + 运行时追踪）。
7. `JNINativeMethod` 表把 4 个 native 方法映射到 0xd15/0xe91/0x1055/0x110d。
8. `signA` 的明文形状（4 段 `##` 分隔）和 10 位随机码的生成方式。
9. 网页端每本只有 3 页（`oriAnswers` 3 条 vs `answerCount` 18）。

**未验证 / 还差**

1. SECRET 的真实生成规则（`nativeSetToken` 内部），以及 signA 为何被服务端拒绝。
2. `downloadanswer` 成功响应的真实字段（只有 `imageUrl` 是反编译得来，没拿到过 errNo=0 的样本）。
3. 全书页数的权威来源：`answeranalysis` 的 `answers.count` 更靠谱，但同样被 antispam 挡住；
   目前只能从网页 `answerCount` 拿。
4. `answeranalysis` 的 `shumei` 参数语义（数美设备指纹，估计可以留空，未验证）。

---

## 7. 怎么用

### 7.1 现在就能跑（网页端，3 页）

```bash
python3 kd_full.py --book cee9bcf902dcb3ba990f58d7b7d82efe --out ~/下载/快对答案 --pdf
# 或者强制走网页端
python3 kd_full.py --book <bookId> --mode web --list
```

默认 `--mode auto`：先试 App 接口，拿不到签名/令牌就自动退回网页端，并在输出里说清楚只拿到了前 3 页。

### 7.2 有安卓设备时拿全书（桥）

```bash
# 设备侧（真机 / Waydroid / 模拟器，root + frida-server）
frida -U -f com.kuaiduizuoye.scan -l kd_bridge.js

# 本机
pip install frida
python3 kd_bridge_server.py --port 8710

# 任意脚本
python3 kd_full.py --book <bookId> --bridge http://127.0.0.1:8710 --out ~/下载/快对答案 --pdf
```

桥的 HTTP 协议（CORS 全开，浏览器扩展可以直接调）：

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| GET | `/health` | — | `{"ok":true,"ready":bool,"cuid":"..."}` |
| POST | `/init` | `{}` | `{"ok":true,"ready":bool}` 触发一次 antispam 握手 |
| POST | `/sign` | `{"pairs":["bookId=..","pageNo=0","appId=scancode"]}` | `{"ok":true,"sign":"<core>&_t_=..&kakorrhaphiophobia=.."}` |
| POST | `/sign_raw` | `{"param":"<base64>"}` | `{"ok":true,"sign":"<32hex>"}`（等价 nativeGetSign） |
| POST | `/downloadanswer` | `{"bookId":"..","pageNo":0}` | `{"ok":true,"imageUrl":"..."}` |

`/sign` 用的是 `com.zuoyebang.baseutil.a.a(List<String>)`——让 App 自己补 `_t_` 和
`kakorrhaphiophobia`，少一处可能算错的地方；`/sign_raw` 才是裸的 `nativeGetSign`。

浏览器侧（`kd_sign.js`）：

```js
const bridge = new kdSign.KdBridge('http://127.0.0.1:8710');
const sign   = await bridge.sign({bookId, pageNo: 0, appId: 'scancode', cuid: '...'});
// 或者一步到位让桥代理请求
const r = await bridge.downloadAnswer(bookId, 0);   // {ok:true, imageUrl:'...'}
```

### 7.3 纯算法（不需要设备）—— 只能算到第 2 层

```python
import kd_sign
ps = kd_sign.param_string({...})                 # 第 1 层，已验证
core = kd_sign.sign_core_from_secret("SECRET", ps)   # 第 2 层形态
```

`kd_sign.js` 里是同一套的 JS 实现（`paramString` / `signCore` / `signValue`），
`signValue` 需要你自己传 SECRET。

---

## 8. 复现命令

```bash
# 1) 反编译
jadx -d /tmp/kdjx --no-res --no-imports classes*.dex
grep -rn "downloadanswer" /tmp/kdjx/sources

# 2) 打接口（看校验阶梯）
BID=cee9bcf902dcb3ba990f58d7b7d82efe
curl -s -X POST -A 'kuaiduizuoye/5.14.0' \
  "https://www.kuaiduizuoye.com/kdtools/book/downloadanswer?bookId=$BID&pageNo=1&appId=scancode"

# 3) 提取 so + 看 native 表
unzip -o 快对_5.14.0_APKPure.apk 'lib/*/libbaseutil.so' -d /tmp/kdlib
readelf -rW /tmp/kdlib/lib/armeabi-v7a/libbaseutil.so | head -60
python3 -c "import struct;d=open('/tmp/kdlib/lib/armeabi-v7a/libbaseutil.so','rb').read();
[print(hex(0x9dbc+i), hex(struct.unpack('<I',d[0x8dbc+i:0x8dc0+i])[0])) for i in range(0,0x28,4)]"

# 4) 从 APK 里抠签名证书（模拟器要用，Android 的 Signature.toCharsString() 就是 DER 的小写 hex）
unzip -o -j 快对_5.14.0_APKPure.apk 'META-INF/*.RSA' -d /tmp/kdcert
openssl pkcs7 -inform DER -in /tmp/kdcert/*.RSA -print_certs -out /tmp/kdcert/cert.pem
openssl x509 -in /tmp/kdcert/cert.pem -outform DER -out /tmp/kdcert/cert.der

# 5) 跑模拟器（需要 pip install unicorn）
python3 kd_native_emu.py --so /tmp/kdlib/lib/armeabi-v7a/libbaseutil.so \
                         --cert /tmp/kdcert/cert.der -v
```

> 证书不是必须的：不给 `--cert` 时模拟器会用占位 DER，流程照样跑（只是服务端更不可能认）。
> 仓库里**不放** APK / so / 证书，这些都在 /tmp 里现做。

---

## 9. 一句话总结

接口本身已经被钉死（POST `https://www.kuaiduizuoye.com/kdtools/book/downloadanswer`，
`bookId`+`pageNo`+`appId=scancode`+公共参数+`sign`），签名链路的**结构**也全部读通了；
唯一没啃下来的是 `nativeSetToken` 内部的密钥生成 —— 它让 `signA` 过不了服务端，
于是整条 App 通道暂时只能靠「真机桥」打通。`kd_full.py` 的网页端通道可以立刻用（3 页），
桥打通后同一份脚本就是全书。
