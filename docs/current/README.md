# 当前技术 Contract

Current Version: V1

当前架构与协议见 [architecture.md](architecture.md)。它由原 `docs/architecture-v1.md` 原样迁入，保留原文和章节；本次文档组织不改变版本、接口、执行 world、权限、状态机、Work Tab 或 Service 职责。

开发及 POC 操作见 [开发说明](../development.md)，证据与未决限制见 [Research](../research/README.md)。后者记录已有观察，不代表本次重新测试，也不自动修改本目录的 Contract。

## 阅读边界

- Bridge 仍是通用、无网站业务语义的 Extension；本目录不承载调用方的实体、任务调度或业务验收规则。
- 已有代码或一次 POC 通过，不等于某项新能力已正式进入 Current；协议变化必须有明确决定并落实到相应文档、实现与验证。
- 当前文档并非承诺历史 POC 覆盖了全部运行环境。浏览器生命周期、长期可达性和新增权限需按任务取得相应证据。

## 整理时保留的待澄清点

这些是既有材料间的边界，不在本次整理中代作技术决定：

- **metadata：** 架构原文称其为“Service 透传信息；Bridge 不解释”，原 README 则说明仅接收、不解释、也不转发。`RESULT` 示例没有该字段。本次保留原 Contract 与既有实现说明，不新增回传承诺；需要依赖 metadata 流向的任务应先明确其语义。

决定形成后按 AGENTS 的交接规则同步 Current；此处不是另一套维护者决定记录。

## 已落地的决定

- **MV3 空闲可达性与 KEEPALIVE：** #9 报告空闲回收，#18 报告 20s KEEPALIVE 的候选 POC，维护者同意了「Service 每 20 秒发送 `{"type":"KEEPALIVE"}`、Bridge 只识别并保持沉默」的方向（[ADR 0001](../decisions/0001-service-keepalive.md)）。该机制已按 §3.1 / §8.7 写入本目录，并有实现、Node 回归与真实浏览器证据。它**不**承诺唤醒已回收的 worker，也不覆盖浏览器退出、休眠或网络中断；实测环境与未覆盖项见 [Research](../research/README.md)。
