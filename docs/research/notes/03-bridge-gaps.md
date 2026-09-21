# 03 — Bridge 能力缺口：为 `targetUrl` 返回最小 Request Context（调研 / POC 笔记）

> 输入：V1.5 当前代码（HEAD 位于 `issue-6-v1.5-user-scripts`，`node --test` = 209 pass）。
> 性质：调研 + POC 设计笔记，**不把任何新协议声明为稳定 V1 契约**。
> 结论边界：本文只谈浏览器与 Bridge 能力，不引入任何站点/平台语义。

## 1. 当前能力清单（逐文件）

### 1.1 `src/`（扩展根目录，Chrome 直接加载，无打包）

| 文件 | 职责 | 关键不变量 |
| --- | --- | --- |
| `src/manifest.json:6` | MV3 声明，`permissions: ["storage","tabs","userScripts"]`、`host_permissions: ["<all_urls>"]`、SW 为 module | 没有 `content_scripts`（`src/manifest.json:8` 起只有 background/options_ui）；无 `optional_permissions` |
| `src/background/service-worker.js:19` | 唯一装配点：`settingsStore` → `serviceConnection` → `configSync` → `workTab` → `bridgeState` | 所有依赖在此显式注入（`chrome.*` 只在这一层出现）；监听器同步注册（`:94-109`）；worker 每次唤醒都重新 `sync()` + `refresh()`（`:70`、`:111`） |
| `src/background/service-worker.js:40` | `createWorkTabBinding()`：把 Work Tab 绑定写进 `chrome.storage.session`（key `workTabBinding`） | 只存 `{rememberedTabId, boundTabWasClosed}`；`chrome.storage.session` 缺失时返回 `undefined`，功能降级而不是报错 |
| `src/background/service-worker.js:72` | 入站帧入口：先 `workTab.settled()` 再 `bridge.handleMessage(data, {deliveredOn})` | `deliveredOn` 在收到帧的瞬间捕获，不是等待之后（`:81`） |
| `src/lib/protocol.js:14` | 冻结的 V1 线协议：2 个 Service 消息 + 2 个 Bridge 消息 + 3 个 error code | 解析/构造都是纯函数；`parseServiceMessage` 永不抛（`:65-116`） |
| `src/lib/protocol.js:167` | `isJsonCompatible`：只接受 `null/boolean/有限 number/string/array/plain object` | 拒绝访问器、不可枚举属性、symbol key、数组空洞、非索引 key、`toJSON`、`Map/Set/Date/RegExp/typed array/DOM`、`NaN/Infinity/-0`、循环引用；**total（读属性抛异常也返回 false）**；`toString()` 会被注入页面（`:157-159`），必须与页面内检查逐字一致 |
| `src/lib/bridge-state.js:65` | 状态机 + 单 Job 槽 + 入站消息分发 | 状态**推导不存储**（`:91-95`）；无 queue/history/retry/幂等；`currentJob !== null` 即 `RUNNING` |
| `src/lib/bridge-state.js:151` | `sendResultFor`：RESULT 只回给提交该 Job 的端点 | 端点变化时丢弃 RESULT（`:152`），Job 仍结束 |
| `src/lib/bridge-state.js:161` | `runJob`：唯一放行 executor 的地方，返回值过 `isJsonCompatible`（`:183`） | 任何失败路径都必须清空 `currentJob`（`:194-197`），否则永久 BUSY |
| `src/lib/bridge-state.js:212` | `handleMessage`：`GET_STATUS` 分支（`:236`）→ 其余**一律当 EXECUTE**（`:241-262`） | 未解析帧若带可用 `jobId` 就用 `SCRIPT_EXECUTION_FAILED` 回 RESULT（`:226-230`），否则静默 |
| `src/lib/work-tab.js:243` | `createWorkTabManager`：用 `chrome.tabs` 事件 + `query({})` 维护唯一候选绑定 | 只判定"是不是普通网页"（scheme ∈ `http:/https:`，`:34`），**从不读 host/path**；不创建/关闭/恢复/重排 Tab；不记 Initial URL |
| `src/lib/work-tab.js:375` | `settled()`：等待所有在途 tab 评估结束 | 这是"读状态前的栅栏"，入站帧与新请求都应以它为前提 |
| `src/lib/user-script-executor.js:116` | `chrome.userScripts.execute()` 薄封装 | 只在 `USER_SCRIPT` world + 主帧（`:161-165`）；`resolveApi()` 每次调用重解析（`:129-131`）；抛异常表达失败，由 bridge 映射成 `SCRIPT_EXECUTION_FAILED` |
| `src/lib/user-script-executor.js:63` | `wrapScript()`：注入信封，把脚本变成 async 函数体，`input` 是它的真参数 | 页面内先跑 `isJsonCompatible` 再返回（`:94`）；用 `JSON.parse` 还原 input 避免 `__proto__` 语义漂移（`:107`） |
| `src/lib/service-connection.js:41` | 唯一 Service WebSocket 的生命周期 | 单 socket；`1s→2s→5s→15s` 退避（`:29`）；换 URL 先退旧 socket（`:113-148`）；`send()` 没有连接时返回 `false` 而不排队（`:310-319`）；**不做认证/心跳/持久化/离线队列** |
| `src/lib/settings-store.js:12` | `chrome.storage.local` 单一配置的读写 | 只读不写默认值（`:31`）；非法值读回视作"未配置" |
| `src/lib/service-config.js:19` | 用 revision 消除"异步读回覆盖新变更"的竞态 | 陈旧读结果被丢弃（`:60-63`） |
| `src/lib/service-url.js:23` | `validateServiceUrl`：只接受 `ws:`/`wss:`，拒绝带 `#` 的地址 | 纯函数；空串是合法的"未配置" |
| `src/options/options.js:49` | 设置页：读取/保存/清除 Service URL | 表单初始 disabled，读取完成后才启用（`:23-27`）；不写隐式默认值 |

