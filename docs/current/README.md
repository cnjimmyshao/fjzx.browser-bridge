# 当前技术 Contract

Current Version: V1

当前架构与协议见 [architecture.md](architecture.md)。它由原 `docs/architecture-v1.md` 迁入，第 1–13 节保留原文与措辞；迁移本身不改变版本、接口、执行 world、权限、状态机、Work Tab 或 Service 职责。第 14 节是 [Issue #25](https://github.com/cnjimmyshao/fjzx.browser-bridge/issues/25) 正式化的 Page Context 与 Request Context，其取舍见 [Decision 0003](../decisions/0003-page-context-vs-request-context.md)，实测依据见 [Research](../research/2026-09-24-page-request-context.md)。

开发及 POC 操作见 [开发说明](../development.md)，证据与未决限制见 [Research](../research/README.md)。后者记录已有观察，不代表本次重新测试，也不自动修改本目录的 Contract。

## 阅读边界

- Bridge 仍是通用、无网站业务语义的 Extension；本目录不承载调用方的实体、任务调度或业务验收规则。
- 已有代码或一次 POC 通过，不等于某项新能力已正式进入 Current；协议变化必须有明确决定并落实到相应文档、实现与验证。
- 当前文档并非承诺历史 POC 覆盖了全部运行环境。浏览器生命周期、长期可达性和新增权限需按任务取得相应证据。

## 整理时保留的待澄清点

这些是既有材料间的边界，不在本次整理中代作技术决定：

- **MV3 空闲可达性：** #9 报告空闲回收，#18 报告 20s KEEPALIVE 的候选 POC。既有架构仍列四种核心消息；不能把 Research 中的建议自动当成已经批准的正式协议。证据、观测干扰和复现限制见 [浏览器观察整理](../research/2026-09-23-existing-browser-evidence.md)。相关技术任务继续独立处理。
- **metadata：** 架构原文称其为“Service 透传信息；Bridge 不解释”，原 README 则说明仅接收、不解释、也不转发。`RESULT` 示例没有该字段。本次保留原 Contract 与既有实现说明，不新增回传承诺；需要依赖 metadata 流向的任务应先明确其语义。

决定形成后按 AGENTS 的交接规则同步 Current；此处不是另一套维护者决定记录。
