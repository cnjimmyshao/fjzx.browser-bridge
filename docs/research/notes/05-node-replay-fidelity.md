# Node.js 回放浏览器请求的忠实度研究报告

> 研究范围：Node.js 全局 `fetch`（= undici）、`node:http`、`node:https`、`node:http2` 在**重放浏览器请求**时，哪些东西能忠实复现、哪些不能。
> 证据等级：**官方规范 / 官方文档 / 官方源码** 为一等证据；本报告另用**本地实测**做交叉验证（Node **v26.7.0**，`process.versions.undici` = **8.9.0**，Windows）。所有 URL 均为实际抓取或实际下载过的地址；无法确认的内容标注 **未验证** 或 **未找到官方说明**。

---

## 0. 结论速览

| 能力 | Node 全局 `fetch`（undici） | `node:http` / `node:https` | `node:http2` |
|---|---|---|---|
| 自定义 `Cookie` | ✅ 可以，原样上线 | ✅ 可以 | ✅ 可以 |
| 自定义 `Host` | ❌ **被删除**，无法伪造 | ✅ 可以 | ✅ 用 `:authority`（可设） |
| 自定义 `Referer` / `Origin` | ✅ 可以 | ✅ 可以 | ✅ 可以 |
| 自定义 `User-Agent` | ✅ 可以（默认注入 `user-agent: node`） | ✅ 可以（默认**不注入**） | ✅ 可以 |
| 自定义 `Accept-Encoding` | ✅ 可以（默认自动注入） | ✅ 可以（默认**不注入**） | ✅ 可以 |
| `Connection` | ⚠️ 可传但被“消费”，由 undici 自己写 | ⚠️ 由 agent 决定 | ⚠️ HTTP/2 禁止连接级头 |
| `Transfer-Encoding` | ❌ 抛错 | ✅ 可以（chunked） | — |
| `Content-Length` | ⚠️ 可传，但会被按 body 重算/校验 | ✅ 可以 | — |
| 跳转时保留手写 `Cookie` | ⚠️ **同源跳转保留，跨源跳转被删除** | 手动跟随才可控 | — |
| `redirect: 'manual'` | 返回**真实 3xx**（非 opaqueredirect） | — | — |
| 自动 cookie jar | ❌ 没有 | ❌ 没有 | ❌ 没有 |
| 请求头**顺序**控制 | ❌ 只能靠插入序，`Host/Connection` 固定在前 | ❌ 只能靠插入序 | 伪头必须最前（RFC） |
| 请求头**大小写** | 保留你传入的原始大小写（HTTP/1.1） | 保留原始大小写 | Node 序列化为小写 |
| TLS/HTTP2 指纹像 Chrome | ❌ 不像（详见第 7 节） | ❌ | ❌ |

---

## 1. Forbidden header names（禁止请求头）

### (a) 规范原文

