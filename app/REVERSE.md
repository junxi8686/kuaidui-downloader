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
| 纯算法能不能独立跑 | **目前不能**。卡在 antispam 握手：`/pluto/app/antispam` 对任何 `data`（空串到 224hex、换编码/换 host/换 appId/换版本）都回同一句 `errNo 7 antispam data error`，而 `data` 是 native 用一套非标准分组密码产出的（§6.5）。同 host 的 `/pluto/publish/checkappupdate` 不签名就 `errNo 0`，说明是 antispam 端点本身在卡 | 实测 + 反汇编 |
| 网页端 | 确实只有 3 页（`oriAnswers` 3 条，`answerCount` 18） | 实测 |
| 要不要账号 | **不要**。匿名就能拿到 `oriAnswers`；所有报错里从未出现 `USER_NOT_LOGIN`。缺的只是设备令牌 | 实测 |

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

## 6.5 无设备复现 antispam（第二轮，结论：走不通）

目标是把 `nativeInitBaseUtil → /pluto/app/antispam → nativeSetToken` 这段握手也搬到脚本里，
从而彻底去掉设备依赖。结论先说：**这一步在无设备条件下复现不了**，下面是完整证据。

### 6.5.1 握手请求的真实形状

```java
// com/baidu/homework/common/net/model/v1/PlutoAntispam.java
public static final String PATH = "/pluto/app/antispam";
this.__pid  = "antispam";
this.__method = 1;                    // POST
getParams() -> {"data": signA}        // 表单只有一个字段
toString()  -> getHost(pid) + PATH + "?data=" + encode(signA)
```

发起方（`com/zuoyebang/baseutil/a.java:78-84`）：

```java
a2 = NativeHelper.nativeInitBaseUtil(application, cuid);          // signA
PlutoAntispam p = (PlutoAntispam) Net.postSync(
        PlutoAntispam.Input.buildInput(a2), PlutoAntispam.class);
a3 = p.data;                                                      // signB
NativeHelper.nativeSetToken(application, cuid, a2, a3);
```

`Net.postSync(input, cls)` 走的是两参版本 → `appendUniqueCommonParamsForInputBase`（**不追加 sign**），
然后 `HWRequest.getParams()` 会把 query 里的键值再解析成 POST body（`HWRequest.java:390-410`），
所以真实请求是「query + body 各带一遍全部参数」。

host 方面：`getHost(pid)` 里 `pid="antispam"` 不在 host map 中 → 仍是 `www.kuaiduizuoye.com`
（`o.java:48-53`；注意 `pluto.zuoyebang.com` 只在 `pid="userinfra"` 这类映射里出现，
而且 `h.d().y` 不含 `/`，`lastIndexOf("/")==-1` 时代码直接 return host，不做域名替换）。

### 6.5.2 实测矩阵：服务端对所有输入回同一句

全部 `POST`，`data` 与公共参数一应俱全，逐个变体打（下表每一行都是一次真实请求）：

| 变体 | 结果 |
|---|---|
| `data=` 空 / `abc` / 32hex / 112hex / 224hex / 448hex / 大写 hex | `errNo 7 antispam data error` |
| `data` 放 body（body 只带 data / body 带全部参数） | 同上 |
| `data` = JSON、JSON 的 base64、`k=v` 串、`k=v` 串 base64 | 同上 |
| `data` = 56 字节密文的 hex / base64 / urlsafe-base64 | 同上 |
| `Content-Type: application/json` / `application/octet-stream`（body 直接塞二进制） | 同上 |
| 带 `sign=init_error&_t_=..&kakorrhaphiophobia=0`（未初始化时 App 会带的形态） | 同上 |
| 换 host：`pluto.zuoyebang.com`、`apivip.kuaiduizuoye.com` | 同上（apivip 恒 302） |
| 换 path：`/napi/user/antispam`（`o.java` 的 UrlRewriter 会把 pluto 路径改写成这个） | 同上 |
| 换 appId：scancode / college / kuaiduizuoye / zybang | 同上 |
| 换版本：vc=3000/3600/4000/4400/4800/5000/5100/5140 | 同上 |

