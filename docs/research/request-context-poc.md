# 调研/POC：受控 Browser Request Context 供 Service 下载媒体资源（issue #13）

> **状态：调研结论 + 实测 + 已并入真扩展的实验性实现（未冻结）。**
> 本文提出的 `GET_REQUEST_CONTEXT` / `REQUEST_CONTEXT` 在评审前**不构成稳定契约**：V1 的四种消息、三个错误码、Job 状态机语义全部未变，新能力是加法（架构文档 §14 明确标注"未冻结"），删掉它不影响 V1 的任何行为。
>
> | 项 | 值 |
> | --- | --- |
> | 实测浏览器 | Chrome for Testing **153.0.8010.52**（headless=new） |
> | 实测 Node | **v26.7.0**（内置 `fetch`/`WebSocket`，零第三方依赖） |
> | 扩展权限增量 | `cookies` / `scripting`（原为 `storage` / `tabs` / `userScripts`）+ `host_permissions: ["<all_urls>"]` |
> | 实现位置 | `src/lib/request-context.js`（纯逻辑）、`src/lib/request-context-source.js`（可注入的 chrome 适配）、`bridge-state.js` 的一条短路径 |
> | 证据文件 | [`evidence/request-context.json`](evidence/request-context.json)（**15/15 场景，在真扩展上跑出来**） |
> | 复现命令 | `npm run poc:context`（= `node tests/poc/request-context.mjs`） |
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
   > **本能力在需求侧尚未被证明"必须有"。** 建议先补一条"带 Cookie 才成功 / 不带就失败"的真实失败复现证据（例如 `media_fetch_http_403` 那 9/416 的成因），再决定是否长期保留它换来的权限面。
   > 维护者的决定是：**先在真扩展里做出来、但明确不冻结**——这样"能不能做、代价多大"是可验证的事实，而不是纸面判断。
