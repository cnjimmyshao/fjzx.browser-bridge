# 文档组织与权威

本仓库迁移的是通用协作和文档治理方法，不是任何调用方的业务模型。Agent 在本仓库内即可找到工作依据，不需要读取另一个项目才能开始开发。

## 去哪里找什么

| 入口 | 职责 |
| --- | --- |
| [AGENTS.md](../AGENTS.md) | 怎么工作：Issue、分支、PR、Review、授权、决策交接和收尾。 |
| [current/](current/README.md) | 当前架构与协议 Contract：系统现在应当保证什么。 |
| [decisions/](decisions/README.md) | 已接受的重要技术取舍：为什么这样设计。 |
| [research/](research/README.md) | 有时间、环境与来源的浏览器/API 实测证据：当时观察到什么。 |
| [development.md](development.md) | 如何加载、测试与运行 POC，以及既有实现说明；不是第二套协议。 |
| `archive/` | 已失效的 Contract / Requirements，仅历史追溯；有真实历史材料需要归档时再建立。 |

根 README 是项目与文档导航，Issue 是任务和决定的工作入口，PR 展示实际交付；长期内容按以上职责沉淀，不靠翻完历史聊天才能理解。

## 权威与变化

AGENTS 规定工作方法，Current 规定技术 Contract，二者不互相替代。已接受 Decision 解释取舍；代码与测试反映实际实现，可能落后于 Current。发现差异应按 Issue 范围补齐实现或提交有依据的变更决定，不以旧代码、旧测试或未接受的建议反向降低 Current。

Research 可以支持或质疑某个前提，但不能自动升级为 Contract。已确认的新决定影响长期协议或保障时，同一交付同步 Current；重要取舍同步 Decision。文档已经准确描述目标行为时，只核对一致性，不要求每次修复都制造文档改动。

Current 始终位于 `docs/current/`，不因版本升级另建 `docs/vX.Y/` 或 `current/vX.Y/`。当前逻辑版本以 [current/README.md](current/README.md) 的声明为准；维护者明确决定版本变化时才更新它，不随普通代码或文档修改自动 bump。此次迁移沿用既有 V1，不重新批准或升级协议；原架构的章节与措辞保留，避免移动文档时悄然改变技术含义。

历史 Contract 主要用 Git 追溯，确有需要时进入 Archive；Research 不因日期旧就移入 Archive，它本身是时间序列证据。新调查改变旧结论时，新建有日期的报告并标明替代关系，不覆盖历史观察。

文档移动时更新当前引用，并在必要的旧路径保留明确导航；不要长期维护两份可分别修改的完整 Current。链接、历史原话和日志要可追溯，不能为了统一术语或排版改写证据。

## 本次组织的来源

工作方法参考 `cnjimmyshao/fjzx.pr-dy @ 26a592f9a4aca0b368541764891235b04348b824` 的 AGENTS 和文档制度；技术内容来自本仓库 `d0d7f28ca65ab2403d74fe72269e3871ecf8bc11`，不是从 PR-DY 复制业务设计。此来源说明仅用于追溯，不构成运行时依赖或自动同步机制。
