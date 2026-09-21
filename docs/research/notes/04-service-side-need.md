# Service 侧需求边界（issue #13 调研输入）

调研对象：`D:\nodejs\com.fajiezhixin.pr-dy`（V0.8/V0.9 架构规格）、`D:\nodejs\com.fajiezhixin.pr-douyin`（现役 Douyin Service 实现）。
方法：只读文档与源码，grep 定向取证，未运行浏览器、未改任何文件。
标注约定：**【事实】**=有 `仓库/文件:行号` 证据；**【未找到证据】**=如实声明；**【需求侧事实】**=允许出现平台词汇；**【通用约束】**=Bridge 必须保持无业务语义的部分。
路径约定：未写仓库名时，`server/…`、`extension/…`、`docs/…`、`logs/…` 指 **pr-douyin**；写 `pr-dy/…` 的指 pr-dy；写 `src/…` 或 `docs/architecture-v1.md` 的指 **本仓库 `fjzx.browser-bridge`**。

---

## 一、媒体资源下载需求的实际形态

### 1.1 新架构（pr-dy）里这个需求还没有条文

- 【事实】`pr-dy` 的 V0.9 schema 计划里 `media` 只是待定 collection 之一（`pr-dy/docs/v0.9/schema/README.md:10`）；全仓 grep `媒体|media|下载|download|Cookie|Referer|User-Agent` **没有**任何媒体下载需求、接口或字段定义。
- 【事实】`pr-dy` 唯一与"请求上下文"相关的现行规格是 Execution Profile：**固定绑定 Operator + Proxy + BrowserProfile + BrowserConfiguration，Dispatcher 不动态重组**（`pr-dy/docs/requirements/01-browser-execution.md:5`）；**Browser Profile 保存 Cookie、Local Storage、Session 和登录状态，且这些内容不复制到业务 MongoDB**（同文件 `:7`）。
- 【事实】浏览器拉起/监督明确归 `pr-douyin` 而非 Bridge，职责含"使用指定 Browser Configuration / Browser Profile / Proxy、加载 `fjzx.browser-bridge`"（`pr-dy/docs/requirements/01-browser-execution.md:11`）。
- 【事实】Bridge 边界："只负责把 Service 提供的受控执行内容送入 Browser/Page，并把 Raw Output 返回"，不解释业务语义（`pr-dy/docs/requirements/04-command-runtime.md:11-13`）；"Bridge 承担 Douyin 业务解释"被列为阻塞放行项（`pr-dy/docs/requirements/07-testing-acceptance.md:13`）。
- 结论：**【需求侧事实】**issue #13 的"请求上下文"需求目前在 pr-dy 规格层是**空白**，唯一可引用的既有立场是"Cookie/Proxy 属于 Browser Profile 与 Service，不属于 Bridge"。

### 1.2 现役 Service（pr-douyin）已经有了完整形态：浏览器只上报 URL，服务端自己下载

- 【事实】发现 URL：
  - 页面渲染数据（playAddr / images / music）：`server/browser-runtime/player-media.js:129-148`，其中渐进式 mp4 优先、DASH 轨道明确排除（`:141-145`）。
  - DOM 兜底：`server/browser-runtime/adapter.js:309`（`video.currentSrc/src` 与 `<source>` 子节点）、`:313`（`performance.getEntriesByType('resource')` 反查 `*.douyinvod.com`）。
  - 音乐地址元素优先（"签名会变，元素上的更新"）：`player-media.js:102-106`。