### 1.2 `tests/`（`node --test`，零依赖）

`protocol.test.js`（冻结消息集/错误码/`isJsonCompatible` 全部边界）、`bridge-state.test.js`（状态机、BUSY、NOT_READY、端点归属、失败后状态回收）、`work-tab.test.js` + `work-tab-manager.test.js`（纯 tracker + 事件/竞态/持久化）、`user-script-executor.test.js`（用 `node:vm` 模拟 Chrome 的 `result: null` 行为 + 页面内校验）、`service-connection.test.js` + `service-connection.integration.test.js`（FakeWebSocket + `tests/helpers/ws-server.js` 真 TCP）、`settings-store/service-config/service-url.test.js`、`manifest.test.js`、`sources-parse.test.js`（全量 `--check`、UTF-8 fatal、禁 `eval`/`new Function`）、`no-business-semantics.test.js`（扫描 `src/` **全部文件**的禁用词）。

### 1.3 Bridge 现在能做什么 / 不能做什么

能做：连一个 Service（出站 WS）、绑定唯一普通 Tab、在它的 `USER_SCRIPT` world 主帧执行 Service 下发的 JS 并回传 JSON 值、报告 `IDLE/RUNNING/NOT_READY`、跨 worker 挂起记住绑定与 Service URL。

不能做（与本 issue 直接相关）：
1. 任何**读浏览器元数据**的能力：无 cookie、无 header、无 storage、无 request 观测（无 `webRequest`/`declarativeNetRequest`）。
2. 任何**非工作 Tab** 的访问：`chrome.tabs` 只用来判定候选与绑定，不读其它 Tab。
3. 任何**页面外请求**：不能替 Service 发 HTTP（`fetch` 只在页面 world 可达，受页面 origin/CORS 约束）。
4. 任何**返回体之外的通道**：没有 ACK、没有独立 ERROR、没有 GET_RESULT，一次请求只对应一次 RESULT/STATUS。
5. `EXECUTE` 之外的请求语义：`handleMessage` 的 `else` 分支假定"剩下的都是 EXECUTE"（`src/lib/bridge-state.js:241`）。

## 2. 已具备的"部分能力"（issue 调研目标第 11 问，逐条回答）

1. **Work Tab 身份**：已可得。`workTab.tabId`（`src/lib/bridge-state.js:258` 传给 executor），`isBound`/`reason` 同样现成。挂起后可从 `chrome.storage.session` 恢复。
2. **Work Tab URL**：**运行期从未被持有**。URL 只在两处出现：判定候选 `isCandidateTab(tab)`（`src/lib/work-tab.js:50-52`）与 `noteNavigated(tabId, changeInfo.url)`（`:168-174`）；`createWorkTabTracker` 不保存任何 URL，`persisted`（`:106-108`）只有 id 与闭包标志。→ 取 URL 必须**在请求时刻**用 `chrome.tabs.get(tabId)`。
3. **`chrome.tabs.get(tabId).url` 何时可用**：SW 侧任何时刻都可调用（manifest 已有 `tabs` 权限，`src/manifest.json:6`；`tab.url` 是权限门控字段，`tests/work-tab.test.js:32-40` 正好固定了"url 不可用就不是候选"）。语义上的可用时刻：仅在 `workTab.isBound === true` 且 `workTab.settled()` 已解析之后才有意义——刚 `onUpdated` 但 query 还在途时读到的是旧 URL；Tab 关闭时 `tabs.get` 会 reject，这本身就是一个准确的存活性探测（交给 `describeError`，`src/lib/bridge-state.js:48-54`）。
4. **`storage.session` 里持久化了什么**：只有 `workTabBinding = {rememberedTabId: number|null, boundTabWasClosed: boolean}`（读 `:44-48`、写 `:49-52`），形状由 `tracker.persisted`（`src/lib/work-tab.js:106-108`）决定。**没有任何页面内容、URL 或凭据**；`storage.local` 只有 `serviceUrl`。→ 新能力必须保持这个边界：Request Context 不进任何 storage。
5. **RESULT 的 JSON-compatible 校验如何约束"结构化上下文对象"**：`runJob` 只对 EXECUTE 路径校验（`src/lib/bridge-state.js:183`），`send()` 只保证不抛（`:128-141`）。因此新路径**必须自己调用 `isJsonCompatible`**，否则 `JSON.stringify` 会把 `Map`→`{}`、`Date`→string、`undefined` 字段丢掉，Service 会收到"看起来成功但内容被改写"的上下文。对上下文对象的实际含义：
   - `{name, value, domain, path, secure, httpOnly, sameSite, expirationDate}` 这类由字面量拼出的对象天然合规（成员都是 string/number/boolean/null）；
   - **不能直接回传 `chrome.cookies.Cookie` 对象本体**（原型不是 `Object.prototype`，`src/lib/protocol.js:212-217` 会拒），也不能回 `Map`/`Date`；字段必须显式白名单拷贝；
   - 缺失值用**字段缺失或 `null`**（`createResultOk` 已把 `undefined`→`null`，`src/lib/protocol.js:122-129`），不要用空串冒充"未知"，否则 Service 无法区分"没有 Referer"与"取失败"。
