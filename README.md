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
4. ✅ 接收 EXECUTE；
5. ✅ 使用 `chrome.userScripts.execute()` 在 USER_SCRIPT world 执行 JavaScript；
6. ✅ 主动 Push RESULT；
7. ✅ 支持 GET_STATUS / STATUS。

## 协议与状态

协议只有四种消息、三个 error code，与 `docs/architecture-v1.md` 完全一致，**没有独立 ERROR / ACK / Heartbeat / GET_RESULT**：

| 方向 | 消息 |
| --- | --- |
| Service → Bridge | `EXECUTE`、`GET_STATUS` |
| Bridge → Service | `RESULT`、`STATUS` |

- `EXECUTE` 必填 `jobId`（非空字符串）与 `script`（字符串）；`input` 可选，会**原样交给脚本**；`metadata` 可选，Bridge **只接收、不解释、也不转发**（V1 的 `RESULT` 里没有它的位置）。给这两者赋予含义就等于把 Service 的业务语义搬进 Bridge。
- `RESULT` 为 `ok:true/data` 或 `ok:false/error`，`jobId` 与请求完全一致；error code 只有 `BUSY` / `NOT_READY` / `SCRIPT_EXECUTION_FAILED`。
- `STATUS` 按状态带最少字段：`IDLE` 只有 state，`RUNNING` 附 `jobId`，`NOT_READY` 附 `reason`。

Bridge 状态只有 `IDLE` / `RUNNING` / `NOT_READY`，而且是**推导出来的、不是存下来的**：有 Job 在跑就是 `RUNNING`，否则没有 Work Tab 就是 `NOT_READY`，否则 `IDLE`。这样三个状态不会互相漂移，Work Tab 消失也会自动反映在下一次 `GET_STATUS` 上。

一个 Bridge 同时只跑一个 Job：`RUNNING` 期间再来的 `EXECUTE` 立刻回 `BUSY`，**不排队、不抢占**，第一个 Job 完全不受影响。没有 Queue、History、Retry、幂等或 exactly-once；Job 结束后不保留任何结果。

无法解析的帧不会打断连接：JSON 非法或没有可用 `jobId` 时只记录并忽略（V1 没有 ERROR 消息可用）；若失败帧仍带有可用 `jobId`，则用 `SCRIPT_EXECUTION_FAILED` 回一个 `RESULT`，免得 Service 一直空等。

## 脚本执行

Service 下发的 `script` 是**一个 async 函数的函数体**，用 `return` 给出结果，可以 `await`：

```js
const title = document.querySelector('h1').textContent;
document.getElementById('go').click();
await new Promise((r) => setTimeout(r, 100));
return { title, out: document.getElementById('out').textContent };
```

`input` 是该函数的参数（缺省为 `null`）。脚本在 Work Tab **主框架**的 `USER_SCRIPT` world 中执行——隔离世界，能操作 DOM，但看不到页面自己 world 里的变量；**MAIN world 在 V1 中不开放**。

### 运行前的一次性设置

Chrome 138 起，`chrome.userScripts` 需要**每个扩展单独授权**：在 `chrome://extensions` 的扩展详情页打开 **Allow User Scripts**。未开启时该 API 在扩展里根本不存在（`undefined`，不是抛错），Bridge 会如实报告 `NOT_READY / USER_SCRIPTS_UNAVAILABLE`；开启后**无需重启**即生效。

### 错误如何映射

`SCRIPT_EXECUTION_FAILED` 覆盖：脚本抛异常、脚本语法错误、返回不可稳定序列化的值（DOM 节点、函数、window）、执行期间 Work Tab 消失、以及 API 调用本身失败。

这里必须包一层再执行，原因是一个实测到的 API 行为：**脚本抛异常和语法错误时，`chrome.userScripts.execute()` 都不 reject，而是 resolve 出 `result: null`**——与「脚本显式 `return null`」无法区分。因此 Bridge 注入的代码会在脚本外再套一个信封，把成功值与失败原因分别带回；没有信封的结果一律视为「脚本根本没跑完」。

