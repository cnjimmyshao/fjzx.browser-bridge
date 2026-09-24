# Decision：已接受的重要技术取舍

这里回答“为什么这样设计”，不维护另一套当前协议。当前行为从 [Current](../current/README.md) 读取，决策过程和批准记录留在关联 Issue 的新增评论中。

只有重要且未来容易重新争论或误改的取舍才需要 ADR；普通实现选择不逐项申请批准，也不为每个小修复写一份设计论文。文件可采用 `0001-<topic>.md`，写清背景、已接受决定、理由、影响与限制、来源和被替代关系即可，不要求固定长模板。

未决提案留在 Issue 或 Research，并明确候选状态；不能因写进本目录就伪装成维护者已批准。既有架构无须为了建立目录补造历史批准日期或 ADR。此次补入的 ADR 是对既有 V1 Contract 的追溯性整理，`Recorded` 表示记录日期，不冒充原始批准日期。

## 当前 ADR

- [0001：Bridge、Service 与 Service Script 的职责边界](0001-bridge-service-responsibility-boundary.md)
- [0002：唯一 Work Tab 与单一活动 Job](0002-single-work-tab-single-job.md)
- [0003：Page Context 与 Request Context 分成两层](0003-page-context-vs-request-context.md)

这些 ADR 用来解释 Current 中已经存在、未来容易被重新争论的核心取舍；它们不另行定义消息字段、错误码、权限或实现细节。若 ADR 与 Current 出现冲突，以 Current 为当前 Contract，并按 Issue / Decision 流程修正冲突。

决定改变时保留旧决定的历史语义，链接新的替代决定，并同步受影响的 Current、代码和测试。仅添加 ADR 不代表实现、Review 或验收完成。