6. **错误码是否需要新增**：现有 3 个 code 足够表达失败，但 `NOT_READY` 的语义要小心：它现在的定义是"这个 Job 无法执行"（Work Tab 缺失，或 `chrome.userScripts` 不可用）。对"取上下文"而言，**`chrome.userScripts` 不可用并不构成阻断**（上下文不依赖页面 JS），所以复用 `notReadyReason()` 整体（`src/lib/bridge-state.js:81-89`）会给出一个过严的判定——必须拆成"Work Tab 绑定条件"和"脚本能力条件"两半。真正新的失败语义只有两类：**目标 URL 无法处理/收集失败** → 复用 `SCRIPT_EXECUTION_FAILED`（诊断 message 说清是上下文）；**若要 Service 机器区分"操作员未授权 cookies"** → 才需要新 code（POC 内可取 `CONTEXT_UNAVAILABLE`，不进 V1 契约）。
7. **`NOT_READY` 语义能否复用**：能复用**字符串族**，但不能复用 `statusMessage()` 的既有 reason 集合（`NO_WORK_TAB / MULTIPLE_TABS / WORK_TAB_CLOSED / USER_SCRIPTS_UNAVAILABLE`，`docs/architecture-v1.md:191-196`）。建议新增两个只属于上下文请求的 reason：`CONTEXT_API_UNAVAILABLE`（`chrome.cookies` 不存在，通常是操作员没授予 `cookies` 权限）与 `TAB_CHANGED`（采样期间 Tab 消失/导航），它们仍然只描述 Bridge 技术状态。
8. **Work Tab 消失对上下文请求的影响**：与 EXECUTE 不同，上下文请求**没有"跑完就算数"的性质**——它必须在绑定有效的瞬间采样。若请求到达时 `isBound === false`，正确回答是立刻失败，而不是等下一次绑定后用另一个页面重试。
9. **请求身份**：V1 只有 `jobId` 且它"只关联当前 EXECUTE 与 RESULT"（`docs/architecture-v1.md:65`）。上下文请求需要一个**与之平行的 `requestId`**；`parseServiceMessage` 的 `jobId` 提取（`src/lib/protocol.js:85-86`）与随之而来的"带 jobId 就回 RESULT"兜底（`src/lib/bridge-state.js:226-230`）都需要为它加一条平行的路径。
10. **可测试性现状**：`src/lib/*` 全部不依赖 `chrome.*`（`chrome` 只在 SW 与 Options 出现），任何一个新模块只要走同样的注入风格，就能在 `node --test` 下用 fake 完全覆盖——包括 `chrome.cookies` 的失败模式。
11. **协议冻结的具体抓手**：`tests/protocol.test.js:16-24` 断言"恰好 4 种消息、3 个 code"；`tests/manifest.test.js:29` 对权限数组做 `deepEqual`；`tests/no-business-semantics.test.js:44` 扫描 `src/` 全部文件。这三处是本 issue 任何实现都会碰到的"必须刻意改"的点（详见第 5 节）。

## 3. 新能力的精确集成点

目标形态（POC）：

```
Service → Bridge : { "type": "GET_REQUEST_CONTEXT", "requestId": "...", "targetUrl": "https://…" }
Bridge → Service : { "type": "RESULT", "requestId": "...", "ok": true, "data": { …RequestContext } }
                   { "type": "RESULT", "requestId": "...", "ok": false, "error": { code, message } }
```

### 3.1 `src/lib/protocol.js`（纯逻辑，改动最小但最"贵"）

