# 调研/POC：受控 Browser Request Context 供 Service 下载媒体资源（issue #13）

> **状态：调研结论 + POC 实测，不是稳定 V1 契约。**
> 本文提出的 `GET_REQUEST_CONTEXT` / `REQUEST_CONTEXT` 是 **Draft**，`src/` 里的 V1 协议、状态机与 manifest 权限数组**一个字都没有改**。按 issue 的完成条件，先人工审核本文与 POC，通过后另开实现 Issue。
>
> | 项 | 值 |
> | --- | --- |
> | 实测浏览器 | Chrome for Testing **153.0.8010.52**（headless=new） |
> | 实测 Node | **v26.7.0**（内置 `fetch`/`WebSocket`，零第三方依赖） |
> | POC 扩展权限 | `storage` / `tabs` / `cookies` / `scripting` + `host_permissions: ["<all_urls>"]` |
> | 证据文件 | [`poc/evidence/request-context.json`](../../poc/evidence/request-context.json)（27/27 通过） |
> | 复现命令 | `node poc/service/run-poc.mjs`（详见 [`poc/README.md`](../../poc/README.md)） |
> | 调研笔记 | [`notes/01-cookie-api.md`](notes/01-cookie-api.md)、[`notes/02-replay-context.md`](notes/02-replay-context.md)、[`notes/03-bridge-gaps.md`](notes/03-bridge-gaps.md)、[`notes/04-service-side-need.md`](notes/04-service-side-need.md)、[`notes/05-node-replay-fidelity.md`](notes/05-node-replay-fidelity.md) |
>
> 证据等级：**【实测】**本机真机跑出来的（可复现）；**【文档】**官方文档明文；**【推断】**由文档/源码推出，未实测。

---

## 0. 结论摘要

1. **技术上可行，而且不需要任何"业务语义"。**【实测】MV3 扩展用 `chrome.cookies.getAll({ url })` 能拿到**HttpOnly** cookie（页面 JS 与 USER_SCRIPT world 都拿不到），把它拼成 `Cookie` 头交给 Node 后，Node 用普通 `fetch` 成功下载了与浏览器**逐字节相同**（SHA-256 一致）的受 Session 保护资源。
2. **最小权限增量是一个权限：`cookies`。**【文档】`"cookies"` 不产生额外安装警告文案；读取范围逐域受 `host_permissions` 限制；`getAll({url})` 由**浏览器自己**决定"哪些 cookie 适用于该 URL"，Bridge 从不需要枚举 cookie 库。
3. **但有三条必须承认的边界**，任何实现与验收标准都要写进去：
   - **CHIPS 分区 cookie**：不指定 `partitionKey` 时 `getAll({url})` **一个都不返回**（【实测】同一 URL：不带 partition 查询 0 个，带 `topLevelSite` 才看到那个 `Partitioned` cookie，而浏览器确实在跨站请求里发了它）。所以"分区"必须由调用方说明。
   - **UA / Referer / 其它头**：Bridge 只能给"页面自陈的事实"。**权威 UA 必须从 Work Tab 页面读**（【实测】页面级 UA 覆盖后：页面报 `RequestContextPOC/9.9`，扩展 service worker 仍报浏览器默认 UA）。
   - **传输层指纹无法重建**：TLS（JA3/JA4）、HTTP/2 帧与 header 顺序、HTTP/3、连接复用都不在 Node 普通 HTTP 客户端能力内（[02 §6](notes/02-replay-context.md)）。有指纹风控的靶站**不作为 POC 承诺**。
4. **需求侧证据与直觉相反，这是本次调研最重要的发现。**现役 Service（`pr-douyin`）**不发 Cookie、不设 UA、只写死一个 Referer**，就已经跑通视频/图集/音频/表情四类媒体；真正卡住它的是**签名 URL 约 3 小时过期后只能回浏览器重新观察**，以及**浏览器出口与后端出口不一致时无任何实现**（[04](notes/04-service-side-need.md)）。因此：
   > **建议：先不把本能力并入 V1。** 先补一条"带 Cookie 才成功 / 不带就失败"的真实失败复现证据（例如 `media_fetch_http_403` 那 9/416 的成因），再决定是否为一个当前用不上的能力永久扩大扩展权限面。
