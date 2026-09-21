# 02 · Replay Context 调研：Cookie 之外的请求上下文

> 调研对象：issue #13 —— Bridge 能否为某个 `targetUrl` 提供「最小 Request Context」，让 Node.js Service 用普通 HTTP 客户端重放该请求并成功下载资源。
> 本文只覆盖 **Cookie 之外** 的上下文（Headers / UA / Referer / 其它重放所需信息）。
>
> **证据等级**
> - `【文档确认】`：官方文档/标准原文明确写了。
> - `【文档推断】`：由官方文档的规则推导，文档没有直接这样写。
> - `【本机实测】`：在**本机 Node（v26.7.0 / undici 8.9.0）**上跑出来的结果，**不是浏览器实测**，只代表 Node 侧行为。
> - `【未验证】`：需真机抓包/浏览器实测才能定论。本文没有启动过任何浏览器，不声称浏览器侧实测。
>
> 所有结论后附官方链接；找不到官方说明的地方直接写「未找到官方说明」。

## 一句话结论摘要

**可以做，而且大部分请求头都能被 Node 忠实重建（`User-Agent` / `Accept` / `Accept-Encoding` / `Accept-Language` / `Referer` / `Origin` / `sec-ch-ua*` / `Sec-Fetch-*` / `Range` / `Priority` 等都可以显式设置），但「能设置」不等于「服务端认它是浏览器」**——Bridge 最容易交付的是**内容协商与来源上下文（UA + Client Hints + Referer + Accept 族）**，必须承认的是**传输层指纹（TLS/JA3-JA4、HTTP/2 SETTINGS 与 header 顺序、HTTP/3、连接复用）无法由 Node 忠实重建**；而三个**工程上最容易翻车的具体坑**是：① `undici` 的 `fetch` 在**跨域重定向时会删除手动设置的 `Cookie` / `Authorization` / `Proxy-Authorization`**（源码级 + 本机实测；`undici < 5.26.2` 反而是不删的，见 CVE-2023-45143），② `undici` 会**自动注入 `user-agent: node`、`accept-language: *`、`connection: keep-alive`、`sec-fetch-mode`**，不显式覆盖就是自报家门，③ 在 MV3 里**唯一能拿到真实 wire 请求头的手段是 `chrome.debugger` + CDP**——`chrome.webRequest` 官方明确写着它「不提供最终发到网络上的 HTTP 头」，`declarativeNetRequest` 则完全读不到头值。

---

## 1. 浏览器为一次子资源请求实际发送哪些头

以「安全上下文页面 → 跨域 HTTPS 的 `<img>` / `<video>` / `fetch()` 拉媒体」为基准。以下按来源分组。

### 1.1 协议层（不是「头」，但服务端看得见）