| 位置 | 改法 | 理由 / 兼容性 |
| --- | --- | --- |
| `SERVICE_MESSAGE_TYPES`（`:14-17`） | 加 `REQUEST_CONTEXT: 'REQUEST_CONTEXT'` | 纯新增 key。**兼容性影响**：`Object.values` 顺序变化 → `tests/protocol.test.js:17` 失败，必须同步改成 3 项（这是刻意 diff） |
| `BRIDGE_MESSAGE_TYPES`（`:20-23`） | **不改**（复用 `RESULT`），或加 `CONTEXT` | 复用 RESULT 可保持"Bridge→Service 只有 2 种消息"的极简性；若新增 `CONTEXT`，`tests/protocol.test.js:18` 同样要改，且 Service 要区分两种成功响应。**建议 POC 复用 RESULT**（它已经同时承载 ok/error 两种结果） |
| `ERROR_CODES`（`:26-30`） | **不改**（首选）；若要机器区分授权缺失，加 `CONTEXT_UNAVAILABLE` | 加 code 会改 `tests/protocol.test.js:19-23`。`docs/architecture-v1.md:148` 的原则是"只有 Service 真正需要机器区分才新增"，POC 阶段用 message 区分即可 |
| `PARSE_FAILURES`（`:33-40`） | 加 `MISSING_REQUEST_ID`、`MISSING_TARGET_URL` | 诊断信息，不会破坏既有断言（测试只按名字取用已有项） |
| `parseServiceMessage`（`:88-116`） | 在 `GET_STATUS` 分支（`:88-90`）之后、`EXECUTE` 校验（`:92`）之前插入新分支：提取 `requestId`（与 `jobId` 同样规则：非空字符串，否则 `null`），要求 `targetUrl` 是非空字符串，然后 `return { ok: true, message: { type: REQUEST_CONTEXT, requestId, targetUrl } }` | 放在 `EXECUTE` 之前是必需的——否则 `parsed.type !== EXECUTE` 会先把它判成 `UNKNOWN_TYPE`。**不要把 URL 的合法性校验放这里**：现有风格是 parse 只做形状校验（`script` 只校验是字符串，`:104-106`），语义校验下沉到执行层（`src/lib/user-script-executor.js:157-159`） |
| 失败返回的 `jobId` 字段（`:101-106`） | 新增的失败分支要**多带** `requestId`（或把 `jobId` 泛化为 `correlationId`） | 否则"带 requestId 的坏帧"会被静默丢弃（`src/lib/bridge-state.js:226` 只认 `jobId`），Service 只能等超时。**建议新增 `requestId` 字段而不是改 `jobId` 含义**，这样 `tests/protocol.test.js:92-116` 的全部断言不动 |
| `createResultOk`（`:122-129`） | **不改** | 它对 `requestId` 无感知：`createResultOk(requestId, context)` 会产出 `{type:'RESULT', jobId: requestId, …}`——**字段名会错**。因此要新增 `createResultOkFor(idField, id, data)`，或让 `createResultOk` 接受 `{jobId}` / `{requestId}` 二选一。推荐新增一个小函数（如 `createContextResult(requestId, data)`），**不动现有函数**，保证 V1 字节级兼容 |
| `createResultError`（`:136-143`） | 同上，新增平行函数 | 同上 |

### 3.2 `src/lib/bridge-state.js`（Job 模型是否适用？）

**结论：不要复用 `EXECUTE` 流程，走独立短路径；但必须复用同一个发送与端点归属逻辑。**

理由：
- Job 槽（`currentJob`，`:77`）带来的语义是 `RUNNING` + `BUSY` + `statusMessage()` 读 `currentJob.jobId`（`:100`、`:244`）。上下文请求是**只读、短、可并发**的操作，占用 Job 槽会：(a) 让一次 cookie 采样把并发 EXECUTE 挡成 `BUSY`；(b) 若 Job 对象没有 `jobId` 字段，`:244` 与 `:100` 会产出 `undefined` 而不是优雅失败；(c) 把"Bridge 正在跑脚本"和"Bridge 正在采上下文"混成同一个状态。
- 反过来，`RUNNING` 期间收到上下文请求**不必**回 `BUSY`：采样不改变页面，也不与脚本执行争夺资源。

具体改动点：

| 位置 | 改法 | 理由 |
| --- | --- | --- |
| `createBridgeState` 选项（`:65`） | 新增可选依赖 `context`（如 `{ resolve: (request) => Promise<Result> }`）| 与 `executor`/`connection`/`workTab` 同样的注入风格；不加校验抛错（`:66-74` 现有三条不动），缺失时按"能力不可用"返回结构化失败 |
| 新增 reason 常量（`:39` 旁） | 加 `CONTEXT_API_UNAVAILABLE`、`TAB_CHANGED` | 与 `USER_SCRIPTS_UNAVAILABLE` 同族，只描述技术状态 |
| `notReadyReason()`（`:81-89`） | **不改**，另加一个 `contextNotReadyReason()`：只判 `!workTab.isBound → workTab.reason`；**不**判 `executor.isAvailable()` | 上下文不依赖 `chrome.userScripts`；沿用现有函数会让"脚本 API 未开启"错误地阻断上下文请求 |
| `handleMessage`（`:236` 之后） | 在 `GET_STATUS` 分支之后、`RUNNING`/BUSY 检查（`:242`）之前插入 `REQUEST_CONTEXT` 分支 | 短请求不占 Job 槽，因此不能排到 `BUSY` 判定后面；同时天然复用 `deliveredOn !== connection.url` 的丢弃逻辑（`:213-217`） |
| 分支内部顺序 | ① `contextNotReadyReason()` → `RESULT{ok:false, code:NOT_READY}`；② 无 `context` 依赖或 `context.isAvailable?.() === false` → `NOT_READY/CONTEXT_API_UNAVAILABLE`；③ `await workTab.settled?.()`（若 manager 暴露）；④ `await context.resolve({tabId: workTab.tabId, targetUrl})`；⑤ 结果过 `isJsonCompatible`（`:183` 同款），不过则 `SCRIPT_EXECUTION_FAILED`；⑥ `sendResultFor` 同款端点归属检查（`:151-159`，用 `requestId` 定位） | ①-② 保持"绑定有效才谈采样"；③ 让 URL 采样不与在途 tab 评估竞态；④ 所有 `chrome.*` 调用都在注入的依赖里；⑤ 防止静默改写；⑥ 与 V1 同样的"不回答非提交方"保证 |
| `state()` / `statusMessage()`（`:91-106`） | **不改** | 采上下文期间不改变对外状态（GET_STATUS 仍报 IDLE 或 RUNNING(jobId)），语义自洽 |
| 返回值对象（`:265-280`） | 不需要新增 getter；`handleMessage` 已经覆盖 | 保持 API 面不变 |

并发：多个 `GET_REQUEST_CONTEXT` 可并发（彼此独立、无共享状态），但**不做缓存**——与"无 Job History、无结果缓存"（`docs/architecture-v1.md:65`）保持一致；重复请求就重复采样。