> 实测环境：Chrome for Testing **153.0.8010.52**。上述行为（含 `result: null`、`Frame with ID 0 was removed.`、host 权限要求、`world: 'MAIN'` 同样可用但 V1 不使用）均已逐条验证。

## 仓库结构

```text
src/                      Extension 根目录，Chrome 直接加载此目录
  manifest.json
  background/             MV3 service worker：Service 连接生命周期、Work Tab 绑定
  lib/                    纯逻辑，不依赖 chrome.*，可在 Node 下直接测试
  options/                Options 设置页
tests/                    node:test 自动化测试
  helpers/ws-server.js    最小 WebSocket 测试服务器（零依赖，仅测试用）
  poc/                    端到端 POC harness（零依赖）
    run-poc.mjs           V1：12 个场景，跑 src/ 真扩展 + mock Service
    request-context.mjs   请求上下文：15 个场景，同样跑 src/ 真扩展
    protected-server.mjs  受 Session 保护的本地源站（Cookie + Referer + UA）
docs/architecture-v1.md   V1 架构与协议
docs/research/            issue #13 的调查报告与调研笔记
```

`src/` 就是 Extension 根目录，**没有打包步骤**：Chrome 直接加载 `src/`，因此 `tests/`、`docs/`、`package.json` 不会进入 Extension。

## 从全新 checkout 跑通 POC

不需要 `npm install`：整个项目零第三方依赖，只需要 Node ≥ 22 和一个**能加载未打包扩展的浏览器**。

**1. 准备浏览器。** 品牌版 Chrome 142+ 与 Edge 已忽略 `--load-extension`，因此需要一个 Chrome for Testing：

```powershell
# 从 https://googlechromelabs.github.io/chrome-for-testing/ 下载 win64 版并解压，然后：
$env:BROWSER_EXECUTABLE = "C:\path\to\chrome-win64\chrome.exe"
```

**2. 跑单元与集成测试**（不需要浏览器，约 2 秒）：

```powershell
npm test            # 等价于 node --test
```

**3. 跑端到端 POC**（会自己启动浏览器、测试 Service 与本地测试页面）：

```powershell
npm run poc         # 等价于 node tests/poc/run-poc.mjs
```

它会自动完成：启动本地测试页面服务器 → 启动最小测试 Service → 启动 Chrome 并加载 `src/` → 在扩展详情页打开 **Allow User Scripts** → 通过真实的设置页保存 Service URL → 依次执行 #7 列出的 12 个场景 → 打印结果并以退出码反映成败。

**4. 跑请求上下文的端到端 POC**（issue #13，同样跑 `src/` 真扩展）：

```powershell
npm run poc:context # 等价于 node tests/poc/request-context.mjs
```

它会另起一个受 Session 保护的本地源站（只有 `Cookie` + `Referer` + `User-Agent` 三者齐全才返回数据），驱动真扩展取上下文，再由 Node 用该上下文重放下载，并逐条验证反例（缺 Cookie → 401、缺 Referer → 403）、跨源 scope、分区 Cookie、UA 权威来源与"不落盘"。

```text
  ✔ 1. 首次配置 Service URL 并连接
  ✔ 2. 唯一业务 Tab → IDLE；GET_STATUS → IDLE
  ...
  场景：15/15 通过
```

常用参数：`--browser <chrome.exe>`、`--port <调试端口>`、`--headed`（显示窗口而不是无头）。

**4. 手工体验（可选）。** 想自己动手而不跑脚本：

1. 打开 `chrome://extensions`，启用「开发者模式」。
2. 「加载已解压的扩展程序」→ 选择本仓库的 `src/`。
3. 在该扩展的详情页打开 **Allow User Scripts**（Chrome 138+ 必需，否则 Bridge 报 `NOT_READY / USER_SCRIPTS_UNAVAILABLE`）。
4. 另开一个终端启动测试 Service，它会把自己的地址打印出来：

   ```powershell
   node tests/poc/service.mjs --interactive   # 默认 ws://127.0.0.1:8787，可用 --port 改
   ```