- 【事实】上报：`server/browser-runtime/page-submission.js:314-342` 构造 `{mediaId, ownerType, ownerId, kind, position, sourceUrl, status:'pending'}`，随批次 HTTP 提交。
- 【事实】服务端登记入池：`server/src/repository.js:355,371-388` → `MediaStore.recordUrl()`（`server/src/media-store.js:101-123`）。
- 【事实】下载由 Service 后端（Node.js）自己发起：`server/src/media-download.js:51-132`，`fetch(url, {headers:{Referer:'https://www.douyin.com/','Accept-Encoding':'identity'}, redirect:'follow'})`（`:64-68`），120s 超时、边下边算 sha256、`.pending` 暂存后 rename、mime 白名单、体积上限。默认开启（`docs/media-layer-rebuild-progress.md:57`）。
- 【事实】"浏览器下载 → 服务端导入"的旧通路**已被整体拆除**：7 个浏览器下载接口统一返回 410 `media_browser_download_removed`（`docs/media-layer-rebuild-progress.md:46-47`），`media-storage.js`/`media-assets.js`/`media-disk.js`/`media-fetch.js` 等 16 个文件删除（同文 `:64-68`），旧票据/认领集合已不存在（同文 `:140`）。
- 【事实】旧通路的入口描述仍留在文档里作对照："媒体由 Chrome / Edge 正常下载；服务只读取允许目录内的本机文件，不抓取来源 URL"（`docs/media-assets.md:3`）。
- 【事实】Service 侧**没有任何 cookie 逻辑**：对 `server/**/*.js` grep `chrome.cookies|document.cookie|Cookie:` 无媒体相关命中；3 处命中分别是 WS 握手 UA 记录（`server/src/command-channel.js:127`）与浏览器名/版本上报（`server/browser-runtime/remote.js:18-21`）。
- 【事实】扩展声明了 `cookies` 权限但**从未调用**：`extension/manifest.json:16` 有 `"cookies"`，全仓 grep `chrome.cookies` 零命中。
- 结论：**【需求侧事实】**现役流程正是 issue #13 想做的形态——Service 拿 URL 自己下载；但它在**不发 Cookie、只发一个固定 Referer 且无 UA 设置**的条件下已经跑通了视频/图片/音频/图集四类。

---

## 二、资源 URL 的实际性质

| 性质 | 结论 | 证据 |
|---|---|---|
| 同源 or 独立 CDN | **独立 CDN 域名**（跨源） | 白名单 14 个域名 `server/src/media-store.js:28-32`；实测 host `p9-pc-sign.douyinpic.com`（`docs/media-layer-rebuild-progress.md:389`）、`sf11-cdn-tos.douyinstatic.com`（`:338`）、`sf6-cdn-tos…`/`lf26-music-east…`（`:577-581`） |
| 签名查询参数 | **有**，多种形态 | 视频：`dy_q`=签发时间 + 路径 8 位 hex=过期时间（`server/src/media-store.js:46-59`）；图片：`x-expires`（同文件 `:54`）；图集带 `biz_tag=aweme_images`（`docs/unified-download-pool.md:200` 引 `adapter.js:281`） |
| 过期时间 | **视频 ≈3h**；**图片 ≈1 个月**；**音频无签名** | `docs/unified-download-pool.md:30-41`、`docs/media-tables-design.md:41`、`docs/media-layer-rebuild-progress.md:391-407`（实测视频 3h19m / 图片 `x-expires`≈1 个月）、`:349-350`（音乐地址 `expiresAt=null`） |
| 分片 / Range | 采集侧**只上报整文件地址**；服务端**整文件 GET，无 Range** | 视频响应带 `accept-ranges: bytes` 但只用于探测（`docs/unified-download-pool.md:23`）；下载器无 Range 头（`server/src/media-download.js:64-68`）；DASH/分轨路径被一票否决（`server/browser-runtime/player-media.js:44,141-145`、`adapter.js:309,313`） |
| m3u8 / HLS | **【未找到证据】** | 全仓 grep `m3u8|HLS` 零命中 |
| 防盗链（Referer 白名单） | **【未找到证据】**；反向证据是不需要 | `docs/unified-download-pool.md:25`：图片/表情抽样 10/10，"带/不带 Referer 都 200" |
| 过期是主失败模式 | **是** | `needs_resign` 独立状态（`server/src/media-store.js:13`、`docs/download-asset-redesign.md:162-178`）；文档结论"`needs_resign` 在实际运行中基本是视频专属状态"（`docs/media-layer-rebuild-progress.md:407`） |

补充：【事实】代码里固定发 `Referer: https://www.douyin.com/`（`media-download.js:65`），但**没有测试断言它**（`server/test/media-download.test.js` grep `Referer|User-Agent` 零命中），也没有文档说明它是否必需——**它的必要性属于【未找到证据】**。