两个例外：

- `/pluto/app/antispam/`（多一个斜杠）和 `/pluto/app/antispam/v1` → `{"errNo":6,"errstr":"antispam sign error"}`，
  这是**网关层另一个校验**（和 `/kdtools/web/search` 未签名时同一句），不是 antispam 服务的响应，
  反过来说明：真正的 antispam 服务只挂在精确路径上。
- `/pluto/publish/checkappupdate`（同 host、同 `/pluto/` 前缀）**完全不签名就返回 `errNo 0 success`**。
  也就是说 pluto 这条管道是通的、网关没拦，**只有 antispam 这个端点对 `data` 内容有硬要求**。

### 6.5.3 为什么判定「复现不了」

1. `data` 必须是 `nativeInitBaseUtil` 产出的那个 blob，服务端会先解它，解不开就统一回 `errNo 7`
   （空串、垃圾串、合法长度串、各种编码——全是同一句，说明判定发生在解密/验签的最外层）。
2. 我们在 unicorn 里把 `libbaseutil.so` 跑起来，`nativeInitBaseUtil` 能跑完并返回 224 个 hex 字符，
   但把这个自洽的 blob 交给服务端仍然 `errNo 7`。说明**模拟出来的 ciphertext 和真机的不同**。
3. 该 cipher 的**结构**已经确定，但**实现不是任何常见原语**：

   | 观测 | 依据 |
   |---|---|
   | 分组 8 字节、ECB 语义（相同明文块 → 相同密文块） | `0x3688("A"×24, "@fG2SuLA")` → 3 个完全相同的 8 字节块 + 1 个固定块 |
   | 填充是 PKCS5 风格（块对齐时补满 8 字节 0x08） | 8→16、16→24、24→32、53→56 字节 |
   | 密钥取 `.rodata 0x687c` 的 `@fG2SuLA` 8 字节 | `0x36a4: ldr r0,[r1]; ldr r1,[r1,#4]; strd r0,r1,[sp,#0x10]` |
   | 不是标准 DES | `E("AAAAAAAA")` 期望 `036114e86c6052bb`，标准 DES(key=`@fG2SuLA`) 给 `8b99d06565618936` |
   | 不是位序/字节序变体 | 试过输入/输出/密钥的逐字节位反转与块内逆序，全不匹配 |
   | 不是 TEA/XTEA | key 补零/重复/补空格 × 大小端 × 32 轮，全不匹配 |
   | 不是「密钥先做 md5」 | md5/sha1 派生的 8 字节密钥也试过 |

   `.so` 里确实带了 `des.c`（`.rodata 0x6c62`）和一整套 S 盒/置换表，
   但实际调用的这条路径输出与标准 DES 不符——很可能是被改过表的变体，或者密钥还叠了一层。

4. 也就是说，能不能离线签名，取决于这套**非标准分组密码**能否被完全静态还原。
   以当前证据（无设备、无真机对照样本）继续硬啃，收益不确定；先把结论钉死更有价值。

### 6.5.3b signA 的结构与编码 —— 已解（逐字节验证）

第三轮把 `nativeInitBaseUtil` 的产物彻底拆开了。先说一个**曾经把结论带偏的坑**：

> `nativeInitBaseUtil` / `nativeSetToken` / `nativeGetSign` 都是 **static** native，
> JNI 传参是 `(JNIEnv*, jclass, 真实参数...)`。按实例方法 `(env, thiz, ...)` 传，
> 会导致 `cuid` 落到 `Context` 槽、真正的 `cuid` 槽是未初始化值——
> 表现就是「signA 完全不随 cuid 变化、第 4 段恒为空」。
> 改正后 signA 立刻随 cuid 变长（256 vs 352 字符）。这条记下来，后面谁再接手别再踩。

**明文**（`nativeInitBaseUtil` 0xd64 处 `asprintf("%s##%s##%s##%s", ...)`，实参已 hook 打出来）：

```
8&%d*##<10位随机码>##<32位md5>##<cuid>
```

