# Browser Bridge V1 架构与协议

## 1. 定位

Browser Bridge 是独立、通用、轻量、稳定、无网站业务语义的 Chrome Extension。它可被 pr-douyin、pr-bilibili、pr-baidu 等独立 Service 使用；每个平台保持独立 Service，不在 Bridge 内建立平台 Adapter。

Bridge 不理解 Douyin/Bilibili/Baidu、Like/Forward/Comment/Report、Captcha/BLOCKED/Login/Risk Control、Operator/Quota/Scheduler/Selector/Action 等业务概念。

核心职责：接收 Service 下发的 JavaScript，在专用 Browser/Profile 的唯一 Work Tab 中执行，并把技术执行结果直接返回 Service。

## 2. 职责边界

### Service

负责 Browser executable、Browser Process、BrowserProfile、Proxy、Initial URL、启动/停止/重启/监督，以及 Scheduler、Queue、Operator、Quota、Command Definition、Selector、Action、Retry、Job History、Data Model 和所有业务状态判断。

### Bridge

负责 Service Connection、唯一 Work Tab、Current Job、USER_SCRIPT 执行、当前技术状态和自身生命周期。

### Service JavaScript

负责当前页面 DOM 查询、读取、点击、输入、滚动、等待、观察及采集返回数据。

原则：浏览器环境归 Service；浏览器内部桥接归 Bridge；页面 JavaScript 能完成的事情归 Service Script。

## 3. Browser Environment 与 Work Tab

Service 启动 Chrome 时直接指定 BrowserProfile、Proxy 和 Initial URL。一个专用 Browser/Profile 正常只保留一个普通业务 Tab，不与人工日常浏览混用。

Bridge 启动后查询普通 Tab，并将唯一候选自动绑定为 Work Tab。Bridge 不根据 URL、域名或平台判断。

- 唯一候选：绑定其 tabId。
- 无候选：NOT_READY / NO_WORK_TAB。
- 多候选：NOT_READY / MULTIPLE_TABS。
- 已绑定 Work Tab 被关闭：NOT_READY / WORK_TAB_CLOSED。

页面在同一 Tab 内导航时，Work Tab 身份不改变。恢复策略由 Service 决定。

## 4. Service URL

Service URL 是 V1 唯一必要的持久配置。新 BrowserProfile 首次使用时，由人工在 Extension Settings 填写并保存到 chrome.storage.local。后续 Bridge 启动后自动读取并连接。

V1 不建设 Bridge Key、Credential、Execution Identity、Enrollment、Pairing 或 Automatic Bootstrap。Service URL 不限定必须为本机地址。

## 5. JavaScript 执行

每个 Job 的 EXECUTE 请求直接携带 JavaScript，不建立 Runtime 下载、Bundle、Repository、Cache、Version、Update、Hot Reload、Dependency 或 Plugin 系统。

JavaScript 统一通过 Chrome userScripts API 在 Work Tab 的 USER_SCRIPT world 中执行。V1 不开放 MAIN world。

普通 DOM 操作不包装为 Bridge API。V1 不提供 bridge.click/input/scroll/findElement/waitSelector 等接口，也不提供 like/forward/comment 等业务接口。

只有 USER_SCRIPT 无法完成、Extension API 可以完成且出现真实需求时，才考虑增加最小 Browser API。V1 可以先不向 Service Script 开放任何额外 Browser API。

### 5.1 实现约束（已由真实浏览器验证）

以下约束是实现过程中由真实 Chrome 行为确定的，属于 V1 协议的组成部分，不是可选的实现细节。

