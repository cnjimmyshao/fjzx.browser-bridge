# Bridge、Service 与 Service Script 的职责边界

Status: ACCEPTED  
Recorded: 2026-09-24

依据：[V1 父 Issue #1](https://github.com/cnjimmyshao/fjzx.browser-bridge/issues/1) 与 [Current V1：定位和职责边界](../current/architecture.md#2-职责边界)。本 ADR 在 2026-09-24 将既有 V1 Contract 的核心取舍单独记录，**不是新的协议批准，也不改变 Current**。

## 背景

Browser Bridge 同时处在 Service、浏览器 Extension API 与网页 DOM 之间。如果职责不清，后续实现很容易把平台 Selector、业务 Action、调度、重试或 Browser 生命周期逐步搬进 Bridge，导致通用桥接层演变成某个平台的业务 Runtime。

V1 因此需要一个稳定的责任分界，让新的 Agent 能判断“这个能力应该放在哪里”，而不是仅凭技术上能否实现决定归属。

## 决定

职责按三个层次划分：

- **Service** 负责 Browser executable / Process、BrowserProfile、Proxy、Initial URL、启动／停止／监督，以及 Scheduler、Queue、Operator、Quota、Command Definition、Selector、Action、Retry、Job History、Data Model 和业务状态判断。
- **Bridge** 负责 Service Connection、唯一 Work Tab、Current Job、USER_SCRIPT 执行、当前技术状态以及 Extension 自身生命周期。
- **Service JavaScript** 负责当前页面的 DOM 查询、读取、点击、输入、滚动、等待、观察以及采集返回数据。

概括为：

> 浏览器环境归 Service；浏览器内部桥接归 Bridge；页面 JavaScript 能完成的事情归 Service Script。

Bridge 保持独立、通用、轻量、无网站业务语义，不建立 Douyin/Bilibili 等平台 Adapter，也不解释 Like/Comment/Report、Captcha、BLOCKED、Login、Risk Control 等业务概念。

## 影响与边界

这项分工不意味着 Bridge 永远不能增加能力。只有当 USER_SCRIPT 无法完成、Extension API 能完成并出现真实通用需求时，才考虑增加最小 Browser Capability；新增能力仍需按 Current / Issue / Decision 流程确认。

“Service 负责业务恢复”也不等于 Bridge 可以忽略自身必须保证的协议校验、技术执行隔离、当前 Job 并发控制和真实 Extension 生命周期问题。简单化不能把实际技术责任推给调用方。

当前行为始终以 [Current](../current/README.md) 为准；后续职责调整若获批准，应同步 Current，并用新的 ADR 说明替代关系。