---

## 三、真正需要浏览器上下文的原因

- 【事实】**现有全部证据都指向"不需要 Cookie"**：`docs/unified-download-pool.md:25-28` 明确写"服务端能取视频和图片，**不需要浏览器 Cookie、不需要特殊请求头**"；端到端验证全程无 Cookie——视频 `200 video/mp4 50.95MB`（`docs/media-layer-rebuild-progress.md:170`）、图集 3 张 webp（同文 `:275-284`）、音频 m4a（同文 `:338-345`）、7 小时无人值守增长（同文 `:573-587`）。
- 【事实】真正**只有浏览器能做**的事是**重新签名**：服务端无法自行签发，必须等浏览器重新访问该作品/评论页（`docs/download-asset-redesign.md:172-178`、`docs/unified-download-pool.md:153-155`、`docs/media-layer-rebuild-progress.md:407`）。
- 【事实】仍会出现的真实失败：`media_fetch_http_403`、`media_fetch_timeout`（`docs/2026-09-13-watch-monitor-defects.md:38`），量级 9/416（同文 `:35`、`:113`）。
- 【事实】已知的 CDN 兼容坑与上下文无关：图片 CDN 上 `HEAD` 返回 405，只允许回退到 GET（`docs/2026-09-07-media-head-405.md:5-7`）。
- **【未找到证据】**：CDN 是否按 Cookie / 出口 IP / User-Agent 判定；403 的具体成因；任何"带 Cookie 才成功"的实测样本。
- 结论：**【需求侧事实】**在 Douyin 这个真实案例上，issue #13 的痛点**不是 cookie，而是 URL 新鲜度（重签名）+ 出口一致性**；"下载需要浏览器 Session"这一命题在当前代码里**没有被证实**，只有一条"重新签名必须回到浏览器"的强证据。

---

## 四、已有的浏览器侧能力（可复用清单）

### 4.1 扩展本体

- 【事实】`pr-douyin`：MV3，`extension/manifest.json:4` version `0.1.48`；permissions 含 `downloads`:11、`debugger`:13、`cookies`:16、`proxy`:28、`userScripts`:41（共 40 项）；`host_permissions: ["<all_urls>"]`:50；background `service_worker: kernel-worker.js`:53。
- 【事实】`fjzx.browser-bridge`：MV3，version `0.1.0`，permissions 仅 `["storage","tabs","userScripts"]`（`src/manifest.json:6`），background `background/service-worker.js`（`:9`）。全仓 grep `cookies|webRequest|declarativeNetRequest|fetch(` **零命中**——Bridge 目前**没有任何 cookie 或网络请求能力**，这是 issue #13 的硬约束。

### 4.2 现有"下发 JS → 页面执行 → 回传"契约（pr-douyin，issue #13 的同类先例）

- 【事实】实现 `server/browser-runtime/script-runtime.js`；契约文档 `docs/backend-scripts.md:1-70`：`POST /v1/commands {action:'script', id/version/source/timeoutMs/params}`；脚本是异步函数体，可用 `api.params`、`api.chrome('ns.method',...)`、`api.cdp('Domain.method',params)`、`api.log`、`api.sleep`、`api.onCleanup`；默认 15s（100–60000ms）；源码 ≤200000 字符、结果 ≤200000；**不同标签页并行上限 3，同标签页严格 FIFO**；正在采集的标签页拒绝脚本（409 `script_target_busy`，`docs/backend-scripts.md:52`）。

### 4.3 启动浏览器 / 加载扩展的 harness（可复用文件与参数）

- 【事实】最可复用的一份：`server/scripts/lib/native-edge-test.mjs:10-33`，`launchNativeEdge(profile, extension, executablePath)`：
  `--user-data-dir=<profile>`、`--remote-debugging-port=0`、`--no-first-run`、`--no-default-browser-check`、`--password-store=basic`、`--use-mock-keychain`、`--disable-features=msEdgeUpdateLaunchServicesPreferredVersion,msForceBrowserSignIn`、`--disable-extensions-except=<ext>`、`--load-extension=<ext>`、`about:blank`；从 `<profile>\DevToolsActivePort` 读临时端口（`:18`），CDP 找 URL 以 `/kernel-worker.js` 结尾的 `service_worker` target（`:25`），attach 后 `Runtime.evaluate`（`:29`）。**换成 Bridge 时只需把 SW 匹配串改为 `/background/service-worker.js`。**