### 3.3 Service worker 侧如何注入 `chrome.cookies`

沿用 `executor` 的既有风格（`src/lib/user-script-executor.js:116-135`）：

1. 新建 `src/lib/request-context.js`：纯逻辑，**不 import `chrome.*`**，导出
   - `REQUEST_CONTEXT_FAILURES`（`COOKIES_API_UNAVAILABLE` / `TABS_API_UNAVAILABLE` / `INVALID_TARGET_URL` / `TAB_CHANGED` / `COLLECT_FAILED`）；
   - `createRequestContextCollector({ cookies, tabs, logger })`，其 `resolve({ requestId, tabId, targetUrl })` **永不抛**，返回 `{ok:true, context}` 或 `{ok:false, failure, message}`（便于 `node --test` 直接断言原因，也让 `bridge-state` 只负责把 failure 映射成 code）；
   - `isAvailable()` 探针。
2. `src/background/service-worker.js`：仿照 `createUserScriptExecutor` 的注入——`createRequestContextCollector({ cookies: chrome.cookies, tabs: chrome.tabs, logger: console })`，然后把 collector 作为 `context` 传进 `createBridgeState`（`:61-66` 处）。
3. **每次调用重解析 API**，不要构造时快照。`chrome.cookies` 是权限型 API：未授予 `cookies` 权限时该属性是 `undefined`（与 `chrome.userScripts` 未授权时的行为一致，`src/lib/user-script-executor.js:121-131` 已按这个事实设计）。采集器内部固定使用 Promise 形式（MV3 下 callback 形式已不推荐，Chrome 文档标注 Promise 支持）。
4. 采集内容（POC 最小集，全部为浏览器技术字段，不含业务语义）：
   - `cookies`：对 `targetUrl` 调 `cookies.getAll({ url: targetUrl })`——**让浏览器自己做 Domain/Path/Secure/SameSite/过期匹配**，不要在扩展里重新实现匹配规则；每项只拷贝白名单字段 `name/value/domain/path/secure/httpOnly/sameSite/expirationDate`（显式字面量，见第 6 节）；
   - `tabUrl`：`tabs.get(tabId).url`（reject ⇒ `TAB_CHANGED`）；
   - `userAgent`：SW 的 `navigator.userAgent`（扩展进程的 UA，非页面的 UA-CH 覆盖值 → 记为 POC 已知偏差）；
   - `referer`：绑定 Tab 的 URL（同源重放近似），显式标注"这是近似值，不是真实请求头"。
   - `document.cookie` **不采**：它是 HttpOnly 的子集，会给出"看起来更可信但更不完整"的数据。

### 3.4 与 Work Tab / `NOT_READY` / `USER_SCRIPTS_UNAVAILABLE` 的关系

| 状态 | EXECUTE | GET_REQUEST_CONTEXT |
| --- | --- | --- |
| 无 Tab / 多 Tab / Tab 被关 | `RESULT NOT_READY`（`:248-252`） | 同：`NOT_READY` + 原有 reason |
| 绑定有效，但 `chrome.userScripts` 不可用 | `NOT_READY / USER_SCRIPTS_UNAVAILABLE`（`:85-87`） | **放行**（上下文不需要页面 JS）；若 `chrome.cookies` 缺失则 `NOT_READY / CONTEXT_API_UNAVAILABLE` |
| 有脚本在跑 | 新 EXECUTE → `BUSY` | 放行（只读，不占 Job 槽） |
| 采样期间 Tab 消失 / 导航 | n/a | `NOT_READY / TAB_CHANGED`（或 `SCRIPT_EXECUTION_FAILED`，见第 2 节第 6 条） |
| 操作员切换 Service URL | 帧被丢弃（`:213-217`），RESULT 不发给新端点（`:151-159`） | 完全相同 |

## 4. 最小改动面：候选方案对比

### 方案 A（推荐）新增独立请求 `GET_REQUEST_CONTEXT`，响应复用 `RESULT`

- 改动文件：`protocol.js`（消息类型 + parse 分支 + 两个平行构造函数）、`bridge-state.js`（可选 `context` 依赖 + 一个分支 + 两个 reason）、**新增** `lib/request-context.js`、`service-worker.js`（注入一行）、`manifest.json`（`cookies` 权限）、`docs/architecture-v1.md` + `README.md`（权限表与"V1 不做"清单）。**6 个既有文件 + 1 个新文件。**
- 对 V1 冻结契约的破坏度：**中**。消息集合从 4 变 5；协议测试与 manifest 测试必须同步修改（刻意 diff）。但既有 4 种消息、3 个 code、`RESULT` 形状、`GET_STATUS/STATUS` 全部字节不变，现有 Service 不受影响（它们永远不会发新类型）。
- 可测试性：**高**。全部逻辑在纯模块里，fake `cookies`/`tabs` 即可覆盖成功、授权缺失、Tab 消失、非法 URL、超长值、JSON 合规性。
- 安全面：需要新增 `cookies` 权限（最大的新增风险点），但数据面可控（只回 `targetUrl` 匹配项 + 字段白名单 + 不落盘 + 不写日志）。
- 业务语义：**不引入**。字段全是浏览器技术概念。

### 方案 B 扩展 `EXECUTE`（增加 `mode` / 缺省 `script` 表示"取上下文"）