Fetch 标准当前把该定义称为 **forbidden request header**（锚点已从 `#forbidden-header-name` 迁移为 [`#forbidden-request-header`](https://fetch.spec.whatwg.org/#forbidden-request-header)）。原文（抓取自 [fetch.spec.whatwg.org](https://fetch.spec.whatwg.org/#forbidden-header-name)，正文经文本渲染后完整读取）为：

> 1. If name is a byte-case-insensitive match for one of:
>    `Accept-Charset`、`Accept-Encoding`、`Access-Control-Request-Headers`、`Access-Control-Request-Method`、`Connection`、`Content-Length`、`Cookie`、`Cookie2`、`Date`、`DNT`、`Expect`、`Host`、`Keep-Alive`、`Origin`、`Referer`、`Set-Cookie`、`TE`、`Trailer`、`Transfer-Encoding`、`Upgrade`、`Via`
>    then return true.
> 2. If name when **byte-lowercased** starts with `proxy-` or `sec-`, then return true.
> 3. If name is a byte-case-insensitive match for one of `X-HTTP-Method`, `X-HTTP-Method-Override`, `X-Method-Override` then:
>    1. Let parsedValues be the result of getting, decoding, and splitting value.
>    2. For each method of parsedValues: if the isomorphic encoding of method is a **forbidden method**, then return true.
> 4. Return false.
>
> These are forbidden so the user agent remains in full control over them.

补充规范细节：

- `Proxy-`/`Sec-` 是**前缀**匹配（先 byte-lowercase 再判断），不是固定名单。
- **`Cookie2` 仍在当前列表中**（MDN 的列表已省略它，写报告时以规范为准）。
- `X-HTTP-Method*` 只在**值等于禁止方法**（`CONNECT` / `TRACE` / `TRACK`）时才算禁止头。
- 相关定义：`CORS non-wildcard request-header name` = “a header name that is a **byte-case-insensitive match for `Authorization`**”。
- MDN 的同一列表见 [Forbidden request header](https://developer.mozilla.org/en-US/docs/Glossary/Forbidden_request_header)（其中注明：“The `User-Agent` header used to be forbidden, but no longer is. However, Chrome still silently drops the header from Fetch requests”，以及“While the `Referer` header is listed as a forbidden header in the spec, the user agent does not retain full control over it”）。

### (b) undici 是否执行这份名单？——**不执行**

undici 官方文档声明其 `fetch` 遵循 Fetch 标准（[undici docs: Fetch](https://raw.githubusercontent.com/nodejs/undici/main/docs/docs/api/Fetch.md)：*"undici implements the WHATWG Fetch Standard, providing `fetch()` together with the `Request`, `Response`, `Headers`, and `FormData` classes that mirror the browser APIs. The implementation follows the standard"*），**但源码明确说明不实现禁止头名单**。`lib/web/fetch/headers.js` 中 `append`、`delete`、`set` 三处都有同一行注释：

```js
// 4. Otherwise, if headers's guard is "request" and name is a
//    forbidden header name, return.
// Note: undici does not implement forbidden header names
```

规范里“guard 为 request 且是禁止头则直接 return”的分支被跳过，只有 `immutable` guard 会抛错。另一个旁证在 `lib/web/fetch/constants.js`：

```js
// See https://github.com/nodejs/undici/issues/2021
// 'Content-Length' is a forbidden header name, which is typically
// removed in the Headers implementation. However, undici doesn't
// filter out headers, so we add it here.
```

官方安全公告的措辞更直接（[GHSA-wqq4-5wpv-mx2g / CVE-2023-45143](https://github.com/nodejs/undici/security/advisories/GHSA-wqq4-5wpv-mx2g)、[advisory-database JSON](https://raw.githubusercontent.com/github/advisory-database/main/advisories/github-reviewed/2023/10/GHSA-wqq4-5wpv-mx2g/GHSA-wqq4-5wpv-mx2g.json)）：

> By design, `cookie` headers are forbidden request headers, disallowing them to be set in `RequestInit.headers` in browser environments. **Since Undici handles headers more liberally than the specification**, there was a disconnect from the assumptions the spec made, and Undici's implementation of fetch.

**结论：WHATWG 的 forbidden header name 名单在 Node/undici 的 `fetch` 下不生效（除少数在 HTTP/1 底层被单独处理的头，见下）。**

### (c) 你问的 8 个具体头（本地实测，Node v26.7.0 / undici 8.9.0，服务端打印 `rawHeaders`）

| 头 | Node `fetch` 能否设置 | 实测/源码证据 |
|---|---|---|
| `Cookie` | ✅ **能**，原样上线 | 实测线上出现 `Cookie: sid=1`（保留原始大小写） |
| `Host` | ❌ **不能**，被删除后使用真实 host | `lib/web/fetch/index.js`：`httpRequest.headersList.delete('host', true)`；实测服务端 `host: 127.0.0.1:<真实端口>` |
| `Referer` | ✅ **能** | 实测 `Referer: https://ref.example/page` 上线 |
| `Origin` | ✅ **能** | 实测 `Origin: https://origin.example` 上线 |
| `User-Agent` | ✅ **能** | 实测 `User-Agent: MyCustomUA/1.0` 上线；不设时 undici 自动注入 `user-agent: node` |
| `Accept-Encoding` | ✅ **能** | 实测 `Accept-Encoding: br` 上线；不设时自动注入（见第 4 节） |
| `Connection` | ⚠️ **能传但被“消费”** | `lib/core/request.js` 的 `processHeader` 对 `connection` 只做合法性校验并据此设置 `reset`，**不写回 headers**；真正的 `connection: keep-alive/close` 由 `lib/dispatcher/client-h1.js` 自己拼 |
| `Transfer-Encoding` | ❌ **抛错** | 同文件：`throw new InvalidArgumentError('invalid transfer-encoding header')`；实测 `TypeError: fetch failed` |
| `Content-Length` | ⚠️ **能传但被重算/校验** | `processHeader` 解析为 `request.contentLength`；写体时用实体长度覆盖，不一致时抛 `RequestContentLengthMismatchError`；实测 `Content-Length: 9` + 5 字节 body → `TypeError: fetch failed` |

另外实测确认这些“规范里禁止”的头**都能原样上线**：`Cookie2`、`Date`、`DNT`、`TE`、`Trailer`、`Via`、`Accept-Charset`、`Proxy-Authorization`、`Proxy-Connection`、`Sec-Fetch-Site`、`Sec-Ch-Ua`、`X-HTTP-Method: TRACE`。其中 `Expect`、`Keep-Alive` 会直接抛错（`NotSupportedError` / `InvalidArgumentError`）：

```
Expect        => THREW TypeError: fetch failed
Keep-Alive    => THREW TypeError: fetch failed
```

> ⚠️ 回放提示：`Expect`/`Keep-Alive`/`Transfer-Encoding`/`Upgrade` 会让 `fetch` 直接 reject（不是被忽略）。若浏览器原请求带这些头（例如 `Expect: 100-continue`），在 Node `fetch` 下必须剔除后再发。

---

## 2. 跳转 + `Cookie` 头（最重要的一项）

### (a) 规范怎么写的

Fetch 标准的 **HTTP-redirect fetch** 算法第 13 步（[#http-redirect-fetch](https://fetch.spec.whatwg.org/#http-redirect-fetch)）由 [whatwg/fetch PR #1544 "Remove Authorization header upon cross-origin redirect"](https://patch-diff.githubusercontent.com/raw/whatwg/fetch/pull/1544.diff) 加入，diff 中的原文是：

> If request's current URL's origin is not same origin with locationURL's origin, then for each headerName of **CORS non-wildcard request-header name**, delete headerName from request's header list.
>
> *Note:* I.e., the moment another origin is seen after the initial request, the `Authorization` header is removed.

而 `CORS non-wildcard request-header name` 的定义（规范原文）是：

> A CORS non-wildcard request-header name is a header name that is a byte-case-insensitive match for `Authorization`.

**规范只删 `Authorization`，没有删 `Cookie`。** 原因不是疏漏：在浏览器里 `Cookie` 根本不在 request 的 header list 中，而是由 cookie store 在网络层注入，因此规范用 cookie 存储的规则（而不是 header list 的删除步骤）来约束跨源行为。

关于 `redirect` 模式，规范定义（抓自 fetch 标准）：

> `manual`: Retrieves an **opaque-redirect filtered response** when a request is met with a redirect, to allow a service worker to replay the redirect offline. The response is otherwise indistinguishable from a network error, to not violate atomic HTTP redirect handling.

### (b) undici 实际怎么做

`lib/web/fetch/index.js` 的 `httpRedirectFetch` 第 13 步实现（当前 main，逐行注释保留规范编号）：

```js
  // 13. If request's current URL's origin is not same origin with locationURL's
  //     origin, then for each headerName of CORS non-wildcard request-header name,
  //     delete headerName from request's header list.
  if (!sameOrigin(requestCurrentURL(request), locationURL)) {
    // https://fetch.spec.whatwg.org/#cors-non-wildcard-request-header-name
    request.headersList.delete('authorization', true)

    // https://fetch.spec.whatwg.org/#authentication-entries
    request.headersList.delete('proxy-authorization', true)

    // "Cookie" and "Host" are forbidden request-headers, which undici doesn't implement.
    request.headersList.delete('cookie', true)
    request.headersList.delete('host', true)
  }
```

要点：

1. **删除条件是“origin 不同”**（scheme/host/port 任一不同即跨源），**不是“每一次跳转都删”**。
2. undici 比规范**多删 3 个头**：`proxy-authorization`、`cookie`、`host`（因为 undici 不实现禁止头名单，需要在跳转路径上手工补偿）。
3. 同源跳转（例如 `http://a/x` → `http://a/y`，仅路径变化）**不触发删除**。

### (c) 本地实测（Node v26.7.0 / undici 8.9.0，两个本机端口构造同源/跨源跳转）

| 场景 | 目的请求实际收到的头 |
|---|---|
| 同源 302 跳转 + 手写 `Cookie: sid=SAME` | `{"cookie":"sid=SAME", ...}` → **保留** |
| 跨源 302 跳转（同 127.0.0.1、不同端口）+ 手写 `Cookie: sid=CROSS` | `{"cookie":null,"authorization":null, ...}` → **被删** |
| 跨源 302 + `Authorization: Bearer SECRET` | `authorization: null` → **被删** |
| 直连跨源（无跳转）+ `Cookie: sid=DIRECT` | `cookie: "sid=DIRECT"` → **正常发送** |
| 跨源跳转中的普通自定义头 `X-Custom` | 仍然保留（只有上述 4 个头被删） |

### (d) 版本相关性（这是关键，实测+源码取证）

| undici 版本 | 跳转时的行为 | 证据 |
|---|---|---|
| ≤ 5.26.1 | **跨源跳转不删 `Cookie`**（`Authorization` 会删）→ 会把 Cookie 泄漏给第三方/开放重定向目标 | [v5.26.1 源码](https://raw.githubusercontent.com/nodejs/undici/v5.26.1/lib/fetch/index.js) 中该分支只有 `request.headersList.delete('authorization')`，全文无 `delete('cookie')` |
| ≥ 5.26.2 | 跨源跳转删除 `authorization` + `proxy-authorization` + `cookie` + `host` | 修复 commit `e041de359221ebeae04c469e8aff4145764e6d76`，见 [GHSA-wqq4-5wpv-mx2g](https://github.com/nodejs/undici/security/advisories/GHSA-wqq4-5wpv-mx2g)；[v6.21.2 源码](https://raw.githubusercontent.com/nodejs/undici/v6.21.2/lib/web/fetch/index.js) 与当前 main 均已包含 |
| 当前 main / 8.9.0 | 同上 | 源码 + 本次实测 |

对应到 Node 发行版（从官方 changelog 下载核对，`undici 5.26.4` 为 ≥5.26.2 的第一个 5.x 补丁版）：

- **Node 18.19.0** 起捆绑 `undici 5.26.4` → 已修复（[CHANGELOG_V18.md](https://raw.githubusercontent.com/nodejs/node/main/doc/changelogs/CHANGELOG_V18.md)）
- **Node 20.10.0** 起捆绑 `undici 5.26.4` → 已修复；**Node 20.9.0 及更早未修复**（[CHANGELOG_V20.md](https://raw.githubusercontent.com/nodejs/node/main/doc/changelogs/CHANGELOG_V20.md)）
- Node 21/22 线后续均升到 undici 6.x（[CHANGELOG_V21.md](https://raw.githubusercontent.com/nodejs/node/main/doc/changelogs/CHANGELOG_V21.md)、[CHANGELOG_V22.md](https://raw.githubusercontent.com/nodejs/node/main/doc/changelogs/CHANGELOG_V22.md)）

安全公告本身（官方）说明：

> **Impact**: Undici clears Authorization headers on cross-origin redirects, but does not clear `Cookie` headers. … As such this may lead to **accidental leakage of cookie to a 3rd-party site** or a malicious attacker who can control the redirection target (ie. an open redirector) to leak the cookie to the 3rd party site.

`Proxy-Authorization` 有同类问题的另一份公告：[GHSA-3787-6prv-h9w3](https://github.com/nodejs/undici/security/advisories/GHSA-3787-6prv-h9w3)（该 URL 出现在搜索结果中，本次未抓取正文，标记为**未验证细节**）。

### (e) `Authorization` 的安全规则

- **规范层面**：跨源跳转必定删除 `Authorization`（第 13 步），这是规范强制行为，不依赖 undici 的额外补偿。
- **undici 层面**：同时删除 `Authorization` 与 `Proxy-Authorization`。
- 注意这是**累积**的：一旦发生过一次跨源跳转，头就被删除且不会恢复；后续即使跳回原源也不会重新加上。

### (f) `redirect: 'manual'` 与 `'error'`

- 支持的值：`['follow', 'manual', 'error']`（`lib/web/fetch/constants.js` 的 `requestRedirect`）。
- **`manual` 在 undici 返回真实 3xx，而不是 opaqueredirect/status 0**。源码原文：

```js
    } else if (request.redirect === 'manual') {
      // Set response to an opaque-redirect filtered response whose internal
      // response is actualResponse.
      // NOTE(spec): On the web this would return an `opaqueredirect` response,
      // but that doesn't make sense server side.
      // See https://github.com/nodejs/undici/issues/1193.
      response = actualResponse
```

  实测：`status = 302`、`type = "basic"`、`headers.get('location') = "/same-dest"`、`url` 为原始 URL、`redirected = false`。
- 背景版本差异：undici issue [#1193 "Fetch: Allow manual redirect handling"](https://github.com/nodejs/undici/issues/1193)（2022-02）的正文记录了**当时**的行为：

  > Currently you only get an opaque responses using `fetch(..., { redirect: 'manual' })` … `// -> 0 HeadersList(0) []` … This is what the spec says should happen, but it is not very useful for a server-side library…

  该 issue 已以 completed 关闭，源码注释即其结果。**因此 `manual` 的返回形态是版本相关的**：老版本给 status 0 的空响应，现版本给真实 3xx。
- `'error'` **支持**：实测抛 `TypeError: fetch failed`（源码分支为 `makeNetworkError('unexpected redirect')`）。

### (g) 明确判定 + 未解决的不确定性

**判定**：`fetch(url, { headers: { Cookie: '...' }, redirect: 'follow' })` 在 Node 上——

1. **同源跳转：手写 `Cookie` 一定保留**（规范没要求删，undici 也没删）。
2. **跨源跳转：`Cookie` 会被删除**（undici ≥5.26.2，含 Node 18.19.0+/20.10.0+）。这是**安全设计**，不是 bug；旧版本（≤5.26.1 / Node ≤20.9.0）反而会保留并造成泄漏。
3. 想在跨源跳转链上继续带 Cookie，**必须自己实现跳转**（`redirect: 'manual'` 或 `redirect: 'error'` + 手工跟随），因为没有任何 header 层面的绕过方式。

**我无法消除的不确定性**：

- 只对 undici **8.9.0** 做了端到端实测；6.x/7.x 只核对了源码文本，没有逐版本跑用例（**未逐一验证**）。
- 未在真实浏览器里做同源/跨源 cookie 对照实验，浏览器侧结论完全基于规范文本（规范对 browser 的 Cookie 处理通过 cookie store 完成，本报告未展开 RFC 6265bis 细节）。
- `sameOrigin()` 的判定包含端口（实测不同端口即跨源）；但 **https→http 降级、IDN/尾点域名等边界情形未实测**。
- 上述“删除”发生在 **undici 的 fetch 层**。如果你用 `undici.request()` / `Agent.dispatch()`（非 fetch 层）并自己实现跳转，则完全不经过这段逻辑（源码位置不同，行为不同）。

---

## 3. `credentials` 选项

### (a) 规范/MDN 语义

[MDN `Request.credentials`](https://developer.mozilla.org/en-US/docs/Web/API/Request/credentials)：

> The **`credentials`** read-only property … determines whether or not the browser sends credentials with the request, as well as whether any **`Set-Cookie`** response headers are respected.
> Credentials are cookies, TLS client certificates, or authentication headers containing a username and password.
> - `omit`: Never send credentials in the request or include credentials in the response.
> - `same-origin`: Only send and include credentials for same-origin requests. **This is the default.**
> - `include`: Always include credentials, even for cross-origin requests.

### (b) undici 里它实际做什么

允许值在 `lib/web/fetch/constants.js`：`const requestCredentials = ['omit', 'same-origin', 'include']`。
实际用法只有一处（`lib/web/fetch/index.js`）：

```js
  //    3. Let includeCredentials be true if one of
  const includeCredentials =
    request.credentials === 'include' ||
    (request.credentials === 'same-origin' &&
      request.responseTainting === 'basic')
```

`includeCredentials` 之后被用于：设置 `response.requestIncludesCredentials`，以及 401 时的认证重试分支。而**规范中真正与 cookie 有关的那两步在 undici 里是 TODO**：

```js
  //    21. If includeCredentials is true, then:
  if (includeCredentials) {
    // 1. If the user agent is not configured to block cookies for httpRequest
    // (see section 7 of [COOKIES]), then:
    // TODO: credentials
```
```js
  //    3. If includeCredentials is true and the user agent is not configured
  //    to block cookies for request (see section 7 of [COOKIES]), then run the
  //    "set-cookie-string" parsing algorithm (see section 5.2 of [COOKIES]) on
  //    the value of each header whose name is a byte-case-insensitive match for
  //    `Set-Cookie` in response's header list, if any, and request's current URL.
  //    TODO
```

**因此在 Node 里 `credentials` 对 cookie 没有任何可观察效果。**

### (c) Node 没有自动 cookie jar；`Set-Cookie` 必须用 `getSetCookie()`

官方依据：

- undici 的 Cookie 工具文档（[undici docs: Cookies](https://raw.githubusercontent.com/nodejs/undici/main/docs/docs/api/Cookies.md)）开门见山：

  > These functions **do not manage a cookie jar** or perform any network activity; they only read from and mutate the supplied `Headers` object.

  （该模块提供 `getCookies` / `setCookie` / `deleteCookie` / `getSetCookies`（v5.15.0 加入）与 `parseCookie`（v7.0.0 加入），但都是纯函数工具，不会保存状态。）
- 源码里“解析并存储 Set-Cookie”的规范步骤是 `// TODO`（见上）。
- `Headers.getSetCookie()` 是唯一能拿到**多个** `Set-Cookie` 的接口。undici 文档（[Fetch.md](https://raw.githubusercontent.com/nodejs/undici/main/docs/docs/api/Fetch.md)）：

  > `headers.getSetCookie()` … Returns each `Set-Cookie` header as a separate string, **without combining them**.

- 实测（Node v26.7.0）：

  ```
  getSetCookie()      => ["a=1; Path=/","b=2; Path=/"]
  get('set-cookie')   => "a=1; Path=/, b=2; Path=/"    ← 被逗号合并，不可靠
  ```
  实现见 `lib/web/fetch/headers.js`：`getSetCookie()` 返回内部 `cookies` 数组，而 `get('set-cookie')` 走通用的“逗号合并”逻辑。
- 实测确认“无 jar”行为：
  - `credentials: 'include'` + 无手写 Cookie → 请求**不带** Cookie；
  - 先请求 `/setcookie`（响应带 `Set-Cookie: s=1`），再请求 → **不带** Cookie；
  - `credentials: 'omit'` **不会**阻止手写 `Cookie` 头（手写头照常上线）。

> **未找到官方说明**：Node 官方文档中没有一句“Node 没有 cookie jar”的直接表述。上述结论由 undici 官方文档 + 官方源码 TODO + 本地实测三条证据共同支持。
> 与浏览器回放有关的重要后果：浏览器在跳转链上会自动带上 `Set-Cookie` 生成的 Cookie；Node 不会。要忠实回放必须自己维护 cookie jar（或使用第三方 jar 库）。

---

## 4. `Accept-Encoding` 与解压

### (a) undici `fetch` 会自动发 `Accept-Encoding`

源码（`lib/web/fetch/index.js`，对应规范第 18/19 步）：

```js
  //    18. If httpRequest's header list contains `Range`, then append
  //    `Accept-Encoding`/`identity` to httpRequest's header list.
  if (httpRequest.headersList.contains('range', true)) {
    httpRequest.headersList.append('accept-encoding', 'identity', true)
  }

  //    19. Modify httpRequest's header list per HTTP. ...
  if (!httpRequest.headersList.contains('accept-encoding', true)) {
    if (urlHasHttpsScheme(requestCurrentURL(httpRequest))) {
      httpRequest.headersList.append('accept-encoding', 'br, gzip, deflate, zstd', true)
    } else {
      httpRequest.headersList.append('accept-encoding', 'gzip, deflate', true)
    }
  }
```

即：

- **https**：自动 `accept-encoding: br, gzip, deflate, zstd`（当前 main/8.9.0）
- **http**：自动 `accept-encoding: gzip, deflate`（实测线上确为 `"accept-encoding":"gzip, deflate"`）
- **只要你设了 `Range`，就强制变成 `accept-encoding: identity`**（实测：`Range: bytes=0-99` → `"accept-encoding":"identity"`）。这条对“回放带 Range 的浏览器请求”影响很大。
- 你自己传的 `Accept-Encoding` 优先（实测传 `br` 时线上只有 `Accept-Encoding: br`）。

**解压支持**（同一文件 `onResponseStart`）：按 `Content-Encoding` 逆序套解码器，支持 `x-gzip`/`gzip` → `zlib.createGunzip`，`deflate` → inflate，`br` → `zlib.createBrotliDecompress`，`zstd` → `zlib.createZstdDecompress`；编码数量上限 5 个（防资源耗尽）。

### (b) undici 的 zstd 支持是版本相关的（本次核对）

| undici 版本 | 广播的 Accept-Encoding | zstd 解码 |
|---|---|---|
| v6.21.2（Node 22.15.0 捆绑） | `br, gzip, deflate`（https） | 无 zstd 代码 |
| v7.0.0 | `br, gzip, deflate` | **完全没有 zstd** |
| v7.11.0 | `br, gzip, deflate` | — |
| v8.0.0 | `br, gzip, deflate` | 有 `coding === 'zstd' && hasZstd`，`const hasZstd = runtimeFeatures.has('zstd')`（运行时特性守卫） |
| 当前 main / 8.9.0 | `br, gzip, deflate, zstd` | 有，且无守卫 |

（前三项/后两项均由下载对应 tag 的 `lib/web/fetch/index.js` 后本地检索确认。）
**zstd 具体是在 8.0.0 与 8.9.0 之间的哪个版本引入：未验证。**

### (c) Node `zlib`：brotli / zstd 的引入版本

来自官方 `doc/api/zlib.md`（[raw](https://raw.githubusercontent.com/nodejs/node/main/doc/api/zlib.md)，亦见 [nodejs.org/api/zlib.html](https://nodejs.org/api/zlib.html)）：

| API | `added:` |
|---|---|
| `zlib.createBrotliDecompress` / `zlib.brotliDecompress` / `brotliCompress` 等 | **v11.7.0 / v10.16.0** |
| `zlib.createZstdDecompress` / `zstdDecompress` / `zstdDecompressSync` / `createZstdCompress` / `zstdCompress` / `zstdCompressSync`、`### Zstd constants` | **v23.8.0 / v22.15.0**（均标 `Stability: 1 - Experimental`） |

模块开头也写明：*"The `node:zlib` module provides compression functionality implemented using Gzip, Deflate/Inflate, Brotli, and Zstd."*，以及 *"The `node:zlib` module can be used to implement support for the `gzip`, `deflate`, `br`, and `zstd` content-encoding mechanisms defined by HTTP."*

官方发布说明：

- [Node.js 22.15.0 (LTS), 2025-04-23](https://nodejs.org/en/blog/release/v22.15.0)：`**(SEMVER-MINOR)** **zlib**: add zstd support (Jan Martin) [#52100]` 与 `**(SEMVER-MINOR)** **deps,tools**: add zstd 1.5.6 (Jan Martin) [#52100]`
- [Node.js 23.8.0, 2025-02-13](https://nodejs.org/en/blog/release/v23.8.0)：专门小节 “Support for the zstd compression algorithm”——*"Node.js now includes support for the Zstandard (zstd) compression algorithm. Various APIs have been added to the `node:zlib` module for both compression and decompression of zstd streams."*
- 本地实测：Node v26.7.0 上 `typeof require('zlib').createZstdDecompress === 'function'`，`createBrotliDecompress` 同样存在。

### (d) `node:http` **不会**加默认 `Accept-Encoding`

- 官方文档证据：`doc/api/http.md` 中 **`Accept-Encoding` 出现 0 次**；文档中列出会自动添加的默认头只有 `Connection`、`Content-Length`、`Transfer-Encoding`、`Host`（`http.request()` 选项 `setDefaultHeaders` / `setHost`，见 [http.md](https://raw.githubusercontent.com/nodejs/node/main/doc/api/http.md)）。
- 本地实测（node:http GET，无自定义头）：服务端 `rawHeaders` = `["Host","127.0.0.1:43364","Connection","keep-alive"]` → **既没有 `Accept-Encoding`，也没有 `User-Agent`**。
- ⚠️ **未找到官方说明**：Node 文档里没有一句“http 模块不会自动加 Accept-Encoding/User-Agent”的**否定式**表述；上述结论由“文档缺失 + 源码/实测行为”支持。

---

## 5. `Host` / `:authority`

### (a) undici `fetch`：**不能**覆盖 `Host`

- 源码（`lib/web/fetch/index.js`，位于 `httpNetworkOrCacheFetch`）：

```js
  httpRequest.headersList.delete('host', true)
```

- 该行来自已合并的 PR [nodejs/undici #2322 "disallow setting host header in fetch"](https://github.com/nodejs/undici/pull/2322)（merged 2023-10-09，merge commit `470ee38145c5e6b367874b8b67f45143b67557c0`，[API 元数据](https://api.github.com/repos/nodejs/undici/pulls/2322)），其新增测试的断言语义正好相反于直觉命名——用户传的 `host` 被忽略：

```js
test('Undici overrides user-provided `Host` header', async (t) => {
  const server = createServer((req, res) => {
    t.equal(req.headers.host, `localhost:${server.address().port}`)
    ...
  await fetch(`http://localhost:${server.address().port}`, { headers: { host: 'www.idk.org' } })
```

- 本地实测：`fetch(url, { headers: { Host: 'evil.example' } })` → 服务端看到 `host: 127.0.0.1:<真实端口>`。
- 注意分层差异：**undici 的底层 `Client`/`Agent`（`undici.request`）是可以指定 `host` 的**——`lib/core/request.js` 的 `processHeader` 中有专门的 `if (headerName === 'host') { … request.host = val }`（注释 `// Consumed by Client`），只是 `fetch` 层在调用 dispatcher 之前把 `host` 删掉了。

### (b) `node:http`：可以设置 `Host`

- 文档：`http.request()` 的 `setHost` 选项（[http.md](https://raw.githubusercontent.com/nodejs/node/main/doc/api/http.md)）——
  > `setDefaultHeaders` {boolean}: Specifies whether or not to automatically add default headers such as `Connection`, `Content-Length`, `Transfer-Encoding`, and `Host`. … Defaults to `true`.
  > `setHost` {boolean}: Specifies whether or not to automatically add the `Host` header. If provided, this overrides `setDefaultHeaders`. Defaults to `true`.
- 本地实测：`http.request({ headers: { Host: 'spoofed.example' } })` → 服务端 `req.headers.host === "spoofed.example"`。
- 因此，若目标是“伪造 Host / 直连 IP 但带域名 Host”，**必须走 `node:http`/`node:https`（或 undici 的 `Client`，而非 `fetch`）**。

### (c) `node:http2`：伪头就是普通的 `':'` 前缀键

- 文档（[http2.md](https://raw.githubusercontent.com/nodejs/node/main/doc/api/http2.md)）：
  > Headers are represented as own-properties on JavaScript objects. The property keys will be serialized to lower-case.
  > `HTTP2_HEADER_METHOD`, `HTTP2_HEADER_AUTHORITY`, `HTTP2_HEADER_SCHEME`, and `HTTP2_HEADER_PATH` identify request pseudo-headers. … Pseudo-headers are not permitted in trailers.
  > `:method` and `:path` 未指定时分别默认 `'GET'` 与 `'/'`。
- `:authority` 与 `host` 的关系（文档 “Note on `:authority` and `host`”）：
  > HTTP/2 requires requests to have either the `:authority` pseudo-header or the `host` header. Prefer `:authority` when constructing an HTTP/2 request directly, and `host` when converting from HTTP/1 …
- 规范（RFC 9113，我下载 [rfc9113.txt](https://www.rfc-editor.org/rfc/rfc9113.txt) 后逐段核对）：
  - §8.3 **HTTP Control Data**：*"HTTP/2 uses special pseudo-header fields beginning with a ':' character (ASCII 0x3a) to convey message control data"*；*"All pseudo-header fields MUST appear in a field block before all regular field lines."*；*"The same pseudo-header field name MUST NOT appear more than once in a field block."*
  - §8.3.1：*"The recipient of an HTTP/2 request MUST NOT use the Host header field to determine the target URI if ':authority' is present."*；*"Clients that generate HTTP/2 requests directly MUST use the ':authority' pseudo-header field to convey authority information, unless there is no authority information to convey."*
- 本地实测（h2c，`http2.createServer` + `http2.connect`）：客户端传 `:method/:path/:scheme/:authority` 全部可自定义，服务端收到
  `{":method":"GET",":path":"/custom?q=1",":scheme":"http",":authority":"fake-authority.example","host":"host-header.example","x-test":"1"}` → **`:authority` 与 `:path` 可任意设置**（可同时携带普通 `host`）。

### (d) undici `fetch` 支持 HTTP/2 吗？

- `Client`/`Agent` 有 `allowH2` 选项，当前官方文档（[Client.md](https://raw.githubusercontent.com/nodejs/undici/main/docs/docs/api/Client.md)、[undici docs site](https://undici.nodejs.org/api/Client)）：
  > `allowH2` {boolean} Enables HTTP/2 support when the server assigns it a higher priority through ALPN negotiation. **Default:** `true`.
- HTTP/2 的前置条件（同一文档）：
  > The server must support HTTP/2 and select it during ALPN negotiation, and must not give HTTP/1.1 a higher priority than HTTP/2.
  > Pseudo headers (`:path`, `:method`, `:scheme`, `:authority`) are attached automatically and **overwrite any user-provided values**.
  明文 h2c 需另行开启：`h2Options.useH2c`（默认 `false`）。
- `fetch` 层不强制关闭 H2：源码把请求交给 dispatcher 时只在特定回退路径上传 `allowH2: false`（websocket over h2 扩展 CONNECT 失败时重试），因此**是否走 HTTP/2 由 dispatcher 的 `allowH2` 默认值与 ALPN 协商决定**。
- ⚠️ **版本提示（未验证）**：`allowH2` 在更早的 undici 版本里曾是实验性/默认关闭；本次只核对了当前 main 与 undici.nodejs.org 上的 v8.10.0 文档，**旧版本的默认值与文档措辞未验证**。Node 内置版本可用 `process.versions.undici` 查询（[Node `fetch` 官方文档](https://raw.githubusercontent.com/nodejs/node/main/doc/api/globals.md)：*"The implementation is based upon undici, an HTTP/1.1 client written from scratch for Node.js. You can figure out which version of `undici` is bundled in your Node.js process reading the `process.versions.undici` property."*）。
- 结论：**用 `fetch` 无法保证与浏览器相同的协议版本**；要精确控制，应直接用 `node:http2`（或 undici 的 `Client` + 明确的 `allowH2`/`useH2c`）。

---

## 6. 请求头顺序与大小写

### (a) 规范侧：大小写不敏感，JS 可见顺序是“排序后合并”

- 头名本身大小写不敏感；`append` 会复用已在列表中的那个头的大小写（规范原文）：
  > To append a header (name, value) to a header list list: 1. If list contains name, then set name to the first such header's name. *This reuses the casing of the name of the header already in list, if any.*
- JS 侧迭代顺序由 **sort and combine** 决定（规范原文）：
  > To convert header names to a sorted-lowercase set … 2. For each name of headerNames, append the result of byte-lowercasing name … 3. Return the result of sorting headerNamesSet in ascending order with byte less than.
  > To sort and combine a header list list … （按排序后的小写名字逐个取值；`set-cookie` 特殊处理，逐条输出）
- undici 文档同样说明：*"`Headers` is iterable, yielding `[name, value]` pairs **sorted by name**"*（[Fetch.md](https://raw.githubusercontent.com/nodejs/undici/main/docs/docs/api/Fetch.md)）。实现见 `lib/web/fetch/headers.js` 的 `toSortedArray()`（≤32 个用二分插入排序，否则 `Array.sort(compareHeaderName)`）。

⚠️ 关键区分：**这套排序只影响 JS 里 `Headers` 的迭代/可见视图，不等于上线顺序。**

### (b) undici 上线时的真实顺序（源码 + 实测）

- 传给 dispatcher 的是 `request.headersList.entries`，而 `HeadersList.entries` 是一个**按 Map 插入序**生成的普通对象（`lib/web/fetch/headers.js`），因此保持用户插入顺序。
- 写出（`lib/dispatcher/client-h1.js` 的 `writeH1`）顺序固定为：
  1. `method path HTTP/1.1`
  2. `host: …`（来自 URL 或 client）
  3. `connection: keep-alive|close`（或 upgrade 组合）
  4. **用户头，按插入序，保留原始大小写**
  5. 写 body 时追加 `content-length: N`（或 `transfer-encoding: chunked`）
- 实测（Node v26.7.0 / undici 8.9.0，服务端 `rawHeaders` 顺序）：

  ```
  传 { 'z-last':1, 'a-first':2, 'm-mid':3 }
  → ["host","connection","z-last","a-first","m-mid","accept","accept-language","sec-fetch-mode","user-agent","accept-encoding"]
  ```
  → **不排序**，保持插入序；`accept`/`accept-language`/`sec-fetch-mode`/`user-agent`/`accept-encoding` 这些 undici 自动加的头永远排在用户头**之后**；`content-length` 排最后。
- 大小写实测：传入 `Content-Type`、`Cookie`、`DNT`、`Accept-Charset`、`Sec-Ch-Ua` 等，线上**保持你写的原始大小写**（`lib/web/fetch/headers.js` 的 `append` 在首次插入时保留 `name`）。

### (c) `node:http` 的顺序

- **未找到官方说明**：`doc/api/http.md` 里没有任何关于请求头写出顺序的承诺（没有 `_storeHeader`，也没有“insertion order”之类表述；文档中出现的 “order” 都用于事件顺序、响应归属等其他语境）。
- 本地实测：`{ Host:'spoofed.example', 'X-Zeta':'1', 'x-Alpha':'2', 'CONTENT-TYPE':'text/plain' }` → 服务端 `rawHeaders` =
  `["Host","spoofed.example","X-Zeta","1","x-Alpha","2","CONTENT-TYPE","text/plain","Connection","keep-alive"]`
  → **插入序 + 原始大小写**，`Connection` 由 agent 追加在最后。

### (d) 协议层对顺序的规定

- RFC 9110 §5.3 **Field Order**（下载 [rfc9110.txt](https://www.rfc-editor.org/rfc/rfc9110.txt) 核对原文）：
  > The order in which field lines with **differing field names** are received in a section is **not significant**. However, it is good practice to send header fields that contain additional control data first, such as **Host** on requests and **Date** on responses …
  > The order in which field lines with the **same name** are received is therefore significant to the interpretation of the field value; a proxy MUST NOT change the order of these field line values when forwarding a message.
- RFC 9113 §8.3：伪头必须在所有普通字段之前（见第 5 节引文）。

### (e) 判定

- **顺序**：undici 与 `node:http` 都**不提供**控制上线顺序的 API，只能依靠对象插入序；且 undici 会把 `host`/`connection` 固定放最前、`content-length` 放最后，自动头插在用户头之后。想完全复刻 Chrome 的头部排列，**做不到**（且无官方 API 支持）。
- **大小写**：HTTP/1.1 下两者都**保留调用方传入的原始大小写**。浏览器发送时的大小写策略本次**未验证**（未找到官方说明），因此“大小写是否与浏览器一致”不能保证。
- **重复头**：undici 的 `HeadersList.append` 对同名头做合并（`cookie` 用 `'; '`，其他用 `', '`），实测 `h.append('Cookie','a=1'); h.append('Cookie','b=2')` → 线上 `cookie: a=1; b=2`。若浏览器原请求真的发了多条同名 Cookie 行，Node `fetch` 会把它们合成一行。

---

## 7. TLS / 传输层指纹

### (a) 结论先行

| 问题 | 结论 |
|---|---|
| Node 的 TLS ClientHello 看起来像 Chrome 吗？ | ❌ **不像**（默认配置下）。Node 用 OpenSSL，extension 按固定顺序生成、cipher 列表比浏览器更宽 |
| 有没有**官方文档**说“Node 指纹与 Chrome 不同”？ | **未找到官方说明**（`nodejs.org/api/tls.html` 里没有任何 JA3/JA4/ClientHello 指纹内容，`fingerprint` 全部指**证书**摘要；undici 文档里的 `fingerprint` 指 CA 证书 pin） |
| 有没有**可信但非官方**的陈述？ | ✅ 有：Node 官方仓库 issue 中 Node core 成员明确陈述；undici issue；OpenSSL issue（均为 **非官方/社区来源**，见 (e)） |
| 能否靠“配置请求头”复刻浏览器指纹？ | ❌ 不能。HTTP/2 指纹来自 SETTINGS/WINDOW_UPDATE/PRIORITY 帧与伪头顺序，undici 文档明确说伪头是**自动附加并覆盖用户值**；TLS 指纹来自 ClientHello 字节序，与 HTTP 头无关 |

### (b) JA3（第一代 TLS 指纹）

来源：[salesforce/ja3 README](https://raw.githubusercontent.com/salesforce/ja3/master/README.md)（仓库页 https://github.com/salesforce/ja3 ）。

> JA3 is a method for creating SSL/TLS client fingerprints that should be easy to produce on any platform and can be easily shared for threat intelligence.
> JA3 gathers the decimal values of the bytes for the following fields in the Client Hello packet; SSL Version, Accepted Ciphers, List of Extensions, Elliptic Curves, and Elliptic Curve Formats. It then concatenates those values together in order, using a "," to delimit each field and a "-" to delimit each value in each field.
> The field order is as follows: `SSLVersion,Cipher,SSLExtension,EllipticCurve,EllipticCurvePointFormat`
> These strings are then MD5 hashed to produce an easily consumable and shareable 32 character fingerprint.
> We also needed to introduce some code to account for Google's GREASE … JA3 ignores these values completely …

维护状态（README 原文，注意**没有**使用 “deprecated” 一词）：

> JA3 was invented at Salesforce in 2017. However, the project is **no longer being actively maintained by Salesforce**. Its original creator, John Althouse, maintains the latest in TLS client fingerprinting technology at [FoxIO-LLC](https://github.com/FoxIO-LLC/ja4).

### (c) JA4 / JA4+（继任者）

来源：[FoxIO-LLC/ja4 README](https://raw.githubusercontent.com/FoxIO-LLC/ja4/main/README.md)、规范图 [technical_details/JA4.png](https://raw.githubusercontent.com/FoxIO-LLC/ja4/main/technical_details/JA4.png)、[technical_details/JA4H.png](https://raw.githubusercontent.com/FoxIO-LLC/ja4/main/technical_details/JA4H.png)、参考实现 [python/ja4h.py](https://raw.githubusercontent.com/FoxIO-LLC/ja4/main/python/ja4h.py)、[FoxIO 官方博客](https://foxio.io/blog/ja4-network-fingerprinting)。

> JA4+ is a suite of network fingerprinting methods by FoxIO that are easy to use and easy to share. These methods are both human and machine readable …
> All JA4+ fingerprints have an **a_b_c format**, delimiting the different sections that make up the fingerprint.

与 JA3 的结构性差异（README Q&A 原文）：

> Q: Why are you sorting the ciphers? … A: … This also reduces the effectiveness of "**cipher stunting**," a tactic of randomizing cipher ordering to prevent JA3 detection.
> Q: Why are you sorting the extensions? A: Earlier in 2023, Google updated Chromium browsers to **randomize their extension ordering**. Much like cipher stunting, this was a tactic to prevent JA3 detection … sorting the extensions gets around this and adding in Signature Algorithms preserves uniqueness.

JA4（TLS client）包含的维度：Protocol（TCP/QUIC）、TLS 版本、是否有 SNI、Cipher 数量、Extension 数量、**首个 ALPN 值**、排序后 Cipher 的 SHA256 截断、排序后 Extension + Signature Algorithms 的 SHA256 截断。

**JA4H（HTTP client 指纹）** 的元素（JA4H.png + `ja4h.py`）：HTTP 方法（GET=`ge`）、HTTP 版本（1.1=`11`）、是否有 Cookie（`c`/`n`）、是否有 Referer（`r`/`n`）、**HTTP 头数量**、Accept-Language 前 4 字符、**按出现顺序**的头名 SHA256 截断（`JA4H_b`）、排序后的 Cookie 字段哈希（`JA4H_c`）、排序后的 Cookie 字段+值哈希（`JA4H_d`）；计算 `JA4H_b` 时会剔除伪头（`:` 开头）与 `cookie`/`referer`。

> 对回放的含义：**`JA4H_b` 直接对“请求头名及其出现顺序”取哈希**——也就是说，第 6 节讨论的“头部顺序/集合差异”会被服务端直接当作指纹维度观测到。Node 无法精确复刻浏览器头部集合与顺序，因此 **JA4H 层面也会与真实浏览器不同**（这一推论基于上述规范图元素，属于本报告的推断，**未经实测验证**）。

许可（README 原文）：

> **JA4: TLS Client Fingerprinting** is open-source, **BSD 3-Clause**, same as JA3. FoxIO does not have patent claims …
> **JA4S, JA4L, …, JA4H, …, JA4N and all future additions (collectively referred to as JA4+)** are patent-pending and licensed under the FoxIO License 1.1. This license is permissive for most use cases … but is **not permissive for monetization**.

### (d) Cloudflare 官方对 JA3→JA4 的说明

来源：[Cloudflare blog: Advancing Threat Intelligence: JA4 fingerprints and inter-request signals](https://blog.cloudflare.com/ja4-signals/)（2024-08-12）、[Cloudflare 官方文档 JA3/JA4 fingerprint](https://developers.cloudflare.com/bots/additional-configurations/ja3-ja4-fingerprint/)。

> Over time, JA3 became less useful due to the following reasons: **Randomization of TLS extensions** … **Inconsistencies across tools** … **Limited scope and lack of adaptability** …
> In response to these challenges, FoxIO developed JA4, a successor to JA3 … Officially launched in September 2023 …
> JA4 fingerprint is **resistant to the randomization of TLS extensions** and incorporates additional useful dimensions, such as **Application Layer Protocol Negotiation (ALPN)**, which were not part of JA3.

（Cloudflare 官方文档中**没有**任何关于 Node.js / undici / OpenSSL 的表述 → 就“Node 与 Chrome 指纹不同”这一点，Cloudflare 官方**未找到官方说明**。）

### (e) HTTP/2 指纹：Akamai 白皮书 + RFC 9113

**Akamai 白皮书可访问**（本次实际下载成功的地址）：
https://blackhat.com/docs/eu-17/materials/eu-17-Shuster-Passive-Fingerprinting-Of-HTTP2-Clients-wp.pdf
（标题页：`AKAMAI WHITE PAPER / Passive Fingerprinting of HTTP/2 Clients / Ory Segal … Aharon Fridman … Elad Shuster … Akamai`，文末 `Published 06/17.`）

> The data analysis yielded a consistent variation in the following protocol flows: 1. **SETTINGS frame** 2. **WINDOW_UPDATE frame** 3. **PRIORITY frame**
> We looked into the SETTINGS frames sent from client to server, and we found that different clients differ in: The SETTINGS parameters they choose to send / **The order by which the SETTINGS parameters are sent** / The values they set for the SETTINGS parameters
> We noticed that request **pseudo-headers appeared in a different order which depends on client implementation.** For example, Chrome browsers issued the pseudo-headers in the following order: `:method`, `:authority`, `:scheme`, `:path` … While Firefox browsers sent them as follows: `:method`, `:path`, `:authority`, `:scheme`
> 建议格式：`S[;]|WU|P[,]#`（伪头顺序可扩展为 `S[;]|WU|P[,]#|PS[,]`，PS 取值 `m`/`p`/`a`/`s`）
> 样例：`Example 1: Chrome Browser on Mac OS X — 1:65536;3:1000;4:6291456|15663105|0`

白皮书自己承认的可定制性限制（对“能否伪装”很关键）：

> while some web clients enable a user to launch them with customized TLS settings, our research shows that **many HTTP/2 clients don't support modification of basic HTTP/2 implementation details such as the SETTINGS frame values, or the pseudo-headers name order**.

**RFC 9113 对顺序的规定**（我用下载的 [rfc9113.txt](https://www.rfc-editor.org/rfc/rfc9113.txt) 与 [rfc9113.html](https://www.rfc-editor.org/rfc/rfc9113.html#section-8.3) 逐段核对）：

- §8.3：*"All pseudo-header fields MUST appear in a field block **before all regular field lines**. Any request or response that contains a pseudo-header field that appears in a field block after a regular field line MUST be treated as malformed."*
- §8.3：*"The same pseudo-header field name MUST NOT appear more than once in a field block."*
- §8.3.1：*"All HTTP/2 requests MUST include exactly one valid value for the ':method', ':scheme', and ':path' pseudo-header fields, unless they are CONNECT requests."*；*"The recipient of an HTTP/2 request MUST NOT use the Host header field to determine the target URI if ':authority' is present."*
- §8.2.3（与 Cookie 回放直接相关）：*"To allow for better compression efficiency, the Cookie header field MAY be split into separate header fields … If there are multiple Cookie header fields after decompression, these MUST be concatenated into a single octet string using the two-octet delimiter of 0x3b, 0x20 (the ASCII string "; ") before being passed into a non-HTTP/2 context."*
- **RFC 9113 通篇没有对普通（非伪）header 字段顺序的任何 MUST/SHOULD 要求**（`order` 的命中只涉及帧顺序、SETTINGS 处理顺序、byte order 等）。
- 因此：Akamai 所利用的“伪头顺序 + SETTINGS 参数顺序”熵，**恰恰来自 RFC 留下的自由度**；而“伪头必须在普通字段之前”是所有实现共同遵守的下界。undici 文档也确认伪头是自动附加且覆盖用户值（*"Pseudo headers (`:path`, `:method`, `:scheme`, `:authority`) are **attached automatically and overwrite any user-provided values**."*，[Client.md](https://raw.githubusercontent.com/nodejs/undici/main/docs/docs/api/Client.md)）。

### (f) 是否存在“Node 指纹 ≠ Chrome 指纹”的权威陈述？

**官方文档层面：未找到官方说明。** 本次实际抓取并全文检索了 [nodejs.org/api/tls.html](https://nodejs.org/api/tls.html)、[undici.nodejs.org/api/Client](https://undici.nodejs.org/api/Client)、[undici.nodejs.org/api/Connector](https://undici.nodejs.org/api/Connector)、[docs.openssl.org openssl-s_client](https://docs.openssl.org/master/man1/openssl-s_client/) —— 均无 JA3/JA4/TLS 指纹相关内容（`fingerprint` 全部指证书摘要或 CA pin）。

**但存在来自 Node 官方仓库、由 Node core 成员（`author_association: MEMBER`）作出的明确陈述**（按你的要求标记为 **非官方/社区来源**）：

[nodejs/node issue #41112 "Provide APIs to help control TLS fingerprints](https://github.com/nodejs/node/issues/41112)（API 抓取：https://api.github.com/repos/nodejs/node/issues/41112 ）：

> There are servers in the wild online (at least all sites using Akamai's CDN bot management feature) which actively block all connections from Node.js clients by examining their **TLS fingerprint**.
> （core 成员 bnoordhuis）Extensions are currently added to the handshake packet in **fixed order**, see `tls_construct_extensions()` in `deps/openssl/openssl/ssl/statem/extensions.c`.
> （core 成员 pimterry）Right now, this is **impossible to do 100% correctly in Node, because not everything is configurable in OpenSSL**, which we use for all TLS.
> （该 issue 关闭时的评论）The final key part of this shipped in **Node 26.4.0**, and it's now possible to fully match most common **JA4** TLS fingerprints in Node.

（“Node 26.4.0 已可匹配 JA4”一说来自 issue 评论，**本报告未独立验证**；其含义恰恰是“默认状态下不匹配、需要额外 API 配置”。）

其它同源（仍为非官方）证据：[nodejs/undici issue #1983](https://github.com/nodejs/undici/issues/1983)：*"Currently, there is no a comfortable way to impersonate a browser's fingerprint in nodejs"*；[openssl/openssl issue #19220](https://github.com/openssl/openssl/issues/19220)（由 bnoordhuis 提交）：*"Request: an API that lets the openssl user (node.js) shuffle extensions in the ClientHello to prevent TLS fingerprinting."*

二手/厂商博客（**未独立验证数值**）：[httptoolkit: Fighting TLS fingerprinting with Node.js](https://httptoolkit.com/blog/tls-fingerprinting-node-js/) —— *"Many TLS implementations (including Node's) don't allow you to configure low-level details that aren't semantically meaningful, such as the order the TLS extensions are set in the client hello."*，并给出（二手）JA3 值示例 `Node.js v12/14/16: c4aac137ff0b0ac82f3c138cf174b427`、`Chrome 97: b32309a26951912be7dba376398abc3b`——**这些具体哈希值本报告未验证**。

### (g) 对“回放浏览器请求”的实际含义

1. **TLS 层**：Node 默认使用 OpenSSL 的固定 extension 顺序与更宽的 cipher 列表，**ClientHello ≠ Chrome**；请求头怎么配都改变不了这一点。想要接近，需要能操纵 OpenSSL ClientHello 的专门客户端（Node 26.4.0+ 相关 API —— 未验证），或直接用真实浏览器/其他栈。
2. **HTTP/2 层**：伪头顺序、SETTINGS 参数集合与顺序、WINDOW_UPDATE 增量都由实现决定；undici 会用自己的值并覆盖用户的伪头。用 `node:http2` 虽然能自定义伪头顺序，但 SETTINGS/WINDOW_UPDATE 等帧参数仍与 Chrome 不同（本报告**未实测** undici/node:http2 与 Chrome 的 HTTP/2 指纹差异）。
3. **HTTP 层**：即便第 1–6 节的所有 header 都能对齐，`JA4H_b` 仍然会对“头名集合 + 出现顺序”取哈希，所以头部层面的任何差异都会被观测到。
4. 因此，对于“以 TLS/H2/HTTP 指纹做风控”的目标站点，**Node 无法忠实复刻浏览器**；本报告的结论是：这不是配置问题，而是传输层实现差异（**核心成员陈述 + RFC/白皮书佐证**）。

---

## 8. `Range` 请求

### (a) `Range` 是 CORS-safelisted request header 吗？——**是（带约束）**

Fetch 标准的 “CORS-safelisted request-header” 判定算法（[fetch.spec.whatwg.org](https://fetch.spec.whatwg.org/#cors-safelisted-request-header)）里 `range` 分支原文：

> `range`
> 1. Let rangeValue be the result of parsing a single range header value given value and false.
> 2. If rangeValue is failure, then return false.
> 3. If rangeValue[0] is null, then return false.
>    *As web browsers have historically not emitted ranges such as `bytes=-500` this algorithm does not safelist them.*

即 CORS-safelisted 的 5 个请求头是 `Accept`、`Accept-Language`、`Content-Language`、`Content-Type`、**`Range`**（MDN 同样列出：[CORS-safelisted request header](https://developer.mozilla.org/en-US/docs/Glossary/CORS-safelisted_request_header)），约束为：

> `Range` needs to have a value of a single byte range in the form of `bytes=[0-9]+-[0-9]*`. … For any header: the value's length can't be greater than 128.

（所以 `Range: bytes=-500` 这种后缀范围**不是** safelisted，会触发预检。）

### (b) Node 里能自由设置 `Range` 吗？——**能，而且不受 CORS 约束**

- Node 的 `fetch` 没有浏览器同源/预检模型：实测 `fetch(url, { headers: { Range: 'bytes=0-99' } })` 正常发出，服务端收到该头；不存在 `Access-Control-Allow-Headers` 之类限制。
- ⚠️ **但有一个 undici 特有的副作用**：只要 header list 里出现 `Range`，undici 就会追加 `Accept-Encoding: identity`（规范第 18 步 / 源码 / 实测均确认），也就是**请求带 `Range` 时响应不会被压缩**。回放带 `Range` 的浏览器请求时会因此与浏览器行为不同（浏览器一般仍会声明 gzip/br）。
- 若用 `node:http` 手动发 `Range`，则没有上述自动改写（需要自己处理 `Content-Encoding` 与 range 语义的交互）。

---

## 9. 汇总：明确“未验证 / 未找到官方说明”的条目

| 条目 | 状态 |
|---|---|
| Node 官方文档中“`http` 不会自动加 `Accept-Encoding`/`User-Agent`”的**否定式**表述 | **未找到官方说明**（由文档缺失 + 实测支持） |
| `node:http` 请求头**写出顺序**的任何官方承诺 | **未找到官方说明**（实测为插入序） |
| `node:http` 请求自动 `Date` 头 | **未找到官方说明**（文档只讲响应侧 `response.sendDate`） |
| `node:http2` 客户端请求 `:scheme`/`:authority` 的“自动填充”明文描述 | **未找到官方说明**（文档只明文写 `:method`/`:path` 默认值，以及 `:authority`↔`host` 回退规则） |
| undici `allowH2: false` 的具体降级行为描述 | **未找到官方说明** |
| 旧版 undici（Node 20/22 早期捆绑版本）`allowH2` 的默认值与措辞 | **未验证**（仅核对当前 main 与 undici.nodejs.org v8.10.0） |
| undici 把 `zstd` 加入默认 `Accept-Encoding` 的确切版本 | **未验证**（已确认 v8.0.0 没有、8.9.0 有） |
| 各 undici 6.x/7.x 版本“同源跳转保留 Cookie”的行为 | **未逐一验证**（仅 8.9.0 实测 + 5.26.1/6.21.2 源码核对） |
| 浏览器 HTTP/1.1 请求头大小写策略 | **未验证** |
| `GHSA-3787-6prv-h9w3`（Proxy-Authorization）正文细节 | **未抓取**（仅出现在搜索结果中） |
| 真实浏览器 cookie 跨源跳转对照实验 | **未验证**（浏览器侧结论基于规范文本） |
| “Node 26.4.0 起可完全匹配常见 JA4 指纹” | **未验证**（仅来自 [nodejs/node#41112](https://github.com/nodejs/node/issues/41112) 的关闭评论，属非官方来源） |
| Node/undici 与 Chrome 的 HTTP/2 指纹（SETTINGS/WINDOW_UPDATE/PRIORITY）实际差异 | **未实测**（只有 Akamai 白皮书给出的 Chrome 样例指纹可作参照） |
| httptoolkit 博客给出的 JA3 哈希值 | **未验证**（二手数据） |

---

## 10. 主要引用来源（均为本次实际抓取/下载）

**规范 / 标准**
- Fetch Standard（禁止请求头、CORS-safelisted、跳转模式、HTTP-redirect fetch）：https://fetch.spec.whatwg.org/#forbidden-header-name 、https://fetch.spec.whatwg.org/#http-redirect-fetch 、https://fetch.spec.whatwg.org/#forbidden-request-header
- whatwg/fetch PR #1544（跨源跳转删除 Authorization 的规范 diff）：https://patch-diff.githubusercontent.com/raw/whatwg/fetch/pull/1544.diff
- RFC 9110 §5.3 Field Order：https://www.rfc-editor.org/rfc/rfc9110.txt （HTML 版 https://www.rfc-editor.org/rfc/rfc9110.html ）
- RFC 9113 §8.3 HTTP Control Data / §8.3.1：https://www.rfc-editor.org/rfc/rfc9113.txt （HTML 版 https://www.rfc-editor.org/rfc/rfc9113.html#section-8.3 ）
- MDN：https://developer.mozilla.org/en-US/docs/Glossary/Forbidden_request_header 、https://developer.mozilla.org/en-US/docs/Glossary/CORS-safelisted_request_header 、https://developer.mozilla.org/en-US/docs/Web/API/Request/credentials

**undici 源码（main）**
- https://raw.githubusercontent.com/nodejs/undici/main/lib/web/fetch/index.js （跳转、Accept-Encoding、User-Agent、credentials、manual redirect）
- https://raw.githubusercontent.com/nodejs/undici/main/lib/web/fetch/headers.js （不实现禁止头、getSetCookie、sort-and-combine）
- https://raw.githubusercontent.com/nodejs/undici/main/lib/web/fetch/request.js
- https://raw.githubusercontent.com/nodejs/undici/main/lib/web/fetch/constants.js
- https://raw.githubusercontent.com/nodejs/undici/main/lib/core/request.js （processHeader：host/content-length/connection/transfer-encoding 处理）
- https://raw.githubusercontent.com/nodejs/undici/main/lib/dispatcher/client-h1.js （HTTP/1.1 上线顺序与拼接）

**undici 历史版本（版本相关性取证）**
- https://raw.githubusercontent.com/nodejs/undici/v5.26.1/lib/fetch/index.js
- https://raw.githubusercontent.com/nodejs/undici/v6.21.2/lib/web/fetch/index.js
- https://raw.githubusercontent.com/nodejs/undici/v7.0.0/lib/web/fetch/index.js 、v7.11.0 、v8.0.0

**undici 官方文档 / 公告**
- Fetch：https://raw.githubusercontent.com/nodejs/undici/main/docs/docs/api/Fetch.md
- Cookies（无 cookie jar）：https://raw.githubusercontent.com/nodejs/undici/main/docs/docs/api/Cookies.md
- Client（allowH2）：https://raw.githubusercontent.com/nodejs/undici/main/docs/docs/api/Client.md 、https://undici.nodejs.org/api/Client
- Agent：https://raw.githubusercontent.com/nodejs/undici/main/docs/docs/api/Agent.md
- PR #2322（fetch 删除 Host）：https://github.com/nodejs/undici/pull/2322 、https://api.github.com/repos/nodejs/undici/pulls/2322 、https://patch-diff.githubusercontent.com/raw/nodejs/undici/pull/2322.diff
- Issue #1193（manual redirect）：https://github.com/nodejs/undici/issues/1193 、https://api.github.com/repos/nodejs/undici/issues/1193
- CVE-2023-45143 / GHSA-wqq4-5wpv-mx2g：https://github.com/nodejs/undici/security/advisories/GHSA-wqq4-5wpv-mx2g 、https://raw.githubusercontent.com/github/advisory-database/main/advisories/github-reviewed/2023/10/GHSA-wqq4-5wpv-mx2g/GHSA-wqq4-5wpv-mx2g.json
- GHSA-3787-6prv-h9w3（Proxy-Authorization，搜索结果）：https://github.com/nodejs/undici/security/advisories/GHSA-3787-6prv-h9w3

**Node.js 官方文档 / 发布说明 / 源码**
- zlib：https://raw.githubusercontent.com/nodejs/node/main/doc/api/zlib.md 、https://nodejs.org/api/zlib.html
- http：https://raw.githubusercontent.com/nodejs/node/main/doc/api/http.md
- http2：https://raw.githubusercontent.com/nodejs/node/main/doc/api/http2.md
- globals（fetch 基于 undici）：https://raw.githubusercontent.com/nodejs/node/main/doc/api/globals.md
- 发布说明：https://nodejs.org/en/blog/release/v22.15.0 、https://nodejs.org/en/blog/release/v23.8.0
- Changelog（undici 版本边界）：CHANGELOG_V18.md / V20.md / V21.md / V22.md （https://raw.githubusercontent.com/nodejs/node/main/doc/changelogs/CHANGELOG_V20.md 等）

**指纹（第 7 节）**
- JA3：https://raw.githubusercontent.com/salesforce/ja3/master/README.md 、https://github.com/salesforce/ja3
- JA4 / JA4+：https://raw.githubusercontent.com/FoxIO-LLC/ja4/main/README.md 、https://raw.githubusercontent.com/FoxIO-LLC/ja4/main/technical_details/JA4.png 、https://raw.githubusercontent.com/FoxIO-LLC/ja4/main/technical_details/JA4H.png 、https://raw.githubusercontent.com/FoxIO-LLC/ja4/main/python/ja4h.py 、https://foxio.io/blog/ja4-network-fingerprinting
- Cloudflare：https://blog.cloudflare.com/ja4-signals/ 、https://developers.cloudflare.com/bots/additional-configurations/ja3-ja4-fingerprint/
- Akamai HTTP/2 指纹白皮书（Black Hat EU-17 材料）：https://blackhat.com/docs/eu-17/materials/eu-17-Shuster-Passive-Fingerprinting-Of-HTTP2-Clients-wp.pdf
- Node/OpenSSL/undici 指纹限制（非官方/社区来源）：https://github.com/nodejs/node/issues/41112 、https://api.github.com/repos/nodejs/node/issues/41112 、https://github.com/nodejs/undici/issues/1983 、https://github.com/openssl/openssl/issues/19220 、https://httptoolkit.com/blog/tls-fingerprinting-node-js/
- 官方“无此声明”的核对页面：https://nodejs.org/api/tls.html 、https://undici.nodejs.org/api/Client 、https://undici.nodejs.org/api/Connector 、https://docs.openssl.org/master/man1/openssl-s_client/

**本报告的本地实测**
- Node v26.7.0（`process.versions.undici` = 8.9.0），Windows；探测脚本 `tmp-undici-probe.cjs` / `-probe2` / `-probe3` / `-probe4` / `-probe5`，输出 `tmp-undici-probe*.out.txt`（同目录）。