- **脚本是函数体，不是表达式。** `script` 字符串被当作函数体执行，`input` 是该函数的唯一参数，因此脚本内可直接使用 `input`，也可以用 `return` 和 `await`。
- **脚本直接返回数据，不写信封。** `return document.title;` 的返回值就是 `RESULT.data`。脚本返回 `undefined` 时按 JSON 的写法记为 `null`。**信封是 Bridge 的内部实现细节，不属于 Service 契约**：Bridge 在脚本外面套一层 `{__browserBridgeEnvelope: true, ok, value|error}` 来承载成功值或错误信息，Service 既不需要写它，也不会在 `RESULT` 里看到它。若脚本自己返回一个 `{ok, value}` 对象，Bridge 会把它当作**普通数据**原样放进 `RESULT.data`，得到一个多余的嵌套层。
- **信封存在的理由是无法从 API 返回值判断成败。** `chrome.userScripts.execute()` 在脚本抛错和脚本语法错误两种情况下都以 `result: null` resolve，而不是 reject，与「脚本返回了 `null`」完全同形。因此 Bridge 用自己那层信封上的专属标记来区分「脚本跑完了」与「包装函数根本没跑完」，并据此决定报错还是回传数据。
- **input 必须是 JSON 兼容值。** `parseServiceMessage` 拒绝 `input` 中出现 `NaN`、`Infinity`、`-0`、稀疏数组、非字符串数组键、Symbol、不可枚举属性、访问器属性、非普通原型和循环引用。`JSON.parse` 能解析但结果不是 JSON 兼容值（例如 `1e400`）的输入同样被拒绝，不会送到页面。
- **host permission 是硬性前提。** `chrome.userScripts.execute()` 要求 Extension 持有目标页面的 host permission，否则抛出 `Extension manifest must request permission to access this host`。V1 因此声明 `<all_urls>`。该声明不引入任何站点语义，只是让 Bridge 能在任意 Work Tab 上执行 Service 提供的脚本。
- **Allow User Scripts 开关决定 `chrome.userScripts` 是否存在。** Chrome 138+ 中，用户在 Extension 详情页开启 Allow User Scripts 之前，`chrome.userScripts` 是 `undefined`，不是「调用失败」。Bridge 因此把这种情况与其他 Work Tab 未就绪的情况分开，报 `NOT_READY / USER_SCRIPTS_UNAVAILABLE`，而不是 `SCRIPT_EXECUTION_FAILED`。
- **只执行主框架。** 执行时固定 `frameIds: [0]`，不执行子框架，也不申请 MAIN world。
- **`tabs` permission 参与状态判定。** 判断 Work Tab 是否仍然存在、导航去了哪里，需要读取 tab 的 URL；纯 `<all_urls>` host permission 覆盖不到 `chrome://` 等内部页面，无法识别「Work Tab 被导航到内部页面」这一情况。因此 manifest 保留 `tabs`。它同样不包含站点语义。
- **Work Tab 绑定跨 Service Worker 重启保存。** 绑定的 tab id 写入 `chrome.storage.session`。这是会话级状态，不是持久配置：Service URL 仍然是 V1 唯一必要的持久配置。保存它是为了让 MV3 Service Worker 被回收重启后仍能认出同一个 Work Tab、不要求用户重新选页。

## 6. Job 模型

一个 Bridge 同一时间只执行一个 Job，不建立 Queue。

- IDLE + EXECUTE → RUNNING
- RUNNING + 新 EXECUTE → 对新 Job 返回 RESULT(ok=false, BUSY)
- RUNNING 完成 → Push RESULT → IDLE
- NOT_READY + EXECUTE → RESULT(ok=false, NOT_READY)

jobId 只关联当前 EXECUTE 与 RESULT。Bridge 不建立 Job History、Execution History、Completed/Failed Cache，也不负责重复执行、幂等、Retry 或 Exactly Once。

## 7. Bridge 不判断业务结果

Bridge 不理解 SUCCESS、FAILED、CAPTCHA、BLOCKED、LOGIN_REQUIRED、RISK_CONTROL 等业务状态。

Service Script 负责采集执行后的页面数据；Bridge 原样返回；Service 自己解释结果并决定后续行为。

因此 Bridge 没有业务性 BLOCKED 状态。

## 8. 通信协议

V1 建议使用 WebSocket + JSON。

核心消息仅四种：

Service → Bridge：
- EXECUTE
- GET_STATUS

Bridge → Service：
- RESULT
- STATUS

不建立 GET_RESULT、独立 ERROR、BLOCKED、ACK、JOB_CREATED、JOB_FINISHED 等消息。

> 例外（**未冻结**）：第 14 节记录一对实验性消息 `GET_REQUEST_CONTEXT` / `REQUEST_CONTEXT`。它们不属于 V1 契约，有自己的错误码，删掉不影响上面四种消息中的任何一种。

### 8.1 EXECUTE

```json
{
  "type": "EXECUTE",
  "jobId": "job-123",
  "script": "...JavaScript...",
  "input": {},
  "metadata": {}
}
```

字段：
- type：必填，固定 EXECUTE。
- jobId：必填，由 Service 提供，仅关联当前 Job。
- script：必填，本次执行 JavaScript。
- input：可选，JSON-compatible 输入。
- metadata：可选，Service 透传信息；Bridge 不解释。

### 8.2 Script 返回值

正常结束时返回 JSON-compatible value：null、boolean、number、string、array、plain object。

不依赖 DOM Element、Window、Document、Function 等不可稳定序列化对象。

### 8.3 RESULT / ok=true

```json
{
  "type": "RESULT",
  "jobId": "job-123",
  "ok": true,
  "data": {}
}
```

ok=true 仅表示 JavaScript 在 Bridge 层正常执行并返回，不代表业务成功。

### 8.4 RESULT / ok=false