5. **最小改动面（已按此实现）**：manifest 加 `cookies` + `scripting`；新增 `src/lib/request-context.js`（纯逻辑）与 `src/lib/request-context-source.js`（可注入适配）；新增一条独立于 `EXECUTE` 的短请求（**不占 Job 槽、不被 `BUSY` 阻断、不受 `USER_SCRIPTS_UNAVAILABLE` 影响**）；`ERROR_CODES` 与 `isJsonCompatible` 未动（[03](notes/03-bridge-gaps.md) §3/§4）。契约见 [§8](#8-protocol-draft非稳定契约)。

---

## 1. 边界：为什么这不是业务能力

issue 的硬约束是 Bridge 不得理解 Douyin / Media / Video / Work。POC 与 Draft 都按这条做：

| 可能被误设计成 | 本方案实际提供的 |
| --- | --- |
| `GET_DOUYIN_COOKIES` | `GET_REQUEST_CONTEXT { targetUrl, scope?, topLevelSite? }` |
| `DOWNLOAD_DOUYIN_VIDEO` | 完全没有下载能力——下载永远由 Service 自己做 |
| `DOUYIN_MEDIA_CONTEXT` | 上下文只依赖"URL + 浏览器当前状态"，不知道 URL 是什么资源 |
| 判断"这个媒体能不能下/过期没" | 不判断；Signature、过期、`kind`、白名单全部留在 Service |

**Bridge 侧唯一新增的知识是"URL 之间的同源关系"**（`new URL(a).origin === new URL(b).origin`），这是 URL 语义，不是网站语义，也不含任何平台名。`src/lib/request-context.js` 甚至没有任何 `import`，因此它既能在扩展里跑，也能被 `node --test` 直接驱动。

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
| **A. 新增独立消息**（`GET_REQUEST_CONTEXT` → 自成一对消息） | 3 个既有文件 + 2 个新模块 + 3 个测试 | 中（新增消息类型，`protocol.test.js` / `manifest.test.js` 各一处断言刻意改） | **采用**（实验性、未冻结） |
| B. 扩展 `EXECUTE` 加 `mode` | 少 | 高（`script` 必填、`jobId` 语义都被改写） | 否决 |
| C. 把能力暴露给 Service Script（注入 bridge 对象） | 零权限 | 低但**不等价**：USER_SCRIPT world 读不到 HttpOnly、也拿不到真实分区 cookie 与页面 UA | 仅作降级路径 |
| D. 独立 POC 扩展 | 不碰 `src/` | 零 | 调研阶段的选择，**已退役**：能力进了真扩展后，独立扩展与第二套 CDP 启动器都不再需要 |

**落地形态 = A，且是加法。** 纯逻辑模块（无 `chrome.*`、无 `import`）落在 `src/lib/request-context.js`，chrome 适配落在 `src/lib/request-context-source.js`，短路径落在 `bridge-state.js`：V1 的四种消息、三个错误码、`isJsonCompatible`、Job 状态机语义全部未变；新消息有**自己的错误码集合**，删掉不影响任何 V1 行为。

---

## 7. POC 设计与实测结果

### 7.1 流程（就是 issue 要求的那条链，跑在真扩展上）

```text
本地受保护源站（tests/poc/protected-server.mjs）
  /feed   页面：登录按钮 + 暴露资源 URL + 浏览器自己取一次资源
  /login  下发 sid=…（HttpOnly, SameSite=Lax）、theme（页面可读）、strict（SameSite=Strict）
  /media/1 需要 Cookie(sid) + Referer + User-Agent 三者齐全，支持 Range
        │
        │  ① 页面登录（浏览器持有 HttpOnly 会话）
        ▼
   Work Tab（唯一普通 Tab）──② 扩展绑定它；需要时读页面自己的 UA / referrer
        │
        │  ③ Service → WS → GET_REQUEST_CONTEXT { targetUrl }
        │  ④ src/ 扩展 → chrome.cookies.getAll({url}) + 分区查询 → REQUEST_CONTEXT
        ▼
   Node Service：fetch(mediaUrl, { Cookie, User-Agent, Referer })
        │
        └─⑤ 200 + 与浏览器逐字节相同的 payload（SHA-256 一致）
```

组件（全部零第三方依赖，**跑的是 `src/` 里的真扩展**）：

| 文件 | 作用 |
| --- | --- |
| `src/lib/request-context.js` | **纯逻辑**：URL/scope/分区归一化、同源判定、Cookie 头拼装、脱敏、上下文组装 |
| `src/lib/request-context-source.js` | 可注入的 `chrome.cookies` / `tabs` / `scripting` 适配，失败一律返回错误值而不抛 |
| `tests/poc/protected-server.mjs` | 受保护源站 + 请求记录（只记 cookie **名字**与头） |
| `tests/poc/request-context.mjs` | 扮演 Service：发请求、用上下文下载、对照与断言、写证据 |
| `tests/request-context.test.js` | 28 条单测：纯逻辑 + 可注入适配（stub chrome）+ 状态机短路径 |

> harness 只有一套：`tests/poc/browser.mjs` / `service.mjs`（V1.6 建的）被两个场景运行器共用（`run-poc.mjs` 跑 V1，`request-context.mjs` 跑本能力）。调研阶段那份独立实验扩展与它自带的 CDP 客户端已删除。

### 7.2 场景清单（15/15 通过，真扩展）

| 场景 | 结果 |
| --- | --- |
| 还没有 Work Tab 时，上下文请求如实回答 `NOT_READY`（而不是沉默） | ✅ |
| 页面登录：页面 JS **看不到** HttpOnly 会话 cookie | ✅ `theme=***; strict=***` |
| 浏览器自己取到受保护资源（对照组，digest 记录） | 200，`sid,theme,strict` |
| **未开启 Allow User Scripts** 时：`GET_STATUS` 是 `USER_SCRIPTS_UNAVAILABLE`，而上下文请求照样成功 | ✅ |
| 返回的 `Cookie` 头里含 **HttpOnly** 会话值；`SameSite=Strict` cookie 照样被返回 | ✅ |
| `userAgent` 来自 Work Tab 页面（`userAgentSource=work-tab-page`），`referer` = Work Tab URL | ✅ |
| **Node 只用该上下文下载，得到与浏览器逐字节相同的资源**；`Range` 重放 206 | ✅ 65536 B |
| 对照：不带 Cookie → 401；不带 Referer → 403（`BAD_REFERER`）；**不带 UA → 403**（`USER_AGENT_MISMATCH`，服务端看到的是 undici 默认的 `user-agent: node`）；UA 不匹配 → 403 | ✅ |
| 跨源目标：默认 `TARGET_OUT_OF_SCOPE`；显式 `scope=TARGET_ONLY` 才允许，且只返回该 host 的 cookie | ✅ |
| **CHIPS**：先确认浏览器真的在跨站请求里发了那个 `Partitioned` cookie；默认分区（顶层文档的请求，`hasCrossSiteAncestor=false`）**不含**它——它是第三方 frame 写进另一个分区的；显式 `hasCrossSiteAncestor: true` 时**恰好只返回它**；`topLevelSite=null` 返回空集 | ✅ |
| 无关 origin 返回 0 个 cookie；`file:` / `javascript:` / 相对 URL / 空串 / 非法 scope 一律拒绝 | ✅ |
| 页面级 UA 覆盖后，上下文跟随**页面**，而 worker 自身 UA 不变 | ✅ |
| **没有任何持久化**：`chrome.storage.local` 只有 `serviceUrl` | ✅ |
| 开启 Allow User Scripts 后：`EXECUTE` 正常，且 **RUNNING 期间取上下文不影响该 Job** | ✅ |
| 关闭页面后：上下文请求 `NOT_READY` | ✅ |

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

## 8. Protocol Draft（已实现，但**未冻结**）

方向参考 issue，形态按实测能力收敛，并已在 `src/` 里按此实现（架构文档 §14 标注"未冻结"）。**在评审明确冻结之前，Service 不应把它当稳定契约**：删掉这一对消息不会影响 V1 的任何行为。

### 8.1 请求：`GET_REQUEST_CONTEXT`

```json
{
  "type": "GET_REQUEST_CONTEXT",
  "requestId": "rc-1",
  "targetUrl": "https://cdn.example.test/media/1?sign=…",
  "scope": "WORK_TAB_ORIGIN",
  "topLevelSite": "https://www.example.test",
  "hasCrossSiteAncestor": true
}
```

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `requestId` | 是 | 与 `jobId` 平行的一次性请求身份；Bridge 原样回显。缺失 → 静默丢弃（没有身份可回答） |
| `targetUrl` | 是 | **原样含签名参数**、不含 fragment、http(s)、不得内嵌凭据；否则 `INVALID_TARGET_URL` |
| `scope` | 否 | `WORK_TAB_ORIGIN`（默认，要求与 Work Tab 同源）或 `TARGET_ONLY`（显式允许跨源，但返回集合仍只含匹配该 URL 的 cookie）；其他值 → `INVALID_SCOPE`（不做静默降级） |
| `topLevelSite` | 否 | CHIPS 分区键的站点部分。**不传时默认取 Work Tab 的 origin**（子资源的分区由顶层站点决定）；传 `null` 表示明确不要分区查询；传非法 URL → `INVALID_PARTITION` |
| `hasCrossSiteAncestor` | 否 | CHIPS 分区键的**另一位**（Chrome 130+）。**只给 `topLevelSite` 会同时命中两种取值**：若两个分区都有同名 cookie，就会一起返回、甚至拼出错误的 `Cookie` 头。这一位描述的是**发起请求的那个 frame 的祖先链**，不是目标的站点：顶层上下文按设计恒为 `false`，只有通过第三方上下文才为 `true`。所以默认是 `false`（本能力的主要场景：Work Tab 页面自己发出的请求，哪怕是跨站子资源），从第三方 frame 发出的请求要显式传 `true`；按"目标是否跨源/跨站"推导会在两个方向上都错。非 boolean → `INVALID_PARTITION` |

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
    "duplicateCookieNames": [],
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

`duplicateCookieNames` 非空表示 `cookieHeader` 里出现了同名 cookie（分区与非分区是两份 cookie，可以同名同 path，浏览器会把两份都发出去）。Chrome 在**同一 path 长度内**按创建时间排序，而 `chrome.cookies` 不暴露创建时间——Bridge 因此无法复现那段顺序，只能把冲突**显式报告**出来，由 Service 用 `cookies[].partitioned` / `topLevelSite` 自己判断。

失败（`ok:false`）沿用 V1 `RESULT.error` 的形状：`{ code, message }`。code 集合（`CONTEXT_ERROR_CODES`，与 V1 的 `ERROR_CODES` **分开**，不动后者）：

| code | 含义 | 备注 |
| --- | --- | --- |
| `NOT_READY` | 没有唯一 Work Tab / 上下文 API 不可用 | **只判绑定与 API 可用性，不与 `USER_SCRIPTS_UNAVAILABLE` 联动**（读 cookie 不需要用户脚本授权，实测场景 4）|
| `INVALID_TARGET_URL` | 非 http(s)、相对 URL、内嵌凭据 | |
| `INVALID_SCOPE` | `scope` 既不是 `WORK_TAB_ORIGIN` 也不是 `TARGET_ONLY` | 拒绝而不是静默按默认处理 |
| `INVALID_PARTITION` | `topLevelSite` 不是合法 URL，或 `hasCrossSiteAncestor` 不是 boolean | |
| `TARGET_OUT_OF_SCOPE` | 默认 scope 下 targetUrl 与 Work Tab 不同源 | 此时**不会**触碰 cookie API |
| `CONTEXT_FAILED` | `chrome.cookies` 调用失败、上下文不可序列化、**采样期间 Work Tab 发生了导航**（重试一次后仍不一致）| |

**刻意不做的**：不返回 `Accept*`/`sec-ch-ua*`/`sec-fetch-*`（可由 Node 构造，Bridge 给"页面自陈"反而可能误导）；不返回 Proxy/出口信息（属 Service）；不缓存、不重试、不排队。

### 8.3 需要评审拍板的三点

1. **`scope` 默认值。** 默认 `WORK_TAB_ORIGIN` 安全但会拒绝**全部真实 CDN 用例**（跨源）；默认 `TARGET_ONLY` 好用，但意味着"任何 http(s) URL 都可以问一次"——虽然每次返回的集合都只含匹配该 URL 的 cookie，但一个被攻陷的 Service 可以逐个 origin 枚举专用 Profile 里的登录态。可选折中：① 保持严格默认 + Service 显式声明跨源；② 用一次性的安装时开关（operator consent）解锁 `TARGET_ONLY`；③ 限制为"Work Tab 同 site（registrable domain）"（需要 PSL，Bridge 要引入一份公共后缀数据）。**实现选的是 ①，②③ 留给评审。**
2. **要不要保留这对消息与两个权限。** 零权限的降级路径（Service Script 自己读 `document.cookie`）拿不到 HttpOnly、分区 cookie 与页面 UA——但需求侧证据（[04](notes/04-service-side-need.md)）显示现役链路本来就没用 Cookie，所以"删掉它、什么都不加"仍是一个合理选项。
3. **上下文请求与 Job 状态机的关系。** 实现选的是：不占 Job 槽、`RUNNING` 期间可并发、不影响 `STATUS`（实测场景 14）。这会让 `BUSY` 的含义从"Bridge 忙"变成"Bridge 的脚本执行槽忙"，需要 Service 侧确认可接受。

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

1. **分区 cookie 的选择是语义问题**（§7.2 CHIPS 那条）。实测：同一个 URL，`hasCrossSiteAncestor` 取另一位就是**另一个分区**（另一份 cookie 或空集），两位互不包含。默认 `false` 覆盖"页面自己发出的请求"；第三方 frame 里发出的请求必须由 Service 说明。另外，查阅资料时看到的"`{topLevelSite, hasCrossSiteAncestor:false}` 对非 first-party 的 URL 会报错"在 Chrome 153 上**没有被复现**：实际是返回空集，不抛错。
2. **`WORK_TAB_ORIGIN` 与真实跨源 CDN 需求的张力**（§8.3-1）。
3. **Cookie 值会以明文穿过 WebSocket**。V1 的 Service URL 可以是任意地址，`ws://` 明文 + 远端 Service = Cookie 在网络上裸奔。**建议在冻结之前明确：本能力要求 `wss://` 或仅限本机/受信网段**（当前实现没有加这条限制）。
4. **上下文会过期。** 签名 URL 会失效、Cookie 可能被轮换；`observedAt` 只是让 Service 能判断新鲜度，Bridge 不做任何续期。
5. **重放的传输层指纹、跨域重定向丢 Cookie、出口 IP 一致性**：都不在 Bridge 能力范围内（[02](notes/02-replay-context.md)），必须写进验收标准的前置条件。
6. **Bridge 给的是"页面自陈的事实"，不是"线上真相"。** 实测已经看到两处背离：页面级 UA 覆盖会让页面值与 SW 值不同（实现选了页面值），而 `declarativeNetRequest` 改的是**线上头**、页面 `navigator.userAgent` 完全不变。想要逐字还原真实 wire 头，MV3 里只有 `chrome.debugger`+CDP 一条路（并付出权限警告、调试提示条、与 DevTools 冲突、可能被企业策略阻止的代价）。**本能力不承诺 L4 级保真。**
7. **未做 Edge 实测**：Edge 复用 Chromium 实现、官方对 `chrome.cookies` 参数级行为零文档（[01 §12](notes/01-cookie-api.md)）——同一套代码，但参数级行为需在 Edge 上复测。
8. **未做 incognito / 企业策略路径**：`runtime_blocked_hosts` 可能让 `getAll` 返回空或失败；实现里需要降级分支。
9. **同名 cookie 的顺序无法完全复现**：分区与非分区可以同名同 path，浏览器按 path + 创建时间排序后两份都发；API 不暴露创建时间，因此同一 path 长度内的顺序做不到逐字复现。实现选择**显式报告**（`duplicateCookieNames`）而不是猜。实测里 cookie 顺序与浏览器一致的场景，都是没有同名冲突的情况。
10. **需求侧证据显示当前用不上 Cookie**（[04](notes/04-service-side-need.md)）：`pr-douyin` 不发 Cookie 也能下四类媒体；`media_fetch_http_403`（9/416）的成因未知。**在拿到真实失败复现之前，扩大权限面的收益无法证明。**

---

## 10. 验收条件对照（issue 原文）

| 验收项 | 状态 |
| --- | --- |
| 调查 Chrome MV3 官方 API 和权限 | ✅ [01](notes/01-cookie-api.md) |
| 调查 Edge Chromium 对应能力 | ✅ [01 §12](notes/01-cookie-api.md)（Edge 复用 Chromium，参数级行为官方无文档 → 需实测）|
| 明确 HttpOnly 可否取得及条件 | ✅ 【实测】可取得，需 `"cookies"` + host permission |
| 明确 SameSite / Secure / Partitioned 限制 | ✅ 【实测】+ [01 §6/§7/§9](notes/01-cookie-api.md) |
| 明确哪些 Header 可可靠提供 | ✅ [§7.3](#73-浏览器真实请求头实测chrome-153)、[02](notes/02-replay-context.md) |
| 明确最小 permissions / host_permissions | ✅ `permissions` 增量为 `cookies` + `scripting`；host 权限逐域限制读取范围（`<all_urls>` 的取舍见 §8.3）|
| POC 能为指定 URL 取得必要上下文 | ✅ 15/15 场景（真扩展） |
| POC 能让 Node Service 成功请求受 Session 保护的资源 | ✅ 200 + digest 一致；对照 401/403 |
| 不引入任何平台专属 API | ✅ §1 |
| 不持久保存 Cookie | ✅ 【实测】场景 13：`chrome.storage.local` 只有 `serviceUrl` |
| 不在日志输出敏感 Context | ✅ 脱敏函数 + 证据文件复核（只有名字、布尔与掩码串）|
| 提供最小 Protocol Draft | ✅ §8（已实现，**未声明为稳定契约**）|
| 提供安全边界与已知限制 | ✅ §9 |
| 提交调查报告 | ✅ 本文 + 5 份调研笔记 |

---

## 11. 后续建议

1. **人工审核本文与已并入的实现**，拍板 §8.3 的三点，尤其是"长期要不要保留这对消息与两个权限"。
2. **补需求侧证据**：从 `pr-douyin` 的 `media_fetch_http_403` 里挑一条可复现的失败样本，判定它是签名过期、出口 IP、UA 还是 Referer——这直接决定上下文里到底需要哪几个字段，以及在真实链路上它是否值得。
3. **冻结或移除**：审核通过就把 `GET_REQUEST_CONTEXT` 写进架构文档的正式章节（去掉"未冻结"），并补上 `wss://`/受信网段限制；不通过就整段删除——它没有修改 V1 的任何既有行为。
4. 复现/回归：
   - `node --test`（257 条，含 28 条本能力单测）
   - `npm run poc`（V1 端到端，15 场景）
   - `npm run poc:context`（本能力端到端，15 场景，需 `BROWSER_EXECUTABLE` 指向 Chrome for Testing）
