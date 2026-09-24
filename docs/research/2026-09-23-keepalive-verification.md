# 当前版本 KEEPALIVE 实测（issue #9 / #18）

- Date：2026-09-23（运行跨越午夜，结束于 2026-09-24 凌晨），本次实测日。
- Keywords：Chrome、MV3、Service Worker、WebSocket、KEEPALIVE、生命周期、DevTools。
- Status：**当前 head 的新实测**，不是既有报告转述。原始证据见 [evidence/keepalive-poc.json](evidence/keepalive-poc.json)。
- 相关：[ADR 0001](../decisions/0001-service-keepalive.md)、[Current §3.1 / §8.7](../current/architecture.md#31-mv3-空闲回收与-service-保活keepalive)、[既有观察整理](2026-09-23-existing-browser-evidence.md)。

## 问题与验收范围

Bridge 依赖 Service 能向既有 WebSocket 随时 push `EXECUTE`。既有报告（#9）显示 MV3 Worker 空闲约 30s 被回收，socket 与重连 timer 一同消失。ADR 0001 因此决定由 **Service 每 20s 发送 `{"type":"KEEPALIVE"}`**。

本报告回答的问题：在**当前 head 的真实扩展**上，这条机制是否真的维持可达性，以及它在 RUNNING / NOT_READY / Service 断开 三种情况下是否有副作用。#18 的 A–F 场景由 `npm run poc:keepalive` 覆盖，本报告另加 G（Service 断开与重连）。

## 环境与提交

| 项 | 值 |
| --- | --- |
| 浏览器 | Chrome for Testing 153.0.8010.52，`--headless=new --disable-gpu` |
| OS | Windows 10.0.26200 x64 |
| Node | v26.7.0（项目要求 >= 22） |
| 扩展 | 本仓库 `src/` 直接加载，无打包 |
| 提交 | 实现与测试在 `d734d9f`；证据文件在 `3907d8c` 之后的提交里，那些提交只改 `docs/`、以及收紧 harness 断言本身，未改 `src/`。证据文件的 `commit` / `workingTreeDirty` 记录运行当时的 HEAD 与工作区状态，据此可核对它跑的就是 `d734d9f`。 |
| 测试 Service | `tests/poc/service.mjs`，真实 TCP WebSocket |
| 测试页面 | 本机静态页（`tests/poc/page-server.mjs`） |
| 独立 Profile | 每次运行新建，运行结束删除 |

一条命令可重复：`npm run poc:keepalive`。

## 方法

- Worker 存活只读 `CDP /json/list` 元数据，**全程不附着 Worker DevTools**。既有报告已给出反例：附着 CDP Runtime 会让窗口内不被回收，即观测方式本身改变被测对象。
- 保活窗口内**唯一的 WebSocket 流量是 KEEPALIVE 循环**。`GET_STATUS` / `EXECUTE` 探针在窗口结束后才运行，不用额外活动代替被测机制。
- 基线先跑，且被要求必须复现回收：基线不复现说明窗口太短或环境不同，运行会失败而不是报一个无意义的 PASS。
- 唤醒被回收的 Worker 只用真实设置页写 Service URL（一次指向死端点、再指回本 Service），并记录唤醒后的重连耗时；不依赖内部 API，也不假装 KEEPALIVE 能唤醒已死 Worker。

## 结果

场景 A–G 全部通过：**7/7 场景、29/29 断言，总耗时 780.5s**。数值以证据文件为准，下面记录可复核的结论。

| 场景 | 结果 |
| --- | --- |
| A 基线（无 WebSocket 活动） | 连接后 **30.9s** Worker 被回收，socket 在同一采样点断开（`service_worker` target 1 → 0），窗口内无重连。 |
| B 20s KEEPALIVE ≥ 10 分钟 | 窗口 **600.7s**：投递 **31** 次、相邻间隔 **20.006–20.016s**、回收 **0** 次、socket 全程 OPEN，并且这 31 次投递换来 **0** 条 Bridge 回帧——窗口内唯一的 WebSocket 流量就是 KEEPALIVE，Bridge 一帧都没有回。窗口起点的重连计数为 2，都来自此前唤醒 Worker 的两次设置页写入（每次约 0.25s 恢复）。 |
| C2 长空闲后探针 | `GET_STATUS` 得到 `STATUS`（IDLE），无副作用 `EXECUTE` 得到 `RESULT ok=true`。 |
| D 停止 KEEPALIVE | 停止后 **31.0s** Worker 被回收；距最后一次投递 **31.6s**，与 A 的基线同一量级。 |
| E RUNNING 期间 KEEPALIVE | 45s Job 期间确实投递了 2 次周期性 KEEPALIVE，全程 `RUNNING` + 原 `jobId`，未出现 `BUSY`，也没有无 `jobId` 的 `RESULT`；原 Job 正常结束。 |
| F NOT_READY 期间 KEEPALIVE | 无 Work Tab（`WORK_TAB_CLOSED`）与多 Work Tab（仍为 `MULTIPLE_TABS`）两种情况下状态与 reason 都不变，未创建或代选 Tab，socket 仍可达。 |
| G Service 断开 | `stop()` 后发送循环已清理、进程内无残留周期定时器；Service 离线 12s 期间 Worker 未被回收，重启后 Bridge **11.1s** 重连，保活恢复投递且仍只有一个循环。 |

本报告采用 `d734d9f` 上这一次完整运行（780.5s）作为证据。同一天还完整跑过 A–G 三次（`5ab9579` 一次、`11ebd13` 两次，其中较早一次只用于排查 harness 自身缺陷）：基线回收时间稳定在 30.8–30.9s，停止保活后的回收时间同为 30.8–31.0s，Service 恢复后的重连耗时 11.1–13.2s，保活窗口内回收每次都是 0 次。

### 测量过程本身被记录下来的地方

`d734d9f` 之前一版 B 场景用的期望次数是 `floor(窗口/20)`，在 600s 窗口上要求 t=600 那一帧也被计入——而它按定义落在窗口之外。该版本因此以「29 次投递」判失败，同时暴露了退出码修复确实生效（失败不再返回 0）。现在的写法改为同时检查两件真正要保证的事：**相邻投递间隔**（实测 20.006–20.016s）与**次数是否覆盖窗口**（31 ≥ 30），并把 min/max gap 记入证据文件。

## 限制与未覆盖项

- KEEPALIVE 只维持**尚存活连接**的消息活动。浏览器退出、系统休眠、网络中断、Worker 已被回收都不在保证范围内；本报告不扩大 ADR 0001 的结论。
- 若 Service 离线时间超过 Worker 空闲窗口，重连 timer 随 Worker 一起消失，Service 恢复后不会自动重连（既有 #9 问题）。G 场景默认把离线时间设在空闲窗口**以内**，因此它验证的是重连后保活恢复；若实际发生回收，POC 不会把它算成通过。
- 单一 Chrome 版本、单一 Windows 机器、`headless=new`。headed 模式与其它 Chrome 版本是否同样回收未在本次验证。
- 只使用本机地址、本机测试页与独立 Profile；没有真实站点、真实账号或真实业务 Job 参与。
- `--phases` 只接受依赖完整的子集（C2/D 需要 B，F/G 需要 E），否则启动前直接拒绝：依赖不全的子集可能跑出「一条 KEEPALIVE 都没发却显示通过」的结果。
- 验证运行时工作区里还有未提交的文档与 harness 改动（`docs/`、`tests/poc/keepalive-poc.mjs`），`src/` 与 `package.json` 相对 `d734d9f` 是干净的；证据文件里的 `workingTreeDirty` 就是这份清单。
- E 场景的 Job 只跨越**两次**周期性投递，即刚好满足「跨多个周期」；没有测更长 Job 或更多帧的组合。

## 证据文件里看不到的东西

- `npm run poc` 的 15/15 结果只在运行日志中，JSON 证据文件只覆盖保活场景。
- Worker 存活只有一个布尔信号（`service_worker` target 在不在）。不附着 DevTools 就只能观察它的存在，看不到内部计时器、Pending 事件或回收原因。
- 唤醒被回收的 Worker 依赖真实设置页写入；这是操作者动作，不是机制本身的一部分。

## 对 Contract 的影响

本次实测支持把 §3.1 / §8.7 记录的 KEEPALIVE 作为已落地机制：它维持了连接活性，并且在 RUNNING / NOT_READY / 断开恢复三条路径上没有副作用。它不改变四种核心应答消息，也不新增 Bridge 侧 timer、健康检查或重试。

同一 revision 上另跑了 `npm run poc`（= `node tests/poc/run-poc.mjs`）：V1 的 **15/15 个场景全部通过**，说明这次为修 harness 而改的 `tests/poc/browser.mjs` 与 `tests/poc/service.mjs` 没有影响既有 V1 链路。该结果只在运行日志里，没有写进本报告的 JSON 证据文件。

观测细节、时序与未覆盖项以 [evidence/keepalive-poc.json](evidence/keepalive-poc.json) 为准；本报告不替代该文件，也不替维护者作出合并或关闭 #9/#18 的决定。
