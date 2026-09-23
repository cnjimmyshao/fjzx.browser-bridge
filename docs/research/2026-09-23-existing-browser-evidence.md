# 既有浏览器观察与 KEEPALIVE 来源整理

- Date：2026-09-23，文档整理日，不是一次新的实测日期。
- Keywords：Chrome、MV3、userScripts、WebSocket、KEEPALIVE、DevTools。
- Status：既有执行者报告整理；本次没有重跑浏览器，也未取得外部工作区原始日志。
- 来源：本仓库 `d0d7f28ca65ab2403d74fe72269e3871ecf8bc11` 的 README / 架构文档，[Issue #9](https://github.com/cnjimmyshao/fjzx.browser-bridge/issues/9)，[Issue #18 结果评论](https://github.com/cnjimmyshao/fjzx.browser-bridge/issues/18#issuecomment-5763192739)。下列数字属于原报告，不是本次测量或独立核验。

## 为什么调查

Bridge 依赖 Service 能向既有 WebSocket 发送执行请求。早期实测发现空闲后 Worker 被回收，连接与内部重连 timer 一同消失，需要区分连接故障恢复与 Worker 生命周期问题。另一些 API 观察决定了既有执行信封、权限和就绪检查。

## 既有 userScripts / 权限观察

原 README 报告在 Chrome for Testing 153.0.8010.52 观察到：脚本抛异常或语法错误时 userScripts.execute() 可能 resolve 为 result:null，无法仅凭此值区别显式 return null；因此采用 Bridge 内部执行信封。原文还记录主框架消失错误 `Frame with ID 0 was removed.`、目标 host 权限要求、tabs 权限对于内部页识别的作用，以及 MAIN world 可用但不属于当前开放范围。

上述内容已经记录在既有 [Current 第 5.1 节](../current/architecture.md#51-实现约束已由真实浏览器验证)。这里不扩大浏览器兼容范围，也不重新批准 MAIN world。Allow User Scripts 与自动加载扩展的版本/发行渠道行为在新环境仍需核验。

## 空闲回收：原始问题报告

Issue #9 的环境为 Chrome for Testing 153.0.8010.52、headless=new、加载 src/，测试 Service 使用 tests/helpers/ws-server.js。原报告记录：+24.0s 连接、+54.1s 断开，其后 300s+ 无重连；CDP /json/list 中 service_worker target 数为 0。一次 storage.onChanged 后 target 恢复为 1 并在约 1s 内重连，再次唤醒后约 33s 又被回收。

同一报告的 Service 重启测试在 Worker 仍存活的窗口内能约 1s 恢复连接。这只能支持“活着的 Worker 可以重连”，不能推出“已经回收的 Worker 会被 Service 自行唤醒”。

## KEEPALIVE：已有 POC 的条件与结果

Issue #18 要求比较无活动 baseline、20s 周期消息、停止消息、RUNNING 与 NOT_READY 期间消息、Service 断开恢复，不修改网站业务或增加重试队列。

结果评论报告的环境：Chrome for Testing 153.0.8010.52；Windows 10.0.26200 x64；扩展为 eab69a2 的 src/ 只读副本；测试页面为本机静态页；工作在仓库外的 `D:\nodejs\fjzx-keepalive-poc`。

| 原报告场景 | 报告结果及限定 |
| --- | --- |
| A1 无消息，120s 窗口，不附着 Worker | 29.8s 被回收；对照窗口无 WebSocket 消息活动。 |
| A2 无消息，但附着 CDP / Runtime | 窗口内未回收，说明观察方式可改变被测对象。 |
| B 每 20s 单向 KEEPALIVE | 两次独立运行各约 10 分钟、29 次投递；报告 Worker 回收 0 次，socket 未断开。包括严格单向、不要求 ACK 的运行。 |
| C 停止 KEEPALIVE | 最后一次消息后 29.8s 回收；浏览器事件唤醒后恢复，不是 Service 把已回收 Worker 唤醒。 |
| D 45s Job | 跨两个周期，BUSY 与额外 RESULT 为 0；状态维持原 jobId，原 Job 正常结束。 |
| E NOT_READY | NO_WORK_TAB 与 MULTIPLE_TABS 各 90s，原状态和 reason 不变，没有代选 Tab。 |
| F Service 断开恢复 | 沿用已有重连逻辑，重连后发送循环恢复；报告无 timer 泄漏。 |

原评论还有“再静默 100s 后 GET_STATUS”的措辞，但同时明确停止所有 KEEPALIVE 会在约 29.8s 后回收；整理时不把前者解读成“停止所有 WebSocket activity 100s 仍保证在线”。该窗口是否继续保活应以原始日志核对，本文不依赖这个歧义数字扩大结论。

POC 中未知 KEEPALIVE type 走既有记录警告并忽略的路径；这是候选验证所使用的实现事实，不自动意味着它已经成为正式协议消息。

## 证据可访问性与复现限制

原评论给出的外部工作区命令是 `node poc/run-keepalive-poc.mjs`；证据名为 results/run-1-evidence.json、results/run-2-cd-evidence.json、results/run-3-unidirectional-evidence.json，另报告 verify-claims.mjs 的 48/48 校验。这些路径指向当时的外部工作区，不能在本仓库 checkout 中直接当作已存在的脚本/文件。

本次只迁入足以理解问题、条件与结论的记录，没有复制不存在的日志，也没有宣称独立复现。仓库已有 npm run poc 是另一条本地浏览器 POC 入口，不等同于这份长时间 KEEPALIVE 实验。

生命周期测试要记录是否附着 DevTools/CDP Worker、发送了什么消息及唤醒方式；否则“没有回收”可能只是观测干扰。敏感 Cookie、Header、真实 Profile 不应进入报告或仓库。

## 结论与 Contract 影响

已有报告支持在该环境下继续评估 Service 驱动的 20s KEEPALIVE；不证明所有版本/环境长期可达，不解决被回收之后的唤醒，也不授予重试有副作用 Job 的权利。

原结果仍提出两个选择：是否显式处理 KEEPALIVE，以及 20s 是否正式确定。文档整理不代作选择，不关闭 #9/#18；正式协议需按 Issue 的明确决定同步 Current、相关实现/注释与验证。旧报告保留为证据，新实验通过另一个有日期的报告增补或替代。