| 段 | 内容 | 来源 |
|---|---|---|
| 1 | `8&%d*` | `.rodata 0x687c` 附近的常量 |
| 2 | 10 位随机码 | 0x3c6c：`time(0)+clock()` 种 `srand48`，循环 10 次 `lrand48()%62` 查 `.rodata 0x6eaa` 的 `A-Za-z0-9` 表 |
| 3 | `md5(签名证书 DER 的 hex)` | **已用真证书验证**：`md5(cert.der.hex())` 与运行时值 `2fb53de6d38eff7109f19d68e047123b` 完全一致 |
| 4 | `cuid` 原样 | 参数直传 |

**最终编码**（0x2ea0）：把 DES 密文按字节拆两个 nibble，每个 nibble **反转 4 位**，
再各自格式化成 2 位 hex（低半字节在前）——即每字节 4 个字符。
`kd_sign.signa_encode()` 的实现与仿真器输出**逐字符相同**（352 字符 / 88 字节），
`signa_decode()` 可逆。所以：

```
signA = signa_encode( DES( "8&%d*##<nonce##md5(cert_hex)##<cuid>" ) )
```

**仍然缺的只有 DES 本身**。它是一套**改过的 DES**：

- `.rodata` 里能搜到标准表：S1 在 0x7740、PC1 在 0x7640（`<I` 与 `>I` 两种字节序都有）；
- DES 的互补性成立：`E(~P,~K) == ~E(P,K)`（实测第一块完全相等）；
- 但输出与标准 DES 不符，且**全零密钥下也不符**
  （`E("ABCDEFGH", 0x00×8)`：.so 给 `d303b8ba2d8bd76e`，标准 DES 给 `d3e6f4483c0ceba9`）；
- 把 `.rodata` 里所有 8 字节候选（1744 个）当密钥、以及 3DES/EDE 组合都试过，无一命中。

也就是说：轮函数或表的使用方式被改过。我们**不需要**复刻它——unicorn 跑的就是真代码；
但用它产出的 signA 交给服务端仍是 `errNo 7`（352 字符 nibble-hex、176 字符 hex、
原始二进制、base64 四种编码都试过）。最可能的残余差异是仿真里那些「真机上由运行时填、
我们给的是 0/占位」的内存（例如 0x3620 生成的那份 state），使得密文与真机不一致。

### 6.5.4 顺带确认的两件事

- **拿答案不需要登录**：书页/图片在匿名状态下可访问（我们全程没带任何 cookie 就拿到了 `oriAnswers`），
  `downloadanswer` 的报错也从未出现 `USER_NOT_LOGIN`（`ErrorCode` 里存在这个分支）。
  所以缺的只是**设备令牌**，不是账号。
- **令牌是长期有效的（如果拿到）**：`baseutil/a.java` 把 `signA/signB` 写进
  `LibPreference.KEY_ANTISPAM_SIGN_A/B`，每次启动优先读缓存，只有服务端回
  `ANTISPAM_SIGNERR` 时才 `baseutil.a.a(elapsedRealtime)` 清空重来。
  即一次握手拿到的令牌可跨重启复用，直到服务端判定失效。

### 6.5.5 关于「服务器只校验格式，所以格式对了就能换到 signB」

这句话对**前面几层**成立：`appId/cuid/_t_/sign` 的缺失会被一一指出（5115/5109/5110/5103），
说明服务端确实在按字段校验，而不是识别设备。

但对 antispam 这一步**目前拿不到验证**：我们已经能完整复算出 signA 的明文与编码
（§6.5.3b，逐字节对上），只剩变体 DES 的实现差异；把这个「格式完全正确」的 blob
用四种编码发过去，得到的仍是和「空字符串」一模一样的 `errNo 7`。
也就是说这个端点在当前状态下**不提供任何可区分的信息**，无法用它迭代。
要么密文内容（取决于那段改过的 DES）与真机不同，要么它还有我们看不见的一致性校验。
这两者在无设备条件下都无法区分。