```json
{
  "type": "RESULT",
  "jobId": "job-123",
  "ok": false,
  "error": {
    "code": "SCRIPT_EXECUTION_FAILED",
    "message": "..."
  }
}
```

V1 error code：
- BUSY
- NOT_READY
- SCRIPT_EXECUTION_FAILED

error.message 用于诊断；只有 Service 真正需要机器区分时才新增 code。

### 8.5 GET_STATUS

```json
{
  "type": "GET_STATUS"
}
```

无需 jobId/requestId/executionId。

### 8.6 STATUS

IDLE：

```json
{
  "type": "STATUS",
  "state": "IDLE"
}
```

RUNNING：

```json
{
  "type": "STATUS",
  "state": "RUNNING",
  "jobId": "job-123"
}
```

NOT_READY：

```json
{
  "type": "STATUS",
  "state": "NOT_READY",
  "reason": "MULTIPLE_TABS"
}
```

V1 NOT_READY reason：
- NO_WORK_TAB
- MULTIPLE_TABS
- WORK_TAB_CLOSED
- USER_SCRIPTS_UNAVAILABLE

这些 reason 只能描述 Bridge 技术状态，不包含 CAPTCHA/BLOCKED 等业务语义。

## 9. RESULT 与 STATUS

RESULT 回答“刚才那个 Job 技术执行得怎么样”，由 Bridge 在 Job 完成后主动 Push；Service 不需要 GET_RESULT。

STATUS 回答“Bridge 现在是什么状态”，仅在 GET_STATUS 时返回。

## 10. V1 状态

核心状态只有：
- IDLE
- RUNNING
- NOT_READY

连接状态可以独立表现为 CONNECTED / DISCONNECTED，不与 Job 状态混成复杂状态机。

## 11. V1 不做

V1 不做 Runtime 系统、多 Tab/并行、Job Queue/History、Retry/幂等、业务 BLOCKED、平台 Adapter、MAIN world、通用 Chrome API 转发、复杂协议 Envelope。

## 12. 第一阶段 POC 验收

1. 设置页可保存 Service URL。
2. Bridge 可通过 WebSocket 连接 Service。
3. Bridge 可自动绑定唯一普通 Work Tab。
4. 多 Tab/无 Tab 时可报告 NOT_READY。
5. Service 可发送 EXECUTE + script + input。
6. Bridge 可通过 chrome.userScripts.execute() 在 USER_SCRIPT world 执行。
7. Script 返回 JSON-compatible data。
8. Bridge 主动 Push RESULT。
9. GET_STATUS 返回 IDLE/RUNNING/NOT_READY。
10. 同一时刻第二个 EXECUTE 返回 BUSY。

## 13. POC 与本文档的对应

`npm run poc` 在真实 Chrome 中跑完整链路，不需要人工操作浏览器。它验证的范围与第 12 节逐条对应：

| 第 12 节验收项 | POC 场景 |
| --- | --- |
| 1 设置页可保存 Service URL | 1 |
| 2 Bridge 可通过 WebSocket 连接 Service | 1、11 |
| 3 自动绑定唯一普通 Work Tab | 2 |
| 4 多 Tab/无 Tab 报告 NOT_READY | 9、10 |
| 5 Service 可发送 EXECUTE + script + input | 3、5 |
| 6 通过 userScripts 在 USER_SCRIPT world 执行 | 3、4、附加「脚本在隔离世界运行」 |
| 7 Script 返回 JSON-compatible data | 3、5 |
| 8 Bridge 主动 Push RESULT | 3、4、8 |
| 9 GET_STATUS 返回 IDLE/RUNNING/NOT_READY | 2、6、9 |
| 10 第二个 EXECUTE 返回 BUSY | 7 |

另外覆盖：第 5.1 节所述的 `USER_SCRIPTS_UNAVAILABLE` 前置条件、脚本抛错返回 `SCRIPT_EXECUTION_FAILED`（场景 8）、Service 断开后自动重连（场景 11）、Bridge 不产生业务状态（场景 12）、非法帧不打断连接。

POC 使用 Chrome for Testing（branded Chrome 142+ 与 Edge 会忽略 `--load-extension`），并在运行前通过 CDP 打开 Extension 详情页开启 Allow User Scripts。

## 14. 实验性能力：请求上下文（未冻结）

> **这一节不是 V1 契约。** 它记录 issue #13 的实验结果与实现，用于评审；冻结与否由维护者决定。调研与实测见 [docs/research/request-context-poc.md](research/request-context-poc.md)。

**问题**：页面里发现一个资源 URL 后，Service 想用自己的 Node 后端把它下下来。普通页面 JavaScript 拿不到 HttpOnly Cookie，因此需要 Bridge 以**通用、最小权限**的方式回答"浏览器会为这个 URL 发送什么"。Bridge 不因此理解任何网站、媒体或业务概念：它只知道 URL 与浏览器当前状态。

