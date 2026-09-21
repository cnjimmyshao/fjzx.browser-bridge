# Request Context POC（issue #13）

> **这不是 V1 的一部分。** `src/` 是 V1 扩展根目录，本目录是一个**独立可加载的 POC 扩展**加一个 Node 侧验证器：它的全部目的是回答"浏览器到底允不允许、以及允许到什么程度"，为 [docs/research/request-context-poc.md](../../docs/research/request-context-poc.md) 的结论与 Protocol Draft 提供可复现的实测证据。V1 的协议、状态机与 `manifest.json` 权限数组**没有被改动**。

## 它证明什么

```text
浏览器已登录本地受保护源站
        ↓
页面/Runtime 得到受保护资源 URL
        ↓
Service 通过 WebSocket 请求 GET_REQUEST_CONTEXT { targetUrl }
        ↓
扩展用 chrome.cookies.getAll({ url }) 取"浏览器自己认为适用于该 URL"的 cookie
        ↓
返回 REQUEST_CONTEXT：HttpOnly cookie 头 + 页面自陈 UA + Work Tab URL + observedAt
        ↓
Node Service 用普通 fetch 重放 → 拿到与浏览器逐字节相同（SHA-256 一致）的资源
```

跑完会得到 **27 项检查**（含反例：不带 Cookie / 不带 Referer / 不带 UA 必须失败）与一份脱敏证据文件 `evidence/request-context.json`。

## 运行

```powershell
# 需要 Chrome for Testing（品牌版 Chrome 137+ 忽略 --load-extension）
node poc/service/run-poc.mjs

# 可选环境变量
#   CHROMIUM_EXECUTABLE=<chrome.exe 路径>   # 不设则自动查找 Chrome for Testing / Chromium
#   POC_HEADLESS=0                          # 弹出真实窗口
#   POC_KEEP_BROWSER=1 / POC_KEEP_PROFILE=1 # 保留现场用于排查
```

纯逻辑单测（不需要浏览器）：

```powershell
node --test tests/request-context-poc.test.js
```

## 组成

| 文件 | 作用 |
| --- | --- |
| `extension/manifest.json` | POC 扩展：`storage` / `tabs` / `cookies` / `scripting` + `<all_urls>` |
| `extension/lib/request-context.js` | **纯逻辑**：URL 归一化、同源判定、Cookie 头拼装（稳定按 path 长度排序）、脱敏、上下文组装。无 `chrome.*`、无 `import`，可直接移动到 `src/lib/request-context.js` |
| `extension/background.js` | MV3 service worker：Service WS 连接、Work Tab 解析、`chrome.cookies` / `chrome.scripting` 调用 |
| `service/poc-server.mjs` | 受保护源站：`/feed`（页面）、`/login`（HttpOnly/Lax/Strict cookie）、`/media/1`（需 Cookie+Referer+UA，支持 Range）、`/embed`（第三方 frame，写 `Partitioned` cookie）。请求记录**只留 cookie 名字** |
| `service/browser.mjs` | 零依赖 CDP 客户端：启动 Chrome for Testing、按 **manifest 名**找到本扩展的 service worker、求值、单页 UA 覆盖 |
| `service/run-poc.mjs` | 扮演 Service：发请求、用上下文下载、对照、断言、写证据 |
| `evidence/request-context.json` | 最近一次运行的完整证据（脱敏，可提交） |

## 已实测的关键行为（详见调查报告）

- `chrome.cookies.getAll({ url })` **包含 HttpOnly** cookie，而页面 `document.cookie` 看不到它；
- `SameSite=Strict/Lax` **不影响读取**（只影响浏览器发送），因此返回的是"存储中匹配该 URL 的全集"；
- **Partitioned（CHIPS）cookie 在 `url` 查询下完全不可见**，必须显式给出 `partitionKey.topLevelSite`；而浏览器确实会在跨站请求里发送它；
- **权威 UA 在页面里**：页面级 UA 覆盖后，页面报覆盖值、扩展 service worker 仍报浏览器默认值；
- `document.referrerPolicy` 在 Chrome 153 页面里是 `undefined`（实测），所以生效的 Referrer 策略无法由 Bridge 汇报；
- Cookie 顺序：`getAll({url})` 的返回顺序就是浏览器发送顺序（POC 因此改成按 path 长度做**稳定**排序）；
- 默认 scope 拒绝跨源，`scope=TARGET_ONLY` 显式放开后仍只返回匹配该 URL 的 cookie；
- 全程**没有任何持久化**：`chrome.storage.local` 只有 `pocServiceUrl`，日志与证据里没有 cookie 值。

## 安全约定（POC 自身遵守）

- 只用 `getAll({ url })`；不出现 `getAll({})` / `getAll({ domain })`；
- 任何日志与错误信息都走 `maskCookieHeader`（只留名字）；
- 不缓存、不复用、不落盘 cookie；
- 证据文件里只有 cookie 的名字、布尔标志与掩码串。