- 【事实】Playwright 系骨架共 20 个（`server/scripts/test-*-browser.mjs`），统一模式 `chromium.launchPersistentContext(<root>/profile,{headless:true,executablePath:process.env.CHROMIUM_EXECUTABLE,args:[--disable-extensions-except=, --load-extension=]})`，例：`server/scripts/test-runtime-kernel.mjs:21`、`server/scripts/test-script-parallel-browser.mjs:56-61`、`extension/tests/script-browser.mjs:10`。
- 【事实】浏览器可执行解析：`server/src/platform.js:95-96`（系统 Chrome 路径表）、`:122-130`（优先 `CHROMIUM_EXECUTABLE`，其次 `CHROME_EXECUTABLE`/`EDGE_EXECUTABLE`，找不到则报错并列出搜索位置，不静默回退）。
- 【事实】Chrome for Testing 的实测启动记录：`logs/pr10-chrome-for-testing.json:3-4` — `executablePath = C:\Users\shaoning\chrome\win64-153.0.8010.52\chrome-win64\chrome.exe`，`profile = D:\nodejs\com.fajiezhixin.pr-douyin\logs\pr10-chrome-for-testing-profile`（两者本机均存在）；文档记录"独立测试配置，加载仓库原有扩展 0.1.48"（`docs/2026-09-17-chrome-target-selection.md:67`）。
- 【事实】**硬约束**：Chrome 137+ 官方 branded 构建（含 Edge）忽略 `--load-extension` 与 `--disable-extensions-except`，加 `--disable-features=DisableLoadExtensionCommandLineSwitch` 也无效（`docs/2026-09-12-browser-harness-load-extension.md:16-34`、`docs/scripts.md:52`、`docs/backend-scripts.md:103`）。**`CHROMIUM_EXECUTABLE` 必须指向 Chromium 或 Chrome for Testing**；真实采集浏览器是正常安装扩展，不受影响（同文 `:40,46-50`）。
- 【事实】端口与凭据：正式服务默认 `PORT=43118`（`server/src/config.js:24`，验收脚本硬编码 `http://127.0.0.1:43118`，`server/scripts/verify-target-selection-chrome.mjs:11`）；脚本凭据读 `data/service/capability-token.txt`（同文件 `:10`）。
- 【事实】pr-dy 侧调研用的浏览器与会话口径："Chrome for Testing 153.0.8010.52 (headed), 1680x1120, ordinary session with a pre-existing ordinary Douyin cookie jar"（`pr-dy/docs/v0.9/research/user-profile-schema-discovery.samples.json:4`），复用本机已存在的普通浏览态 profile，**本机直连、无代理**（`pr-dy/docs/v0.9/research/user-profile-schema-discovery.md:27-28`）。
- 【事实】**代理在 pr-douyin 里没有任何实现**：全仓 grep `proxy` 只命中 `extension/runtime-kernel.js:177` 的 JS `Proxy` 对象与 `server/src/http.js:51` 的 HTTPS 反向代理校验。

---

## 五、对 Bridge 的最小契约诉求（消费方立场）

### 5.1 最少需要的字段

以"给定一个具体 URL，返回该 URL 的最小请求上下文"为唯一契约：