### 6.5.5b DES 的位反序规则：数据路径确认，密钥路径待定

按 lead 给的规则 `密文 = bitrev_byte( DES_std( bitrev_byte(明文), 密钥 ) )` 做了对拍。

**数据路径成立**：全零密钥时逐字节命中。

| 明文 | 密钥 | 仿真器输出（8 字节） | bitrev(DES_std(bitrev(pt), 0)) |
|---|---|---|---|
| `4142434445464748` | `0000000000000000` | `d303b8ba2d8bd76e` | `d303b8ba2d8bd76e` ✅ |
| `4141414141414141` | `0000000000000000` | `913db19b3f697739` | `913db19b3f697739` ✅ |

**密钥路径不成立**：非零密钥下，`as-is` / `bitrev` / `byte-reversed` 三种都试过，全不命中。

| 明文 | 密钥(hex) | 仿真器 | 标准(bitrev 规则, 密钥原样) | bitrev(密钥) | 字节逆序密钥 |
|---|---|---|---|---|---|
| `ABCDEFGH` | `66646126385e2524` (`fda&8^%$`) | `4d0bedece0baa367` | `852a2d4429459a1c` | `96305caa5fc858d1` | `1546b9ab808bf686` |
| `0123456789ABCDEF` | `66646126385e2524` | `2fd03def80134604` | `5ebbbb9a31ef1d17` | `d8f150ba307be432` | `eac950c169919574` |
| `ABCDEFGH` | `4066473253754c41` (`@fG2SuLA`) | `e0c79155025ea5a9` | `6e46490d31a91599` | `56728016cc204d31` | `d46b697a4bd59334` |
| `ABCDEFGH` | `3132333435363738` (`12345678`) | `3238a081b7b6d07a` | `601e26844ed1ec4b` | `5cf26949224b05bc` | `66e786034f7ef8e7` |
| `ABCDEFGH` | `133457799bbcdff1` | `4b6835897cf30f9e` | `1bb43e6bdb411f12` | `1791bd07201cffd9` | `81ff75021669b500` |

单比特密钥探测（输入密钥只置 1 位，看输出是否等于某个「单比特 DES 密钥」的结果）得到的信息：
每字节只有 bit0 / bit5 / bit6 / bit7 能映射到单比特结果，bit1..bit4 找不到对应——
说明**密钥不是被简单地做位/字节置换**（4/8 的位被丢弃或混淆了）。这条留给继续啃的人。

> 注意：`E("AAAAAAAA", @fG2SuLA)` 早先记录的 `036114e86c6052bb` 确实是 JNI 传参 bug 期间的产物；
> 修正后同一调用是 `e0c79155025ea5a9`，与上表一致。

### 6.5.5c 一条完整可复现的 signA（固定 nonce，供对拍）

```
cuid  = F866E45663BDBA0F49A2405310D0891C|0
cert  = APK 里的 META-INF/KUAIWENZ.RSA 解出的 X.509 DER（775 字节）
md5(cert.hex()) = 2fb53de6d38eff7109f19d68e047123b
nonce = ABCDEFGHIJ                      （真机是随机的，这里是定值）

明文(88 字节) =
8&%d*##ABCDEFGHIJ##2fb53de6d38eff7109f19d68e047123b##F866E45663BDBA0F49A2405310D0891C|0

密文(88 字节, 仿真器输出) =
4d2dcce5438a3695a0f87a4d1e89f28cf764309bcdca27edfe1f6cd600bfe2bb
e4fd5488b35c19972d4f312d7367b384e40aa39366b3f9bfa661c69c1806a407
dffa1f8f06d41afa2a9b465169e1908dd751ccd92566472a

signA(352 字符, signa_encode(密文)) =
0b020b0403030a070c020501060c0a090005010f050e0b0207080901040f03010e0f0206000c0d090b0305030e040b07070f0f080306060b00000f0d04070d0d02070b0f020a01010c0d030a09080e090b040f02080c0b040c0e0e060c0d0201020705000c050c0906060c0d090f0f0d06050806060303090108060002050e000f0b050f0f080f010600020b0508050f05040d090602080a0906080700090b010e0b080a0303090b0a0406060e020504
```

