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
2. WebSocket 连接 Service；
3. 自动识别唯一 Work Tab；
4. 接收 EXECUTE；
5. 使用 `chrome.userScripts.execute()` 在 USER_SCRIPT world 执行 JavaScript；
6. 主动 Push RESULT；
7. 支持 GET_STATUS / STATUS。

## 仓库结构

```text
src/                      Extension 根目录，Chrome 直接加载此目录
  manifest.json
  lib/                    纯逻辑，不依赖 chrome.*，可在 Node 下直接测试
  options/                Options 设置页
tests/                    node:test 自动化测试
docs/architecture-v1.md   V1 架构与协议
```

`src/` 就是 Extension 根目录，**没有打包步骤**：Chrome 直接加载 `src/`，因此 `tests/`、`docs/`、`package.json` 不会进入 Extension。

## 开发

需要 Node >= 20.11（测试使用内置 `node:test`，无第三方依赖）。

```powershell
npm test        # 等价于 node --test
```

> 若 PowerShell 执行策略阻止 `npm.ps1`，直接运行 `node --test`，或改用 `npm.cmd test`。

加载 Extension：

1. 打开 `chrome://extensions`，启用右上角「开发者模式」。
2. 点击「加载已解压的扩展程序」，选择本仓库的 `src/` 目录。
3. 在扩展卡片上点击「扩展程序选项」，填写 Service URL（形如 `ws://127.0.0.1:8080`）并保存。

Service URL 是 V1 唯一的持久配置，保存在 `chrome.storage.local`。未配置时 Options 页明确显示"未配置"，不会写入任何隐式默认值。