- HTTP/2 / HTTP/3 的伪头：`:method`、`:scheme`、`:authority`、`:path`，必须出现在常规字段之前。【文档确认】[RFC 9113 §8.3.1 Request Pseudo-Header Fields](https://www.rfc-editor.org/rfc/rfc9113.html#section-8.3.1)
- HTTP/1.1 下等价物是请求行 + `Host`。`Host` 是 **forbidden request header name**，页面 JS 无法设置。【文档确认】[MDN: Forbidden request header](https://developer.mozilla.org/en-US/docs/Glossary/Forbidden_request_header)、[Fetch Standard §2.2.2 Headers](https://fetch.spec.whatwg.org/#terminology-headers)

### 1.2 内容协商类

- `Accept`：由 **request destination** 决定，不是随手写的。`<img>` → destination `image`，`<video>` → `video`，`fetch()` → destination 为空串（`Sec-Fetch-Dest: empty`）。Fetch 标准为 `image` / `audio` / `video` 规定了**历史遗留的默认 Accept 值**（HTML 时代继承下来的具体串）。【文档确认】[MDN: Sec-Fetch-Dest](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Sec-Fetch-Dest)；具体串见 [Fetch Standard §4.4 HTTP fetch](https://fetch.spec.whatwg.org/#http-fetch) ——**具体字符串本文未逐字核对，标【未验证】，以抓包为准。**
- `Accept-Encoding`：浏览器固定值，至少包含 `gzip, deflate, br`（`zstd` 已是 IANA 登记的 content coding，较新的 Chrome 也会发）。【文档确认】编码取值与登记：[MDN: Accept-Encoding](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Accept-Encoding)；**Chrome 当前实际串（含顺序）未在官方文档中找到逐字说明，标【未验证】。**
- `Accept-Language`：来自浏览器 UI 语言设置，**页面无法影响浏览器实际发送的值**。该头不在 forbidden 名单里，但页面没有 API 能改它。【文档推断】[MDN: Forbidden request header](https://developer.mozilla.org/en-US/docs/Glossary/Forbidden_request_header)

### 1.3 User-Agent Client Hints

- **低熵（默认对所有请求发送，无需 `Accept-CH`）**：`Sec-CH-UA`、`Sec-CH-UA-Mobile`、`Sec-CH-UA-Platform`。【文档确认】[Chrome: Improving user privacy and developer experience with User-Agent Client Hints](https://developer.chrome.com/docs/privacy-security/user-agent-client-hints)
- **高熵（只有服务端用 `Accept-CH` 显式索取过，后续请求才带）**：`Sec-CH-UA-Full-Version`（已废弃）、`Sec-CH-UA-Full-Version-List`、`Sec-CH-UA-Platform-Version`、`Sec-CH-UA-Arch`、`Sec-CH-UA-Model`、`Sec-CH-UA-Bitness`。【文档确认】同上；[MDN: getHighEntropyValues()](https://developer.mozilla.org/en-US/docs/Web/API/NavigatorUAData/getHighEntropyValues)
- `Sec-CH-UA-WoW64`、`Sec-CH-UA-Form-Factors` 同属高熵。【文档确认】[MDN: getHighEntropyValues()](https://developer.mozilla.org/en-US/docs/Web/API/NavigatorUAData/getHighEntropyValues)、[Chrome 124 release notes](https://developer.chrome.com/release-notes/124)
- 这些头**只在安全连接上发送**，且值可能被 **GREASE**（故意掺入无效品牌/版本）。【文档确认】[Chrome UA-CH 文档](https://developer.chrome.com/docs/privacy-security/user-agent-client-hints)
- 所有 `Sec-` 前缀头都是 forbidden request header name，页面 JS 不能设置/修改。【文档确认】[MDN: Forbidden request header](https://developer.mozilla.org/en-US/docs/Glossary/Forbidden_request_header)

> **对重放的直接含义**：如果真实请求里出现了 `Sec-CH-UA-Full-Version-List`，说明该源站**曾经下发过 `Accept-CH`**；重放时把它一起带上是对的，但**凭空添加**一个真实请求里没有的高熵头，反而是异常信号。【文档推断】

### 1.4 安全 / 来源上下文类（Fetch Metadata）

Fetch Metadata 规范定义了四个头：`Sec-Fetch-Site`、`Sec-Fetch-Mode`、`Sec-Fetch-Dest`、`Sec-Fetch-User`。【文档确认】[MDN: Fetch metadata](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Fetch_metadata)

- `Sec-Fetch-Dest`：`image` / `video` / `audio` / `empty`（`fetch()`）/ `document` / `script` / `iframe`…【文档确认】[MDN: Sec-Fetch-Dest](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Sec-Fetch-Dest)
- `Sec-Fetch-Mode`：`navigate` / `no-cors`（图片、字体、脚本等子资源默认）/ `cors`（跨域 `fetch()`）/ `same-origin`。【文档确认】[MDN: Fetch metadata](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Fetch_metadata)
- `Sec-Fetch-Site`：`same-origin` / `same-site` / `cross-site` / `none`。【文档确认】[MDN: Fetch metadata](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Fetch_metadata)
- `Sec-Fetch-User`：**只有用户动作发起的请求才有**，值恒为 `?1`。【文档确认】同上
- `Sec-Fetch-Storage-Access`：Storage Access API 场景下出现（`entitlement` / `activate` / `none`）。【文档确认】[MDN: Sec-Fetch-Storage-Access](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Sec-Fetch-Storage-Access)
- `sec-purpose`（prefetch/prerender 提示）由 Fetch 标准定义。【文档确认】[Fetch Standard §3.8 Sec-Purpose header](https://fetch.spec.whatwg.org/#sec-purpose-header)

> **服务端风控最常做的就是 Fetch Metadata 校验**：一个「`Sec-Fetch-Dest: image` + `Sec-Fetch-Mode: no-cors` + 无 `Sec-Fetch-User`」的组合与「`fetch()` 直取」的组合，在源站眼里是完全不同的东西。重放时必须与真实请求**同型**。【文档推断】

### 1.5 引用来源

- `Referer`：由**发起请求的文档 URL + 该文档的 referrer policy** 决定，**不含 URL fragment，也不含 userinfo**。【文档确认】[MDN: Referer](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Referer)
- 默认策略 `strict-origin-when-cross-origin`：同源发全路径，跨源只发 origin。【文档确认】[MDN: Referrer-Policy](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Referrer-Policy)
- `Origin`：跨源请求、以及同源的**非 GET/HEAD** 请求会带；**跨源 `no-cors` 的 GET/HEAD（典型如 `<img>`）不带 `Origin`**；跨源重定向、跨源 `<img>/<video>/<audio>` 等情况下可能为 `null`。【文档确认】[MDN: Origin](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Origin)

### 1.6 缓存 / 范围 / 优先级

- `Range`：媒体元素拉流时会发 `Range: bytes=0-` 之类；`Range` 在**单个 byte range** 时是 CORS-safelisted，不触发预检。【文档确认】[MDN: Range](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Range)、[Fetch Standard §2.2.2](https://fetch.spec.whatwg.org/#terminology-headers)
- `If-Range`：续传条件；签名 URL 场景下如果 `Range` 被签入，`If-Range` 也必须被签入（见 §7）。【文档确认】[AWS S3 presigned URL 文档](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html)
- `Priority`：Chrome 124 起为**所有** HTTP 请求加 `Priority` 头，语法由 RFC 9218 定义（`u=0..7`，`i` 表示可增量处理）。【文档确认】[Chrome 124 release notes](https://developer.chrome.com/release-notes/124)、[RFC 9218](https://httpwg.org/specs/rfc9218.html#header-field)、[MDN: Priority](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Priority)
  - Chrome 对 `<img>` 具体发 `u=` 几，**官方文档未列举，标【未验证】。**
- `Upgrade-Insecure-Requests: 1`：客户端偏好加密响应的信号。【文档确认】[MDN: Upgrade-Insecure-Requests](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Upgrade-Insecure-Requests)；Chrome 是否对**子资源**也发，**未找到官方说明，标【未验证】。**

### 1.7 明确要说清的几件事

- `DNT`：是 forbidden request header name（页面 JS 不能设）。【文档确认】[MDN: Forbidden request header](https://developer.mozilla.org/en-US/docs/Glossary/Forbidden_request_header)；**Chrome 默认不发，未找到官方逐字说明，标【未验证】。**
- `Cookie`：由 cookie store 注入，页面 JS 不能设。【文档确认】同上前提；详细由 Cookie 子代理负责。
- HTTP/2 的 field 顺序：除「伪头必须在最前」外，RFC 9113 **没有**规定字段顺序，但服务端指纹方案普遍把顺序当特征。【文档确认】[RFC 9113 §8.3.1](https://www.rfc-editor.org/rfc/rfc9113.html#section-8.3.1)
- HTTP/2 下 `Cookie` 会被拆成多行再压缩。【文档确认】[RFC 9113 §8.2.3 Compressing the Cookie Header Field](https://www.rfc-editor.org/rfc/rfc9113.html#section-8.2.3)
- HTTP/2 禁止 `Connection`、`Keep-Alive`、`Transfer-Encoding`、`Upgrade` 等 connection-specific 字段。【文档确认】[RFC 9113 §8.2.2](https://www.rfc-editor.org/rfc/rfc9113.html#section-8.2.2)

---

## 2. 哪些能由 Node 忠实重建，哪些不能

这里必须**把两个问题分开**：

| 问题 | 含义 |
| --- | --- |
| **A. Node 能不能设这个头？** | 客户端能力问题。Node 不是浏览器，**不执行 Fetch 标准的 forbidden header name 名单**（那份名单是给 user agent 用的）。 |
| **B. 服务端能不能识破它不是浏览器发的？** | 服务端能力问题。取决于**该头本身是否可信**，以及**头以外的信道**（TLS、HTTP/2 帧、时序、连接复用）。 |

### 2.1 Node 能设的（实测确认）

【文档确认】[MDN: Forbidden request header](https://developer.mozilla.org/en-US/docs/Glossary/Forbidden_request_header) 列出的名单（`Accept-Encoding`、`Connection`、`Content-Length`、`Cookie`、`Date`、`DNT`、`Expect`、`Host`、`Keep-Alive`、`Origin`、`Proxy-*`、`Referer`、`Sec-*`、`TE`、`Trailer`、`Transfer-Encoding`、`Upgrade`、`Via` 等）在 **undici 里大多可以直接设置**；【本机实测】我实测能正常送到服务端的包括：`Cookie`、`Referer`、`Origin`、`User-Agent`、`Accept`、`Accept-Language`、`sec-ch-ua`、`Sec-Fetch-Dest`、`Sec-Fetch-Site`、`Sec-Fetch-User`、`Range`、`If-Range`、`Priority`、`DNT`、`Connection`。

### 2.2 Node 设不了 / 不该设的（实测确认）

全部来自【本机实测】（Node v26.7.0 / undici 8.9.0，本地回环 HTTP 服务端回声）：

| 头 | 实测结果 | 备注 |
| --- | --- | --- |
| `Host` | **被静默丢弃**，线上仍是 URL 推导出的真实 host | undici 在重定向处理里也无条件 `delete('host')`；与 undici「禁止 fetch 设置 host」的变更一致：[undici PR #2322](https://github.com/nodejs/undici/pull/2322) |
| `Transfer-Encoding` | **抛错** `TypeError: fetch failed`，`cause.code = UND_ERR_INVALID_ARG`，`invalid transfer-encoding header` | 传输层管理；`Keep-Alive` / `Upgrade` / `Expect` 同样直接抛错 |
| `Content-Length: 0`（GET 无 body） | **被丢弃** | 传输层管理 |
| `Content-Type: text/plain`（308 同源重定向后） | 被 undici 改写成 `text/plain;charset=UTF-8` | 与原始请求字节不完全一致 |
| `Referer` 头 + `referrer:` 选项同时给 | 两者被**合并**成 `https://example.com/from-header, https://example.com/` | 只能二选一 |
| HTTP/2 伪头 `:authority` / `:path` | `fetch` **不支持**（Node 官方文档明确 undici 是 HTTP/1.1 客户端） | 需换 `node:http2` 自己写 |
| **其余 forbidden header name** | **原样上线**：`Cookie` / `Cookie2` / `Date` / `DNT` / `Referer` / `Origin` / `Accept-Charset` / `Sec-*` / `Proxy-*` / `X-HTTP-Method: TRACE` 等 | undici 源码注释直言 *"forbidden request-headers, which undici doesn't implement"* |

### 2.3 服务端「识破」的可能性

见 §6。核心判断：**请求头这一层可以做到很像；传输层做不到像。**

---

## 3. User-Agent 怎么取才忠实

### 3.1 扩展 Service Worker（WorkerNavigator）

- extension service worker 的全局是 `WorkerGlobalScope`，其 `navigator` 是 `WorkerNavigator`；`WorkerNavigator.userAgent` 可用。【文档推断】[MDN: WorkerNavigator](https://developer.mozilla.org/en-US/docs/Web/API/WorkerNavigator)（该接口继承 `NavigatorID` 等，`userAgent` 在 worker 中可用；MDN 的 `WorkerNavigator.userAgent` 专页本次未逐字核对）
- `WorkerNavigator.userAgentData` **存在**，且 `NavigatorUAData`「available in Web Workers」，`getHighEntropyValues()` 同样「available in Web Workers」。【文档确认】[MDN: WorkerNavigator.userAgentData](https://developer.mozilla.org/en-US/docs/Web/API/WorkerNavigator/userAgentData)、[MDN: NavigatorUAData](https://developer.mozilla.org/en-US/docs/Web/API/NavigatorUAData)、[MDN: getHighEntropyValues()](https://developer.mozilla.org/en-US/docs/Web/API/NavigatorUAData/getHighEntropyValues)
- 条件：`userAgentData` 需要 **secure context**。【文档确认】[MDN: WorkerNavigator.userAgentData](https://developer.mozilla.org/en-US/docs/Web/API/WorkerNavigator/userAgentData)。`chrome-extension://` 是否被算作 secure context，**未找到官方逐字说明，标【未验证】。**
- 权限条件：`getHighEntropyValues()` 受 `Permissions-Policy: ch-ua-high-entropy-values` 控制，被拒绝时只返回 `brands` / `mobile` / `platform` 低熵值；**在扩展 SW 这种没有容器策略的顶层执行环境中，默认应为允许**。【文档确认】权限机制存在：[MDN: getHighEntropyValues()](https://developer.mozilla.org/en-US/docs/Web/API/NavigatorUAData/getHighEntropyValues)；【文档推断】扩展 SW 不受限；**是否真的返回高熵值需实测。**

### 3.2 页面上下文（USER_SCRIPT world）

- USER_SCRIPT world 是**隔离世界**（与 content script 的 isolated world 同类）：能访问同一份 DOM，但看不到页面自己 world 的 JS 变量。【文档确认】[chrome.userScripts API](https://developer.chrome.com/docs/extensions/reference/api/userScripts)、[Content scripts（isolated world）](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts)（该两页正文本次抓取被截断，仅确认页面存在；**V1 Bridge README 亦声明 USER_SCRIPT 为隔离世界**）
- 隔离世界里的 `navigator` 是**同一份底层 navigator**，因此**页面级 UA 覆盖会体现在这里**。【文档推断】

### 3.3 「某个 Tab 的 UA 被改写」时，谁说了算

Chromium 官方文档明确：UA override 有两个来源——**浏览器进程的 `WebContentsImpl::SetUserAgentOverride`** 和 **DevTools**；对 renderer / subresource 请求，覆盖行为取决于 `CommitNavigationParams.is_overriding_user_agent`，即**按 WebContents（Tab/Frame）生效**。【文档确认】[Chromium docs/user_agent/README.md](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/docs/user_agent/)

由此可推出的关键差异（均为【文档推断】，需实测确认）：

| 改写方式 | 页面/A USER_SCRIPT world 的 `navigator.userAgent` | 扩展 SW 的 `navigator.userAgent` | 线上请求头 `User-Agent` |
| --- | --- | --- | --- |
| DevTools 设备模拟（CDP `Network.setUserAgentOverride` / Device Mode） | 变 | **不变**（SW 是另一个 target） | 变 |
| `chrome.debugger` + CDP 覆盖 | 变 | **不变** | 变 |
| `declarativeNetRequest` `modifyHeaders` 改 `User-Agent` | **不变** | **不变** | 变 |
| 命令行 `--user-agent` / 企业策略 | 变 | 变（浏览器级） | 变 |

> **因此「权威 UA」不应该是扩展 SW 的 `navigator.userAgent`。** SW 只代表**浏览器默认 UA**，不代表该 Tab 的真实线上 UA。
> **权威来源排序建议**：
> 1. **直接观察到的线上 `User-Agent` 头**（§5，最强，但代价最高）；
> 2. **Work Tab 页面 / USER_SCRIPT world 的 `navigator.userAgent`**（能反映 DevTools/CDP 覆盖，但不能反映 DNR 改头）；
> 3. **扩展 SW 的 `navigator.userAgent`**（只能作为「没有被任何方式改写」时的兜底）。
>
> 而且：**HTTP 头层的真实值与 JS 可见值可能不一致**（`declarativeNetRequest` 就是这种情况），Bridge 若不观察线上头，就只能报告 JS 侧的值。【文档推断】

### 3.4 User-Agent Reduction 与 Client Hints 的一致性

- Chrome 自 **M110** 起全面推行 UA reduction，目的就是把 UA 串里的信息量降到最低；这也正是 UA-CH 出现的理由。【文档确认】[Chromium docs/user_agent/README.md](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/docs/user_agent/)（并链接到 [chromium.org/updates/ua-reduction](https://www.chromium.org/updates/ua-reduction/)）
- **redaction 的后果**：UA 串只剩「平台 + 主版本」（形如 `… Chrome/153.0.0.0 …`），而**精确的 build / patch、设备型号、CPU 架构 / bitness 只存在于高熵 Client Hints 里**。【文档确认】[Chrome UA-CH 文档](https://developer.chrome.com/docs/privacy-security/user-agent-client-hints)、[MDN: getHighEntropyValues()](https://developer.mozilla.org/en-US/docs/Web/API/NavigatorUAData/getHighEntropyValues)
- **Node 侧伪造一组一致的 `sec-ch-ua*` 必须注意**：
  1. **主版本一致**：`User-Agent` 里的主版本必须与 `Sec-CH-UA` / `Sec-CH-UA-Full-Version-List` 的品牌版本一致（例如 UA 是 `153.0.0.0`，CH 却是 `v="140"` 就是硬伤）。【文档推断】
  2. **平台一致**：`Sec-CH-UA-Platform` 必须与 UA 里的平台 token 对应（Chromium 文档明确要求二者同步改动）。【文档确认】[Chromium docs/user_agent](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/docs/user_agent/)
  3. **GREASE 要保留**：`Sec-CH-UA` 里那个故意无效的品牌项（如 `" Not;A Brand";v="99"`）是**规范要求**的行为，抹掉它对不上真实浏览器。【文档确认】[Chrome UA-CH 文档](https://developer.chrome.com/docs/privacy-security/user-agent-client-hints)、[UA-CH 规范](https://wicg.github.io/ua-client-hints/)
  4. **不要凭猜测补高熵头**：`Sec-CH-UA-Arch/-Bitness/-Model/-Platform-Version/-Full-Version-List` 只有在服务端 `Accept-CH` 要过之后才会出现；凭空加上是异常。【文档推断】
  5. **`Sec-CH-UA-Full-Version` 已废弃**，别用。【文档确认】[Chrome UA-CH 文档](https://developer.chrome.com/docs/privacy-security/user-agent-client-hints)
  6. **`Sec-CH-UA-Mobile: ?0` 的布尔语法**是 Structured Fields 的 `?0`/`?1`，不是 `0`/`1`。【文档确认】同上

---

## 4. Referer / Referrer-Policy 与 Bridge 的偏差

### 4.1 规则

- `Referer` = **发起请求的文档的 URL**，经过 referrer policy 的**截断/省略**处理后发出；**不带 fragment**，**不带 userinfo**；可能只有 origin，也可能整个头被省略。【文档确认】[MDN: Referer](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Referer)
- 各策略的效果（截断 / 省略 / 降级不发）：`no-referrer`（完全不发）、`origin`（只发 origin）、`origin-when-cross-origin`、`same-origin`（跨源不发）、`strict-origin`、`strict-origin-when-cross-origin`（**默认**，跨源只发 origin，且 HTTPS→HTTP 不发）、`unsafe-url`（全发）。【文档确认】[MDN: Referrer-Policy](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Referrer-Policy)
- referrer policy 还会影响 `Origin` 是否被置为 `null`（针对 navigate 类、非 cors 的请求）。【文档确认】同上（"Effect on the Origin header"）
- **重定向不改变 `request's referrer`**：Fetch 标准的 HTTP-redirect fetch 步骤只处理 URL、方法、body 与部分头的删除，不重算 referrer，因此**跨域重定向后第二跳的 `Referer` 仍是原始发起页**，而不是上一跳 URL。【文档推断】[Fetch Standard §4.5 HTTP-redirect fetch](https://fetch.spec.whatwg.org/#http-redirect-fetch)
- 反过来，**跨域重定向后 `Origin` 可能变成 `null`**。【文档确认】[MDN: Origin](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Origin)

### 4.2 Bridge 提供「Work Tab 当前 URL」作为 Referer 的偏差

- Referer 的语义是「**发起这次子资源请求的那个文档**」，而不是「Bridge 现在绑定的那个 Tab 的 URL」。【文档确认】[MDN: Referer](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Referer)
- 典型偏差：媒体请求的真实发起页可能是**已经导航走的页面**（媒体在后台继续加载）、**另一个 tab/frame**（iframe / 弹窗 / worker）、或者**完全不同的页面**（例如先打开详情页拿到媒体 URL，再回到列表页）。
- **Bridge 不做业务语义**，因此它**无法判断**某个 `targetUrl` 的真实 referrer 是哪一页；它能诚实提供的只有「Work Tab 当前 URL」+「该 URL 的 referrer policy（若要精确，还需读 `document.referrer` / `document.referrerPolicy`）」。【文档推断】
- **建议**：Bridge 侧最小、无业务语义的做法是**返回页面自陈的事实**——`location.href`、`document.referrer`、`document.referrerPolicy`，由 Service Script 决定怎么用；**不要把「当前 URL」包装成「Referer」**，那会把一个业务判断藏进 Bridge。【文档推断】

---

## 5. MV3 下能否观察页面真实发出的请求头

> 本节结论来自对官方文档/Chromium 源码的核对（并行调研），**【文档确认】的条目已附官方链接**；涉及 UI 行为的部分（提示条、DevTools 冲突）标【文档推断】或注明来源。

### 5.1 `chrome.webRequest`

- **MV3 仍然可以「观测」**，事件齐全：`onBeforeRequest`、`onBeforeSendHeaders`、`onSendHeaders`、`onHeadersReceived`、`onCompleted`、`onErrorOccurred`，另有 `onBeforeRedirect`、`onResponseStarted`、`onAuthRequired`。【文档确认】[chrome.webRequest](https://developer.chrome.com/docs/extensions/reference/api/webRequest)
- ⚠️ **但它给的不是真实 wire headers**。官方原文：**"the API does not provide the final HTTP headers that are sent to the network"**（原因是「一个 URL request 内部可能被拆成多个 HTTP 请求，例如为大文件抓取各个 byte range」）。【文档确认】同上
- **永远不可见（官方"不提供"清单，且原文声明该清单 "not guaranteed to be complete or stable"）**：`Authorization`、`Cache-Control`、`Connection`、`Content-Length`、`Host`、`If-Modified-Since`、`If-None-Match`、**`If-Range`**、`Partial-Data`、`Pragma`、`Proxy-Authorization`、`Proxy-Connection`、`Transfer-Encoding`。【文档确认】同上
  → **这对本调研非常关键**：`If-Range` 与 `Host`、`Content-Length`、`Connection` **在 webRequest 里根本拿不到**，而它们恰恰是签名 URL / 分片续传重放需要的头（§7）。
- **`extraHeaders` opt-in**：不加 `extraHeaders` 时看不到 `Accept-Language`、`Accept-Encoding`、`Referer`、`Cookie`（Chrome 72 起）以及 `Origin`（Chrome 79 起）；响应侧 `Set-Cookie` 同理（Chrome 72 起）。官方另有性能警告：`extraHeaders` "may have a negative impact on performance"。【文档确认】同上
- **缓存命中的请求完全不可见**：官方原文 "Requests that are answered from the in-memory cache are invisible to the web request API."。【文档确认】同上
- **可见范围受 host 权限约束**：需要同时拥有**请求 URL 与 initiator** 的 host 权限（Chrome 72 起）；只覆盖 `http/https/ftp/file/ws/wss/urn/chrome-extension` 等 scheme，且部分敏感 URL 被隐藏。【文档确认】同上
- **blocking 在 MV3 只剩 policy 安装的扩展**：官方原文 "As of Manifest V3, the 'webRequestBlocking' permission is no longer available for most extensions… Policy installed extensions can continue to use 'webRequestBlocking'."；Chromium `_permission_features.json` 里 MV3 分支为 `"location": "policy"`。【文档确认】同上 + [Replace blocking web request listeners](https://developer.chrome.com/docs/extensions/develop/migrate/blocking-web-requests)
- **请求 body 可见**：`onBeforeRequest` 加 `'requestBody'` 可拿到 `formData` / `raw`。这一点比 CDP 便宜。【文档确认】同上
- **MV3 SW 约束**：监听器必须在**全局作用域顶层同步注册**；SW 空闲 30s 即被终止（单次请求超过 5 分钟、fetch 响应超过 30s 也会终止）。【文档确认】[Service worker events](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/events)、[Service worker lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)
- **结论**：`webRequest + extraHeaders` 只能给出**近似头**，且**结构性缺失**一批重放关键头（`Host`/`If-Range`/`Content-Length`/`Connection`/`Authorization`），不能作为"以真实请求为模板重放"的权威来源。

### 5.2 `chrome.declarativeNetRequest`

- **完全不能读取头值**。官方原文：**"This lets extensions modify network requests without intercepting them and viewing their content"**。【文档确认】[chrome.declarativeNetRequest](https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest)
- `HeaderInfo`（Chrome 128+）只能做**条件匹配**（`header` 名 + `values` / `excludedValues` 模式），**匹配到的具体值不会回传给扩展**。【文档确认】同上
- `getMatchedRules` / `onRuleMatchedDebug` 只回传 `ruleId` / `rulesetId` / `tabId` / `timestamp`（外加 `RequestDetails`，其属性只有 `documentId/frameId/initiator/method/requestId/tabId/type/url` 等，**没有 headers 字段**）；`onRuleMatchedDebug` 仅对 **unpacked 扩展** 且需要 `declarativeNetRequestFeedback` 权限可用。【文档确认】同上
- 这些权限只写在 `declarativeNetRequest` 参考页里——**`declarativeNetRequestFeedback` 没有独立官方页面**（该 URL 实测 404）。【文档确认】
- 它能做的是 `modifyHeaders` 的 `set` / `remove` / `append`——**只能"伪装"，不能"取证"**。注意 `append` **只对一份白名单头有效**（含 `cookie`、`user-agent`、`range`、`accept*`、`connection` 等，`referer` / `origin` / `sec-*` **不在**白名单内）；官方也**没有**给出「禁止修改的头」清单。【文档确认】同上
- **结论：DNR 对重放上下文毫无用处。** 它唯一相关的用途是「用规则改写 UA/Referer 让页面发出的请求更像目标」，而不是收集上下文。

### 5.3 `chrome.debugger` + CDP —— 唯一能拿到真实 wire 头

- **`Network.requestWillBeSentExtraInfo.headers` 的官方字段注释是 "Raw request headers as they will be sent over the wire."**，且额外提供 `associatedCookies`（含被 `blockedReasons` 拦下的 Cookie）。【文档确认】[CDP Network 域](https://chromedevtools.github.io/devtools-protocol/tot/Network/)
  ⚠️ 措辞上的诚实说明：CDP 官方**没有**写过「`requestWillBeSent` 只含 reported headers」这种话；它的 `Network.Request.headers` 只被注释为 "HTTP request headers"，而 `requestWillBeSentExtraInfo` 被定义为来自**网络栈**的 additional information。因此「真实 wire 头以 ExtraInfo 为准」是**合理推论**，不是官方原话。【文档推断】
  另注：官方**不保证**两者先后顺序（"no guarantee whether requestWillBeSent or requestWillBeSentExtraInfo will be fired first"），必须按 `requestId` 缓冲配对。【文档确认】同上
- `Network` 与 `Fetch` 都在 `chrome.debugger` 允许的 domain 白名单内，因此还能 `Network.getRequestPostData` / `Network.getResponseBody` / `Network.responseReceivedExtraInfo`，或用 `Fetch` 域暂停与改写请求（`Fetch.continueRequest` 的 header override **不延续到后续重定向跳**）。【文档确认】[chrome.debugger](https://developer.chrome.com/docs/extensions/reference/api/debugger)、[CDP Fetch 域](https://chromedevtools.github.io/devtools-protocol/tot/Fetch/)
- **代价（必须写进报告，因为这是 Service/运维的决策）**：
  1. 权限 `debugger`，安装时显示警告 **"Access the page debugger backend"**。【文档确认】[chrome.debugger](https://developer.chrome.com/docs/extensions/reference/api/debugger)
  2. 附加后浏览器顶部出现 infobar，文案是 **"… started debugging this browser"**（不是 "is debugging"）；Chromium 源码注释明确该提示**在用户手动关闭前不会消失**，即使 debugger 已经 detach 也可能继续显示，且**扩展侧没有任何官方 API 可隐藏**。【文档确认（Chromium 资源串）+ 未找到官方抑制手段】
  3. **与已打开的 DevTools 不能共存**：官方 `onDetach` 原文——"This happens when either the tab is being closed or Chrome DevTools is being invoked for the attached tab."。【文档确认】
  4. **企业策略可阻止**：`runtime_blocked_hosts` 命中时 `attach()` 报 "Host access is restricted by policy."。【文档确认】
  5. ✅ 一个利好：**Chrome 118 起，活跃的 debugger session 会保活 service worker**，不会因为 SW 空闲回收而中断采集。【文档确认】[Service worker lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)

### 5.4 `chrome.devtools.network`

- 只对声明了 `devtools_page` 的扩展有效，且**要求 DevTools 窗口处于打开状态**才能拿到 `onRequestFinished` / `getHAR()`。【文档确认】[chrome.devtools.network](https://developer.chrome.com/docs/extensions/reference/api/devtools/network)
- **不能用于无人值守的 Node 重放服务。**【文档推断】

### 5.5 四者对比

| 机制 | 能读真实线上头？ | 能改写？ | 权限 | MV3 可用性 | 对 Bridge 的适用性 |
| --- | --- | --- | --- | --- | --- |
| `webRequest` | ❌ 只是近似头（官方明说不是最终 wire headers）；`Host`/`If-Range`/`Content-Length`/`Connection`/`Authorization` **永不可见**；`Cookie`/`Referer`/`Origin` 还需 `extraHeaders`；缓存命中的请求完全看不到 | 否（非阻塞） | `webRequest` + host（含 initiator） | 可用（仅观察） | 降级方案：不需要精确 wire 头时够用；**拿不到 `If-Range` 是硬伤** |
| `declarativeNetRequest` | **完全不能** | 是（`modifyHeaders`） | `declarativeNetRequest*` | 可用 | 只能"伪装"，不能当模板来源 |
| `chrome.debugger` + CDP | **✅ 是**（`requestWillBeSentExtraInfo` = wire headers） | 是 | `debugger` | 可用，但**有提示条**、与 DevTools 冲突、可被企业策略阻止 | ⭐ 唯一能满足"以真实请求为模板重放"的方案 |
| `chrome.devtools.network` | 是 | 否 | `devtools_page` | 需 DevTools 打开 | 不适用 |

> **建议**：重放链路按 **`chrome.debugger` + `Network.enable` + `requestWillBeSentExtraInfo` + `getRequestPostData` / `getResponseBody`** 设计；`webRequest + extraHeaders` 只能作为**不需要精确 wire 头时的降级方案**。
> 但要注意：**这会把 Bridge 从"零额外权限的通用桥"变成"带 debugger 提示条的、可被企业策略阻止的扩展"**，是一个需要 Service/产品侧拍板的架构决策，而不是实现细节。而且它仍然**解决不了 §6 的传输层指纹问题**——`requestWillBeSentExtraInfo` 给的是头，不是 TLS/h2 指纹。

---

## 6. 无法重建、必须承认的限制

### 6.1 TLS 指纹（JA3 / JA4）

- JA3 是把 TLS ClientHello 里的 version / cipher suites / extensions / elliptic curves / EC point formats 拼成指纹；**Node 的 ClientHello 与 Chrome 不同**（cipher 列表、extension 集合、GREASE、key share、ALPN、以及 Chrome 的 X25519Kyber768 混合密钥交换等）。【文档推断】[JA3 (salesforce/ja3)](https://github.com/salesforce/ja3)；Chrome 的 ML-KEM/Kyber 混合密钥交换见 [Chrome 124 release notes](https://developer.chrome.com/release-notes/124)
- JA4/JA4+ 是 JA3 的后继；Cloudflare 给出 JA3 失效的三个原因（Chromium 对 TLS extension **顺序随机化**、工具实现不一致、覆盖面窄且不含 QUIC），并说明 JA4 会**先对 cipher/extension 排序再哈希**以对抗随机化、且纳入 ALPN 维度。【文档确认（厂商文档/白皮书）】[FoxIO JA4](https://github.com/FoxIO-LLC/ja4)、[Cloudflare: Advancing Threat Intelligence: JA4 fingerprints and inter-request signals](https://blog.cloudflare.com/ja4-signals/)
- ⚠️ **与本调研最相关的是 JA4H（HTTP 客户端指纹）**：其指纹元素包括**方法 / 版本 / 是否带 Cookie / 是否带 Referer / Header 数量 / 按出现顺序的头名 SHA256 / Cookie 字段与值哈希**。也就是说——**"头集合 + 出现顺序"本身就是被哈希的对象**，Node 侧任何头名增减或顺序变化都会被观测到，不需要任何 JS 侧线索。【文档确认（官方 README/参考实现）】[FoxIO JA4 README](https://raw.githubusercontent.com/FoxIO-LLC/ja4/main/README.md)
- ⚠️ **许可证提醒（若 POC 打算用 JA4H 做自检工具）**：JA4 本体是 BSD-3，但其余 JA4+（含 **JA4H**）为 patent-pending + FoxIO License 1.1，官方表述是 *"not permissive for monetization"*。商用前需评估。【文档确认】同上
- **Node 官方没有提供「让 ClientHello 像 Chrome」的开关**；OpenSSL 也并非所有参数可配。【文档推断】——**「Node TLS 指纹与 Chrome 不同」的权威量化对比，未找到官方说明**；可信但**非官方**的来源是 Node 仓库 issue 中的 core 成员陈述（如 nodejs/node#41112），本文不作为结论引用。

### 6.2 HTTP/2 帧与 SETTINGS 指纹

- HTTP/2 连接由 **SETTINGS 帧**开局（`HEADER_TABLE_SIZE` / `ENABLE_PUSH` / `MAX_CONCURRENT_STREAMS` / `INITIAL_WINDOW_SIZE` / `MAX_FRAME_SIZE` / `MAX_HEADER_LIST_SIZE` 的取值与顺序）、随后是 `WINDOW_UPDATE` / `PRIORITY` 行为——这些组合本身就是客户端指纹。【文档确认】帧与设置定义：[RFC 9113 §6.5 SETTINGS](https://www.rfc-editor.org/rfc/rfc9113.html#section-6.5)、[§6.9 WINDOW_UPDATE](https://www.rfc-editor.org/rfc/rfc9113.html#section-6.9)、[§3.4 Connection Preface](https://www.rfc-editor.org/rfc/rfc9113.html#section-3.4)
- HTTP/2 指纹的具体维度由 Akamai 的白皮书给出：**SETTINGS 参数的集合、顺序与取值**、`WINDOW_UPDATE` 增量、`PRIORITY` 帧、以及**伪头顺序**（Chrome 为 `:method,:authority,:scheme,:path`，Firefox 为 `:method,:path,:authority,:scheme`），并指出多数客户端**不支持**修改这些细节。【文档确认（厂商白皮书）】[Akamai: Passive Fingerprinting of HTTP/2 Clients (Black Hat EU 2017)](https://blackhat.com/docs/eu-17/materials/eu-17-Shuster-Passive-Fingerprinting-Of-HTTP2-Clients-wp.pdf)
- RFC 9113 **已废弃** RFC 7540 的 priority 信令，改用 `PRIORITY_UPDATE` 帧 / `Priority` 头。【文档确认】[RFC 9113 §5.3 Prioritization](https://www.rfc-editor.org/rfc/rfc9113.html#section-5.3)
- **Node 的全球 `fetch` 默认走 HTTP/1.1，不是"完全不支持 h2"**（此处必须精确）：
  - Node 官方对 `fetch` 的描述是「基于 **undici，an HTTP/1.1 client written from scratch for Node.js**」。【文档确认】[Node.js Globals: fetch](https://nodejs.org/api/globals.html#fetch)
  - 但 undici 的 `Client` / `Agent` 有 **`allowH2` 选项**（需服务端 ALPN 选中 h2；明文 h2c 另需 `h2Options.useH2c`），且其文档明确 **伪头是由 undici 自动附加并覆盖用户提供值的**（"Pseudo headers (`:path`, `:method`, `:scheme`, `:authority`) are attached automatically and overwrite any user-provided values"）。【文档确认（undici 文档）】
  - 因此准确表述是：**默认 HTTP/1.1；开 `allowH2` 后可以走 h2，但伪头不可自定义、SETTINGS/帧行为与 Chrome 不同**。这仍然意味着"HTTP 版本与帧层指纹不可忠实重建"，只是原因不是"不支持 h2"。【文档推断】

### 6.3 header 顺序

- RFC 9113 只强制「伪头在前」，不规定其余字段顺序；RFC 9110 §5.3 的原文是 *"The order in which field lines with **differing field names** are received in a section is **not significant**. However, it is good practice to send header fields that contain additional control data first, such as **Host** on requests"*——**顺序"不重要"是协议语义，不是指纹语义**：熵恰恰来自标准留下的这块自由度（且 JA4H 直接对头名顺序取哈希，见 §6.1）。【文档确认】[RFC 9113 §8.3.1](https://www.rfc-editor.org/rfc/rfc9113.html#section-8.3.1)、[RFC 9110](https://www.rfc-editor.org/rfc/rfc9110.txt)
- **【本机实测】undici 的可控性**：用户提供的头**按插入顺序先发**，之后 undici 追加自己的 `sec-fetch-mode` / `pragma` / `cache-control` / `accept-encoding`。也就是说**顺序是部分可控的，但尾部会多出 undici 自己的字段，且无法把它们插到中间**。
- undici 的 `Headers` 迭代是**按名字排序**的（官方文档原文：iterable, yielding `[name, value]` pairs sorted by name）。【文档确认】[undici Fetch 文档](https://raw.githubusercontent.com/nodejs/undici/main/docs/docs/api/Fetch.md)
  → 用 `new Headers({...})` 构造再传出去，顺序会被规范化；要控制顺序需用数组 `[[name, value], ...]` 形式并注意这一点。【文档推断】

### 6.4 `Accept-Encoding` 与压缩实现差异

- 浏览器发的是它**自己能解**的编码集合；Node 侧即使发一模一样的串，**服务端仍可通过"返回 zstd/br 后客户端行为"间接判断实现**（例如某些编码组合只有在特定实现下才会被正确解码）。【文档推断】
- **好消息（【本机实测】）**：Node v26.7.0 / undici 8.9.0 的 `fetch` **能透明解码 `gzip`、`br`、`zstd`**，`Range` 请求除外（见下）。
- **坑（【本机实测】）**：
  - 不设 `Accept-Encoding` 时，undici 的默认值**与协议有关**：明文 `http:` 上是 `gzip, deflate`；TLS `https:` 上是 `br, gzip, deflate, zstd`（后者更接近 Chrome，但**顺序与 Chrome 不同**）。
  - **只要请求带 `Range`，undici 就强制把 `identity` 追加到 `Accept-Encoding`**：显式设 `gzip, deflate, br, zstd` 会变成 `gzip, deflate, br, zstd, identity`；不显式设则变成 `identity`。**这会和真实浏览器的媒体请求头直接冲突。**
  - 请求带 `If-Range` 时，undici 还会额外注入 `pragma: no-cache` 和 `cache-control: no-cache`。

### 6.5 HTTP/3 与连接复用

- Chrome 会对支持的站点走 QUIC/HTTP/3。**Node 没有内置 HTTP/3 客户端**，这是「协议版本」层面的不可重建。【文档推断】——**未找到 Node 官方"不支持 HTTP/3"的逐字说明，标【未验证】。**
- 连接复用：浏览器会把子资源请求**复用到同一条 HTTP/2 连接**上（`SETTINGS`/`WINDOW_UPDATE`/流 ID 递增都有特征）。【文档确认】[RFC 9113 §9.1.1 Connection Reuse](https://www.rfc-editor.org/rfc/rfc9113.html#section-9.1.1)；Node 侧是 HTTP/1.1 + keep-alive（【本机实测】默认发 `connection: keep-alive`）。

### 6.6 服务端风控如何可能识别重放（用于设定验收标准）

可被利用的信号（全部为【文档推断】，需真实靶站验证）：

1. **TLS ClientHello 指纹**与 UA 声称的浏览器不一致（JA3/JA4 不匹配 `Chrome/153`）。
2. **默认 HTTP/1.1 + `connection: keep-alive`**：一个自称 Chrome 153 的客户端却不用 h2/h3。（undici 可用 `allowH2` 走 h2，但伪头被自动覆盖、SETTINGS/帧行为仍与 Chrome 不同，见 §6.2。）
3. **undici 的自报特征**：忘了覆盖的 `user-agent: node`、`accept-language: *`、`sec-fetch-mode` 的固定注入、`pragma`/`cache-control` 的意外注入。
4. **Header 顺序与集合**：缺少 `sec-ch-ua-mobile` / `priority` / `sec-fetch-dest`，或出现浏览器不会有的组合。
5. **`Accept-Encoding` 与 `Range` 的 `identity` 追加**（§6.4）。
6. **Referer 与实际发起页不符**（§4.2）。
7. **连接/时序特征**：无 h2 复用、无 `PRIORITY_UPDATE`、请求间隔过于规整。
8. **出口 IP / ASN / 地理位置**与登录会话不一致（§8）。

---

## 7. 被 URL 本身携带的上下文

### 7.1 签名 URL / token

- 以 AWS S3 presigned URL 为例：URL 里带签名与过期信息（`X-Amz-Signature`、`X-Amz-Expires`、`X-Amz-SignedHeaders` 等），**签名时指定的 header 集合必须在重放时逐字匹配**。官方明确：出现 `SignatureDoesNotMatch` 时要「verify that all request parameters—including the HTTP method, headers, and query string—match exactly between URL generation and usage」，并且**代理可能修改 header 或 query string 导致签名不匹配**。【文档确认】[AWS S3: Download and upload objects with presigned URLs](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html)
- 过期语义：S3 在**收到请求时**校验过期时间；已经开始的大文件下载不会因中途过期而中断，但**断线后重连续传会失败**。【文档确认】同上
- 若 `Range` 被签入 `X-Amz-SignedHeaders`，则**出现的 `If-Range` 也必须被签入**，否则 `AccessDenied / HeadersNotSigned: if-range`。【文档确认】同上
- **对 Bridge 的含义**：签名 URL 的重放对「头集合」的**精确性要求高于普通 URL**；Bridge 若不能提供「与真实请求一致的头集合」，Node 侧的签名校验就会失败。而**签名 URL 的具体参数名属于站点业务/服务商语义，Bridge 不应理解**——它只需要把 URL 原样交给 Service。【文档推断】

### 7.2 `Range` 分片下载

- `Range: bytes=<start>-<end>`；服务端回 `206`；不支持则忽略并回 `200` 全量。【文档确认】[MDN: Range](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Range)
- **观察侧的硬伤**：`If-Range` 在 `chrome.webRequest` 的「不提供」清单里（§5.1），所以**用 webRequest 做上下文采集时续传条件头根本拿不到**；只有 `chrome.debugger` 能看到它。`Range` 本身是否可见**官方未说明**。【文档确认】（清单）+【未找到官方说明】（`Range`）[chrome.webRequest](https://developer.chrome.com/docs/extensions/reference/api/webRequest)
- **重放注意**：`Range` 会让 undici 追加 `identity` 到 `Accept-Encoding`（§6.4），从而可能与真实请求头不一致；若源站签名覆盖了 `Accept-Encoding`，可能直接失败。
- 分片重放的**认证上下文必须每片都带**（Cookie/签名都在 URL/头里），而跨域重定向会丢 Cookie（见下）。

### 7.3 重定向链（**本项为重点确认**）

1. **浏览器侧的规则**
   - Fetch 标准的 HTTP-redirect fetch **在跨域重定向时会删除一批头**（步骤 13），且 `Authorization` 会被删除（whatwg/fetch PR #1544 之后）。【文档确认】[Fetch Standard §4.5 HTTP-redirect fetch](https://fetch.spec.whatwg.org/#http-redirect-fetch)、[whatwg/fetch#553 讨论存档（明确指向 step 13）](https://lists.w3.org/Archives/Public/public-webapps-github/2025Mar/0179.html)
   - 具体被删除的头名单（`CORS-non-wildcard-request-header-name` 的定义）**本次未能取到标准原文，标【未验证】。**
   - 浏览器里 `Cookie` 不走"手动 header"这条路，而是由 cookie store 按**目标 URL** 重新注入，所以跨域重定向后带的是**新域的 Cookie**，不是原域的。【文档推断】
   - `Referer` 不因重定向而重算（§4.1）；`Origin` 在跨域重定向后可能变 `null`。【文档推断】/【文档确认】
2. **Node / undici 侧（【本机实测】，Node v26.7.0 / undici 8.9.0）—— 这是本节最需要记住的结论**

   | 场景 | 手动设置的 `Cookie` 是否保留 |
   | --- | --- |
   | 无重定向 | ✅ 原样发送 |
   | **同源**重定向（含改路径、308 保方法） | ✅ **保留** |
   | **跨域**重定向（换端口即算跨域，含 302 与 307） | ❌ **被删除** |

   - 跨域重定向时被删除的还有 **`Authorization`** 与 **`Proxy-Authorization`**；实测中 `Referer` / `Origin` / `User-Agent` / `Accept` / `Accept-Language` / `sec-ch-ua` / `Sec-Fetch-*` / `Range` / `If-Range` / `Priority` / `DNT` **都保留了**。
   - **源码级依据（undici `lib/web/fetch/index.js` → `httpRedirectFetch`，规范第 13 步位置）**：

     ```js
     if (!sameOrigin(requestCurrentURL(request), locationURL)) {
       request.headersList.delete('authorization', true)      // 规范第13步（CORS non-wildcard = Authorization）
       request.headersList.delete('proxy-authorization', true)
       // "Cookie" and "Host" are forbidden request-headers, which undici doesn't implement.
       request.headersList.delete('cookie', true)
       request.headersList.delete('host', true)
     }
     ```

     注意两点：① **删除条件只是 origin 不同**（scheme/host/port 任一不同即触发，本例中"同 host 不同端口"就算跨源）；② **`Host` 被无条件删除**，这也是 `Host` 无法伪造的原因。
     ⚠️ **规范与实现的差异必须分清**：Fetch 标准的第 13 步只删 `CORS non-wildcard request-header name`，**其定义就是 `Authorization`**——规范**并不要求**删 `Cookie`（浏览器里 Cookie 不在 header list 上，由 cookie store 在网络层注入）。undici 额外删 `proxy-authorization` / `cookie` / `host`，并在注释里把 `cookie`/`host` 归因于"undici 未实现 forbidden header name"。【文档确认（规范定义 + PR #1544 diff + undici 源码）】[whatwg/fetch PR #1544 diff](https://patch-diff.githubusercontent.com/raw/whatwg/fetch/pull/1544.diff)
   - **版本相关性（重要，且直接决定选哪个 Node）**：这是**安全修复的结果**。`CVE-2023-45143` / `GHSA-wqq4-5wpv-mx2g`（"Undici's cookie header not cleared on cross-origin redirect in fetch"）指出：*"Undici clears Authorization headers on cross-origin redirects, but does not clear Cookie headers … Since Undici handles headers more liberally than the specification"*。【文档确认】[GHSA-wqq4-5wpv-mx2g](https://github.com/nodejs/undici/security/advisories/GHSA-wqq4-5wpv-mx2g)、[CVE-2023-45143（Debian tracker）](https://security-tracker.debian.org/tracker/CVE-2023-45143)
     - undici **≤ 5.26.1 只删 `authorization`、不删 `cookie`**；**5.26.2 起修复**（commit `e041de359221ebeae04c469e8aff4145764e6d76`）。
     - 对应到 Node：**Node 18.19.0 / 20.10.0 起捆绑 undici 5.26.4（已修复）；Node ≤ 20.9.0 未修复。**【文档确认（Node CHANGELOG_V18 / CHANGELOG_V20）】
     → **同一份重放代码在不同 Node 版本上行为不同**，POC 必须锁定 Node 版本（用 `process.versions.undici` 打印确认）并显式处理重定向。
   - **结论：`fetch(url, {headers:{Cookie}, redirect:'follow'})` 在跨域重定向链上会静默丢掉 Cookie，下载会以未认证身份失败。** 这不是"会不会"的问题，是**默认一定发生**（且"同域不同端口/CDN 域名"就会触发）。
   - **规避方式（三种，按推荐度）**：
     1. `redirect: 'manual'` + 自己写重定向循环，每一跳都自己决定要不要带 `Cookie`。**undici 的 `redirect: 'manual'` 返回的是真实 3xx 响应**（【本机实测】：`status=302`、`type='basic'`、`redirected=false`），不像浏览器那样给 `opaqueredirect`，所以这条路完全可行。
     2. 先 `redirect: 'manual'` 解析出最终 URL，再对最终 URL **直接发一次不跟随重定向的请求**并带上全部头。
     3. 用 `node:http`/`node:https` 手写重定向循环（最可控，但失去 fetch 的解码便利）。
   - **另一个坑（【本机实测】）**：`redirect: 'manual'` 下拿到的 `Location` 若是相对路径，需要自己按当前 URL 解析。
3. **给 Service 的建议**：重放器**不要依赖 `redirect: 'follow'`**；把重定向链当作需要显式处理的协议步骤，并记录每一跳的实际头，便于诊断。

---

## 8. 出口网络上下文（Proxy / 出口 IP）

- Bridge 的职责边界里**没有 Proxy**：V1 架构明确把 `BrowserProfile`、`Proxy`、`Initial URL`、进程管理都划归 **Service**。【文档确认】[docs/architecture-v1.md §2 职责边界](../../architecture-v1.md)
- 这不仅是"分工"，也是**技术必然**：Proxy 决定的是**出口 IP / ASN / 地理位置**，属于**连接层**；而 Bridge 运行在浏览器内部，**看不到也提供不了** Node 侧应该用哪个出口。Node 重放要复现同一出口，只能由 Service 配置自己的代理（或与浏览器共用同一代理）。【文档推断】
- **风险（必须在报告里写清）**：
  1. **会话/IP 绑定**：很多站点把登录态或风控评分与来源 IP 绑定。浏览器走代理 A、Node 直连 B，会立刻暴露不一致（Cookie 有效但 IP 变化）。【文档推断】
  2. **代理会改头**：AWS 官方就点名"某些企业代理可能修改 header 或 query string，导致签名不匹配"，并建议"try testing without the proxy"。【文档确认】[AWS S3 presigned URL 文档](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html)
  3. **出口一致性无法验证**：Bridge 无法证明"当前浏览器的出口 IP"——这需要一次外部回显请求，属于业务动作，不属于 Bridge。【文档推断】
- **因此**：报告与 POC 验收标准必须写明——**「相同出口」是 Service 的责任，Bridge 不提供、也不保证**；若 Service 不配置与浏览器一致的代理，重放失败**不能归因于 Bridge**。【文档推断】

---

## 9. Node 侧重放可行性的官方依据 + 本机实测

### 9.1 forbidden header names 对 Node 不适用

- 该名单的语义是「**user agent** 保留控制权，页面 JS 不能设置」。【文档确认】[MDN: Forbidden request header](https://developer.mozilla.org/en-US/docs/Glossary/Forbidden_request_header)、[Fetch Standard §2.2.2](https://fetch.spec.whatwg.org/#terminology-headers)
- Node 不是 user agent、没有页面 JS 这个威胁模型，**undici 并未实现整份名单**（源码注释原话："forbidden request-headers, which undici doesn't implement"）：实测可以直接设置 `Cookie` / `Cookie2` / `Date` / `DNT` / `Referer` / `Origin` / `Accept-Charset` / `Sec-*` / `Proxy-*` 并原样送到服务端。【本机实测】
- 但 undici **另有自己的约束**：`Host` 被静默丢弃、`Transfer-Encoding` / `Keep-Alive` / `Upgrade` / `Expect` 直接抛错、`Content-Length` 被传输层接管。【本机实测】

### 9.2 默认注入的头（不覆盖就是自报家门）

【本机实测】不传任何 headers 时，undici 在明文 `http:` 上发出：

```
host: 127.0.0.1:PORT
connection: keep-alive
accept: */*
accept-language: *
sec-fetch-mode: cors
user-agent: node
accept-encoding: gzip, deflate
```

在 TLS `https:` 上 `accept-encoding` 的默认值不同（`br, gzip, deflate, zstd`）。【本机实测（子代理复现）】

- `user-agent: node`、`accept-language: *`、`connection: keep-alive`、`sec-fetch-mode: cors` 四个都是**浏览器绝不会发**的组合，必须显式覆盖。
- `sec-fetch-mode` 由 `mode` 选项决定（`cors` / `no-cors` / `same-origin`），**用户直接设置 `Sec-Fetch-Mode` 会被 undici 自己的值覆盖**（实测：传 `Sec-Fetch-Mode: no-cors` 但 `mode` 默认 `cors` 时，线上仍是 `cors`）。要发 `no-cors` 必须写 `mode: 'no-cors'`。
- **`mode: 'navigate'` 会被拒绝**：`TypeError: Request constructor: invalid request mode navigate`。【本机实测】
  → **重放一个"文档级导航请求"的头组合（`Sec-Fetch-Mode: navigate`）用 fetch 做不到。**
- `redirect: 'error'` 受支持，遇到重定向抛 `TypeError: fetch failed`。【本机实测（子代理复现）】

### 9.3 压缩 / 解码

- Node 官方：`fetch` 基于 **undici，Node 专用、从零写的 HTTP/1.1 客户端**。【文档确认】[Node.js Globals: fetch](https://nodejs.org/api/globals.html#fetch)
- 【本机实测】undici 对 `content-encoding: gzip` / `br` / `zstd` 都能**透明解码**；`getSetCookie()` 可正常取回多个 `Set-Cookie`（用 `headers.get('set-cookie')` 会被逗号合并，**不可靠**）。
- 【本机实测】显式设置 `Accept-Encoding` 时 undici **不会**再追加默认值（`Range` 场景除外，见 §6.4）。
- **版本下限**：Node 的 zstd zlib API（`createZstdDecompress` 等）`added: v23.8.0 / v22.15.0`，且标注 `Stability: 1 - Experimental`。【文档确认】[Node zlib 文档](https://nodejs.org/api/zlib.html)、[Node v22.15.0 release notes](https://nodejs.org/en/blog/release/v22.15.0)、[Node v23.8.0 release notes](https://nodejs.org/en/blog/release/v23.8.0)
  → **若 Service 运行在 Node ≤ 22.14，zstd 解压不可用**；并且 undici 广播 `zstd` 的边界版本尚未精确验证（6.x/7.x 只广播 `br, gzip, deflate`）。**POC 应锁定 Node 版本并实测。**

### 9.4 `Host` / `:authority`

- `fetch`：`Host` 设置被**丢弃**（实测服务端只看到真实 host）；undici 源码里 `httpRequest.headersList.delete('host', true)`，来自已合并的 [undici PR #2322](https://github.com/nodejs/undici/pull/2322)。【本机实测】+【文档确认（PR）】
- **但底层 API 可以**：`undici.request` / `Client` 会消费 `host` 头（`lib/core/request.js`）；`node:http` 可用 `setHost` / 直接设 `Host`；`node:http2` 的伪头就是**以 `:` 开头的普通 key**，实测可自定义 `:method` / `:path` / `:scheme` / `:authority`（服务端收到 `:authority: fake-authority.example`）。【本机实测（并行调研复现）】
- RFC 9113：所有伪头 **MUST** 出现在普通字段之前；`:authority` 存在时接收方 **MUST NOT** 使用 `Host`；直接生成 HTTP/2 请求 **MUST** 用 `:authority`。【文档确认】[RFC 9113 §8.3.1](https://www.rfc-editor.org/rfc/rfc9113.html#section-8.3.1)
- **结论**：`fetch` 无法控制 `Host`/`:authority`；要控制就得换 `node:http` / `node:http2`（或 undici 的低层 `request`），代价是失去 fetch 的解码与重定向便利。

### 9.5 `credentials` 在 Node 中的意义

- undici 的 `fetch` 接受 `credentials: 'omit' | 'include' | 'same-origin'`。【文档确认】[undici Fetch 文档](https://raw.githubusercontent.com/nodejs/undici/main/docs/docs/api/Fetch.md)
- 但 **Node 没有 cookie store**：不同于浏览器，`credentials` 不会让 fetch 自动带上任何 Cookie；`Set-Cookie` 必须自己用 `response.headers.getSetCookie()` 取回并自行管理。【文档确认】`getSetCookie()` 存在：同上；【本机实测】`credentials: 'include'` 不会自动带任何 Cookie。
- **结论**：Node 侧 Cookie 只能**手动从 `headers` 里塞**，这也正是 §7.3 那个跨域重定向删除陷阱之所以致命的原因。

### 9.6 与「忠实重放」相关的其它实测

- 同时给 `Referer` 头和 `referrer` 选项 → **两者被合并**成逗号串（实测值：`https://example.com/from-header, https://example.com/`）。二选一，别同时给。
- 302 跨域 POST → 变成 GET（符合标准）；307/308 → 保留方法与 body（实测）。跨域 307 的 Cookie 仍被删除。
- `response.type` 在跨域重定向后变为 `'cors'`。

---

## 重放能力总表

> 「取值来源」列：**页面** = Work Tab / USER_SCRIPT world 可读；**扩展 SW** = service worker 可读；**Node 构造** = Service 依规则/抓包自行构造。

| Header | 能否忠实重放 | 取值来源 | 风险备注 |
| --- | --- | --- | --- |
| `:method` `:scheme` `:authority` `:path`（HTTP/2 伪头） | ❌（`fetch` 不支持） | Node 构造 | Node `fetch` 是 HTTP/1.1（【文档确认】Node 文档）；要伪头必须 `node:http2` |
| `Host` | ❌ 被 undici 丢弃 | — | 【本机实测】；`node:http` 可设 |
| `User-Agent` | ✅ | **页面** `navigator.userAgent` 最接近；SW 值可能是浏览器默认而非本 Tab 真实值 | 默认发 `user-agent: node`，必须覆盖；DNR/CDP 改头后 JS 侧值 ≠ 线上值 |
| `sec-ch-ua` / `-mobile` / `-platform` | ✅ | **页面** `navigator.userAgentData` | 低熵、默认发送；必须与 UA/平台一致，保留 GREASE |
| `sec-ch-ua-arch` / `-bitness` / `-model` / `-platform-version` / `-full-version-list` / `-wow64` / `-form-factors` | ⚠️ 能设但**不该凭空补** | **页面** `getHighEntropyValues()`（需 secure context） | 只有服务端 `Accept-CH` 要过才真实存在；凭空加是异常 |
| `Accept` | ✅ | 依 destination 推导 / 抓包最准 | `image`/`video` 有历史遗留默认值（具体串未核对） |
| `Accept-Encoding` | ⚠️ 部分 | Node 构造（模仿 Chrome 串） | undici 默认 `gzip, deflate`；**带 `Range` 时强加 `identity`**；带 `If-Range` 时额外加 `pragma`/`cache-control` |
| `Accept-Language` | ✅ | **页面** `navigator.languages` | undici 默认 `*`，必须覆盖 |
| `Referer` | ✅（值需正确） | **页面** `document.referrer` + `document.referrerPolicy`；**不要**直接用 Work Tab 当前 URL | 真实发起页可能不是当前页；不含 fragment |
| `Origin` | ✅ | 按规则推导（跨源 `no-cors` GET 不发） | 跨域重定向后浏览器会置 `null` |
| `Cookie` | ✅（**但跨域重定向会丢**） | Cookie 子代理 | 【本机实测】跨域重定向删除 `Cookie`/`Authorization`/`Proxy-Authorization`；改用 `redirect:'manual'` |
| `Range` | ✅ | 抓包 / 依分片策略 | 触发 undici 的 `identity` 追加 |
| `If-Range` | ✅ | 抓包 | 触发 undici 注入 `pragma`/`cache-control: no-cache`；签名 URL 场景可能必须签入 |
| `Sec-Fetch-Dest` / `-Site` / `-User` | ✅ | 依发起方式推导 | 必须与真实请求**同型**；`Sec-Fetch-User` 只在用户动作时出现 |
| `Sec-Fetch-Mode` | ⚠️ 不可直接设 | 用 `mode` 选项控制 | 用户设值被 undici 覆盖；`mode:'navigate'` 直接报错 |
| `Sec-Fetch-Storage-Access` | ✅（罕见） | 抓包 | 仅在 Storage Access API 场景出现 |
| `Priority` | ✅ | 抓包（Chrome 124+ 必发） | 具体 `u=` 值未核实 |
| `DNT` | ✅ 能设，但**不该设** | — | 真实 Chrome 不发；发了反而异常 |
| `Upgrade-Insecure-Requests` | ✅ | 抓包 | Chrome 是否对子资源发送未核实 |
| `Connection` | ⚠️ 能设，但**不该设** | — | undici 默认 `keep-alive`，必须去掉；HTTP/2 下禁止 |
| `Transfer-Encoding` | ❌ 报错 | — | `UND_ERR_INVALID_ARG invalid transfer-encoding header` |
| `Content-Length` | ❌ 被管理 | — | 手动设会被丢弃 |
| `TE` / `Trailer` / `Upgrade` / `Via` / `Keep-Alive` | ⚠️ 一般不应出现 | — | 浏览器子资源请求通常没有 |
| `Content-Type`（重定向后） | ⚠️ 被改写 | Node 构造 | 实测 308 同源重定向后变 `text/plain;charset=UTF-8` |
| TLS ClientHello（JA3/JA4） | ❌ | — | Node 与 Chrome 不同，且无官方开关 |
| HTTP/2 SETTINGS / 帧 / 伪头 | ❌ | — | 默认走 HTTP/1.1；`allowH2` 可开 h2，但**伪头被 undici 自动覆盖**、SETTINGS/帧行为与 Chrome 不同 |
| header 顺序 / 头集合 | ⚠️ 仅插入序可控 | Node 构造 | 自动头永远排在用户头之后；**JA4H 直接对头名顺序取哈希** |
| HTTP/3 / QUIC | ❌ | — | Node 无内置 HTTP/3 客户端 |
| 出口 IP / ASN | ❌ 不属于 Bridge | **Service 配置 Proxy** | 架构文档已把 Proxy 划归 Service |

---

## 无法重建的部分与影响

1. **传输层不可重建（TLS / h2 帧 / HTTP 版本 / 连接复用）** → 服务端若有 TLS 或 h2 指纹风控，**无论请求头做得多像都会被打**。**这不是 POC 能修的**，只能换传输栈（超出 Node 普通 HTTP 客户端范围）。而且**头层本身也被指纹**：JA4H 的元素包含「头数量 + 按出现顺序的头名 SHA256 + 是否带 Cookie/Referer」，所以头的集合与顺序差异不需要 TLS 层就能被看见（§6.1）。
2. **Bridge 只能提供"事实"，不能提供"真相"** → Bridge 给出的是 Work Tab 页面自陈的 UA/URL/referrer policy；**线上真实头与 JS 可见值可能不一致**（`declarativeNetRequest` 就是这种情况）。想拿到**真实 wire 头**只有 `chrome.debugger` 一条路（`webRequest` 官方明说不提供最终发到网络的头，`declarativeNetRequest` 完全读不到头值）。若验收标准要求"与真实请求逐字一致"，就必须接受 `debugger` 权限 + 提示条 + 与 DevTools 冲突 + 可能被企业策略阻止这一整套代价。
3. **Referer 语义天然有偏差** → 子资源请求的真实发起页与 Work Tab 当前 URL 不保证相同，Bridge 不做业务判断就无法消除这个偏差。
4. **重定向链上的 Cookie 不能靠 `redirect:'follow'`** → 【本机实测】跨域即丢失。POC 若不显式处理重定向，会出现"看起来是风控、实际是自己丢头"的假失败。
5. **Proxy / 出口 IP 不属于 Bridge** → 浏览器与 Node 出口不一致导致的失败**不能归因于 Bridge**，必须写进验收标准的前置条件。

**对 POC 验收标准的建议（明确区分"Bridge 的交付"与"外生条件"）**：

| 层次 | 验收内容 | 责任方 |
| --- | --- | --- |
| L1 | Bridge 能给出 `targetUrl` 的重放上下文（UA + CH + Accept 族 + Referer 建议值 + 页面自陈事实），且与 Bridge 无业务语义的定位不冲突 | Bridge |
| L2 | Node 用该上下文 + Cookie + 与浏览器**同一出口**，能对**无风控的靶站**成功下载 | Service |
| L3 | 对**有指纹风控的靶站**成功 | **不作为 POC 承诺**；需先做指纹可行性预研 |
| L4 | Header 逐字一致（含顺序） | 用 `fetch` 不可达；需 `chrome.debugger` 观察 + 更底层的客户端 |

---

## 未解决问题（需实测）

> 以下均需**真机抓包/浏览器实测**，本文一律未验证。给出验证方法。

1. **Chrome 当前真实的请求头集合与顺序**
   方法：DevTools → Network → 右键请求 → `Copy as cURL`，或 CDP `Network.requestWillBeSentExtraInfo` 打印 `headers`；对同一目标分别用 `<img>`、`<video>`、`fetch()` 触发，比较 `Accept` / `Sec-Fetch-*` / `Priority` / `Accept-Encoding` 的实际值。
2. **`Accept` 的历史遗留默认串（image / video / audio）**
   方法：同上抓包，或读 Fetch 标准 `#http-fetch` 原文核对。
3. **`Priority` 在 Chrome 里对 `<img>` / `<video>` 的实际 `u=` 取值**
   方法：抓包。
4. **`Upgrade-Insecure-Requests` 是否出现在子资源请求上**
   方法：抓包比对导航请求与图片请求。
5. **扩展 SW 的 `navigator.userAgent` / `userAgentData` 是否反映 DevTools 设备模拟**
   方法：对某 Tab 开 Device Mode（或 CDP `Network.setUserAgentOverride`），在 SW console 与页面 console 分别打印 `navigator.userAgent`；预期 SW 不变、页面变（【文档推断】），需实测确认。
6. **`declarativeNetRequest` `modifyHeaders` 改 `User-Agent` 后，页面 `navigator.userAgent` 与线上头是否背离**
   方法：加一条 DNR 规则改 UA，页面打印 `navigator.userAgent`，同时抓线上头；预期 JS 侧不变、线上变。
7. **`chrome-extension://` 是否满足 `userAgentData` 的 secure context 要求；扩展 SW 里 `getHighEntropyValues()` 是否真的返回高熵值**
   方法：SW console 执行 `navigator.userAgentData.getHighEntropyValues([...])`。
8. **`chrome.webRequest` 实际能给出哪些头、与 CDP `requestWillBeSentExtraInfo` 差多少**
   已确认官方立场是"不给最终 wire headers"并有明确"不提供"清单（§5.1），但**清单原文声明 "not guaranteed to be complete or stable"**，且是否同样适用于 `onSendHeaders` 官方未说明。
   方法：同一请求分别用 `onSendHeaders`（带 `extraHeaders`）与 CDP `requestWillBeSentExtraInfo` 打印，逐条 diff。
   未找到官方说明的点（需实测）：`Range` 是否可见；页面自身 service worker 发出的 `fetch()` 是否可见。
9. **`chrome.debugger` 的实际可用性边界**
   已确认：权限警告 "Access the page debugger backend"、infobar "… started debugging this browser"（用户不关就不消失）、打开 DevTools 会 `onDetach`、企业策略可阻止 attach、Chrome 118+ 活跃调试会话保活 SW（§5.3）。
   **未找到官方说明**、需实测：infobar 能否被程序化隐藏；能否/如何 attach `chrome://` 页面；HTTP/2 伪头在 `requestWillBeSentExtraInfo` 里如何呈现。
   方法：附加 `debugger` 后观察 UI；对 `chrome://version` 尝试 attach；抓一个 h2 请求看 extraInfo 的 headers 里有没有伪头。
10. **跨域重定向删除 `Cookie` 的版本边界**
    已验证：undici ≥ 5.26.2 删除（CVE-2023-45143 修复），更早版本**不删**。仍需确认的是**目标运行环境实际捆绑的 undici 版本**（`process.versions.undici`），以及公司内其它 HTTP 客户端（axios/got/node:http）是否也有各自不同的行为。
    方法：用目标 Node 版本重跑本文的探针脚本（本地两个端口互跳即可复现）。
11. ~~Fetch 标准 HTTP-redirect fetch 步骤 13 删除头的完整名单~~ → **已解决**：规范第 13 步删的是 `CORS non-wildcard request-header name`，其定义**就是 `Authorization`**（规范 Note 原文：*"the moment another origin is seen after the initial request, the `Authorization` header is removed"*）。规范**不删 `Cookie`**；undici 多删的 `proxy-authorization` / `cookie` / `host` 是它自己补偿"未实现 forbidden header name"的行为。【文档确认】[whatwg/fetch PR #1544 diff](https://patch-diff.githubusercontent.com/raw/whatwg/fetch/pull/1544.diff)
12. **跨域重定向删 `Cookie` 的版本边界**
    已验证：undici ≥ 5.26.2 删除（CVE-2023-45143 修复），≤ 5.26.1 只删 `Authorization` 不删 `Cookie`；对应 Node **18.19.0 / 20.10.0 起**捆绑已修复的 undici 5.26.4，**Node ≤ 20.9.0 未修复**。
    仍需确认：目标环境的实际捆绑版本（打印 `process.versions.undici`）；以及 6.x / 7.x 中间版本只核过源码、未端到端实测；公司内其它 HTTP 客户端（axios/got/node:http/自实现跳转）行为各异，尤其是**用 `undici.request()` 自己实现跳转不经过 fetch 的删除逻辑**。
    方法：用目标 Node 版本重跑本文的探针脚本（本地两个端口互跳即可复现）。
13. **`mode: 'navigate'` 之外，浏览器「文档级导航」还有哪些头组合是 fetch 无法复现的**
    方法：抓一个真实的顶层导航请求头，尝试用 fetch 复现并逐条 diff。
14. **undici 广播 `zstd` 的起始版本、旧版 `allowH2` 默认值**
    方法：读对应 tag 的 undici 源码；本文只对 8.9.0 端到端实测。
15. **Node 没有 HTTP/3 的官方依据**
    方法：查 Node 文档/issue；本文只确认了"`fetch` 基于 undici、官方描述为 HTTP/1.1 客户端"【文档确认】。

---

## 参考链接汇总

> 正文已逐条附链接，这里只列「一次给全」的入口。

- 标准：Fetch <https://fetch.spec.whatwg.org/>（§2.2.2 Headers、§3.8 Sec-Purpose、§4.4 HTTP fetch、§4.5 HTTP-redirect fetch）｜ RFC 9113 HTTP/2 <https://www.rfc-editor.org/rfc/rfc9113.html> ｜ RFC 9218 <https://httpwg.org/specs/rfc9218.html> ｜ UA-CH <https://wicg.github.io/ua-client-hints/>
- MDN：Fetch metadata ｜ Forbidden request header ｜ Referer / Referrer-Policy / Origin / Range / Priority / Accept-Encoding / Upgrade-Insecure-Requests / Sec-Fetch-Dest / Sec-Fetch-Storage-Access ｜ `NavigatorUAData` / `getHighEntropyValues` / `WorkerNavigator.userAgentData`
- Chrome / Chromium：UA-CH 文档 <https://developer.chrome.com/docs/privacy-security/user-agent-client-hints> ｜ UA Reduction <https://chromium.googlesource.com/chromium/src/+/refs/heads/main/docs/user_agent/> ｜ Chrome 124 release notes <https://developer.chrome.com/release-notes/124>
- MV3：`webRequest` / `declarativeNetRequest` / `debugger` / `devtools.network` / `blocking-web-requests`（见 §5 正文链接）
- CDP：<https://chromedevtools.github.io/devtools-protocol/tot/Network/>、<https://chromedevtools.github.io/devtools-protocol/tot/Fetch/>
- Node / undici：<https://nodejs.org/api/globals.html#fetch>、<https://raw.githubusercontent.com/nodejs/undici/main/docs/docs/api/Fetch.md>、<https://github.com/nodejs/undici/pull/2322>、<https://github.com/nodejs/undici/security/advisories/GHSA-wqq4-5wpv-mx2g>、<https://security-tracker.debian.org/tracker/CVE-2023-45143>、<https://lists.w3.org/Archives/Public/public-webapps-github/2025Mar/0179.html>
- 指纹：JA3 <https://github.com/salesforce/ja3>、JA4 <https://github.com/FoxIO-LLC/ja4>、<https://blog.cloudflare.com/ja4-signals/>
- 其它：AWS S3 presigned URL <https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html> ｜ 仓库内 `docs/architecture-v1.md`（Proxy 属 Service）
