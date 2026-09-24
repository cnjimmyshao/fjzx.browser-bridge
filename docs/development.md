# 开发、运行与 POC

本文整理既有 README 的运行步骤与实现说明；正式约定从 [Current](current/README.md) 读取。历史实测移至 [Research](research/2026-09-23-existing-browser-evidence.md)，本文的操作步骤和示例不表示当前 head 已经运行过测试。

## 仓库结构

```text
src/                      Extension 根目录，浏览器直接加载，无打包步骤
  manifest.json
  background/             MV3 Service Worker：连接生命周期与浏览器事件接线
  lib/                    逻辑模块，Chrome 能力通过相应入口接入
  options/                Extension 设置页
tests/                    node:test 单元与集成测试
  helpers/ws-server.js    测试用 WebSocket server
  poc/                    本地测试 Service、页面和真实浏览器场景运行器
docs/                     Current、Research、Decision 和开发说明
```

`tests/`、`docs/` 和 `package.json` 不属于被加载的 Extension 目录。

## 从全新 checkout 跑通 POC

按现有项目说明使用 Node >= 22；项目无第三方依赖，无需为当前测试额外安装依赖。命令以根目录 [package.json](../package.json) 为准。

1. 准备能加载未打包扩展的浏览器，优先使用既有 POC 路径采用的 Chrome for Testing，指定可执行文件：

   ```powershell
   $env:BROWSER_EXECUTABLE = "C:\path\to\chrome-win64\chrome.exe"
   ```

   原 README 报告 branded Chrome 142+ / Edge 的 `--load-extension` 限制；这是既有环境记录，不保证所有版本和发行渠道表现相同。环境不匹配时先核实加载能力，不修改协议来迎合测试环境。

2. 运行 Node 测试：

   ```powershell
   npm test
   # 等价于 node --test
   # PowerShell 执行策略阻止 npm.ps1 时可使用 npm.cmd test
   ```