- 改动文件：`protocol.js`（`script` 校验放宽 + `mode` 解析）、`bridge-state.js`（`runJob` 分叉）、executor 或新模块、manifest。
- 破坏度：**高**。`docs/architecture-v1.md:104-108` 明确 `script` 必填；`tests/protocol.test.js:101-108` 断言缺 `script` 必须失败；`bridge-state.test.js` 大量用例以"EXECUTE 就是跑脚本"为前提。一旦放宽 `script` 必填，`EXECUTE` 的含义变成"看字段决定干什么"，`RESULT` 的语义也随之分裂（跑脚本 vs 取上下文），而 Job 槽/BUSY 会错误地套在只读采样上。
- 可测试性：中（要重测大量既有断言）。安全面：同 A。业务语义：不引入，但把两种能力耦合成一条消息，未来扩展会继续往 `mode` 上加分支。
- 结论：**否**。

### 方案 C 把上下文能力注入给 Service Script（如页面里可用的 `bridge.cookies(url)`）

- 实现路径：要么在页面里注入一个桥对象并把结果带回（需要页面↔扩展通道，V1 没有 content script，只有 `userScripts.execute` 的单向求值），要么让脚本自己读 `document.cookie`。
- 破坏度：若只允许脚本读 `document.cookie`，**零改动**——但**能力上不等价**：HttpOnly cookie 不可见（服务端会话通常正是 HttpOnly），UA 是页面的（含 UA-CH 覆盖，反倒更准），Referer 在页面内根本拿不到（`document.referrer` 只是同源策略下的文档来源，不等于请求头，且 `Referrer-Policy` 会削减它）。
- 可测试性：高（就是现有 executor 路径）。安全面：**看起来更好**（不加 `cookies` 权限），但会诱导 Service 把"半个上下文"当成完整上下文，失败模式不可区分（"没有 cookie" vs "cookie 是 HttpOnly"）。
- 业务语义：不引入。**结论：作为"零权限降级路径"记录，不作为本 issue 的主方案。**
- 另外，把能力暴露成 `bridge.*` 命名空间与 `docs/architecture-v1.md:52-54`（"普通 DOM 操作不包装为 Bridge API"、"可以先不向 Service Script 开放任何额外 Browser API"）的方向相反。

### 方案 D 完全不动 `src/`，另建 POC 扩展

- 形态：新增顶层 `poc/`（自己的 `manifest.json` + SW），通过**相对路径 import `../src/lib/*.js`** 复用已测逻辑；`src/` 一个字节不改，全部既有测试保持绿。
- 破坏度：**零**。可测试性：可（把 `poc/` 纳入 `node --test` 范围，或为它单写测试目录）。安全面：同 A（POC 自己的 manifest 加 `cookies`），且**默认不会被误装**。业务语义：不引入。
- 代价：`docs/architecture-v1.md`/README 不说这件事时，能力是"影子实现"；要维护第二份装配代码（SW、options、连接引导）。

### 推荐

**短期（本 issue 的 POC）走 D 的隔离形态 + A 的设计**：把新能力实现在 `src/lib/request-context.js`（纯逻辑、可测）与一个最小 POC 装配点里，`src/` 的冻结面（`protocol.js` 的四个常量、`bridge-state.js` 的状态机、`manifest.json` 的权限数组）**在 POC 期间不动**，让"V1 基线 209 个测试全绿"成为一个可验证的事实；等评审确认后，再按 A 把消息与权限正式并进 `src/`（那时第 5 节列出的三处测试改动就是**必须的、经评审的 diff**）。

推荐 A 而非 B/C 的核心理由：Request Context 是**一条独立的、只读的、短时的**能力，它的失败条件（绑定、权限、URL 合法性）与脚本执行的失败条件不同；把它塞进 `EXECUTE` 或页面 API 都会让"一个 code 覆盖两种语义"，而 Bridge 的全部价值恰恰建立在"语义最小、状态可推导"上。

## 5. 测试影响：会失败的地方，以及为什么必须刻意改