> 措辞上的诚实：`chrome.cookies` 给的是"**存储中匹配该 URL 的 cookie 全集**"，不是"浏览器此刻会发送的集合"——SameSite 与第三方拦截都不参与读取，所以 Service 可能拿到浏览器本会扣下的 cookie。要真正复现浏览器的发送行为，需要 Service 侧再套一层策略。

**新增的消息对**（Service → Bridge 请求，Bridge → Service 应答）：

```json
{ "type": "GET_REQUEST_CONTEXT", "requestId": "rc-1", "targetUrl": "https://cdn.example/media/1?sign=…",
  "scope": "WORK_TAB_ORIGIN", "topLevelSite": "https://www.example", "hasCrossSiteAncestor": true }
```

```json
{ "type": "REQUEST_CONTEXT", "requestId": "rc-1", "ok": true, "context": {
  "targetUrl": "…", "targetOrigin": "…", "scope": "…", "observedAt": "2026-01-01T00:00:00.000Z",
  "cookieHeader": "…", "cookieCount": 2, "httpOnlyCookieCount": 1, "partitionedCookieCount": 0,
  "cookies": [{ "name": "…", "domain": "…", "path": "/", "secure": true, "httpOnly": true,
                "sameSite": "lax", "session": true, "partitioned": false, "topLevelSite": null }],
  "userAgent": "…", "userAgentSource": "work-tab-page", "serviceWorkerUserAgent": "…",
  "referer": "…", "workTabUrl": "…", "documentReferrer": "…", "referrerPolicy": null } }
```

失败时 `ok:false` + `error:{code,message}`，code 只有：`NOT_READY`、`INVALID_TARGET_URL`、`INVALID_SCOPE`、`INVALID_PARTITION`、`TARGET_OUT_OF_SCOPE`、`CONTEXT_FAILED`。

**与 Job 模型的关系**：上下文请求**不占 Job 槽**、在 `RUNNING` 期间照常服务、也不与 `USER_SCRIPTS_UNAVAILABLE` 联动——读 Cookie 与页面事实从不执行 Service JavaScript。它既不改 `currentJob`，也不改 `IDLE/RUNNING/NOT_READY` 的推导。

**权限**：新增 `cookies`（`cookies` 权限本身不新增安装警告）与 `scripting`（读 Work Tab 页面自己的 UA / referrer，worker 代答不了）。读取范围由 `chrome.cookies.getAll({ url })` 与 host 权限共同限制：**Bridge 从不用 `getAll({})` 或 `getAll({domain})`**。

**实测约束**：HttpOnly 可读；SameSite 不影响读取（产物是"存储中匹配的全集"，见上）；**分区（CHIPS）cookie 必须给出完整的分区键** —— 只有 `topLevelSite` 会同时命中 `hasCrossSiteAncestor` 的两种取值（两个分区都有同名 cookie 时会一起返回），因此请求可以带 `hasCrossSiteAncestor`，默认按两个 schemeful site 推导（同站 → `false`，跨站 → `true`；"可注册域"是无 PSL 的末两段近似，例外情况由调用方显式传值；非法 boolean 一律 `INVALID_PARTITION`，`topLevelSite: null` 也不豁免校验）；**cookie store 取自 Work Tab**（`getAllCookieStores()`，隐身窗口的 Tab 有自己的 store，不传 `storeId` 会读到普通 profile）；UA 必须取自页面，**页面读不到就是失败**（用户限制站点访问时 `chrome.cookies` 同时被静默过滤，不能降级成 worker 的 UA）；**目标站点的访问权限单独校验**（跨源时 Work Tab 可读不代表 CDN 的 cookie 可见，`chrome.permissions.contains` 说不通过就报错，而不是交一个空集合）；一次采样必须来自同一个**文档**（中途导航——包括同源换路径——会重试一次，仍不一致则报 `CONTEXT_FAILED`）；采样后要**等 Work Tab 的当前快照**（`settled()`）再复验绑定，期间出现第二个普通 Tab 即返回 `NOT_READY`，而不是披露旧绑定的上下文；同名 cookie 无法复现 Chrome 在同一 path 长度内的创建时间顺序，实现用 `duplicateCookieNames` 显式报告冲突；cookie 值不落盘也不进日志。

**验证**：`npm run poc:context`（= `node tests/poc/request-context.mjs`）在真实扩展上跑 15 个场景，含反例与"RUNNING 期间取上下文不影响 Job"；证据写在 `docs/research/evidence/request-context.json`。`npm run poc` 的 12 个 V1 场景不受影响。