3. 运行真实浏览器 POC：

   ```powershell
   npm run poc
   # 等价于 node tests/poc/run-poc.mjs
   ```

   运行器启动本地页面、测试 Service 和独立测试浏览器，通过真实设置页配置 URL，并执行场景。常用参数：`--browser <chrome.exe>`、`--port <调试端口>`、`--headed`。场景与验收映射见 [架构文档第 13 节](current/architecture.md#13-poc-与本文档的对应)；以本次实际输出为准，不沿用旧 README 的场景数量、耗时或 PASS 数。

4. 运行保活 POC（可选，耗时较长）：

   ```powershell
   npm run poc:keepalive
   # 等价于 node tests/poc/keepalive-poc.mjs
   ```

   默认跑 A、B、C2、D、E、F、G 全部场景，其中 B 是 10 分钟保活窗口，整轮约 15–18 分钟。参数：`--keepalive-seconds`、`--baseline-seconds`、`--stop-seconds`、`--reconnect-down-seconds`、`--phases A,B,...`、`--evidence <path>`。场景含义与证据字段见 [架构文档第 13.1 节](current/architecture.md#131-保活31--87的-poc-对应)。

   `--phases` 只接受依赖完整的子集：C2/D 需要 B，F/G 需要 E（分别复用它们建立的保活循环与状态）。`--phases C2` 这类调用会在启动前被拒绝，而不是跑出一份「没发送过一条 KEEPALIVE 却显示通过」的结果。

   先用 `--smoke` 跑一遍更省时间：它把三个窗口缩短到 100s/60s/100s，并强制把证据写到临时目录，因此一次约 4 分钟就能确认整条场景编排没坏。它的结果**不是**保活验证，证据文件里也会写明这一点。

   > `--evidence` 默认覆盖 `docs/research/evidence/keepalive-poc.json`；用短窗口或子集试跑时请指定别的路径（`--smoke` 已自动如此），否则会把缩水的运行写进证据文件。

只使用独立测试 Profile 和本机测试页面，不依赖第三方网站或真实账号。不得把日常登录态、Cookie 或 Profile 目录提交到仓库。

> POC harness 需要能加载未打包扩展的浏览器。Windows 上 Chrome 会把会话交给另一个进程、以退出码 0 结束启动进程，因此 `launchBrowser` 不再把「启动进程退出」本身当作启动失败：只有在调试端口被明确拒绝连接时才据此快速失败。关闭浏览器同时通过 CDP 请求，避免上一个进程已退出、真正持有调试端口的进程仍在运行并锁住 Profile。

## 手动加载与体验

1. 在 `chrome://extensions` 开启开发者模式，加载本仓库 `src/`。
2. 在扩展详情页开启 Allow User Scripts，见下节。
3. 启动本地测试 Service：

   ```powershell
   node tests/poc/service.mjs --interactive
   # 默认 ws://127.0.0.1:8787；可通过 --port 指定
   ```

4. 打开扩展 Options，保存终端打印的 Service URL；专用 Profile 中只保留一个普通网页作为 Work Tab。
5. 在终端输入脚本函数体，例如 `return document.title`；`:status` 请求当前状态，`:input <json>` 设置后续输入，`:quit` 退出。

测试 Service 启动时会同时启动保活循环，因此终端每 20 秒会看到一条 `→ {"type":"KEEPALIVE"}`。这是必要的：手工会话一旦静默约 30s，Chrome 会回收 Worker 并断开 socket，之后的 `:status` 或脚本就再也到不了 Bridge。不加 `--interactive` 时只打印往来帧，同样带保活。其他测试客户端的使用方式以测试 Service 的实际接口为准；Bridge 本身仍主动连接 Service。

> 保活 POC 自己按场景开关这个循环（见 `tests/poc/keepalive-poc.mjs`），所以基线场景仍然能观察到无活动时的回收。

### 运行前的一次性设置

既有 Contract 记录 Chrome 138+ 需要每个扩展的 Allow User Scripts 授权；未开启时按 `NOT_READY / USER_SCRIPTS_UNAVAILABLE` 处理。原实测记录开启后无需重启生效；新环境按实际浏览器行为核验，详见 [执行约束](current/architecture.md#51-实现约束已由真实浏览器验证)。

Service URL 是唯一必要的持久配置，保存在 `chrome.storage.local`；未配置时不写隐式默认值，也不连接。连接地址不被本文示例限制为本机。

## 协议与状态

协议字段、消息种类及错误码以 [Current](current/architecture.md#8-通信协议) 为准。以下沿用原 README 的实现说明，不新增协议：

- 状态由 current Job 和 Work Tab 就绪情况推导；有 Job 时为 RUNNING，否则按就绪情况为 IDLE 或 NOT_READY。RUNNING 期间新 EXECUTE 返回 BUSY，不排队、不抢占原 Job。
- 非法 JSON 或没有可用 jobId 的非法帧记录并忽略，不打断连接；失败帧仍有可用 jobId 时用 SCRIPT_EXECUTION_FAILED 返回 RESULT。
- KEEPALIVE 被显式识别后静默处理：不产生任何应答、不占 Job、不改变三态、不读写 Work Tab 绑定。它与其他入站帧一样在 Work Tab 评估就绪（`settled()`）后按类型直接返回——复位发生在浏览器**收到**消息时，因此不需要为它做一条绕过就绪等待的快路径。见 [Current §8.7](current/architecture.md#87-keepalive)。
- input 原样交给脚本。原 README 说明 metadata 仅接收、不解释、不转发；架构措辞尚需澄清，见 [Current 阅读边界](current/README.md#整理时保留的待澄清点)。不要从“透传”自行推导新增 RESULT 字段。
- RESULT.ok 是技术执行成功，不是业务成功；没有 Job Queue、History、Retry、幂等或 Exactly Once 的新增承诺。

## 脚本执行

Service 下发的是 async 函数的函数体，`input` 是参数，缺省为 null；可直接 `return` 和 `await`：

```js
const title = document.querySelector('h1').textContent;
document.getElementById('go').click();
await new Promise((r) => setTimeout(r, 100));
return { title, out: document.getElementById('out').textContent };
```

只在 Work Tab 主框架 USER_SCRIPT world 中执行，能操作 DOM，不以访问页面自身 world 的变量为前提；当前不开放 MAIN world。

### 错误如何映射

原实现用内部信封区分成功值与脚本异常／包装执行失败，Service Script 仍直接返回数据，不负责写信封。SCRIPT_EXECUTION_FAILED 覆盖脚本异常、语法错误、不可稳定序列化值、执行期间 Work Tab 消失和 API 调用失败。原因和历史浏览器观察见 [Research](research/2026-09-23-existing-browser-evidence.md)，正式约束见 [Current 第 5.1 节](current/architecture.md#51-实现约束已由真实浏览器验证)。

## Work Tab

既有绑定只按普通网页候选判断，不读取平台业务语义。http: / https: 为候选；chrome:、chrome-extension:、devtools:、about:、file: 等不是候选。唯一候选绑定，零候选 NO_WORK_TAB，多候选 MULTIPLE_TABS，已绑定 Tab 关闭为 WORK_TAB_CLOSED；不任意选择多个候选之一。

同一 Tab 内普通网页导航保留身份；候选情况改变时重新反映技术状态，不依赖旧绑定掩盖多 Tab。Bridge 不创建、关闭、恢复或重排 Tab，不记 Initial URL，恢复策略属于 Service。绑定 tabId 使用 storage.session；它不是新增持久配置。

## 权限

既有 manifest 的权限用途：storage 保存配置及会话绑定；tabs 用于识别 URL／内部页变化；userScripts 用于 USER_SCRIPT 执行；host_permissions 的 `<all_urls>` 提供目标页执行权限，不编码具体站点。无 optional_permissions 或 content script 的新增设计。实际声明见 [manifest](../src/manifest.json)，协议约束见 Current；本次不增加或删除权限。

## Service 连接

沿用原 README 的连接实现说明：已配置才连接；意外断开按 1s → 2s → 5s → 15s 退避，成功后重置。变更 URL 先发起旧连接关闭，等待结束后切换；closeGraceMs 默认 1000ms，超时可继续连接新地址，因此底层旧连接可能短暂并存，不能向 Service 承诺绝对连接互斥。

连接状态 DISCONNECTED / CONNECTING / CONNECTED 与 Job 状态分开。连接层将帧交给协议处理；旧 README 的“V1.2 尚未实现协议”属于早期阶段描述，不应继续当成当前缺少协议的结论。

原 README 同时写过“任何路径都不会留下无人管理的活连接”与上述有界关闭说明；排障时须区分管理状态、事件处理和底层 socket 存活，不能据一句概括扩大保障。

重连并不证明 Worker 永不被回收，也不自动恢复已经失去的 Worker。MV3 空闲回收的机制、Service 侧 20s KEEPALIVE 的已确认方案与保证边界见 [Current §3.1](current/architecture.md#31-mv3-空闲回收与-service-保活keepalive) 与 [ADR 0001](decisions/0001-service-keepalive.md)；本文不据此推导新的 heartbeat、认证、消息持久化、离线队列或 Job 重放。