（`kd_sign.signa_plaintext()` / `signa_encode()` 可复算前两步；第三步需要那段 DES。）

### 6.5.5d nativeSetToken：SECRET 不是算出来的，是 token 里拷出来的

`nativeSetToken`（0x0e90）尾段（0xff0–0x103c）读出来是这样：

```asm
00000ffc: bne 0xf76                  ; strlen(tok+0xc) != 0xa 就失败
00001010: blx #0xae0                 ; strcmp(两个 10 字符串)
00001018: movs r0, #0xb
0000101a: bl  #0xc2c                 ; 申请 11 字节
00001022: ldrh r1, [r4, #8]
00001024: strh r1, [r0, #8]          ; 拷贝第 9~10 字节
00001026: vld1.8 {d16}, [r4]
0000102a: vst1.8 {d16}, [r0]         ; 拷贝前 8 字节
0000102e: str r0, [r5]               ; ← 存进全局 0xa0d4
```

关键点：

- `r5` 指向的正是 **0xa0d4** —— 也就是 `nativeGetSign` 里 `md5_sec = *(0xa0d4)` 读的那个槽位；
- 存进去的是**从 token 里抠出来的 10 个字节**（8 + 2），**没有再过 DES、也没有再做 md5**。

也就是说：

```
SECRET = signB 里某一段固定的 10 字节
md5(SECRET) 就是 nativeGetSign 公式里的 [ ... ] 那 32 位 hex
```

`nativeSetToken` 其余的检查都是结构性的，且用的是 init 时拿到的设备信息（实测寄存器/内存）：

| 检查 | 对照物 |
|---|---|
| token 里 32 位 hex | `md5(inner+0x14)`，而 `inner+0x14` = 证书 hex（已核实 `2fb53de6…`） |
| token 里某段字符串 | `inner+0x08` = **cuid** |
| 结构 | 在 token 的 +0x11、+0x33 处写 NUL，再要求 +0x13 起 strlen == 0x20（32） |

补一条：`nativeSetToken` 收到 token 后**先 DES 解密**（0x38b0，和 0x3688 用同一套
key schedule 0x3334 / state 0x3620，密钥同样是 .rodata 0x687c 那 8 字节），
解出来的才是上面这个带内嵌 NUL 的结构体。所以 signB 也是一个「位反序 DES」密文，
只是换成解密方向。

**结论：零设备路线的最后一道门比想象中矮**——只要拿到过一个有效的 signB，
里面那段 10 字节就是 SECRET，之后 `md5(SECRET)` 一算，纯 Python/JS 就能签一辈子
（`kd_sign.LocalCore` 已经实现了这条路径，只差把这个 32 位常量填进去）。

### 6.5.6 如果将来想做「一次性握手 + 之后纯脚本」

需要一次性拿到 **`md5(SECRET)`**（注意不是 signA/signB 本身）：

```
sign_core = md5( "8&%d*[" + md5(SECRET) + "]@" + paramString )
```

只要那个 32 位 hex 常量到手，之后任何参数都能用纯 Python/JS 离线签（`kd_sign.sign_core_from_secret`）。
它可以从一台设备的任一次请求里取：hook `nativeGetSign` 的入参（就是 `"8&%d*[...]@..."` 明文），
或 hook 0xa0d4 指向的字符串后自己 md5。取到后写进 `app/token.json`，
`kd_full.py --token-file` 即可全程离线使用（不需要再跑 .so）。
在此之前，唯一可靠的全书通道仍是设备上的 frida 桥（§7.2）。

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
| GET/POST | `/secret` | — | `{"ok":true,"secret_md5":"<32hex>"}` —— **离线的钥匙** |
| POST | `/downloadanswer` | `{"bookId":"..","pageNo":0}` | `{"ok":true,"imageUrl":"..."}` |

