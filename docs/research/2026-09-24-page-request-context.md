# Page Context 与 Request Context：当前实现的真实浏览器验证

Status: VERIFIED（本次实测）
日期：2026-09-24（实测日）
依据：[Issue #25](https://github.com/cnjimmyshao/fjzx.browser-bridge/issues/25)（正式实现）、[Issue #13](https://github.com/cnjimmyshao/fjzx.browser-bridge/issues/13) 与 [PR #17](https://github.com/cnjimmyshao/fjzx.browser-bridge/pull/17)（调研与 POC）、[Current 第 14 节](../current/architecture.md#14-page-context-与-request-context)。

本报告自包含：它记录本次在真实 Chrome 上实测了什么、条件是什么、结果是什么，以及哪些结论**没有**被本次测试覆盖。协议语义以 Current 为准，本报告不自行升级 Contract。

## 目的与验收范围

验证 [Issue #25](https://github.com/cnjimmyshao/fjzx.browser-bridge/issues/25) 的两项能力在当前 `src/` 上确实成立：

1. 成功 `RESULT` 携带与当前 Work Tab / 当前文档一致的 Page Context；导航或重载竞争时不返回混合页面事实。
2. 针对一个明确 `targetUrl` 的 Request Context 独立按需取得，且不需要开启 Allow User Scripts；Service 在 EXECUTE 得到资源 URL 后可以用该 URL 取得上下文并用 Node 重放成功。
3. 普通 EXECUTE 不触发 target-specific Cookie 查询（由 `node --test` 覆盖，见下文"证据"）。

## 环境

| 项 | 值 |
| --- | --- |
| 系统 | Windows 10.0.26200 x64 |
| Node | v26.7.0 |
| 浏览器 | Chrome for Testing 153.0.8010.52（`--headless=new --disable-gpu`） |
| 扩展 | 本仓库 `src/`，通过 `--load-extension` 直接加载，无打包步骤 |
| 目标站点 | 本机测试服务器（`127.0.0.1` / `localhost`），不使用第三方网站、真实账号或日常 Profile |

注意：本次运行的 shell 处于提权状态，Chrome 会因此自行重启并让被测进程先退出。POC harness 因此新增 `--do-not-de-elevate`（见 [开发说明](../development.md#从全新-checkout-跑通-poc)）。这是 harness 的环境适配，不改变扩展行为。

## 方法与证据

两个 POC 都使用真实扩展与真实浏览器，脚本在 `tests/poc/`，可复现：

```powershell
npm test          # node --test
npm run poc       # V1 端到端 + Page Context 三个附加场景（18/18）
npm run poc:context  # 请求上下文（16/16）
```

证据文件：`docs/research/evidence/page-request-context.json`（本次 `poc:context` 运行自动写入，只含 cookie **名字**与掩码串，不含值）。本次 `npm run poc` 的输出即终端结果本身，未另存文件；下表逐条列出观察到的结果。

## 结果

### Page Context（`npm run poc`，18/18 通过）

| 观察 | 结果 |
| --- | --- |
| 成功 RESULT 的 `pageContext` | `available: true`；`workTabUrl` 等于页面自身的 `location.href`，`userAgent`、`documentReferrer` 等于页面自身报告值；`documentId = EBE8C4C6B3C4D1EAC1281762ECED00E1` |
| 字段集合 | 只有 `available`/`workTabUrl`/`userAgent`/`documentReferrer`/`documentId`，没有 Cookie 或 target-specific 字段 |
| 同一 URL 重载 | 重载后 `documentId` 与重载前不同，`workTabUrl` 不变；说明它标识文档而不是 URL |
| 导航竞争（脚本内 `location.reload()` 后立刻返回） | Job 仍 `ok: true`，`pageContext.available: false`、`reason: PAGE_FACTS_UNAVAILABLE` —— 注入与导航相撞时如实降级，没有拼出混合事实 |
| V1 原有行为 | 12 个场景全通过，未回归 |

本次运行只观察到竞争场景的降级分支，没有观察到"竞争期间仍取到某一个文档事实"的分支；场景断言同时接受两种结果（可用时必须属于重载前或重载后的某个已知 `documentId`）。

### Request Context（`npm run poc:context`，16/16 通过）

报告中记录的关键观察（完整列表见证据文件的 `observations`）：

| 观察 | 结果 |
| --- | --- |
| 未开启 Allow User Scripts 时上下文是否可用 | 可用；`GET_STATUS` 为 `NOT_READY/USER_SCRIPTS_UNAVAILABLE` 的同时，上下文请求照常返回 |
| HttpOnly | `cookieHeader` 含 HttpOnly 会话 cookie，页面 `document.cookie` 看不到它 |
| SameSite | `SameSite=Strict` 的 cookie 读取不受 SameSite 约束（读取的是存储集合） |
| Node 重放 | 只用 `cookieHeader` + `userAgent` + `referer` 下载到与浏览器**逐字节相同**的资源（sha256 相同）；`Range: bytes=0-1023` 得到 206 / 1024 字节 |
| 反例 | 少 Cookie → 401；少 `Referer` → 403 `BAD_REFERER`；UA 被省略（Node 默认 `user-agent: node`）→ 403 `USER_AGENT_MISMATCH` |
| 跨源 | 默认 `WORK_TAB_ORIGIN` 拒绝（`TARGET_OUT_OF_SCOPE`）；显式 `scope=TARGET_ONLY` 才允许 |
| CHIPS | 浏览器在真实跨站请求中确实发送了分区 cookie；默认分区键取到它，另一位 `hasCrossSiteAncestor` 取不到，`topLevelSite: null` 不做分区查询 |
| UA 来源 | 页面级 UA 覆盖后上下文跟随**页面**的 UA；`serviceWorkerUserAgent` 不受影响 |
| 持久化 | `chrome.storage.local` 只有 `serviceUrl`，不含任何 cookie 值 |
| 并发 | `RUNNING` 期间取上下文照常应答，且不影响正在执行的 Job |
| EXECUTE → 上下文 → 重放 | 先用 EXECUTE 从页面读到资源 URL，再按该 URL 取上下文，Node 重放得到与浏览器相同的字节；该 EXECUTE 的 RESULT 同时带 Page Context |

### 单元测试（`npm test`，本次 288 项全通过）

其中与本次能力直接相关、且 POC 无法观察的部分：

- `tests/page-context.test.js`：Page Context 的四个字段组装、`available:false` + `reason` 的降级、`documentId` 缺失记 `null`、注入失败只报错误类型（不复述可能含 URL 的浏览器错误文本）、**普通 EXECUTE 期间 `chrome.cookies.getAll` 调用次数为 0**。
- `tests/request-context.test.js`：分区键推导与拒绝路径、host 覆盖范围标注、文档一致性（含同 URL 重载）、绑定复验、并发与错误码。
- `tests/protocol.test.js`、`tests/manifest.test.js`：消息集合与权限清单的显式断言。

## 结论

1. Page Context 可以在真实浏览器中随每个成功 RESULT 返回，并与当前文档一致；同一 URL 的重载可以靠 `documentId` 区分；与导航相撞时实现选择如实降级而不是拼接两个文档。
2. Request Context 可以在真实浏览器中独立按需取得，包含 HttpOnly、分区 Cookie、页面 UA 与 Referrer，足以让 Node 端逐字节复现浏览器的下载；不依赖 Allow User Scripts。
3. 普通 EXECUTE 不读取任何 target-specific Cookie（单测固定）。

## 限制与未测

- 只在一个 Chrome for Testing 版本（153.0.8010.52）与 Windows 上实测。Chrome < 130 的分区降级路径（`exactPartitionSelection: false`）**未在真实浏览器验证**，只有单测覆盖。
- 导航竞争场景本次只观察到降级分支；"竞争期间取到旧文档或新文档事实"的分支未在本次运行中出现。
- 传输层指纹（TLS/HTTP2）与出口 IP 不在 Bridge 能力范围，本次未测也不承诺。
- `hostAccessCoverage` 的 `'origin'`/`'unknown'` 分支未在真实浏览器构造（需要人工收窄站点授权），只有单测覆盖。
- 本报告不覆盖 MV3 Worker 空闲回收（见 [既有浏览器观察](2026-09-23-existing-browser-evidence.md)）。

## 与既有材料的关系

- 本次实现在协议层取代了 [PR #17](https://github.com/cnjimmyshao/fjzx.browser-bridge/pull/17) 中的实验性草案：页面事实从"请求上下文的一部分"独立为随 RESULT 返回的 Page Context，请求上下文保留独立消息对。
- PR #17 的调研笔记（Cookie API 能力、CHIPS 行为、重放忠实度、Service 侧需求）不在本分支内，仍以该 PR 为来源；本报告只记录在当前 head 上重新实测的部分。
- 本报告不修改任何已验证结论；如后续浏览器版本改变上述行为，应新建带日期的报告并注明取代关系。
