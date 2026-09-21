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

1. ✅ Extension Settings 保存 Service URL；
2. ✅ WebSocket 连接 Service；
3. ✅ 自动识别唯一 Work Tab；
4. 接收 EXECUTE；
5. 使用 `chrome.userScripts.execute()` 在 USER_SCRIPT world 执行 JavaScript；
6. 主动 Push RESULT；
7. 支持 GET_STATUS / STATUS。

## 仓库结构

```text
src/                      Extension 根目录，Chrome 直接加载此目录
  manifest.json
  background/             MV3 service worker：Service 连接生命周期、Work Tab 绑定
  lib/                    纯逻辑，不依赖 chrome.*，可在 Node 下直接测试
  options/                Options 设置页
tests/                    node:test 自动化测试
  helpers/ws-server.js    最小 WebSocket 测试服务器（零依赖，仅测试用）
docs/architecture-v1.md   V1 架构与协议
```

`src/` 就是 Extension 根目录，**没有打包步骤**：Chrome 直接加载 `src/`，因此 `tests/`、`docs/`、`package.json` 不会进入 Extension。

## Work Tab

一个专用 Browser/Profile 正常只保留一个普通业务 Tab，Bridge 把**唯一候选**绑定为 Work Tab。判定只看"这是不是一个普通网页"，**从不读取域名、路径或平台**：

| 候选数 | 结果 |
| --- | --- |
| 恰好 1 个 | 绑定该 tabId |
| 0 个 | `NO_WORK_TAB` |
| 多于 1 个 | `MULTIPLE_TABS`（**不任选一个**） |
| 已绑定 Tab 被关闭 | `WORK_TAB_CLOSED` |

"普通网页"只按 scheme 判定：`http:` / `https:` 之外一律不是候选，因此 `chrome://`、`chrome-extension://`（含本扩展自己的 Options 页）、`devtools://`、`about:`、`file:` 都不会被误判。

绑定结果是**候选列表的纯函数**，没有滞回：一旦出现第二个普通 Tab，Bridge 就无法知道 Service 在驱动哪一个，于是如实报告 `MULTIPLE_TABS`，而不是沿用可能已经过期的绑定。同一 Tab 内导航会让该 Tab 仍是唯一候选，因此身份自然保持不变。

Bridge 不会创建、关闭、恢复或重排任何 Tab，也不记住 Initial URL——这些都归 Service。受影响的只有 Bridge 的技术状态，页面内容是否"正常"仍由 Service 判断。

> `manifest.json` 因 V1.3 新增了 `tabs` 权限：没有它时 `tab.url` 会被脱敏（已实测为 `undefined`），无法区分普通网页与浏览器页面。它不授予页面内容访问权，也不是 host 权限。

## Service 连接

Bridge 同一时刻只维护一个 Service WebSocket：

- 启动/唤醒时读取 Service URL，**已配置才连接**，未配置时不向任何地址拨号。
- 意外断线按 `1s → 2s → 5s → 15s` 退避重连，最后一个值持续重复；连接成功后重置退避。没有自定义 heartbeat、认证、消息持久化或离线队列。
- 修改 Service URL 时，**先关闭旧连接、等它真正关闭后才连接新地址**。`WebSocket.close()` 只是发起关闭握手，因此替换会等到对端确认（或 TCP 断开）才拨号。
- 但「不会同时存在两个连接」是**有界保证，不是绝对保证**：WebSocket API 没有强制关闭 TCP 的手段，若对端始终不回应关闭帧，等待会在 `closeGraceMs`（默认 1000ms）后放弃并照常切换，此时旧连接可能与新连接短暂并存。**Service 不应假设 Bridge 侧连接互斥，更不要据此拒绝新连接。**
- 同一时刻 Bridge 自身只管理**一个** socket：任何路径都不会留下无人管理的活连接。
- 收到的帧原样交给处理函数，V1.2 尚未实现协议，因此未知文本或非法 JSON 只记录并忽略，不会影响连接。

连接状态（`DISCONNECTED` / `CONNECTING` / `CONNECTED`）与 Job 状态（`IDLE` / `RUNNING` / `NOT_READY`）是两套独立状态，不混成一个状态机。

### ⚠️ 已知限制：MV3 service worker 空闲回收

MV3 service worker **不是常驻进程**。实测（Chrome for Testing 153.0.8010.52）：

| 时刻 | 现象 |
| --- | --- |
| +24.0s | Bridge 连接到 Service，TCP 建立 |
| +54.1s | 连接断开，此后 300s+ 无重连 |
| — | `CDP /json/list` 中 `service_worker` target 数量 = **0** |
| 一次 `chrome.storage.onChanged` | target 回到 1，连接在 1s 内重新建立 |
| 再次唤醒后 +33s | 又被回收，连接再次断开 |

即：**空闲约 30s 后 worker 被回收，socket 随之关闭，而重连定时器也随 worker 一起消失**，因此 Bridge 会一直离线，直到某个扩展事件把它唤醒。上面实现的重连逻辑本身是正确的（Service 重启后 1s 内自动恢复），但它救不了已经死掉的 worker。

这意味着「Service 随时 push EXECUTE」这一前提需要额外机制才能成立，V1 架构文档尚未覆盖。详见 issue #9。

> 当前行为：worker 被唤醒时会重新读取 Service URL 并重连，因此 Options 页保存配置、浏览器启动等事件都会触发恢复。

## 开发

需要 Node >= 22（测试使用内置 `node:test` 与全局 `WebSocket`，无第三方依赖）。

```powershell
npm test        # 等价于 node --test
```

> 若 PowerShell 执行策略阻止 `npm.ps1`，直接运行 `node --test`，或改用 `npm.cmd test`。

加载 Extension：

1. 打开 `chrome://extensions`，启用右上角「开发者模式」。
2. 点击「加载已解压的扩展程序」，选择本仓库的 `src/` 目录。
3. 在扩展卡片上点击「扩展程序选项」，填写 Service URL（形如 `ws://127.0.0.1:8080`）并保存。

Service URL 是 V1 唯一的持久配置，保存在 `chrome.storage.local`。未配置时 Options 页明确显示"未配置"，不会写入任何隐式默认值。

