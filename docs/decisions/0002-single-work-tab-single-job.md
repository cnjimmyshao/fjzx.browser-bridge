# 唯一 Work Tab 与单一活动 Job

Status: ACCEPTED  
Recorded: 2026-09-24

依据：[V1 父 Issue #1](https://github.com/cnjimmyshao/fjzx.browser-bridge/issues/1)、[Issue #4：唯一 Work Tab](https://github.com/cnjimmyshao/fjzx.browser-bridge/issues/4)、[Issue #5：消息协议与状态](https://github.com/cnjimmyshao/fjzx.browser-bridge/issues/5)，以及 [Current V1：Browser Environment 与 Work Tab](../current/architecture.md#3-browser-environment-与-work-tab) / [Job 模型](../current/architecture.md#6-job-模型)。本 ADR 记录既有 V1 取舍，不改变协议。

## 背景

Browser Bridge 服务的是由 Service 管理的专用 Browser/Profile，不与人工日常浏览混用。V1 的目标是提供清晰、可观察的最小执行链路，而不是在 Extension 内建设多 Tab 调度器、任务队列或复杂恢复系统。

如果 Bridge 同时管理多个业务 Tab 或多个 Job，就需要额外引入目标选择、排队、并发写入、历史结果和重试等语义，并显著扩大状态机。

## 决定

V1 保持两个单一性约束：

1. **唯一 Work Tab**
   - Bridge 只按普通 Tab 的唯一候选绑定 Work Tab，不根据 URL、域名或平台语义猜测。
   - 无候选或多候选时进入相应 NOT_READY 状态；不会任选一个 Tab，也不建设 Tab Pool。
   - 同一个 tabId 内导航不改变 Work Tab 身份；Work Tab 被关闭后的恢复由 Service 决定。

2. **同一时间一个活动 Job**
   - IDLE 收到合法任务后进入 RUNNING。
   - RUNNING 时新的任务直接返回 BUSY，不排队、不打断当前 Job。
   - Job 完成后返回结果并回到相应当前状态。
   - Bridge 不建立 Job Queue、Job History、Completed/Failed Cache、Retry、幂等或 Exactly Once 机制。

## 影响与边界

该模型使“当前 Bridge 在做什么”始终可直接观察，也避免把 Service 的调度职责复制进 Extension。

连接恢复与 Job 恢复是不同问题：连接重新建立并不授权 Bridge 自动重放可能有副作用的任务。是否重新发起任务由 Service 根据业务状态决定。

如果未来出现已确认的多 Tab 或并行执行需求，应作为新的架构变化处理，而不是在现有单 Job 模型上逐步增加隐式队列和特判。当前行为以 [Current](../current/README.md) 为准。