| 测试 | 现状断言 | 触发改动的行为 | 说明 |
| --- | --- | --- | --- |
| `tests/manifest.test.js:29` | `deepEqual(manifest.permissions, ['storage','tabs','userScripts'])` | manifest 加 `cookies` | 这就是"权限蔓延必须显式评审"的机制本身。改法：把 `'cookies'` 追加进数组，并**在注释里写清用途与最小化理由**（`:21-28` 已有这种注释风格） |
| `tests/manifest.test.js:38-41` | host permission 只有 `<all_urls>` 且必须匹配 `[*<]` | 若为"只允许特定站点取上下文"收紧 host 权限 | 任何具体站点模式都会被这条挡住——**这是特性，不是障碍**：Bridge 不得编码站点知识，权限收敛只能靠"按 `targetUrl` 运行时过滤"，不能靠 manifest 列举站点 |
| `tests/protocol.test.js:16-24` | 恰好 4 种消息 / 3 个 code | 加 `REQUEST_CONTEXT`（或加 `CONTEXT` 响应、`CONTEXT_UNAVAILABLE` code） | 必须同步更新期望值。**建议在同一次改动里明确标注"V1 契约 → V1.x 契约"**，并在 `docs/architecture-v1.md` §8 记录，避免以后有人以为这 5 个类型一直是 V1 原始集合 |
| `tests/protocol.test.js:83-90` | 未知类型（含 `RESULT`/`STATUS`）必须 `UNKNOWN_TYPE` | 新类型加入后，`'REQUEST_CONTEXT'` 若出现在 `SERVICE_MESSAGE_TYPES` 就不再是未知类型 | 这些断言不会自动失败，但要**补一条正向用例**（新类型可解析）与一条反向用例（Bridge→Service 的类型仍被拒），保证方向性不被打穿 |
| `tests/sources-parse.test.js:28-42` | 每个 `src/**/*.js` 必须 `node --check` 通过 | 新文件自动被纳入 | 新模块必须语法正确；注意该文件还会扫 `eval`/`new Function`（`:80-96`） |
| `tests/sources-parse.test.js:80-96` | 禁止 `eval(`、`new Function(`、`Function("…")` | 采集器若想"动态构造请求"会踩线 | 上下文采集必须用结构化 API（`chrome.cookies`/`tabs.get`），**不得**靠拼字符串求值 |
| `tests/no-business-semantics.test.js:44-58` | 扫描 `src/` **全部文件**（注释、README 之外的一切）的禁用词列表（`:13-29`） | 新文件、新注释、新常量名 | 三个具体注意点：(a) 不要在标识符里出现 `blocked`；(b) 不要用平台名做示例 URL/注释；(c) 不要引入 `captcha` 之类的业务状态词。用 `targetUrl`、`cookies`、`userAgent`、`referer`、`httpOnly` 这类纯技术词是安全的 |
| `tests/bridge-state.test.js:86-96` | `createBridgeState` 三个必需依赖的 `TypeError` | 新增 `context` 依赖 | **把 `context` 设计成可选**，否则这 5 条断言之外的构造点（以及未来调用方）都要改；可选依赖也符合"能力探测"风格（`executor.isAvailable` 就是可选的，`:85`） |
| `tests/bridge-state.test.js:180-208` | RUNNING 时第二个 EXECUTE 得 `BUSY` | 若上下文请求占用 Job 槽 | 会与"上下文请求不占槽"的设计冲突，并可能让既有 BUSY 用例之外的 `currentJobId` 断言变脆。建议**不占槽**，并补一条"RUNNING 期间上下文请求不被 BUSY 挡"的新用例 |

**建议的新增测试清单（全部可在 `node --test` 下不依赖浏览器运行）**

1. `tests/request-context.test.js`（新文件，纯逻辑）：fake `cookies.getAll` + fake `tabs.get`
   - 成功：只包含 `targetUrl` 匹配项；字段白名单（`partitionKey`/`storeId` 等不得出现在结果里）；`secure`/`httpOnly`/`sameSite` 原样保留（不解释）。
   - `cookies.getAll` reject → `COLLECT_FAILED`（且不抛）；返回非数组 → 失败而不是 `null`。
   - `cookies` 为 `undefined` → `COOKIES_API_UNAVAILABLE`；`tabs` 为 `undefined` → `TABS_API_UNAVAILABLE`（对应"每次调用重解析"的语义：构造时可用、调用时不可用也要正确）。
   - `tabs.get` reject → `TAB_CHANGED`；`tabId` 非数字 → 失败。
   - `targetUrl` 非法/非 http(s) scheme → `INVALID_TARGET_URL`，且**不发生任何 API 调用**（用 fake 记录调用次数断言）。
   - 结果对象整体过 `isJsonCompatible` 为 true；空 cookie 集、空字符串 value、极大 value 都不被改写或截断。
   - 日志检查：注入 recording logger，断言任何一次失败路径的日志里**不含 cookie value**（这个测试保护第 6 节第 1 条）。
2. `tests/protocol.test.js` 追加：`REQUEST_CONTEXT` 解析（`requestId`/`targetUrl` 缺失分别对应新 `PARSE_FAILURES`）、`requestId` 原样回填、`RESULT` 构造函数的字段名是 `requestId` 而不是 `jobId`、`input`/`metadata` 等既有字段不受影响。
3. `tests/bridge-state.test.js` 追加：`contextNotReadyReason` 的优先级（Work Tab 问题优先于 `CONTEXT_API_UNAVAILABLE`）；`chrome.userScripts` 不可用**不**阻断上下文请求；有脚本在跑时上下文请求照常成功且 `currentJobId` 不变；`context.resolve` 抛异常也不会卡状态（对照 `:487-516` 的既有防御性用例）；端点变化时上下文 RESULT 不回新端点（对照 `:518-531`）。
4. `tests/manifest.test.js`：权限数组与注释同步（见上表）。
5. `tests/sources-parse.test.js`：新文件自动覆盖，无需改动。

## 6. 安全审计视角：最容易出错的点

**最危险的一类（数据泄漏）**