5. 点击「扩展程序选项」，填写第 4 步打印出来的地址并保存。
6. 在同一个 Profile 里只留**一个普通网页标签页**作为 Work Tab。
7. 回到第 4 步的终端发消息：直接输入一段脚本函数体（例如 `return document.title`）回车，就会看到 Bridge 回传的 `RESULT`。`:status` 发 `GET_STATUS`，`:input <json>` 设置后续 `EXECUTE` 的 `input`，`:quit` 退出。也可以改用自己的任何 WebSocket 客户端。

不加 `--interactive` 时它只打印往来帧，适合与别的客户端配合排查。

> POC 全程只使用本机地址与本地测试页面，**不依赖任何第三方站点**。

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

## 权限

| 权限 | 用途 |
| --- | --- |
| `storage` | 唯一持久配置 Service URL；Work Tab 绑定存于 `storage.session` |
| `tabs` | 读取 `tab.url` 与 `changeInfo.url`。host 权限覆盖不了 `chrome://`，没有它时 Work Tab 导航到浏览器页面会被漏掉、继续被当成已绑定（实测） |
| `userScripts` | 在 Work Tab 的 USER_SCRIPT world 执行 Service JavaScript |
| `cookies` | 实验性请求上下文（issue #13）：读"浏览器自己会为某个 URL 发送什么 Cookie"。只用 `getAll({url})`，永不枚举整个 cookie 库；`cookies` 本身不新增权限警告文案 |
| `scripting` | 同一能力：读 Work Tab **页面自己**的 `navigator.userAgent` 与 `document.referrer`。实测页面级 UA 覆盖在页面里可见、在 service worker 里不可见，因此 worker 无法代答 |
| `host_permissions: <all_urls>` | `execute()` 要求扩展对目标标签页有 host 权限（实测）；`chrome.cookies` 的读取范围也逐域受它限制 |

没有 `optional_permissions`，也没有 content script。`<all_urls>` **不指向任何具体站点**：所有站点一视同仁，manifest 里不编码任何平台知识，因此 Bridge 仍然是"无业务语义"的。

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

## 调研：受控 Request Context（issue #13）

issue #13 的调研、POC，以及**按维护者要求做进真扩展的实验性实现**。它不改变 V1 的四种消息与三个错误码：

- 调查报告：[docs/research/request-context-poc.md](docs/research/request-context-poc.md)（含最小 Protocol Draft，**未声明为稳定契约**）
- 调研笔记：`docs/research/notes/`（Cookie API、重放上下文、Bridge 差距、Service 侧需求、Node 重放忠实度）
- 真实实现：`src/lib/request-context.js`（纯逻辑）+ `src/lib/request-context-source.js`（可注入的 `chrome.cookies` / `tabs` / `scripting` 适配）+ `bridge-state.js` 里一条**不占 Job 槽**的短路径
- 端到端验证：`npm run poc:context`（等价 `node tests/poc/request-context.mjs`）——在**真扩展**上跑 15 个场景，含反例；证据写在 `docs/research/evidence/request-context.json`

`GET_REQUEST_CONTEXT` / `REQUEST_CONTEXT` 是**新增的一对实验性消息**（架构文档 §13），错误码自成一套（`NOT_READY` / `INVALID_TARGET_URL` / `INVALID_SCOPE` / `TARGET_OUT_OF_SCOPE` / `CONTEXT_FAILED`），删掉它不会影响 V1 的任何行为。是否冻结、是否保留 `cookies` + `scripting` 权限，都还留给评审决定。

实测事实（Chrome for Testing 153）：`chrome.cookies.getAll({url})` 能拿到 **HttpOnly** cookie（页面 JS 看不到）；`SameSite=Strict` 不影响读取；**分区（CHIPS）cookie 必须给出完整分区键**——只给顶层站点会同时命中 `hasCrossSiteAncestor` 的两种取值，实测换一位就是另一个分区（空集）；页面级 UA 覆盖后上下文跟随页面；全程不落盘、日志里没有 cookie 值。

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