> 拼 URL 时有个坑：`sign` 的值是**原样拼接**的，里面本来就有 `&_t_=..&kakorrhaphiophobia=..`，
> 拼完 URL 上必须能看见 `_t_` 和 `kakorrhaphiophobia` 这两个**独立顶层参数**
> （少了服务端回 `errNo 5110 lack time param: _t_`）。`kd_sign.build_query()` 已按此处理。

`/sign` 用的是 `com.zuoyebang.baseutil.a.a(List<String>)`——让 App 自己补 `_t_` 和
`kakorrhaphiophobia`，少一处可能算错的地方；`/sign_raw` 才是裸的 `nativeGetSign`。

浏览器侧（`kd_sign.js`）：

```js
const bridge = new kdSign.KdBridge('http://127.0.0.1:8710');
const sign   = await bridge.sign({bookId, pageNo: 0, appId: 'scancode', cuid: '...'});
// 或者一步到位让桥代理请求
const r = await bridge.downloadAnswer(bookId, 0);   // {ok:true, imageUrl:'...'}
```

### 7.3 一次性拿到 `md5(SECRET)` 之后：完全离线

`sign_core = md5("8&%d*[" + md5(SECRET) + "]@" + paramString)`——公式里只用到 SECRET 的 md5，
所以**只要那 32 位 hex**，之后任何参数都能纯 Python/JS 签，不用设备、不用 .so：

```bash
# 1) 找一个能跑快对的设备/模拟器，连一次 frida（只需一次）
frida -U -f com.kuaiduizuoye.scan -l kd_bridge.js
python3 kd_bridge_server.py --port 8710
python3 -c "import kd_sign; print(kd_sign.fetch_token('http://127.0.0.1:8710'))"
#    → 写出 app/token.json: {"secret_md5": "...", "cuid": "..."}

# 2) 之后彻底离线
python3 kd_full.py --book <bookId> --mode app --pdf
```

`kd_bridge.js` 里 `secretMd5()` 的做法：读 `libbaseutil.so` 基址 + `0xa0d4` 那个全局指针，
拿到 SECRET 字符串，用 `MessageDigest("MD5")` 取 md5。§4 反汇编里 `nativeGetSign` 正是从这里取值。

浏览器侧等价（`kd_sign.js`，已与 Python 逐字节对齐）：

```js
const sign = kdSign.signValueFromSecretMd5(secretMd5, {bookId, pageNo: 0, appId: 'scancode'});
const qs   = kdSign.buildQuery({bookId, pageNo: 0, appId: 'scancode'}, sign);
```

**有效期怎么判断**：`secret_md5` 跟着服务端发的那枚令牌走；App 端把 signA/signB 存进
`LibPreference`，只有收到 `ANTISPAM_SIGNERR` 才清空重来。所以只要令牌不失效就一直能用；
一旦开始收到 `errNo 6`/签名错，重跑一次第 1 步即可。

### 7.4 纯算法（不需要设备）—— 只能算到第 2 层

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

---

# §9 真机实证（2026-11-21 深夜补记）

设备：Waydroid + 快对 5.14.0（vc=660），已 root（Magisk 给 `[SharedUID] Shell` 授权），
mitmproxy 系统证书 + 全局代理，全链路抓包。

## 9.1 已确认的（都有实证）

| 项 | 结论 |
|---|---|
| SECRET | 从进程内存 `libbaseutil.so+0xa0d4` 读到的**指针**指向 10 字节：`33 51 4a 50 62 47 46 46 51 4a` = `"3QJPbGFFQJ"` |
| md5(SECRET) | `16da319cadec25d7897de248f446502f` |
| sign 公式 | **`md5("8&%d*[" + md5hex(SECRET) + "]@" + paramString)` 已用真机请求逐字节验证通过** |
| paramString | `base64( sorted("k=v") 直接拼接 )`，**不含** `_t_` / `kakorrhaphiophobia` |
| `_t_` | **秒级 epoch** |
| `kakorrhaphiophobia` | **开机以来毫秒数（uptime）**，不是 epoch 毫秒 —— 之前一直算错，导致 `5112 client time too old` |
| 公共参数 | 24 个：grade/gradeChangeTime/area/cuid/os/city/abis/channel/appBit/vc/token/adid/province/osVersion/pkgName/appId/vcname/sdk/operatorid/device/brand/nt + 端点参数 |
| 请求头 | `zyb-cuid` / `zyb-did` / `zyb-adid` / `x-zyb-trace-id` / `cookie: cuid=`，UA 是 WebView UA |
| 接口结果 | 用上述参数签 `/kdtools/book/downloadanswer` 得到过 `errNo:0 success` |

