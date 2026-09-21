# 01 · Cookie 能力调研：扩展如何为 targetUrl 取得最小 Request Context

> 范围：Chrome / Edge（Chromium）Manifest V3 扩展，如何在**受控、最小权限、网站无关**的前提下，为某个 `targetUrl` 取得最小 Request Context（核心是 Cookie），交给 Node.js Service 重放请求。
> 证据等级：**【文档确认】**官方文档明文；**【文档推断】**由官方文档 / 官方源码合理推出；**【未验证】**官方未说明、必须真机实测。
> 本文**未做任何真机验证**（调研期间未启动浏览器）。凡标注“Chromium 源码”的结论均来自官方仓库 `chromium.googlesource.com`，属官方源码但**不是**文档明文，故一律降级为【文档推断】并列入末尾待实测清单。

## 一句话结论摘要

- 【文档确认】`chrome.cookies` 是 MV3 下**权限成本最低**的“能拿到 cookie **值**（含 HttpOnly）”的通道；`"cookies"` 权限本身**不产生额外权限警告文案**，但读取范围受 `host_permissions` **逐域**限制。（能拿到值的另一条路是 `chrome.debugger` + CDP，代价见第 11 节。）
- 【文档推断】`getAll({url})` 返回的是“**与该 URL 匹配**的 cookie 集合”，因此可以把结果收敛到最小集合；**绝不**应该用 `getAll({})` / `getAll({domain})`（在当前 `<all_urls>` 下等于导出整个浏览器 cookie 库）。
- 【文档推断】HttpOnly cookie **可被扩展读到**（`Cookie.httpOnly` 字段存在 + Chromium 源码显式 `set_include_httponly()`）；这是本 issue 的核心能力，但官方文档**没有一句明文承诺**，必须实测。
- 【文档确认】默认所有方法**只操作非分区（unpartitioned）cookie**；Partitioned / CHIPS cookie 必须显式传 `partitionKey` 才拿得到（[chrome.cookies](https://developer.chrome.com/docs/extensions/reference/api/cookies)）。
- 【文档推断】SameSite **不影响读取**（只影响“浏览器实际会发送什么”），因此“扩展取 cookie → Node 重放”不受 SameSite 约束，但也因此可能**多发**浏览器本不会发的 cookie。

---

## 1. `chrome.cookies` API 全貌

| 成员 | 签名要点 | 参考页标注版本 | 支持按 `url` 过滤 | 出处 |
|---|---|---|---|---|
| `get(details)` | `CookieDetails{url,name,storeId?,partitionKey?}`，返回单个 cookie | Chrome 88+ | 是（`url` **必填**） | [cookies](https://developer.chrome.com/docs/extensions/reference/api/cookies) |
| `getAll(details)` | `{url?,name?,domain?,path?,secure?,session?,storeId?,partitionKey?}` | Chrome 88+ | 是（`url` 可选） | 同上 |
| `set(details)` | 写能力，与本次只读需求无关 | Chrome 88+ | `url` 必填 | 同上 |
| `remove(details)` | `CookieDetails` | Chrome 88+ | `url` 必填 | 同上 |
| `getAllCookieStores()` | 返回 `CookieStore[]{id,tabIds}` | Chrome 88+ | 无 url 概念 | 同上 |
| `getPartitionKey(details)` | `FrameDetails{tabId?,frameId?,documentId?}` → `{partitionKey}` | **Chrome 132+** | 按 frame 定位 | 同上 |
| `onChanged` | `changeInfo{removed,cookie,cause}` | 事件；`OnChangedCause` 枚举 Chrome 44+ | 无过滤参数 | 同上 |

类型与引入版本（同一参考页标注）：

| 类型 | 版本 | 关键字段 |
|---|---|---|
| `Cookie` | — | `name/value/domain/hostOnly/path/secure/httpOnly/sameSite/session/expirationDate?/storeId/partitionKey?` |
| `CookieDetails` | Chrome 88+ | `url`（必填）、`name`、`storeId?`、`partitionKey?` |
| `CookiePartitionKey` | **Chrome 119+** | `topLevelSite?`、`hasCrossSiteAncestor?`（**Chrome 130+**） |
| `SameSiteStatus` | Chrome 51+ | `no_restriction / lax / strict / unspecified` |
| `OnChangedCause` | Chrome 44+ | `evicted/expired/explicit/expired_overwrite/overwrite` |
| `FrameDetails` | **Chrome 132+** | `tabId?/frameId?/documentId?` |

- 说明：“Chrome 88+”是参考页对当前 Promise 化签名的标注，**不代表** API 首次引入版本（cookies API 在 MV2 时代即存在）。
- 【文档确认】`getAll` 的参数里**没有** `sameSite` 过滤器（官方参考页无此参数），也没有 `excludeHttpOnly` 之类的开关。要在 SameSite 维度做筛选，只能取回后自行判断。
- 【文档推断】同一参考页对上表的“Chrome 版本”标注与 Chromium API schema 完全一致（[cookies.json](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/chrome/common/extensions/api/cookies.json)），因此上述版本号可直接用于 `minimum_chrome_version` 决策。

## 2. `getAll({url})` 是否返回 HttpOnly

- 【文档确认】官方对 `httpOnly` 字段的**原话**是：*“True if the cookie is marked as HttpOnly (i.e. the cookie is **inaccessible to client-side scripts**).”*——只描述字段语义，**没有**说明 `getAll` 是否包含 HttpOnly cookie（[cookies](https://developer.chrome.com/docs/extensions/reference/api/cookies)）。
- 【文档确认】官方参考页**通篇没有任何“排除 HttpOnly”的说明**；`getAll` 的描述只有两条限制：按 path 排序、*“This method only retrieves cookies for domains that the extension has host permissions to.”*（同上）。
- 【文档推断】扩展**可以看到页面 JS 看不到的 cookie**。两条硬证据：
  1. `Cookie.httpOnly` 是 API 返回结构的一等字段——若 API 从不返回 HttpOnly cookie，该字段永远为 `false`，无存在意义（[cookies](https://developer.chrome.com/docs/extensions/reference/api/cookies)）；
  2. Chromium 源码中，`getAll({url})` 走 `net::CookieOptions::MakeAllInclusive()`，其实现包含 `options.set_include_httponly()`；而排除逻辑只在 `options.exclude_httponly()` 为真时生效（[cookie_options.cc](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/net/cookies/cookie_options.cc)、[cookies_helpers.cc](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/chrome/browser/extensions/api/cookies/cookies_helpers.cc)、[cookie_base.cc](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/net/cookies/cookie_base.cc)）。
- 【文档确认】对照组：`document.cookie` 属 RFC 定义的 “non-HTTP API”，*“the attribute instructs the user agent to omit the cookie when providing access to cookies via ‘non-HTTP’ APIs (such as a web browser API that exposes cookies to scripts)”*，且存储模型明确规定 *“If the cookie was received from a ‘non-HTTP’ API and the cookie's http-only-flag is set, abort these steps and ignore the cookie entirely.”*（[RFC 6265 §4.1.2.6](https://datatracker.ietf.org/doc/html/rfc6265#section-4.1.2.6)、[§5.3](https://datatracker.ietf.org/doc/html/rfc6265#section-5.3)）。
- **结论**：HttpOnly 可见性是【文档推断】（证据强、但无文档明文）→ 必须真机验证，见末尾第 1 条。

## 3. 需要哪些权限；缺权限时的行为；是否弹额外授权提示

- 【文档确认】必须同时声明 `"cookies"` 权限**和**目标主机的 host permissions：*“To use the cookies API, declare the ‘cookies’ permission in your manifest along with host permissions for any hosts whose cookies you want to access.”*（[cookies](https://developer.chrome.com/docs/extensions/reference/api/cookies)）；`declare-permissions` 亦把 *“Access cookies with the chrome.cookies API”* 列为需要 host permission 的例子（[declare-permissions](https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions)）。
- 【文档确认】缺 host permission 时**两种不同行为**：
  - `get` / `set` / `remove`（带 `url` 的方法）：*“If host permissions for this URL are not specified in the manifest file, the API call will fail.”*（硬失败）；
  - `getAll`：*“This method only retrieves cookies for domains that the extension has host permissions to.”*（**静默过滤**，不报错）。
  两者均见 [cookies](https://developer.chrome.com/docs/extensions/reference/api/cookies)。
- 【文档推断】`getAll` 的过滤是**逐 cookie**进行的：源码里 `AppendCookieToVectorIfMatchAndHasHostPermission()` 用 `GetPageAccess() != kAllowed` 直接丢弃该 cookie（[cookies_helpers.cc](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/chrome/browser/extensions/api/cookies/cookies_helpers.cc)）→ 这与官方 “only retrieves cookies for domains that the extension has host permissions to” 完全对应。
- 【文档确认】`"cookies"` 权限**不会**新增权限警告文案。官方权限清单里 `"cookies"` 条目只有一句 *“Gives access to the chrome.cookies API.”*，**没有** “Warning displayed:” 段落；对照 `"debugger"` 明确列出两条警告（*Access the page debugger backend.* / *Read and change all your data on all websites.*）、`"tabs"` 列出 *Read your browsing history.*（[permissions-list](https://developer.chrome.com/docs/extensions/reference/permissions-list)）。
- 【文档推断】因此引入 `cookies` 能力后，用户可见的安装提示**不会因为 `cookies` 而变多**；当前 manifest 的用户可见警告来自 `tabs`（“Read your browsing history.”）与 `host_permissions` 的站点读写提示（[permissions-list](https://developer.chrome.com/docs/extensions/reference/permissions-list)、[declare-permissions](https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions)）。
- 【未验证】官方权限清单只列 API 权限，**没有**给出 `<all_urls>` 等 host permission 的警告文案原文 → 具体文案需在真机安装提示上确认（见末尾第 8 条）。

## 4. 如何限定“只取与某个 URL 相关的最小 cookie 集合”

`getAll` 各过滤参数的确切语义（均为 [cookies](https://developer.chrome.com/docs/extensions/reference/api/cookies) 原文摘要）：

| 参数 | 官方语义 | 关键限制 / 坑 |
|---|---|---|
| `url` | *“Restricts the retrieved cookies to those that would match the given URL.”* | 只保留“该 URL 会匹配到”的 cookie（域名/路径/scheme 匹配）；`get` 路径下官方明确 `url` 可带完整 URL，**path 之后的内容（含 query）被忽略** |
| `name` | *“Filters the cookies by name.”* | 精确相等匹配 |
| `domain` | *“Restricts the retrieved cookies to those whose domains match or are **subdomains** of this one.”* | **会连带返回子域 cookie**（例如 `domain: "example.com"` 会带出 `a.example.com` 的 cookie）→ 不符合“最小集合”目标 |
| `path` | *“Restricts the retrieved cookies to those whose path **exactly matches** this string.”* | 是精确相等，**不是前缀匹配** |
| `secure` | *“Filters the cookies by their Secure property.”* | 【文档推断】源码里判断写作 `if (details_->secure && *details_->secure != cookie.SecureAttribute())`，即传 `false` 时**不启用过滤**（只有 `true` 有效）→ 见 [cookies_helpers.cc](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/chrome/browser/extensions/api/cookies/cookies_helpers.cc) |
| `session` | *“Filters out session vs. persistent cookies.”* | 同上：源码判断 `if (details_->session && ...)`，传 `false` 等于不过滤 |
| `storeId` | *“The cookie store to retrieve cookies from. If omitted, the current execution context's cookie store will be used.”* | Service Worker 的执行上下文即默认 profile 的 store |
| `partitionKey` | *“The partition key for reading or modifying cookies with the Partitioned attribute.”* | 不传 = 只返回**非分区** cookie，详见第 9 节 |
| `sameSite` | **不存在该参数** | 需要按 SameSite 过滤只能自行遍历判断 |

- 【文档确认】`get` 的同名多 cookie 规则：*“If more than one cookie of the same name exists for the given URL, the one with the longest path will be returned. For cookies with the same path length, the cookie with the earliest creation time will be returned.”*（[cookies](https://developer.chrome.com/docs/extensions/reference/api/cookies)）→ 想“精确定位某一个 cookie”时，`get` 并不保证是你想的那一个。
- 【文档推断】最小集合的推荐配方：`getAll({ url: targetUrl })`（必要时再叠加 `name`），而不是 `getAll({})`、`getAll({domain})`。在 `<all_urls>` host permission 下，`getAll({})` 等价于把整个 cookie store 交给调用方——功能上可用，但违背本 issue 的最小权限目标；`url` 过滤同时把域名、路径两个维度收敛掉。
- 【文档推断】`getAll({url})` 的实现路径是 `CookieManager::GetCookieList(url, options, partitionKeyCollection)`，而非 `GetAllCookies()`（[cookies_api.cc](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/chrome/browser/extensions/api/cookies/cookies_api.cc)）→ 这解释了为什么带 `url` 时会应用 scheme/路径匹配（第 7 节）。

## 5. `getAllCookieStores()`、`storeId` 与 incognito

- 【文档确认】`CookieStore` 的定义原文：*“Represents a cookie store in the browser. **An incognito mode window, for instance, uses a separate cookie store** from a non-incognito window.”*，其 `id` 由 `getAllCookieStores()` 提供，`tabIds` 为共享该 store 的标签页（[cookies](https://developer.chrome.com/docs/extensions/reference/api/cookies)）。
- 【文档确认】incognito 行为由 manifest `"incognito"` 决定：`"spanning"`（默认，单一共享进程，incognito 事件带 `incognito` 标志）/ `"split"`（incognito 独立进程，*“has a separate **memory-only** cookie store”*）/ `"not_allowed"`（Chrome 47+ 起不可在 incognito 启用）（[manifest/incognito](https://developer.chrome.com/docs/extensions/reference/manifest/incognito)）。
- 【文档确认】**前提是用户手动允许**：*“Retrieves the state of the extension's access to Incognito-mode. This corresponds to the user-controlled per-extension **‘Allowed in Incognito’** setting accessible via the chrome://extensions page.”*（`chrome.extension.isAllowedIncognitoAccess()`，Chrome 99+）（[extension API](https://developer.chrome.com/docs/extensions/reference/api/extension)）。
- 【文档确认】Edge 侧同样要求手动开启，且**组策略无法代劳**：*“By design, you can't enable extensions for InPrivate browsing through Group Policy.”*，做法是在 `edge://extensions` 里勾 **Allow in InPrivate**（[Edge troubleshoot](https://learn.microsoft.com/en-us/troubleshoot/microsoft-edge/manageability/enable-extension-inprivate-policy)）。
- 【文档推断】把上述三点合起来：扩展要读 incognito cookie，必须（a）manifest 允许 + 用户手动允许，（b）用 `getAllCookieStores()` 拿到 incognito store 的 `id` 后显式传 `storeId`；`spanning` 模式下是否有第二个 store、以及未授权时 API 是报错还是返回空，官方未说明。
- 【未验证】源码里普通/隐身 store 常量是 `"0"` / `"1"`（[cookies_helpers.cc](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/chrome/browser/extensions/api/cookies/cookies_helpers.cc)），但**官方文档从未写死这两个值** → 不要硬编码，必须用 `getAllCookieStores()`。

## 6. SameSite 对“读取”和“重放”的不同影响

- 【文档推断】SameSite **不影响** `chrome.cookies` 的读取结果：官方文档完全没有提 SameSite 与读取的关系（`sameSite` 只是返回字段）。源码层面，带 `url` 的读取使用 `MakeAllInclusive()`，其中 SameSite 上下文被设为 `SameSiteCookieContext::MakeInclusive()`（即最宽松的 `SAME_SITE_STRICT` 上下文）；`cookie_base.cc` 只在上下文**低于** `SAME_SITE_STRICT` 时才排除 Strict cookie（[cookie_options.cc](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/net/cookies/cookie_options.cc)、[cookie_base.cc](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/net/cookies/cookie_base.cc)）。
- 【文档推断】**因此扩展读到的是“存储中匹配的 cookie 全集”，而不是“浏览器此刻实际会发送的 cookie 集合”**——SameSite、以及“该请求是否为跨站”，都不参与读取过滤。这一点直接决定了本 issue 的语义：我们是在导出**存储状态**，不是在录制**线上流量**。
- 【文档确认】三个不同场景对 SameSite 的敏感度差异：
  - **页面内 `fetch` 重放**：受 SameSite 约束（跨站请求不带 `Lax`/`Strict` cookie）；扩展场景有一个官方豁免——*“Requests from an extension to a third-party are **treated as same-site** if the extension has host permissions for the third-party. This means `SameSite=Strict` cookies can be sent. Note that this only applies to network requests, not access through `document.cookie` in JavaScript, and does not apply if third-party cookies are blocked.”*（[storage-and-cookies](https://developer.chrome.com/docs/extensions/develop/concepts/storage-and-cookies)）
  - **扩展取 cookie → Node 重放**：SameSite **完全不参与**（Node 不是浏览器，Cookie 头由我们手工拼装），官方文档对此无任何说明（属【文档推断】：SameSite 是 UA 发送决策，不是服务端校验）。
  - **风险**：Node 重放可能带上浏览器本不会发的 `Strict`/`Lax` cookie；反过来，如果目标接口依赖 **Sec-Fetch-Site / Origin / Referer** 等 Request Context 的其他部分，仅带 Cookie 并不能复现浏览器行为（这些头不在 cookie API 覆盖范围内）。

## 7. Secure 与 scheme；localhost 例外

- 【文档确认】扩展自身页面在 scheme 上受限：*“The Secure cookie attribute is only supported for the `https://` scheme. Consequently, `chrome-extension://` pages are not able to set cookies with this attribute.”* 并因此无法使用依赖 Secure 的 `SameSite=None` 与 `Partitioned`；*“Cookies set on chrome-extension:// pages always use SameSite=Lax.”*（[storage-and-cookies](https://developer.chrome.com/docs/extensions/develop/concepts/storage-and-cookies)）。
- 【文档推断】用 **http URL** 查询时，`Secure` cookie 会被排除、拿不到；用 **https URL** 查询才能拿到。依据：源码 `IncludeForRequestURL()` 在 access scheme 为 `kNonCryptographic` 时对 `SecureAttribute()` 的 cookie 打上 `EXCLUDE_SECURE_ONLY`；access scheme 由 `cookie_util::ProvisionalAccessScheme(url)` 计算（`SchemeIsCryptographic()` → `kCryptographic`）（[cookie_base.cc](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/net/cookies/cookie_base.cc)、[cookie_util.cc](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/net/cookies/cookie_util.cc)）。
- 【文档推断】**localhost 例外确实存在**：同一处源码注释写明 *“Secure cookies should not be included in requests for URLs with an insecure scheme, **unless it is a localhost url**, or the CookieAccessDelegate otherwise denotes them as trustworthy”*，且 `ProvisionalAccessScheme()` 对 localhost 返回 `kTrustworthy`（此时允许访问 Secure cookie，但会附加 `WARN_SECURE_ACCESS_GRANTED_NON_CRYPTOGRAPHIC` 警告而非排除）（[cookie_base.cc](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/net/cookies/cookie_base.cc)、[cookie_util.cc](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/net/cookies/cookie_util.cc)）。
- 【文档确认】官方文档**没有**描述 localhost 的 Secure 例外（`storage-and-cookies` 只写了“Secure 仅支持 https scheme”，未提 localhost）→ 若工具里要依赖这一点，必须实测（见末尾第 4 条）。
- 【未验证】源码中另有 scheme-bound cookies 机制（`EXCLUDE_SCHEME_MISMATCH`），在启用且 scope 语义非 LEGACY 时，https 设置的 cookie 对 http URL 不可见（[cookie_base.cc](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/net/cookies/cookie_base.cc)）。cookies API 使用哪种 scope 语义，官方文档未说明。
- **工程结论**：查询 URL 必须与目标资源的真实 scheme 一致（下载链路是 https 就用 https 查询）；不要用 http URL 去“顺便”取 Secure cookie。

## 8. `__Host-` / `__Secure-` 前缀与重放注意事项

- 【文档确认】前缀约束是**设置阶段**的校验规则：
  - `__Secure-`：必须以 `Secure` 属性设置，且来自安全来源（[rfc6265bis §4.1.3.1](https://datatracker.ietf.org/doc/html/draft-ietf-httpbis-rfc6265bis#section-4.1.3)）。
  - `__Host-`：必须 `Secure`、**无 `Domain` 属性**、`Path=/`；文档给出合法/非法示例集合（同上，§4.1.3.2）。
- 【文档推断】重放时前缀**不提供任何额外保证**：前缀只是 UA 在接受 `Set-Cookie` 时的拒绝条件，HTTP 请求里只有 `Cookie` 头，服务端无法从请求中看出该 cookie 当初是否满足前缀约束。扩展取 cookie 与 Node 手工拼 `Cookie` 头的链路，等于跳过了 UA 的这层校验；如果服务端把 `__Host-` 当作强保证来信任，需要在 Service 侧自行维护这份假设。
- 【文档推断】“Node 用 **http** 重放带 `Secure` cookie”会发生什么：`Secure` 只约束 UA 的存储/发送决策，请求里没有该标记 → Node 会照发，服务端通常也照收。也就是说，重放链路**丢掉了 Secure 语义**；如果目标服务端自行做了 scheme 校验，行为可能与浏览器不同（需实测，见末尾第 11 条）。
- 【文档确认】配套事实：`SameSite=None` 的 cookie 必须带 `Secure`（源码在非 LEGACY 语义下对 `NO_RESTRICTION && !SecureAttribute()` 打 `EXCLUDE_SAMESITE_NONE_INSECURE`）（[cookie_base.cc](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/net/cookies/cookie_base.cc)）→ 这类 cookie 也只能用 https URL 查询才拿得到（第 7 节）。

## 9. Partitioned cookies / CHIPS

- 【文档确认】官方对 partition key 的定义：*“A cookie's partition key is the site (scheme and registrable domain) of the top-level URL the browser was visiting at the start of the request to the endpoint that set the cookie.”*；CHIPS 自 **Chrome 114+ 默认支持**；`Partitioned` cookie **必须带 `Secure`**；每分区上限 180 cookies、每嵌入站点 10 KB（[CHIPS](https://privacysandbox.google.com/cookies/chips)、[privacycg/CHIPS](https://github.com/privacycg/CHIPS)）。
- 【文档确认】`partitionKey` 结构：`topLevelSite`（*“The top-level site the partitioned cookie is available in.”*）+ `hasCrossSiteAncestor`（Chrome 130+，*“Indicates if the cookie was set in a cross-cross site context.”*）（[cookies](https://developer.chrome.com/docs/extensions/reference/api/cookies)）。
- 【文档确认】`hasCrossSiteAncestor` 即 cross-site ancestor chain bit：*“If the bit indicates true, it means the cookie has been set in a third-party context.”*，且**顶层上下文按设计恒为 false**（[w3c/webextensions 提案](https://raw.githubusercontent.com/w3c/webextensions/refs/heads/main/proposals/hasCrossSiteAncestor.md)）。官方 CHIPS 文档只讲 top-level site，**未提**该 bit。
- 【文档确认】默认行为：*“By default, all API methods operate on unpartitioned cookies. The `partitionKey` property can be used to override this behavior.”*（[cookies](https://developer.chrome.com/docs/extensions/reference/api/cookies)）→ **`getAll` 不传 `partitionKey` 时不会返回 partitioned cookie**。
- 【文档推断】各组合的确切语义（Chromium 源码 `CookiePartitionKeyCollectionFromApiPartitionKey()`，[cookies_helpers.cc](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/chrome/browser/extensions/api/cookies/cookies_helpers.cc)）：

| 传入的 `partitionKey` | 实际匹配范围 |
|---|---|
| 完全不传 | 仅**非分区** cookie（空 key 集合；源码注释确认空集合时不去查分区 map） |
| `{ topLevelSite: "" }` | 仅**非分区** cookie |
| `{ topLevelSite: S }`（不带 CAB） | site 为 S 的**两种**分区 key（same-site 与 cross-site 都算） |
| `{ topLevelSite: S, hasCrossSiteAncestor: b }` | **精确一个**分区 key |
| 只传 `{ hasCrossSiteAncestor: b }`（不带 topLevelSite） | **全部分区 + 非分区**（源码注释明确点出这个 edge case） |

- 【文档推断】`{ topLevelSite: S, hasCrossSiteAncestor: false }` 在 URL 与 S 不是 first-party 时**会报错**（源码中有该校验分支）（[cookies_helpers.cc](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/chrome/browser/extensions/api/cookies/cookies_helpers.cc)）。
- 【文档确认】跨站点 iframe 场景下“该用哪个分区”可以直接问浏览器：`chrome.cookies.getPartitionKey({tabId, frameId})`（Chrome 132+）返回该 frame 的 partition key，再用它调 `getAll`（[cookies](https://developer.chrome.com/docs/extensions/reference/api/cookies)）。
- 【文档确认】注意一个容易混用的场景：*“When an extension embeds a third-party site, that site will use the **extension origin** as the partition key. This means the site won't be able access the same cookies as if it were navigated to directly.”*（[storage-and-cookies](https://developer.chrome.com/docs/extensions/develop/concepts/storage-and-cookies)，引用 crbug.com/1463991）→ 走“扩展页 + 目标 URL”这条路径取到的分区集合，可能与“工作标签页里的第三方 iframe”**不是同一份**。
- 【文档确认】重放影响：*“There is no way to programmatically determine if a cookie sent in an HTTP request is partitioned or unpartitioned.”*（[CHIPS transition](https://privacysandbox.google.com/cookies/chips-transition)）→ 服务端无法区分；且同名分区/非分区 cookie 可共存且互不覆盖（同上）。因此 Node 重放时**送哪一份完全由我们决定**，送错不会有任何服务端信号提示。

## 10. 第三方 Cookie 限制对扩展 cookie API 的影响

- 【文档确认】扩展顶层页对第三方 cookie 有强豁免：*“Third-party cookies are **never blocked** even in subframes if the top-level page for a given tab is a `chrome-extension://` page.”*（[storage-and-cookies](https://developer.chrome.com/docs/extensions/develop/concepts/storage-and-cookies)）。
- 【文档确认】扩展 → 第三方的网络请求在拥有 host permission 时被当作 same-site（`SameSite=Strict` 也能发），但*“this only applies to network requests, not access through `document.cookie` in JavaScript, and **does not apply if third-party cookies are blocked**”*（同上）。
- 【未验证】`chrome.cookies` 是否**绕过**第三方 cookie 拦截 → **官方未说明**。已知的官方事实只有：默认只操作非分区 cookie；跨分区访问需显式 `partitionKey`（[cookies](https://developer.chrome.com/docs/extensions/reference/api/cookies)）。因此不能把“扩展一定能拿到第三方 cookie”当前提。
- 【文档确认】政策现状：Google 于 2025-10-17 明确 Chrome **不再弃用**第三方 cookie，改为维持“给用户第三方 cookie 选择权”的现有方案，并继续支持 CHIPS 与 FedCM（[Privacy Sandbox 博客](https://privacysandbox.google.com/blog/update-on-plans-for-privacy-sandbox-technologies)）→ 短期政策风险下降，但**用户级设置/无痕模式**仍可能让目标 cookie 不存在。
- 【文档确认】Edge 侧：`BlockThirdPartyCookies` 默认不拦（可被用户/管理员改动），但*“This policy doesn't apply in InPrivate mode. In InPrivate, third-party cookies are blocked by default”*（[Edge 策略](https://learn.microsoft.com/en-us/deployedge/microsoft-edge-policies/blockthirdpartycookies)）；Tracking Prevention 的官方表述对象始终是 *websites/trackers*，**没有**提到扩展或 `chrome.cookies`（[Edge 策略](https://learn.microsoft.com/en-us/deployedge/microsoft-edge-policies/trackingprevention)）→【文档推断】Tracking Prevention 不构成扩展读取的限制。
- 【文档确认】真正能“按站点掐断扩展读 cookie”的官方机制是企业策略：*“Blocking unwanted actions is done by blocking actions such as script injection into your websites, **reading the cookies**, or making web-request modifications.”*（`ExtensionSettings.runtime_blocked_hosts`）（[Edge 扩展企业策略](https://learn.microsoft.com/en-us/deployedge/microsoft-edge-manage-extensions-policies)）→ 企业环境下 `chrome.cookies.getAll` 可能返回空/失败，需要错误处理（见末尾第 13 条）。

## 11. 替代/补充方案对比

**速览**

| 方案 | 能读到 Cookie **值** | 权限成本 | MV3 |
|---|---|---|---|
| `chrome.cookies` | **能**（含 HttpOnly，【文档推断】） | 低：`"cookies"` + host_permissions（逐域） | 可用 |
| `chrome.debugger` + CDP | **能** | 高：`"debugger"`（两条警告，但**不需要** host permission） | 可用 |
| `chrome.webRequest` | **能**（必须 `'extraHeaders'`） | 中高：`"webRequest"` + host permissions | 可用（仅观察） |
| `chrome.declarativeNetRequest` | **不能** | 低 | 可用 |
| `document.cookie` / USER_SCRIPT world | **不能**（HttpOnly） | 低：`"userScripts"` + host permission | 可用 |
| 扩展 SW 内 `fetch(..., {credentials})` | 不返回（浏览器自行携带） | 低：host permissions | 可用，但不满足 Node 重放 |

**逐项说明**

`chrome.cookies`
- 能否读到值：**能**，含 HttpOnly（【文档推断】）；默认**不含** partitioned cookie；无 `sameSite` 过滤参数。
- 需要权限：`"cookies"` + 目标域 host permissions（逐域生效，`getAll` 静默过滤）。
- MV3 可用性：可用；`"cookies"` 不新增权限警告文案。
- 出处：[cookies](https://developer.chrome.com/docs/extensions/reference/api/cookies)、[permissions-list](https://developer.chrome.com/docs/extensions/reference/permissions-list)。

`chrome.debugger` + CDP
- 能否读到值：**能**。按 URL 取用 `Network.getCookies(urls)`（不传 `urls` 时默认取当前页与所有子帧）；全量取用 `Network.getAllCookies`——**官方协议已标注 Deprecated，改用 `Storage.getCookies`**（后者支持 `browserContextId`）。
- 需要权限：`"debugger"`；**不需要** host permission（官方把它列为 host permission 的例外场景）。
- MV3 可用性：可用；CDP `Network`、`Storage` 都在 `chrome.debugger` 的可用域清单内。代价是两条权限警告（*Access the page debugger backend.* / *Read and change all your data on all websites.*）与附着时的用户可见调试提示。
- 额外限制：Edge 上 `chrome.debugger` 不支持 Android；企业策略 `runtime_blocked_hosts` 自 Edge 154 起会让 `chrome.debugger.attach()` 对所有 target 失效。
- 出处：[debugger](https://developer.chrome.com/docs/extensions/reference/api/debugger)、[declare-permissions](https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions)、[permissions-list](https://developer.chrome.com/docs/extensions/reference/permissions-list)、[CDP Network](https://chromedevtools.github.io/devtools-protocol/tot/Network/)、[CDP Storage](https://chromedevtools.github.io/devtools-protocol/tot/Storage/)、[Edge API support](https://learn.microsoft.com/en-us/microsoft-edge/extensions/developer-guide/api-support)、[ExtensionSettings](https://learn.microsoft.com/en-us/deployedge/microsoft-edge-policies/extensionsettings)。

`chrome.webRequest`（观察 `Cookie` 请求头）
- 能否读到值：**能**，但**必须**在 `opt_extraInfoSpec` 里加 `'extraHeaders'`——官方原文列出 *“Starting from Chrome 72, the following request headers are not provided and cannot be modified or removed without specifying 'extraHeaders' in opt_extraInfoSpec: Accept-Language, Accept-Encoding, Referer, **Cookie**”*。
- 需要权限：`"webRequest"` + host permissions（拦截子资源还需同时有请求 URL 与 initiator 的权限）。
- MV3 可用性：观察可用、blocking 不可用——*“As of Manifest V3, the `webRequestBlocking` permission is no longer available for most extensions… Aside from `webRequestBlocking`, the webRequest API is unchanged and available for normal use. Policy installed extensions can continue to use `webRequestBlocking`.”*
- 【文档推断】只能看到“实际发出的” cookie（已被 SameSite / 第三方策略裁剪过），因此语义上更接近“浏览器会发什么”，而不是“存储里有什么”；且只在我们主动触发对应请求时才有数据。`"webRequest"` 权限自身在权限清单中无警告文案，警告来自所需 host permissions。
- 出处：[webRequest](https://developer.chrome.com/docs/extensions/reference/api/webRequest)、[blocking-web-requests](https://developer.chrome.com/docs/extensions/develop/migrate/blocking-web-requests)、[permissions-list](https://developer.chrome.com/docs/extensions/reference/permissions-list)。

`chrome.declarativeNetRequest`
- 能否读到值：**不能**。官方定性原文：*“This lets extensions modify network requests **without intercepting them and viewing their content**, thus providing more privacy.”*
- 能做什么：删/改 `cookie` 请求头——`cookie` 在支持 `append` 的请求头列表内，官方示例正是 remove cookie（可按 `main_frame` / `sub_frame` 限定）。
- 需要权限：`"declarativeNetRequest"`（安装时触发权限警告，但隐式获得 block 类能力）或 `"declarativeNetRequestWithHostAccess"`（**不**显示安装警告，但必须已有 host permissions）。MV3 可用。
- 出处：[declarativeNetRequest](https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest)。

`document.cookie` / USER_SCRIPT world
- 能否读到值：只能读到**非 HttpOnly** 的页面 cookie（HttpOnly 读不到）。
- 依据：RFC 6265 *“the attribute instructs the user agent to omit the cookie when providing access to cookies via ‘non-HTTP’ APIs (such as a web browser API that exposes cookies to scripts)”*，存储模型另有 *“If the cookie was received from a ‘non-HTTP’ API and the cookie's http-only-flag is set, abort these steps and ignore the cookie entirely.”*
- 需要权限：`"userScripts"` + host permission，且官方注明 *“NOTE: the user must also explicitly enable the usage of user scripts.”*；USER_SCRIPT world 是*“specific to user scripts and is exempt from the page's CSP”*、对宿主页与其它扩展不可见。
- 【文档推断】USER_SCRIPT world 属于页面文档上下文，不是扩展特权上下文，因此不具备 `chrome.cookies` 这类扩展 API；这也正是本 issue 用 USER_SCRIPT world 执行 JS **拿不到 HttpOnly cookie** 的原因。
- 出处：[RFC 6265 §4.1.2.6](https://datatracker.ietf.org/doc/html/rfc6265#section-4.1.2.6)、[RFC 6265 §5.3](https://datatracker.ietf.org/doc/html/rfc6265#section-5.3)、[permissions-list](https://developer.chrome.com/docs/extensions/reference/permissions-list)、[userScripts](https://developer.chrome.com/docs/extensions/reference/api/userScripts)。

扩展 Service Worker 内 `fetch(..., {credentials})`
- 能否读到值：**不返回** cookie 值（它只是让浏览器自行携带 cookie 发请求）。可满足“让浏览器下载”，但**无法满足“把 cookie 交给 Node 重放”**。
- 需要权限：host permissions——官方把 *“Make fetch() requests from the extension service worker and extension pages.”* 列为需要 host permission 的场景。
- 【未验证】官方**未说明**扩展 SW 的 `fetch` 是否默认附带 cookie；官方只有一句相关的语义说明：*“Requests from an extension to a third-party are treated as same-site if the extension has host permissions for the third-party.”*（该句讲 SameSite，不等于“一定带 cookie”）。
- 出处：[declare-permissions](https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions)、[storage-and-cookies](https://developer.chrome.com/docs/extensions/develop/concepts/storage-and-cookies)、[network-requests](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests)。

- 【文档推断】若目标是“Node 重放”，只有 `chrome.cookies` 与 `chrome.debugger+CDP` 两条路能拿到值；前者权限成本低一个数量级，后者只在需要“不依赖 host permission 或需要跨 store/分区全量”时才值得考虑（`chrome.debugger` 的 `Storage.getCookies` 支持 `browserContextId`，天然覆盖多 store）。

## 12. Microsoft Edge（Chromium）侧

- 【文档确认】Edge 官方 API 支持表：*“Microsoft Edge extensions use a subset of the JavaScript methods for the Chromium browser engine platform.”* 其中 `chrome.cookies` 标 **MV2, MV3**、平台 Windows/Linux/Mac/Android；`chrome.debugger` 标 MV2, MV3 但**无 Android**；`chrome.userScripts` 标 **MV3 only**；`chrome.webRequest` 与 `chrome.declarativeNetRequest` 均 MV2, MV3（[Edge API support](https://learn.microsoft.com/en-us/microsoft-edge/extensions/developer-guide/api-support)）。
- 【文档确认】兼容性承诺：*“The Extension APIs and manifest keys supported by Chrome are code-compatible with Microsoft Edge.”*（[port-chrome-extension](https://learn.microsoft.com/en-us/microsoft-edge/extensions/developer-guide/port-chrome-extension)）。
- 【文档确认】Edge **没有**独立的 `chrome.cookies` 专页：API 支持表该行只给一句描述（*“Queries and modifies cookies, and receives notifications when they change.”*）并链回 developer.chrome.com；`declare-permissions` 里 `"cookies"` 也只有一句 *“Gives your extension access to the chrome.cookies API.”*（[Edge API support](https://learn.microsoft.com/en-us/microsoft-edge/extensions/developer-guide/api-support)、[Edge declare-permissions](https://learn.microsoft.com/en-us/microsoft-edge/extensions/developer-guide/declare-permissions)）。
- 【未验证】Edge 官方**完全没有**说明 `chrome.cookies` 的参数级行为：`partitionKey`/CHIPS 支持、SameSite 读取语义、HttpOnly 可见性、`storeId`/InPrivate 返回范围、权限警告文案 → 结论是：**Edge 复用 Chromium 实现，官方未单独说明**；既不要假设有差异，也不要假设一定相同，需按第 12 条实测。
- 【文档确认】InPrivate 差异：扩展需用户在 `edge://extensions` 手动勾选 **Allow in InPrivate**，组策略无法代劳（[Edge troubleshoot](https://learn.microsoft.com/en-us/troubleshoot/microsoft-edge/manageability/enable-extension-inprivate-policy)）；InPrivate 下第三方 cookie 默认被拦（[BlockThirdPartyCookies](https://learn.microsoft.com/en-us/deployedge/microsoft-edge-policies/blockthirdpartycookies)）。
- 【文档确认】Edge 特有的企业限制（会影响 debugger 方案）：**自 Edge 154 起**，对带 `debugger` 权限的扩展应用 `runtime_blocked_hosts` 会*“completely disable `chrome.debugger.attach()` on all targets”*（[ExtensionSettings](https://learn.microsoft.com/en-us/deployedge/microsoft-edge-policies/extensionsettings)）。
- 【文档确认】Edge 的 MV2 退场时间线仍在进行中（2026-08 起 Partner Center 弃用警告、2026 年底完成消费者过渡、2027 年初开始企业弃用；完整关停日期 TBD）（[Edge MV3 timeline](https://learn.microsoft.com/en-us/microsoft-edge/extensions/developer-guide/manifest-v3)、[Edge 官方博客](https://blogs.windows.com/msedgedev/2026/08/07/moving-the-microsoft-edge-extensions-ecosystem-forward-with-manifest-version-3/)）→ 本仓库是 MV3，不受影响。
- 【文档确认】`--load-extension` / `--disable-extensions-except`：**Microsoft 官方文档中不存在这两个开关的任何记载**。官方“本地加载扩展”的正式路径是 `edge://extensions` → Developer mode → **Load unpacked**（[extension-sideloading](https://learn.microsoft.com/en-us/microsoft-edge/extensions/getting-started/extension-sideloading)）；自动化路径是 WebDriver 的 `extensions` 能力（base64 `.crx`，[Edge WebDriver options](https://learn.microsoft.com/en-us/microsoft-edge/webdriver/capabilities-edge-options)）；企业路径是 `ExtensionSettings` / `ExtensionInstallForcelist`。官方唯一相关的策略是 `CommandLineFlagSecurityWarningsEnabled`（压制“unsupported command-line flag”安全警告），但**未点名** `--load-extension`（[Edge 策略](https://learn.microsoft.com/en-us/deployedge/microsoft-edge-policies/commandlineflagsecuritywarningsenabled)）→ 若 Service 需要以独立实例 + 扩展启动 Edge，这条路径属**未文档化**，需实测。

---

## 最小权限结论

1. **权限增量最小化**：`permissions` 只增加 `"cookies"`；**不要**引入 `"debugger"`（两条警告 + 调试提示）、`"webRequest"`（只观察 + `extraHeaders` 才可见 Cookie 头）、`"declarativeNetRequest"`（读不到值）。`"cookies"` 本身不新增权限警告文案（[permissions-list](https://developer.chrome.com/docs/extensions/reference/permissions-list)）。
2. **host_permissions 按需收敛**：读取范围**逐域**受 host permission 限制（[cookies](https://developer.chrome.com/docs/extensions/reference/api/cookies)）。当前 `<all_urls>` 让"最小集合"只能靠调用侧自律；若要真正落地最小权限，应改为按目标域申请（`optional_host_permissions` + 运行时请求），这也是唯一能实质降低用户可见警告的方向。
3. **取数配方（推荐实现顺序）**：
   1. 用**与目标资源一致的 scheme**（下载链路是 https 就用 https）构造查询 URL；
   2. `chrome.cookies.getAll({ url: targetUrl })` → 得到“与该 URL 匹配”的 cookie（`getAll` 会逐 cookie 检查 host permission，无权限的静默丢弃）；
   3. 若目标位于第三方 iframe：先用 `chrome.cookies.getPartitionKey({ tabId, frameId })` 取该 frame 的 key，再 `getAll({ url, partitionKey: key })`；
   4. 需要更小集合时，在扩展侧按 `name` 白名单二次过滤（API 无 `sameSite` 过滤，`secure:false`/`session:false` 等于不过滤）；
   5. 组装 `Cookie` 头（`name=value; name2=value2`）返回给 Service。
4. **禁止项**：不要用 `getAll({})` / `getAll({ domain })` 作为默认实现（前者在 `<all_urls>` 下等于导出整个浏览器 cookie 库，后者会连带返回子域 cookie）；本 issue 只读，不要在扩展里实现 `set` / `remove`。
5. **只读语义声明**：明确产物是“**存储中匹配该 URL 的 cookie 全集**”，不是“浏览器此刻会发送的 cookie 集合”（SameSite/第三方策略不参与读取，第 6 节）。Service 侧若要更接近浏览器行为，需要额外的策略层（例如按 `sameSite` + 目标场景自行裁剪）。
6. **Edge 复用 Chromium 实现**：能力相同、文档未说明参数级差异（第 12 节）；同一套代码可直接用，但需按第 12 条在 Edge 上复测。

## 未解决问题（需实测）

以下均因“官方文档未明文”而必须由真机验证。**禁止**把实测前的结论写进实现假设。

1. **HttpOnly 可见性（本 issue 核心）**：构造服务端 `Set-Cookie: H=1; HttpOnly; Path=/`，页面内 `document.cookie` 应看不到；在扩展 Service Worker 里 `chrome.cookies.getAll({url})` 打印 `httpOnly` 与 `value`，确认返回值非空且 `httpOnly === true`。同时验证 `get({url, name:'H'})`。
2. **SameSite 是否影响读取**：在 A 站设置 `SameSite=Strict` 与 `SameSite=Lax` cookie，在与 A 站无导航关系的标签页里调用 `getAll({url:A})`，确认两者都被返回；对照 `chrome.webRequest` + `'extraHeaders'` 观察实际请求头，确认“读取结果 ⊋ 实际发送”。
3. **`secure: false` / `session: false` 是否真的不过滤**（源码疑似行为）：对同一 URL 分别用“不传”“传 `false`”“传 `true`”三种参数调 `getAll`，比较返回条数；若 `false` 与不传结果相同，则确认该坑存在。
4. **localhost 的 Secure 例外**：在 `http://localhost:PORT` 页面写入 `Secure` cookie，再用 `getAll({url:'http://localhost:PORT/'})` 查询，确认是否返回（官方文档未提该例外）。
5. **http URL 查询是否排除 Secure cookie**：同一域分别以 `http://` 与 `https://` URL 调 `getAll`，对比 `secure: true` 条目数量。
6. **`domain` 过滤的子域行为**：父域有 cookie、子域也有 cookie，用 `{domain: 父域}` 查询，确认是否两者都返回（官方文字为 "match or are subdomains"）。
7. **分区 cookie 查询语义**：构造顶层页 + 跨站 iframe，让 iframe 第三方站点写入 `Partitioned; Secure` cookie；分别用 `{url}`、`{url, partitionKey:{topLevelSite}}`、`{url, partitionKey:{topLevelSite, hasCrossSiteAncestor:true|false}}`、`{url, partitionKey:{hasCrossSiteAncestor:true}}` 调 `getAll`，与 `getPartitionKey({tabId, frameId})` 的结果交叉比对；确认第 9 节表格（源码推断）是否成立，以及 `hasCrossSiteAncestor:false` + 非 first-party 是否报错。
8. **安装提示文案**：打包（含 `cookies` 与不含 `cookies` 两版）后在 `chrome://extensions` 观察权限文案是否完全一致；顺带记录 `<all_urls>` 的实际警告原文（官方权限清单未列 host permission 文案）。Edge 同法在 `edge://extensions` 复测。
9. **incognito 行为**：manifest 分别设 `not_allowed` / `spanning` / `split`，在允许与不允许 “Allowed in Incognito” 两种状态下：`getAllCookieStores()` 返回几个 store、`getAll({storeId})` 在无权限时是报错还是空、`spanning` 下从普通上下文能否读到 incognito store。
10. **扩展 SW 的 fetch 是否自带 cookie**：SW 内对目标 URL 分别用 `credentials: 'same-origin' | 'include' | 'omit'` 发请求到可控回显服务，记录 `Cookie` 头；再与页面内 `fetch` 对照。特别验证 `HttpOnly` 与 `SameSite=Strict` 是否被带上。
11. **重放正确性**：把扩展取到的 cookie 拼成 `Cookie` 头，在 Node 中重放目标请求，与浏览器内同请求的响应（状态码/关键头/长度）对比；另外专门测试“https 下设置、经 http 重放”的 `Secure` cookie 是否被服务端接受。
12. **Edge 参数级行为复测**：在 Edge 上重跑第 1、5、7、8 条，确认与 Chrome 一致（Edge 官方对 cookies API 参数级行为零文档）。
13. **企业/策略受限路径**：在 Edge 上应用 `ExtensionSettings.runtime_blocked_hosts` 后，确认 `chrome.cookies.getAll` 的实际表现（报错、空数组、还是部分返回），以便实现里做正确降级。
14. **`chrome.debugger` 备选路径**：attach 后 `Network.getCookies({urls})` 与 `Storage.getCookies` 的返回范围（是否含分区 cookie、是否受 host permission 限制、是否需先 `Network.enable`），与 `chrome.cookies` 的结果做差异表。

## 主要来源

- [chrome.cookies API reference](https://developer.chrome.com/docs/extensions/reference/api/cookies) · [Chromium cookies.json schema](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/chrome/common/extensions/api/cookies.json)
- [Storage and cookies](https://developer.chrome.com/docs/extensions/develop/concepts/storage-and-cookies) · [Manifest – Incognito](https://developer.chrome.com/docs/extensions/reference/manifest/incognito) · [chrome.extension](https://developer.chrome.com/docs/extensions/reference/api/extension)
- [Permissions list](https://developer.chrome.com/docs/extensions/reference/permissions-list) · [Declare permissions](https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions)
- [chrome.webRequest](https://developer.chrome.com/docs/extensions/reference/api/webRequest) · [Convert blocking web requests (MV3)](https://developer.chrome.com/docs/extensions/develop/migrate/blocking-web-requests) · [chrome.declarativeNetRequest](https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest) · [chrome.debugger](https://developer.chrome.com/docs/extensions/reference/api/debugger) · [chrome.userScripts](https://developer.chrome.com/docs/extensions/reference/api/userScripts) · [Cross-origin network requests](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests)
- [Chrome DevTools Protocol – Network](https://chromedevtools.github.io/devtools-protocol/tot/Network/) · [CDP – Storage](https://chromedevtools.github.io/devtools-protocol/tot/Storage/)
- [CHIPS](https://privacysandbox.google.com/cookies/chips) · [CHIPS transition](https://privacysandbox.google.com/cookies/chips-transition) · [Privacy Sandbox 政策更新（2025-10-17）](https://privacysandbox.google.com/blog/update-on-plans-for-privacy-sandbox-technologies) · [w3c/webextensions: hasCrossSiteAncestor](https://raw.githubusercontent.com/w3c/webextensions/refs/heads/main/proposals/hasCrossSiteAncestor.md) · [privacycg/CHIPS](https://github.com/privacycg/CHIPS)
- [RFC 6265 §4.1.2.6 HttpOnly](https://datatracker.ietf.org/doc/html/rfc6265#section-4.1.2.6) · [RFC 6265 §5.3 Storage Model](https://datatracker.ietf.org/doc/html/rfc6265#section-5.3) · [draft-ietf-httpbis-rfc6265bis §4.1.3 Cookie Name Prefixes](https://datatracker.ietf.org/doc/html/draft-ietf-httpbis-rfc6265bis#section-4.1.3)
- Chromium 源码：[cookies_api.cc](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/chrome/browser/extensions/api/cookies/cookies_api.cc) · [cookies_helpers.cc](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/chrome/browser/extensions/api/cookies/cookies_helpers.cc) · [cookie_base.cc](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/net/cookies/cookie_base.cc) · [cookie_options.cc](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/net/cookies/cookie_options.cc) · [cookie_util.cc](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/net/cookies/cookie_util.cc) · [cookie_partition_key_collection.h](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/net/cookies/cookie_partition_key_collection.h)
- Microsoft Edge：[API support](https://learn.microsoft.com/en-us/microsoft-edge/extensions/developer-guide/api-support) · [Declare permissions](https://learn.microsoft.com/en-us/microsoft-edge/extensions/developer-guide/declare-permissions) · [Port a Chrome extension](https://learn.microsoft.com/en-us/microsoft-edge/extensions/developer-guide/port-chrome-extension) · [MV3 timeline](https://learn.microsoft.com/en-us/microsoft-edge/extensions/developer-guide/manifest-v3) · [Extension sideloading](https://learn.microsoft.com/en-us/microsoft-edge/extensions/getting-started/extension-sideloading) · [WebDriver options](https://learn.microsoft.com/en-us/microsoft-edge/webdriver/capabilities-edge-options) · [Enable extension in InPrivate](https://learn.microsoft.com/en-us/troubleshoot/microsoft-edge/manageability/enable-extension-inprivate-policy) · [BlockThirdPartyCookies](https://learn.microsoft.com/en-us/deployedge/microsoft-edge-policies/blockthirdpartycookies) · [TrackingPrevention](https://learn.microsoft.com/en-us/deployedge/microsoft-edge-policies/trackingprevention) · [ExtensionSettings](https://learn.microsoft.com/en-us/deployedge/microsoft-edge-policies/extensionsettings) · [Manage extensions policies](https://learn.microsoft.com/en-us/deployedge/microsoft-edge-manage-extensions-policies)
