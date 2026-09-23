# fjzx.browser-bridge

通用、轻量、无网站业务语义的 Chrome Browser Bridge。接收 Service 下发的 JavaScript，在专用 Profile 的唯一 Work Tab 中受控执行并返回技术结果。

## 从这里开始

- 做任务：[AGENTS.md](AGENTS.md) → 对应 Issue 正文及相关评论 → 开发分支与 PR；文档调整同样走该流程。
- 了解当前约定：[Current](docs/current/README.md) 与[架构协议](docs/current/architecture.md)。
- 加载、开发和测试：[开发与 POC](docs/development.md)。
- 查依据与历史：[文档分工](docs/README.md)、[Research](docs/research/README.md)、[Decision](docs/decisions/README.md)。

`src/` 是 Extension 根目录，无打包步骤；`tests/` 是本地测试与 POC，不随扩展加载。测试命令见 [package.json](package.json)。

## 历史入口导航

以下标题保留旧 README 的定位入口，具体内容只在相应文档维护。

## V1 核心模型

见 [Current](docs/current/architecture.md#2-职责边界)。

## V1 通信协议

见 [通信协议](docs/current/architecture.md#8-通信协议)。

## 当前阶段

当前任务进度在 Issue / PR 中以新增评论记录；不把旧 POC 的勾选或通过数量当成新提交的验证。已有观察见 [Research](docs/research/2026-09-23-existing-browser-evidence.md)。

## 协议与状态

见 [协议及状态](docs/current/architecture.md#8-通信协议)与[实现说明](docs/development.md#协议与状态)。

## 脚本执行

见 [执行约定](docs/current/architecture.md#5-javascript-执行)。

### 运行前的一次性设置

见 [开发说明](docs/development.md#运行前的一次性设置)。

### 错误如何映射

见 [错误与执行信封](docs/development.md#错误如何映射)。

## 仓库结构

见 [开发说明](docs/development.md#仓库结构)和[文档分工](docs/README.md)。

## 从全新 checkout 跑通 POC

见 [POC 操作](docs/development.md#从全新-checkout-跑通-poc)。

## Work Tab

见 [Work Tab](docs/development.md#work-tab)。

## 权限

见 [权限](docs/development.md#权限)。

## Service 连接

见 [Service 连接](docs/development.md#service-连接)。

### ⚠️ 已知限制：MV3 service worker 空闲回收

见 [带环境的历史观察与限制](docs/research/2026-09-23-existing-browser-evidence.md)。

## 开发

见 [开发与 POC](docs/development.md)。