| 字段 | 必需性 | 理由（Service 侧用途） |
|---|---|---|
| `url`（原样，**含签名 query，不做归一化**） | 必需 | Service 用它做任务键；`media-assets.md:7` 明确"不删除 query、签名或鉴权参数" |
| `cookie`（可直接放入 `Cookie:` 头的字符串） | **条件必需** | 当前 Douyin 证据显示不需要；但若要支持确实需要登录态的 CDN，这是唯一有用形态。数组形式让 Service 自己拼也可以，但会增加两侧实现分歧 |
| `userAgent` | 必需 | 与 Cookie 同源同账号的一致性；Service 目前完全没设 UA（`media-download.js:64-68`） |
| `referer`（= 观察到该资源的页面 URL） | 必需 | Service 现在写死一个站点根 Referer（`media-download.js:65`），真实值更有依据 |
| `observedAt` | **必需** | Service 必须自己判"这份上下文是不是已经过期"；缺它就无法与 URL 的 `expiresAt` 对齐 |
| `profileId` / `collectorId`（上下文来自哪个浏览器/Profile） | 必需 | 出口一致性判定的最小依据（见 5.3） |
| `acceptLanguage`、`sec-ch-ua*` 等客户端提示 | 可选 | 只有出现真实失败样本后再加，避免能力面先于需求膨胀 |

Service **不需要** Bridge 返回：URL 是否可下载、是否过期、媒体类型、`kind`（video/image/audio）、`ownerType/ownerId`、sha256、文件大小。
依据：过期解析 Service 已自己做（`server/src/media-store.js:46-59`），类型只信响应 `Content-Type`（`docs/media-layer-rebuild-progress.md:349`），其余全是业务语义。

### 5.2 调用时机

- 【事实】现有链路是"观察即上报、入池即下载"（`page-submission.js:314-342` → `repository.js:371-388` → `media-download.js`）。
- 诉求：Service 在**拿到新观察到的 URL 之后、真正发起下载之前**请求上下文；**批量请求**（一个作品一次，含 N 个 URL）优于逐 URL 一次——因为一次作品观察会同时产生视频+图集+音频（`page-submission.js:336-342`）。
- 诉求：**不要在 URL 已过期后才来要上下文**。Service 已经能从 `expiresAt` 判过期（`media-store.js:48-59`），过期时正确动作是回浏览器重新观察（`needs_resign`），而不是要上下文。

### 5.3 错误处理诉求

- 明确的失败码，且能区分：无 Work Tab / Work Tab 不在目标 origin / 该 URL 取不到上下文。**不要用空对象或空字符串表示失败**——Service 侧已经吃过"静默丢弃"的亏：服务端白名单比浏览器窄导致音频整整一轮全丢且无任何日志（`docs/media-layer-rebuild-progress.md:310-331`）。
- 每次返回必须带 `observedAt`；Service 自己判过期，**Bridge 不代判**。
- **重定向**：Service 下载器用 `redirect:'follow'`（`media-download.js:66`）。跨主机重定向时 Cookie/Referer 是否跟随，属 **Service 的下载策略**，不需要 Bridge 管；但 Bridge 不应在契约里暗示"上下文对所有跳转目标都有效"。
- **代理出口 IP 一致性**：这是本次调研**唯一必须补的规格缺口**。pr-dy 已定"Execution Profile 固定绑定 Operator + Proxy + BrowserProfile"（`pr-dy/docs/requirements/01-browser-execution.md:5`），但 pr-douyin **没有任何代理实现**（见 4.3 末条）。若浏览器与 Service 后端出口 IP 不同而 CDN 做 IP 绑定，**Cookie 也救不了**。当前【未找到证据】表明 Douyin CDN 做 IP 绑定，因此这项目前是**规格要求，不是已验证需求**。

---

## 六、风险清单：这个能力最容易被误用/滥用成什么样

