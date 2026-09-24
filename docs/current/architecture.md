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

### 3.1 MV3 空闲回收与 Service 保活（KEEPALIVE）

Bridge 是 Manifest V3 Service Worker，**空闲约 30s 会被 Chrome 回收，socket 随之关闭，重连定时器也一起消失**，此后 Bridge 一直离线，直到某个扩展事件把它唤醒。这与「Service 随时 push EXECUTE」直接冲突。

已确认的机制：**Service 在既有 WebSocket 上周期性发送 `{"type":"KEEPALIVE"}`（每 20 秒）**。Chrome 116 起，收发 WebSocket **消息**会重置 Service Worker 的空闲计时；仅保持 socket 打开不算活动，因此这条消息的作用就是制造接收活动。决定来源与限制见 [ADR 0001](../decisions/0001-service-keepalive.md)。

- **发送循环属于 Service**，与连接生命周期绑定：每条 Service 连接只有一个循环，断开或发送失败时清理，重连后恢复。
- **Bridge 只识别它，然后保持沉默。** 不回 ACK/RESULT/STATUS，不占 Job 槽，不访问 Work Tab，不持久化，不改变 `IDLE/RUNNING/NOT_READY` 的推导。详见 §8.7。
- **这不是健康检查，也不是唤醒通道。** KEEPALIVE 维持的是**尚存活连接**的消息活动；浏览器退出、系统休眠、网络中断、以及 worker 已被回收都不在保证范围内，Bridge 也不因此获得新的恢复或重放能力。

Bridge 侧不新增自发保活 timer、`alarms`、offscreen、Native Messaging、健康评分或 Job 重试。

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
- **脚本直接返回数据，不写信封。** `return document.title;` 的返回值就是 `RESULT.data`。脚本返回 `undefined` 时按 JSON 的写法记为 `null`。**信封是 Bridge 的内部实现细节，不属于 Service Contract**：Bridge 在脚本外面套一层 `{__browserBridgeEnvelope: true, ok, value|error}` 来承载成功值或错误信息，Service 既不需要写它，也不会在 `RESULT` 里看到它。若脚本自己返回一个 `{ok, value}` 对象，Bridge 会把它当作**普通数据**原样放进 `RESULT.data`，得到一个多余的嵌套层。
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

核心消息四种，另有一条不计入应答的保活帧：

Service → Bridge：
- EXECUTE
- GET_STATUS
- KEEPALIVE（§8.7，保活专用，无载荷、无应答）

Bridge → Service：
- RESULT
- STATUS

不建立 GET_RESULT、独立 ERROR、BLOCKED、ACK、JOB_CREATED、JOB_FINISHED 等消息。

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

### 8.7 KEEPALIVE

```json
{
  "type": "KEEPALIVE"
}
```

Service → Bridge 的单向保活帧，用于在 §3.1 所述的空闲回收窗口内维持 socket 的接收活动。它**没有其他字段**，Bridge 也不解释其中的任何内容。

Bridge 收到它的行为就是**什么都不做**：不发送任何应答，不创建或占用 Job，不读写 Work Tab，不改变 `IDLE/RUNNING/NOT_READY`，不写历史。判定它是否达成的唯一依据就是这帧到达了浏览器，而这在收到它时已经成立。

- 它不是心跳健康检查：没有 miss 计数、没有延迟测量、没有健康评分，也没有超时判定。
- 它不是唤醒机制：Worker 一旦已被回收，KEEPALIVE 无法把它叫回来，那条连接的对象已经不存在。
- 它不产生错误：Bridge 不为它回 `RESULT`，也不会因为连接不可用而回错误——连「发送失败」都不会发生，因为根本没有发送。
- 帧上若带了其他字段（例如一个 `jobId`），Bridge 一律忽略，不会把它当成一个需要答复的 Job。

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

§8.7 的 KEEPALIVE 是这条清单的唯一例外，而且是明确决定过的例外：它不新增 Bridge 侧 timer、健康监控、ACK 或重试，也不改变上面任何一种保证。除它之外的 heartbeat、健康评分、missed-heartbeat 计数仍不属于 V1。

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

### 13.1 保活（§3.1 / §8.7）的 POC 对应

`npm run poc:keepalive`（= `node tests/poc/keepalive-poc.mjs`）在真实浏览器上验证保活，与 #18 的 A–F 场景对应：

| 场景 | 内容 |
| --- | --- |
| A | 建立连接后不发任何消息，观察至少 90s：Worker 是否被回收、socket 何时断开 |
| B | 每 20s 一次 KEEPALIVE，连续至少 10 分钟：Worker 与 socket 是否持续可用、投递间隔是否保持、Bridge 是否始终不作答 |
| C2 | 长时间无业务 Job 后 GET_STATUS / 无副作用 EXECUTE 是否立即成功 |
| D | 停止 KEEPALIVE 后，记录 Chrome 的实际 idle 回收时间 |
| E | RUNNING 的 Job 跨越两个 keepalive 周期：不返回 BUSY、jobId 不被改写、原 Job 正常 RESULT |
| F | NOT_READY（无 Tab / 多 Tab）期间：状态不变、不创建 Tab、不任选一个、socket 仍可达 |
| G | Service 断开：发送循环被清理且无残留定时器；重连后保活恢复 |

它只读 `CDP /json/list` 元数据，**从不附着 Worker DevTools**（附着会让 Worker 一直存活，使测量失去意义），也不在保活窗口内跑 GET_STATUS/EXECUTE 探针。任何被选中的场景失败都会使运行以非零退出码结束；`--phases` 也不接受依赖不完整的子集（C2/D 需要 B，F/G 需要 E），避免跑出「一条 KEEPALIVE 都没发却显示通过」的结果。证据写在 `docs/research/evidence/keepalive-poc.json`，含环境、提交、时序与未覆盖项；`npm run poc` 的 12 个 V1 场景不受影响。
