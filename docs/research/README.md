# Research：带环境的调查证据

Research 回答“某个时间和环境下实际观察到什么”，不代替 [Current](../current/README.md)。本仓库关注浏览器、Extension API、权限、执行隔离和生命周期等通用事实，不承载调用方的网站业务模型。

报告使用 `YYYY-MM-DD-<topic>.md`。说明日期是实测日还是整理日，并提供问题与验收范围、相关浏览器/系统/提交、测试方法、证据、结果、结论、限制及 Contract 影响。字段可按任务需要简洁组织，不强制长模板。

报告应自包含：Issue 链接用于追溯，读者不必打开 Issue 才能知道测了什么、条件和结果。原始日志/脚本未归档时明确其位置与可访问性，不把本机路径伪装成仓库中可复现的命令。

区分实际新测、已有执行者报告和推断。没有取得原始证据或没有重跑时写明，不凭一次评论、Review clean 或文档迁移标成独立 VERIFIED。保留未测场景，不能把一个浏览器版本的结果推广到所有版本。

新证据推翻旧结论时新建报告并注明 Supersedes / Superseded By，旧报告不覆盖、不因年代旧而 Archive。候选方案通过实验不代表维护者已批准；必要的 Current / Decision 变化走 AGENTS 规定的交接流程。

## 索引

| 整理日期 | 报告 | 证据状态 |
| --- | --- | --- |
| 2026-09-23 | [既有浏览器观察与 KEEPALIVE 来源](2026-09-23-existing-browser-evidence.md) | 已有 README / Issue 报告整理；本次未重跑，外部原始日志未取得 |
| 2026-09-24 | [Page Context 与 Request Context：当前实现的真实浏览器验证](2026-09-24-page-request-context.md) | 本次实测（Chrome for Testing 153.0.8010.52 / Windows）；证据 `evidence/page-request-context.json` |