1. **Bridge 变成通用 cookie 导出器（最高风险）。** 一旦为"取上下文"给 Bridge 加 `cookies` 权限，任何 Service 脚本都能枚举全网 cookie。Bridge 当前 manifest 只有 `storage/tabs/userScripts`（`src/manifest.json:6`），加 `cookies` 是**不可逆的能力扩张**。缓解：只能按"Work Tab 当前页面 origin / 该 URL 的 origin"取，不提供按域名枚举、不落盘、不缓存。
2. **把"取上下文"和"下载"耦合在一起。** 一旦 Bridge 顺手做下载/转发，就会长出重试、分片、磁盘、并发策略，Bridge 立刻变成业务执行器。**现成反面教材**：pr-douyin 早期"浏览器下载 + 服务端票据/认领/磁盘预留"体系，单集合膨胀到 259,712 条票据（放大 173 倍、无 TTL）、同一 URL 最多 1003 条票据（`docs/unified-download-pool.md:258-299`），最终整套废弃（`docs/media-layer-rebuild-progress.md:46-47,140`）。
3. **把平台语义写进 Bridge。** 例如把 `MEDIA_HOSTS` 白名单（`server/src/media-store.js:28-32`）搬进 Bridge，就是平台 Adapter。pr-douyin 已有教训：两侧白名单不一致导致静默丢数据（`docs/media-layer-rebuild-progress.md:310-331`），现在的处置是**白名单留在 Service，Browser 侧只做"离页面最近的上下文判断"**。
4. **"媒体上下文"被扩展成"通用鉴权代理"。** 从"取某个媒体 URL 的 Cookie"滑向"用浏览器会话去拉取任意需要登录的接口内容"，等于把 Bridge 变成绕登录通道——这与 `pr-dy` 关于 Bridge 不承担业务解释的红线（`pr-dy/docs/requirements/04-command-runtime.md:11-13`）直接冲突。
5. **Service 侧反向误用：拿到 Cookie 就默认加。** 现有证据是 Douyin CDN **不需要** Cookie（`docs/unified-download-pool.md:25-28`）。若无条件带上浏览器 Cookie，可能引入"cookie 账号与签名 URL 不匹配 → 403/风控"的新失败模式，且目前**无任何证据**支持收益。正确做法是把它做成按需、可观测、可回退的能力。

---

## 七、明确【未找到证据】的清单

- Douyin CDN 是否校验 Referer / 是否有防盗链白名单（反向证据：带不带 Referer 都 200，`docs/unified-download-pool.md:25`）。
- `media_fetch_http_403`（9/416）的具体成因（`docs/2026-09-13-watch-monitor-defects.md:35,38,113`）。
- CDN 是否要求 User-Agent 与浏览器一致。
- CDN 是否做出口 IP 绑定。
- `Referer: https://www.douyin.com/`（`media-download.js:65`）是否真的必需——无测试、无文档。
- m3u8 / HLS 形态的媒体资源（全仓零命中）。
- pr-dy 侧任何媒体下载实现或接口定义（只有 schema 占位）。
- pr-douyin 侧任何代理/出口 IP 实现。

---

## 对 Bridge 的通用化要求

1. **契约是"URL → 请求上下文"，不是"作品 → 媒体"。** Bridge 侧字段里不得出现 `workId`、`ownerType`、`kind`、`position`、"作品/评论"等任何平台概念；这些只存在于 Service（`page-submission.js:314-342` 的 `mediaId` 构造即平台侧语义，必须留在 Service）。
2. **不出现任何域名、CDN 名单、平台名。** 白名单与严格性只能加在 Service 与 Service 自己下发的脚本里（pr-douyin 现行不变量：严格性只加在离页面最近的一侧，`docs/media-layer-rebuild-progress.md:328`）。
3. **不做 URL 解析/归一化/过期判定。** 签名格式与寿命是平台知识（`media-store.js:46-59`、`media-layer-rebuild-progress.md:391-407`），Bridge 只回原样 URL 与 `observedAt`。
4. **不做下载、重试、退避、并发、分片、磁盘。** 这些是 Service 的下载策略（`media-download.js`）。
5. **不判断"能不能下"、"该不该带 Cookie"。** 这是 Service 的策略决策；Bridge 只提供事实（有哪些上下文可用）。
6. **不引入业务状态机。** 没有 `needs_resign`、没有 SUCCESS/FAILED 业务判定，与既有 V1 立场一致（`docs/architecture-v1.md:67-73`）。
7. **不做长期缓存、不做 Job History、不建幂等。** 上下文是即时事实，过期即无意义；与 V1 的 Job 模型一致（`docs/architecture-v1.md:56-65`）。
8. **权限面按最小必要扩张，且要能证明必要性。** 若最终确需 Cookie，必须把"为什么只能由 Bridge 提供、Service 下发脚本为何做不到"写成证据（现有证据反而指向"Douyin 不需要 Cookie"）。在此之前，Bridge 保持零 cookie 能力是更符合需求事实的状态。