## 9.2 唯一还缺的一环：响应里的 imageUrl 是 RC4 加密的

```
{"errNo":0,"data":{"imageUrl":"5xozNZXfDoSPg3oySay+sMelkK3jjTAbZf1SQ4cuijdW8HuHqEibxXsX+EvzIi4Pp9MzH+1iY2bwuV7B/dh+lPpfNq/N9r/BLjZiYZA="}}
```

- 解密入口：`BookDownloadAnswer.imageUrl` 带 `@Decrypt` → `JtmConfig.decryptString` → `NetConfig.decryptString` → RC4
- RC4 的键：`com.kuaiduizuoye.scan.c.a.a.b()` 里 `f20813c = com.zuoyebang.baseutil.a.a(String.valueOf(BaseApplication.j()))`
  → 即 `NativeHelper.nativeGetKey(versionCode)` —— 又是个 native 函数
- 另有一处常量：`HWRequest.java:183` 用 `new RC4("vVkiD!@9vaXB0INQ")` 加密"随机 key"
- 试过 135 种"md5/原文 + 盐 + vc"的组合去解 imageUrl，全部不中 → 说明 nativeGetKey 不是简单哈希

## 9.3 因此当前状态

- ✅ 签名链路 100% 通（公式、参数、时间戳都对）
- ❌ 响应解密差一个 `nativeGetKey` 的算法
- 可选收口方式：
  1. 逆 `nativeGetKey`（跟 `nativeGetSign` 同一套 .so，工作量中等）
  2. 直接从设备内存里读 RC4 key（Java String，需要定位）
  3. 用 App 自己解密：抓 App 请求 `kd-book.cdnjtzy.com/scanimg/...` 的明文 URL（mitm 已能看到），
     即「App 翻页 + 抓包」就能拿到原图直链 —— 不依赖上面任何一步

## 9.4 补记：JNI 符号表（`.data.rel.ro` 0x8dbc）

按 12 字节一条解出来，函数指针在第 1 个字段（Thumb，最低位是 1）：

| 名称 | 地址 |
|---|---|
| nativeInitBaseUtil | 0x9dbc* |
| nativeSetToken | 0x0d15 |
| nativeGetSign | 0x0e91 |
| nativeGetKey | 0x1055 → Thumb 入口 **0x1054** |

> 修正一处旧结论：之前把 0x1054 当成 `nativeGetSign`，实际那是 **`nativeGetKey`**。
> （不过 sign 公式已用真机请求验证过，结论不受影响。）

`nativeGetKey` 的输入是 `String.valueOf(BaseApplication.j())` = `"660"`（versionCode）。
`BaseApplication.java:170` 里 `s = 660`。

拿 `.rodata` 里 192 个字符串 × 6 种拼法（原文 / md5 / MD5 / md5(vc+s) / md5(s+vc) / vc+s）共 1152 个候选当 RC4 密钥，
去解上面那个 imageUrl 密文，**全部不中** → 说明 `nativeGetKey` 不是简单哈希，里面还有别的处理
（0x1054 处先做 JNI 字符串转换，再 `bl 0x3978` / `bl 0x1ef0`，真正算法在这两个里面）。

另外：扫了 App 的 4 个主要堆区（73MB + 58MB + 19MB + 12MB，共约 150MB）的**全部可打印字符串
（含 UTF-16LE）**，逐个当 RC4 密钥试解，也没命中 —— 说明这个 key 在内存里不是以明文 ASCII 存在，
或者当前进程还没走到取 key 的那一步。
