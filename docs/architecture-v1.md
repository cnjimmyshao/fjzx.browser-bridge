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