1. **日志泄漏**：`targetUrl` 常带查询串（token、签名、会话参数），cookie **value** 就是凭据。现有代码大量用 `logger.warn?.()`（`src/lib/bridge-state.js:88,120,133,137,153,215,222`；`src/lib/work-tab.js:294,309,329,344`；`src/lib/service-config.js:56`）——沿用这个习惯，但新路径的规则必须更严：**只记录"技术事实"（失败原因、cookie 条数、来源 scheme+host），绝不记录完整 URL、query、cookie 名值对**。建议把"上下文模块不得出现任何 template 里含 value/targetUrl 的日志"写成静态断言式测试。
2. **RESULT 里回传全部 cookie**：`cookies.getAll({url})` 只要 url 一放宽（改成 `{domain}` 或漏掉 `url`）就会把整个 cookie jar 送出去。POC 的硬约束：**必须传 `url`，且必须是请求里那一个字符串**；结果条数设上限并在超限时失败（而不是截断后静默成功）。
3. **跨站枚举**：这是本能力最本质的风险——它把"Bridge 只能在绑定 Tab 里跑脚本"扩展成"可以对任意 URL 取 cookie 元数据"。缓解（POC 必须至少做前两条）：(a) 只接受与 Work Tab **同 site/origin** 的 `targetUrl`（绑定 Tab 的 URL 由 `tabs.get` 提供），越界即 `INVALID_TARGET_URL`；(b) 每个 requestId 一次性、不缓存、不批量；(c) 操作员可见的开关（Options 页勾选"允许上下文请求"）——注意这会引入新的持久配置，与"V1 只有 Service URL 一个持久配置"（`docs/architecture-v1.md:42`）冲突，需要评审决定。
4. **持久化**：cookie/上下文**绝不进** `chrome.storage.session` 或 `local`。现有 `storage.session` 只放两个数字/布尔（`src/background/service-worker.js:44-52`），这是应保持的边界；也不要为了"性能"加结果缓存——`docs/architecture-v1.md:65` 的"无 History/无缓存"同时是安全属性。
5. **错误信息带值**：`describeError`（`src/lib/bridge-state.js:48-54`）只返回 `message`，且连"无法描述的值"都有兜底。新模块的所有失败 message 必须是**自己构造的常量字符串**，绝不把 cookie 值、完整 URL 或 API 原始错误对象直接拼进去。注意 `chrome.runtime.lastError`/API 错误文本可能包含 URL——需要过滤。
6. **不改写就是安全属性**：`isJsonCompatible` 的严格性（拒绝访问器、`toJSON`、非 plain 原型、`Map/Date/typed array`，`src/lib/protocol.js:167-244`）在这里的价值是"Service 收到的一定是扩展检查过的那个值"。同时 `chrome.cookies.Cookie` 对象本体**不能**直接回传（原型不是 `Object.prototype`），必须白名单拷贝——这个"必须拷贝"的要求顺便挡住了未来 API 新增敏感字段（如 `partitionKey`）自动外泄。
7. **权限面变化的准确表述**：`cookies` 权限授予的是"对所有 `host_permissions` 覆盖站点 cookie 的读写"。它不会让扩展**能做**以前做不到的事（Service JS 现在已能在页面里读写非 HttpOnly cookie），但它把风险从"执行"转成"数据外泄"，并把可观测范围从"当前页面"扩到"任意 URL"。评审时必须把这句话写进 manifest 注释与文档，而不是笼统写"最小权限"。
8. **`<all_urls>` + `cookies` 的组合**要有意识地确认：若未来把 host 权限收紧到具体站点，`tests/manifest.test.js:38-41` 会立刻失败——这正是防止"为了取某个站点的 cookie 而在 manifest 里写死站点"的守门测试。

## 7. 一段话总结（推荐方案 / 改动清单 / 三个人工评审点）

**推荐**：把"按 `targetUrl` 取最小 Request Context"实现为一条**独立于 `EXECUTE` 的只读短请求**（`GET_REQUEST_CONTEXT` → 复用 `RESULT` 形状），逻辑落在新的纯模块 `src/lib/request-context.js`（注入 `chrome.cookies` / `chrome.tabs`，每次调用重解析 API，永不抛），由 `bridge-state.js` 新增一个**不占 Job 槽、不受 `USER_SCRIPTS_UNAVAILABLE` 阻断**的分支来驱动；**POC 期间先不修改 `src/` 的冻结面**（消息常量、状态机、`manifest.json` 权限数组、`docs/architecture-v1.md`），把新代码与最小装配放在隔离位置验证，评审通过后再按方案 A 并入。

**需要改动的文件清单**（正式并入时）：`src/lib/protocol.js`（`SERVICE_MESSAGE_TYPES` + parse 分支 + 平行结果构造函数；`ERROR_CODES` 与 `isJsonCompatible` 不动）、`src/lib/bridge-state.js`（可选 `context` 依赖 + 一个分支 + 两个新 reason）、`src/lib/request-context.js`（新增）、`src/background/service-worker.js`（注入一行）、`src/manifest.json`（`cookies` 权限）、`docs/architecture-v1.md` §8/§11 与 `README.md` 权限表、`tests/protocol.test.js`、`tests/manifest.test.js`、`tests/bridge-state.test.js`、新增 `tests/request-context.test.js`。

**最需要人工评审的 3 个点**：① **`cookies` 权限 + `<all_urls>` 的组合**是否可接受，以及"只允许与 Work Tab 同 site 的 `targetUrl`"这条限制是否足够（它决定了这个能力是"页面上下文"还是"全站 cookie 拉取"）；② **契约扩展方式**——新增第 5 种消息是否真的必要，还是应当先只做"Service Script 读 `document.cookie`"的零权限降级路径，把 HttpOnly 的缺口交回 Service 判断；③ **Job 模型边界**——上下文请求不占 Job 槽、可在 `RUNNING` 期间并发、不与 `USER_SCRIPTS_UNAVAILABLE` 联动，这三条会改变 Service 对 `STATUS/BUSY` 的既有假设，必须由 Service 侧确认可接受（以及失败时到底用 `NOT_READY` 还是需要新的可机器区分的 code）。