5. 如果决定要做，**最小改动面**是：manifest 加 `cookies`；新增纯逻辑模块；新增一条独立于 `EXECUTE` 的短请求（**不占 Job 槽、不被 `BUSY` 阻断、不受 `USER_SCRIPTS_UNAVAILABLE` 影响**）；`ERROR_CODES` 与 `isJsonCompatible` 不动（[03](notes/03-bridge-gaps.md) §3/§4）。Draft 见 [§8](#8-protocol-draft非稳定契约)。

---

## 1. 边界：为什么这不是业务能力

issue 的硬约束是 Bridge 不得理解 Douyin / Media / Video / Work。POC 与 Draft 都按这条做：

| 可能被误设计成 | 本方案实际提供的 |
| --- | --- |
| `GET_DOUYIN_COOKIES` | `GET_REQUEST_CONTEXT { targetUrl, scope?, topLevelSite? }` |
| `DOWNLOAD_DOUYIN_VIDEO` | 完全没有下载能力——下载永远由 Service 自己做 |
| `DOUYIN_MEDIA_CONTEXT` | 上下文只依赖"URL + 浏览器当前状态"，不知道 URL 是什么资源 |
| 判断"这个媒体能不能下/过期没" | 不判断；Signature、过期、`kind`、白名单全部留在 Service |

**Bridge 侧唯一新增的知识是"URL 之间的同源关系"**（`new URL(a).origin === new URL(b).origin`），这是 URL 语义，不是网站语义，也不含任何平台名。POC 的纯逻辑模块甚至没有任何 `import`，可原样移动到 `src/lib/request-context.js`（`tests/request-context-poc.test.js` 用一条断言把这条性质钉住）。

---

## 2. 逐条回答 issue 的调研目标

| # | 问题 | 结论 | 证据 |
| --- | --- | --- | --- |
| 1 | 哪些 API 能取适用于目标 URL 的 Cookie | `chrome.cookies.getAll({url})`（低权限）；替代方案 `chrome.debugger`+CDP（高权限，两条警告）| 【文档】[01 §1/§11](notes/01-cookie-api.md) |
| 2 | 是否包含 HttpOnly | **包含**。POC 的服务端下发 `HttpOnly` 会话 cookie，页面 `document.cookie` 看不到 `sid`，扩展返回的 `Cookie` 头里有它 | 【实测】`page.javascript-cannot-read-httponly-cookie`、`context.includes-httponly-session-cookie` |
| 3 | 如何限定到当前 Work Tab / Origin / 目标 URL | 两道闸：① API 语义上只返回**匹配该 URL** 的 cookie（`getAll({url})`，`getAll({})`/`getAll({domain})` 明确禁止）；② Bridge 侧 scope 检查，默认要求 `targetUrl` 与 Work Tab **同源** | 【实测】`scope.cross-origin-refused-by-default`、`scope.cross-origin-returns-only-that-hosts-cookies` |
| 4 | 重放还需要哪些上下文 | 最小集：`targetUrl`（**原样含签名**）、`cookieHeader`、`userAgent`、`referer`、`observedAt`。其余（`Accept*`、`sec-ch-ua*`、`sec-fetch-*`）可由 Node 按规则构造 | 【实测】+[02 §1/§9](notes/02-replay-context.md) |
| 5 | UA 是否需要 Bridge 提供 | **需要，且必须从 Work Tab 页面读**。扩展 SW 的 `navigator.userAgent` 在页面被覆盖时是错的 | 【实测】`user-agent.context-follows-the-page-not-the-worker` |
| 6 | Referer / 当前页面 URL 怎么给 | Bridge 给 Work Tab 当前 URL（去 fragment）作为**建议值**，另外把页面自陈的 `document.referrer` 作为**事实**单独返回；**真实发起页可能不是当前页**，而且**实测 Chrome 153 页面里 `document.referrerPolicy` 是 `undefined`**，生效策略拿不到 | 【实测】`context.referer-is-the-work-tab-url`、`context.reports-page-self-reported-referrer-facts`；【文档】[02 §4](notes/02-replay-context.md) |
| 7 | 哪些 Header 能可靠取得/重建 | 能重建：`User-Agent`、`Accept`、`Accept-Encoding`、`Accept-Language`、`Referer`、`Origin`、`sec-ch-ua*`、`Sec-Fetch-*`、`Range`、`Priority` | 【实测】POC 捕获了 Chrome 153 的真实请求头，见 [§7.3](#73-浏览器真实请求头实测chrome-153) |
| 8 | 哪些 Header 是浏览器生成、不该导出 | TLS 指纹、HTTP/2 伪头与 SETTINGS、header 顺序、`Host`、HTTP/3；另有 `DNT`/`Connection` 等"设了反而异常"的项 | 【文档】[02 §2/§6](notes/02-replay-context.md) |
| 9 | SameSite / Secure / Partitioned 影响 | SameSite **不影响读取**（只影响浏览器发送，POC 实测 `SameSite=Strict` cookie 照样返回）；Secure 需与目标 URL 的 scheme 一致（localhost 有例外，POC 里 `http://localhost` 查询拿到了 `Secure` cookie）；**Partitioned 必须显式指定分区，否则返回空** | 【实测】三条检查 + [01 §6/§7/§9](notes/01-cookie-api.md) |
| 10 | 需要哪些 permissions / host_permissions | `permissions: ["cookies"]`（不新增警告文案）；host permissions **逐域**限制读取范围 | 【文档】[01 §3](notes/01-cookie-api.md)；【实测】POC 用 `cookies`+`scripting`+`tabs`+`storage` 跑通 |
| 11 | 当前 Bridge 已具备哪些能力 | Work Tab 身份（`tabId`）现成，但**运行期从不持有 URL**（只在判定与导航时用），取 URL 要在请求时刻 `chrome.tabs.get`；`storage.session` 只存 `{rememberedTabId, boundTabWasClosed}`；`isJsonCompatible` 只在 EXECUTE 路径校验；错误码只有 3 个 | 【文档】[03 §1/§2](notes/03-bridge-gaps.md)（带 `文件:行号`） |
| 12 | 最小新增能力是什么 | 一条只读短请求 + 一个纯逻辑模块 + 一个权限；**不碰** `ERROR_CODES`、`isJsonCompatible`、Job 状态机语义 | [§6](#6-最小改动面与方案对比)、[§8](#8-protocol-draft非稳定契约) |

---

## 3. Cookie 通道（摘要）

完整版见 [notes/01-cookie-api.md](notes/01-cookie-api.md)（含官方链接与 Chromium 源码引用）。要点：

- **写入方不需要 Bridge 做任何事**：`"cookies"` 权限 + 目标域 host permission 即可读，含 HttpOnly；`"cookies"` 在官方权限清单里**没有**警告文案段（对照 `"debugger"` 有两条）。
- **只读、按 URL 收敛**：`getAll({url})` 的实现是 `CookieManager::GetCookieList(url, …)`，会逐 cookie 检查 host permission 并把无权限的静默丢弃。`getAll({})` 在当前 `<all_urls>` 下等于导出整个 cookie 库——**必须禁止**。
- **`domain` 过滤会带出子域**，`path` 是精确相等，`secure:false` / `session:false` 等于不过滤，**没有 `sameSite` 过滤参数**（要按 SameSite 裁剪只能自己遍历）——这些"看起来能用"的参数都不能当成最小化手段。
- **读取语义是"存储里匹配该 URL 的全集"，不是"浏览器此刻会发的集合"**：SameSite、第三方拦截都不参与读取。所以 Bridge 交付的是**事实采样**，不是**流量录制**；Service 若想更接近浏览器行为，得自己再套一层策略。
- **Partitioned**：默认所有方法只操作非分区 cookie；`partitionKey: { topLevelSite }` 才会带上分区。顶层站点的 schemeful site 才是 key（POC 传了带端口的 origin，Chrome 归一化成了 `http://127.0.0.1`）。`chrome.cookies.getPartitionKey({tabId, frameId})`（Chrome 132+）可以问某个 frame 的分区键。
- **替代方案对比**：`chrome.debugger`+CDP 也能读到值（且不需要 host permission），代价是两条权限警告 + 调试提示条 + 与 DevTools 冲突 + 可能被企业策略整体禁用；`chrome.webRequest` 只能观察且官方明说"不提供最终发到网络的头"；`declarativeNetRequest` **读不到头值**。**若只是要 Cookie，`chrome.cookies` 的权限成本低一个数量级。**

---

## 4. 重放上下文（Cookie 之外，摘要）

完整版见 [notes/02-replay-context.md](notes/02-replay-context.md)。工程上最需要记住的四件事：

1. **能设置 ≠ 像浏览器**。`User-Agent` / `Accept*` / `Referer` / `Origin` / `sec-ch-ua*` / `Sec-Fetch-*` / `Range` 都可以由 Node 显式设置，但 TLS 指纹、HTTP/2 帧与 header 顺序、HTTP/3、连接复用**无法重建**——有指纹风控的靶站不因"头伪造得像"而放行。补充两点精确表述：**(a)** 头这一层本身也在被指纹：JA4H 一类指纹直接对"是否带 Cookie / 是否带 Referer / **头的数量** / **按出现顺序的头名哈希**"取值，所以多一个头、少一个头、换一次顺序，**不需要 TLS 就能被观测**；**(b)** 不是"Node 不支持 HTTP/2"（undici 的 `allowH2` 可开），而是**伪头由 undici 自动附加并覆盖调用方提供的值**，帧行为与 Chrome 不同——不可保真的是帧层，不是协议版本（[02 §6](notes/02-replay-context.md)）。
2. **不覆盖就是自报家门**：undici 的 `fetch` 默认发 `user-agent: node`（【实测】POC 里服务端确实收到 `node`）、`accept-language: *`、`connection: keep-alive`；`Accept-Encoding` 默认与 Chrome 不同，且**带 `Range` 时会被强加 `identity`**。
3. **跨域重定向会丢 `Cookie`**：undici ≥ 5.26.2 在跨域重定向时删除 `Cookie`/`Authorization`/`Proxy-Authorization`（CVE-2023-45143 的修复；对应 **Node 18.19.0 / 20.10.0 起已修复**，`undici ≤ 5.26.1`（Node ≤ 20.9.0）**只删 `Authorization`、不删 `Cookie`**，所以同一份重放代码在不同 Node 上行为不同）。用 `redirect:'follow'` 重放会得到"看起来像风控、实际是自己丢头"的假失败。**POC 的下载验证走的是同源直连，没有覆盖这一条**——它是 Service 侧必须自己处理的坑。逐项对照（`fetch` / `node:http` / `node:http2` 各自能忠实重放什么）见 [notes/05-node-replay-fidelity.md](notes/05-node-replay-fidelity.md)。
4. **出口 IP 不属于 Bridge**：浏览器可能走 Proxy，Node 重放必须走同一出口，否则 Cookie 救不了。这是 Service/Execution Profile 的职责，也是验收标准的前置条件。

---

## 5. 当前 Bridge 的能力与差距

详见 [notes/03-bridge-gaps.md](notes/03-bridge-gaps.md)（逐条带 `文件:行号`）。结论摘要：

| 现成的 | 缺的 |
| --- | --- |
| Work Tab `tabId`（`bridge-state.js` 传给 executor） | **URL 运行期从不持有**——须在请求时刻 `chrome.tabs.get(tabId)`（`tabs` 权限已有） |
| `storage.session` 只存 `{rememberedTabId, boundTabWasClosed}`，`storage.local` 只存 `serviceUrl` | 没有任何 `chrome.cookies` / 网络能力（全仓 `cookies\|webRequest\|declarativeNetRequest\|fetch(` 零命中） |
| `isJsonCompatible` 的严格校验（拒绝 DOM 节点、访问器、循环引用） | 该校验只在 EXECUTE 路径调用；新路径**必须自己调**，而且 `chrome.cookies.Cookie` 本体因原型不是 `Object.prototype` **会被拒**，必须白名单拷贝字段 |
| `NOT_READY` / `BUSY` / `SCRIPT_EXECUTION_FAILED` 三个码 | 没有"请求身份"概念（只有 `jobId`）；`notReadyReason()` 会把 `USER_SCRIPTS_UNAVAILABLE` 也算进去，而**上下文请求不该被"未开启 Allow User Scripts"阻断** |

---

## 6. 最小改动面与方案对比

四个候选（[03 §4](notes/03-bridge-gaps.md) 有完整评分）：

| 方案 | 改动面 | 对 V1 冻结契约的破坏 | 结论 |
| --- | --- | --- | --- |
| **A. 新增独立消息**（`GET_REQUEST_CONTEXT` → 复用 `RESULT` 形状） | 6 个既有文件 + 1 个新模块 | 中（新增消息类型，`protocol.test.js` 必须刻意改） | **推荐**，但要等审核 |
| B. 扩展 `EXECUTE` 加 `mode` | 少 | 高（`script` 必填、`jobId` 语义都被改写） | 否决 |
| C. 把能力暴露给 Service Script（注入 bridge 对象） | 零权限 | 低但**不等价**：USER_SCRIPT world 读不到 HttpOnly、也拿不到真实请求头 | 仅作降级路径 |
| **D. 独立 POC 扩展（本次采用）** | 不碰 `src/` | 零 | **POC 期间的选择**：V1 基线 209 个测试保持可验证 |

**本次交付 = D（POC）+ A 的设计。** POC 的纯逻辑模块设计为可直接 `git mv` 到 `src/lib/request-context.js`：无 `chrome.*`、无 `import`、`node --test` 全覆盖（16 条单测）。正式并入时按 A 的清单动 6 个文件与 3 个测试，并同步 `docs/architecture-v1.md` §8/§11 与 README 权限表。

---

## 7. POC 设计与实测结果

### 7.1 流程（就是 issue 要求的那条链）

```text
本地受保护源站（POC Server）
  /feed   页面：登录按钮 + 暴露媒体 URL + 浏览器自己取一次媒体
  /login  下发 sid=…（HttpOnly, SameSite=Lax）、theme（页面可读）、strict（SameSite=Strict）
  /media/1 需要 Cookie(sid) + Referer + User-Agent 三者齐全，支持 Range
        │
        │  ① 页面登录（浏览器持有 HttpOnly 会话）
        ▼
   Work Tab（唯一普通 Tab）──② 扩展绑定它、读出页面 UA / 当前 URL
        │
        │  ③ Service → WS → GET_REQUEST_CONTEXT { targetUrl }
        │  ④ 扩展 → chrome.cookies.getAll({url}) → REQUEST_CONTEXT
        ▼
   Node Service：fetch(mediaUrl, { Cookie, User-Agent, Referer })
        │
        └─⑤ 200 + 与浏览器逐字节相同的 payload（SHA-256 一致）
```

组件（全部零第三方依赖，`src/` 未改动）：

| 文件 | 作用 |
| --- | --- |
| `poc/extension/lib/request-context.js` | **纯逻辑**：URL 归一化、同源判定、Cookie 头拼装、脱敏、上下文组装 |
| `poc/extension/background.js` | MV3 service worker：Service WS 连接、Work Tab 解析、`chrome.cookies`/`chrome.scripting` 调用 |
| `poc/service/poc-server.mjs` | 受保护源站 + 请求记录（只记 cookie **名字**） |
| `poc/service/browser.mjs` | 零依赖 CDP 客户端（启动 Chrome for Testing、按 manifest 名找到本扩展的 worker、求值、UA 覆盖） |
| `poc/service/run-poc.mjs` | 扮演 Service：发请求、用上下文下载、对照与断言、写证据 |
| `tests/request-context-poc.test.js` | 纯逻辑单测（含"可移动到 `src/lib`"的守卫） |

> 仓库里另有 `tests/poc/`（V1.6 的**端到端 POC**，`npm run poc`）：它跑的是 `src/` 里的真扩展 + 一个 mock Service，验证 V1 链路本身；本目录的 POC 跑的是一个**独立实验扩展**，只回答"浏览器允许交出什么上下文"。两者目的不同、都零依赖，但确实存在两套 CDP 启动器——**是否合并成一份 harness 属于评审取舍**，本 PR 不做单方面合并。

### 7.2 检查清单（27/27 通过）

| 检查 | 结果 |
| --- | --- |
| Node 能设置 `Cookie` / `Referer` / `User-Agent`（浏览器禁止的 forbidden headers，Node 不禁止） | 200 |
| 扩展连上 Service、上报 Work Tab | IDLE + `workTabUrl` |
| 页面 JS **看不到** HttpOnly 会话 cookie（`document.cookie` = `theme=***; strict=***`） | ✅ |
| 浏览器自己能取到该资源（对照组，digest 记录） | 200，`sid,theme,strict` |
| `GET_REQUEST_CONTEXT`（同源）返回 | 3 个 cookie、1 个 HttpOnly |
| **返回的 `Cookie` 头里含 HttpOnly 会话值** | ✅ |
| `SameSite=Strict` cookie 照样被返回（读取不受 SameSite 约束） | ✅ |
| `userAgent` 来自 Work Tab 页面，而非扩展 SW | ✅ |
| `referer` = Work Tab URL | ✅ |
| 页面自陈的 `documentReferrer` 与页面真实值一致（`referrerPolicy` 实测为 `undefined` → `null`） | ✅ |
| 带 `observedAt` | ✅ |
| **Node 用该上下文下载成功，与浏览器 digest 逐字节相同** | 200 / 65536 B |
| `Range` 重放 | 206 / 1024 B |
| 对照：不带 Cookie | 401 |
| 对照：不带 Referer | 403 |
| 对照：不带 User-Agent | 403 |
| 默认 scope 拒绝跨源目标 | `TARGET_OUT_OF_SCOPE` |
| 显式 `scope=TARGET_ONLY` 允许跨源，且**只**返回该 host 的 cookie（127.0.0.1 的会话 cookie 不出现在 localhost 的上下文里） | 0 个 cookie |
| **CHIPS：同一 URL 不带分区查询 = 0 个；带 `topLevelSite` 才看到那个 `Partitioned` cookie（浏览器确实发过它）** | ✅ |
| 无关 origin 返回 0 个 cookie | ✅ |
| `file:` / `javascript:` / 相对 URL / 空串一律拒绝 | `INVALID_TARGET_URL` |
| 页面级 UA 覆盖后，上下文跟随**页面**，扩展 SW 仍是浏览器默认 UA | ✅ |
| **没有任何持久化**：`chrome.storage.local` 只有 `pocServiceUrl` | ✅ |
| 没有 Work Tab 时拒绝 | `NOT_READY` |

同时记录为"观察"（不作为断言）：Node `fetch` 不设 UA 时实际发 `user-agent: node`；跨站 `fetch` 不发 `SameSite=Lax/Strict` cookie 但会发分区 cookie（401）；`http://localhost` 查询能拿到 `Secure` cookie（localhost 可信例外在 `chrome.cookies` 上同样成立）。

### 7.3 浏览器真实请求头（实测 Chrome 153）

同源 `fetch()` 拉媒体时服务端实际收到的头（节选，完整见证据文件）：

```text
accept: */*
accept-encoding: gzip, deflate, br, zstd
accept-language: zh-CN,zh;q=0.9
sec-ch-ua: "Chromium";v="153", "Not_A Brand";v="8"
sec-ch-ua-mobile: ?0
sec-ch-ua-platform: "Windows"
sec-fetch-dest: empty
sec-fetch-mode: cors
sec-fetch-site: same-origin
referer: http://127.0.0.1:<port>/feed
user-agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) … HeadlessChrome/153.0.0.0 Safari/537.36
cookie: sid=…; theme=…; strict=…
```

跨站 `fetch(…, {credentials:'include'})` 时多出 `origin`、`sec-fetch-site: cross-site`，且只剩分区 cookie。**这张表就是"Node 重放该带什么"的实测基线**：`accept` / `accept-encoding` / `accept-language` / `sec-ch-ua*` / `sec-fetch-*` 都能由 Node 构造，但要注意 `user-agent: node` 默认值、`Accept-Encoding` 的 `Range` 特例，以及跨域重定向丢 Cookie。

### 7.4 两个被 POC 纠正的实现细节

**Cookie 顺序。** 第一版按"路径长度降序 + 名字升序"拼 `Cookie` 头，跑出来 `sid; strict; theme`，而浏览器自己发的是 `sid; theme; strict`。【实测】**`chrome.cookies.getAll({url})` 的返回顺序就是浏览器发送顺序**；API 不提供创建时间字段，所以唯一能保持保真的做法是：**只按 path 长度做稳定排序**（RFC 6265 要求长路径在前），同长度内保留 API 顺序。这条已写进代码注释并由单测钉住。

**Referrer 策略拿不到。** 原计划把 `document.referrerPolicy` 一并返回，实测**Chrome 153 页面里该属性是 `undefined`**（不是空串）。所以 Draft 只承诺"页面自陈的 `document.referrer`"，生效的 Referrer 策略由 Service 按浏览器默认（`strict-origin-when-cross-origin`）或响应头自行推断——Bridge 不该假装知道。

---

## 8. Protocol Draft（非稳定契约）

方向参考 issue，形态按实测能力收敛。**未经审核不得当作 V1 契约实现。**

### 8.1 请求：`GET_REQUEST_CONTEXT`

```json
{
  "type": "GET_REQUEST_CONTEXT",
  "requestId": "rc-1",
  "targetUrl": "https://cdn.example.test/media/1?sign=…",
  "scope": "WORK_TAB_ORIGIN",
  "topLevelSite": "https://www.example.test"
}
```

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `requestId` | 是 | 与 `jobId` 平行的一次性请求身份；Bridge 原样回显 |
| `targetUrl` | 是 | **原样含签名参数**、不含 fragment、http(s)、不得内嵌凭据；否则 `INVALID_TARGET_URL` |
| `scope` | 建议必填 | `WORK_TAB_ORIGIN`（默认，要求与 Work Tab 同源）或 `TARGET_ONLY`（显式允许跨源，但返回集合仍只含匹配该 URL 的 cookie）|
| `topLevelSite` | 否 | CHIPS 分区键。**不传就取不到分区 cookie**；Bridge 可默认用 Work Tab 的 schemeful site（页面子资源的分区天然由顶层站点决定）|

### 8.2 响应：`REQUEST_CONTEXT`

```json
{
  "type": "REQUEST_CONTEXT",
  "requestId": "rc-1",
  "ok": true,
  "context": {
    "targetUrl": "https://cdn.example.test/media/1?sign=…",
    "targetOrigin": "https://cdn.example.test",
    "scope": "WORK_TAB_ORIGIN",
    "observedAt": "2026-09-21T11:06:59.916Z",
    "cookieHeader": "sid=…; theme=…",
    "cookieCount": 2,
    "httpOnlyCookieCount": 1,
    "partitionedCookieCount": 0,
    "cookies": [
      { "name": "sid", "domain": "cdn.example.test", "path": "/", "secure": true,
        "httpOnly": true, "sameSite": "lax", "session": true,
        "partitioned": false, "topLevelSite": null }
    ],
    "userAgent": "Mozilla/5.0 …",
    "userAgentSource": "work-tab-page",
    "serviceWorkerUserAgent": "Mozilla/5.0 …",
    "referer": "https://www.example.test/feed",
    "workTabUrl": "https://www.example.test/feed",
    "documentReferrer": "",
    "referrerPolicy": null
  }
}
```

`referer` 是 Bridge 的**建议值**；`documentReferrer` 是页面自陈的**事实**（Chrome 153 上 `referrerPolicy` 恒为 `null`，见 [§7.4](#74-两个被-poc-纠正的实现细节)）。把两者分开返回，是为了不在 Bridge 里替 Service 判断"真实的发起页是谁"。

失败（`ok:false`）沿用 V1 `RESULT.error` 的形状：`{ code, message }`。Draft 的 code 集合：

| code | 含义 | 备注 |
| --- | --- | --- |
| `NOT_READY` | 没有唯一 Work Tab / 上下文 API 不可用 | 复用 V1 已有码；**只判绑定与 API 可用性，不与 `USER_SCRIPTS_UNAVAILABLE` 联动**（读 cookie 不需要用户脚本授权）|
| `INVALID_TARGET_URL` | 非 http(s)、相对 URL、内嵌凭据 | |
| `TARGET_OUT_OF_SCOPE` | 默认 scope 下 targetUrl 与 Work Tab 不同源 | |
| `CONTEXT_FAILED` | `chrome.cookies` 调用失败等 | |

**刻意不做的**：不返回 `Accept*`/`sec-ch-ua*`/`sec-fetch-*`（可由 Node 构造，Bridge 给"页面自陈"反而可能误导）；不返回 Proxy/出口信息（属 Service）；不缓存、不重试、不排队。

### 8.3 需要评审拍板的三点

1. **`scope` 默认值。** 默认 `WORK_TAB_ORIGIN` 安全但会拒绝**全部真实 CDN 用例**（跨源）；默认 `TARGET_ONLY` 好用，但意味着"任何 http(s) URL 都可以问一次"——虽然每次返回的集合都只含匹配该 URL 的 cookie，但一个被攻陷的 Service 可以逐个 origin 枚举专用 Profile 里的登录态。可选折中：① 保持严格默认 + Service 显式声明跨源；② 用一次性的安装时开关（operator consent）解锁 `TARGET_ONLY`；③ 限制为"Work Tab 同 site（registrable domain）"（需要 PSL，Bridge 要引入一份公共后缀数据）。**POC 实现了 ①，并把 ② 留给评审。**
2. **是不是真的需要第 5 种消息。** 零权限的降级路径（Service Script 自己读 `document.cookie`）拿不到 HttpOnly、也拿不到分区 cookie 与真实 Referer——但如果需求侧证据（[04](notes/04-service-side-need.md)）成立，这条降级路径可能就够了，V1 可以什么都不改。
3. **上下文请求与 Job 状态机的关系。** 建议：不占 Job 槽、`RUNNING` 期间可并发、不影响 `STATUS`。这会让 `BUSY` 的含义从"Bridge 忙"变成"Bridge 的脚本执行槽忙"，需要 Service 侧确认可接受。

---

## 9. 安全边界与已知限制

**设计上保证的**

| 要求 | 本方案如何满足 | 证据 |
| --- | --- | --- |
| 与当前 Execution / Work Tab 明确关联 | 默认 scope 要求与 Work Tab 同源；无 Work Tab 直接 `NOT_READY` | 【实测】`bridge.refuses-when-no-work-tab` |
| 不允许无限制导出整个 cookie 库 | 只用 `getAll({url})`；代码内禁止 `getAll({})` / `getAll({domain})` | 【实测】跨源查询返回 0 个 cookie；无关 origin 返回 0 个 |
| 只返回适用于该 URL 的最小上下文 | 由浏览器自己按 domain/path/scheme 匹配；Bridge 不做二次猜测 | 【实测】 |
| 不持久保存 Cookie | 只有 Service URL 进 `storage.local`；cookie 只存在于一次响应里 | 【实测】`security.nothing-persisted`（storage 只有 `pocServiceUrl`）|
| 不把 Cookie 写日志 | 日志与错误信息一律走 `maskCookieHeader`（只留名字）；POC 服务端记录也只留 cookie 名字 | 【实测】证据文件里没有任何 cookie 值 |
| Context 只作一次性运行数据 | 不缓存、不复用、不写库（Bridge 侧无数据库）| 【实测】 |

**已知限制 / 未解决**

1. **分区 cookie 需要调用方声明分区**（§7.2 CHIPS 那条）。Service 若不知道分层结构就会静默拿到空集合——Draft 里用 `topLevelSite` 暴露它，但"用哪个分区"最终是语义问题。
2. **`WORK_TAB_ORIGIN` 与真实跨源 CDN 需求的张力**（§8.3-1）。
3. **Cookie 值会以明文穿过 WebSocket**。V1 的 Service URL 可以是任意地址，`ws://` 明文 + 远端 Service = Cookie 在网络上裸奔。**建议在实现 Issue 里明确：本能力要求 `wss://` 或仅限本机/受信网段。**
4. **上下文会过期。** 签名 URL 会失效、Cookie 可能被轮换；`observedAt` 只是让 Service 能判断新鲜度，Bridge 不做任何续期。
5. **重放的传输层指纹、跨域重定向丢 Cookie、出口 IP 一致性**：都不在 Bridge 能力范围内（[02](notes/02-replay-context.md)），必须写进验收标准的前置条件。
6. **Bridge 给的是"页面自陈的事实"，不是"线上真相"。** 实测已经看到两处背离：页面级 UA 覆盖会让页面值与 SW 值不同（POC 选了页面值），而 `declarativeNetRequest` 改的是**线上头**、页面 `navigator.userAgent` 完全不变。想要逐字还原真实 wire 头，MV3 里只有 `chrome.debugger`+CDP 一条路（并付出权限警告、调试提示条、与 DevTools 冲突、可能被企业策略阻止的代价）。**本 Draft 不承诺 L4 级保真。**
7. **未做 Edge 实测**：Edge 复用 Chromium 实现、官方对 `chrome.cookies` 参数级行为零文档（[01 §12](notes/01-cookie-api.md)）——同一套代码，但参数级行为需在 Edge 上复测。
8. **未做 incognito / 企业策略路径**：`runtime_blocked_hosts` 可能让 `getAll` 返回空或失败；实现里需要降级分支。
9. **需求侧证据显示当前用不上 Cookie**（[04](notes/04-service-side-need.md)）：`pr-douyin` 不发 Cookie 也能下四类媒体；`media_fetch_http_403`（9/416）的成因未知。**在拿到真实失败复现之前，扩大权限面的收益无法证明。**

---

## 10. 验收条件对照（issue 原文）

| 验收项 | 状态 |
| --- | --- |
| 调查 Chrome MV3 官方 API 和权限 | ✅ [01](notes/01-cookie-api.md) |
| 调查 Edge Chromium 对应能力 | ✅ [01 §12](notes/01-cookie-api.md)（Edge 复用 Chromium，参数级行为官方无文档 → 需实测）|
| 明确 HttpOnly 可否取得及条件 | ✅ 【实测】可取得，需 `"cookies"` + host permission |
| 明确 SameSite / Secure / Partitioned 限制 | ✅ 【实测】+ [01 §6/§7/§9](notes/01-cookie-api.md) |
| 明确哪些 Header 可可靠提供 | ✅ [§7.3](#73-浏览器真实请求头实测chrome-153)、[02](notes/02-replay-context.md) |
| 明确最小 permissions / host_permissions | ✅ `permissions: ["cookies"]`；host 权限逐域限制（`<all_urls>` 的取舍见 §8.3）|
| POC 能为指定 URL 取得必要上下文 | ✅ 27/27 |
| POC 能让 Node Service 成功请求受 Session 保护的资源 | ✅ 200 + digest 一致；对照 401/403 |
| 不引入任何平台专属 API | ✅ §1 |
| 不持久保存 Cookie | ✅ 【实测】 |
| 不在日志输出敏感 Context | ✅ 脱敏函数 + 证据文件复核 |
| 提供最小 Protocol Draft | ✅ §8（**未声明为稳定契约**）|
| 提供安全边界与已知限制 | ✅ §9 |
| 提交调查报告 | ✅ 本文 + 4 份调研笔记 |

---

## 11. 后续建议

1. **人工审核本文与 POC**，先拍板 §8.3 的三点，尤其是"现在要不要做"。
2. **补证据**：从 `pr-douyin` 的 `media_fetch_http_403` 里挑一条可复现的失败样本，判定它是签名过期、出口 IP、UA 还是 Referer——这直接决定上下文里到底需要哪几个字段。
3. 若审核通过：另开实现 Issue，按 [§6](#6-最小改动面与方案对比) 方案 A 的清单改 6 个文件 + 3 个测试，同步 `docs/architecture-v1.md` 与 README 权限表；`GET_REQUEST_CONTEXT` 先以"实验性、可移除"的身份进入，稳定后再冻结。
4. 复现/回归：`node --test`（纯逻辑）+ `node poc/service/run-poc.mjs`（真机 27 项）。
