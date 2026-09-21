# fjzx.browser-bridge

通用、轻量、无网站业务语义的 Chrome Browser Bridge。

## V1 核心模型

- 每个平台使用独立 Service（如 pr-douyin、pr-bilibili、pr-baidu）。
- Service 负责 Browser Process、BrowserProfile、Proxy、Initial URL、调度、业务规则与数据。
- Bridge 只管理浏览器内部的唯一 Work Tab，并执行 Service 下发的 JavaScript。
- Service JavaScript 通过 Chrome `userScripts` API 在 Work Tab 的 `USER_SCRIPT` world 中执行。
- 一个 Bridge 同一时间只执行一个 Job。
- Bridge 不判断 CAPTCHA、BLOCKED、登录失效、风控等业务状态；这些由 Service 根据返回数据判断。
- V1 不建立 Runtime Bundle、Runtime 下载/缓存/版本系统。
- V1 不建立 Job Queue、Job History、Retry、幂等或重复执行防护。
- Bridge 首次只需在 Extension Settings 中配置 `Service URL`，保存于 `chrome.storage.local`。
- Work Tab 按“唯一普通业务 Tab”原则自动绑定；无候选或多候选时进入 `NOT_READY`。

## V1 通信协议

建议使用 WebSocket + JSON。

Service → Bridge：

- `EXECUTE`
- `GET_STATUS`

Bridge → Service：

- `RESULT`
- `STATUS`

`RESULT.ok` 只描述 Bridge 层的技术执行是否成功，不代表业务成功。

Bridge 当前状态：

- `IDLE`
- `RUNNING`
- `NOT_READY`

详细设计见 [docs/architecture-v1.md](docs/architecture-v1.md)。

## 当前阶段

先完成最小 POC，验证：

1. Extension Settings 保存 Service URL；
2. WebSocket 连接 Service；
3. 自动识别唯一 Work Tab；
4. 接收 EXECUTE；
5. 使用 `chrome.userScripts.execute()` 在 USER_SCRIPT world 执行 JavaScript；
6. 主动 Push RESULT；
7. 支持 GET_STATUS / STATUS。
