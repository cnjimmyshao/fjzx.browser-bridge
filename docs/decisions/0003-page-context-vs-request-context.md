# Page Context 与 Request Context 分成两层

Status: ACCEPTED  
Recorded: 2026-09-24

依据：[Issue #25](https://github.com/cnjimmyshao/fjzx.browser-bridge/issues/25)（维护者已确认的分层与实现范围）、[Issue #13](https://github.com/cnjimmyshao/fjzx.browser-bridge/issues/13) 与 [PR #17](https://github.com/cnjimmyshao/fjzx.browser-bridge/pull/17)（调研、POC 与实测证据）、[Current 第 14 节](../current/architecture.md#14-page-context-与-request-context)。本 ADR 解释为什么这样分层；字段与错误码以 Current 为准。

## 背景

Service 在自己的 Node 后端重放一个请求时，需要知道"浏览器为这个 URL 保存了什么"（Cookie、HttpOnly、分区 Cookie、页面 UA 与 Referrer）。实验实现（PR #17）把这套信息做成一个按 `targetUrl` 取得的上下文，并讨论过是否让它随每个 `RESULT` 一起返回。

讨论后确定不能合并成一个"浏览器上下文"，因为两类事实的**对象不同**：

- "当前 Work Tab / 当前页面是什么"有唯一、稳定的对象，与任何资源 URL 无关；
- "针对某个 URL 要发什么 Cookie / 用哪个分区"没有 `targetUrl` 就没有唯一正确答案，也与当前页面可以完全无关。

## 决定

分成两层，各自有触发条件与消息：

1. **Page Context 随每个成功 `RESULT` 返回**
   - 只描述当前 Work Tab 的页面事实：`workTabUrl`、`userAgent`、`documentReferrer`、`documentId`。
   - 不含 Cookie，也不含任何 target-specific 字段；取样与 Cookie 无关，因此普通 EXECUTE 不触发任何针对目标 URL 的查询。
   - 取样发生在 Job 执行完成之后、RESULT 推送之前，由**一次**注入读取完成，因此四个字段必然来自同一个文档快照。
   - 取不到时用 `available:false` + `reason` 明确降级，不伪造字段，也不把成功的 Job 改写成失败。

2. **Request Context 继续独立按需取得**
   - 消息对 `GET_REQUEST_CONTEXT` / `REQUEST_CONTEXT`，`targetUrl` 必填。
   - Cookie、HttpOnly、CHIPS 分区、host 覆盖范围、页面 UA / Referrer 都属于这一层。
   - 不占 Job 槽、`RUNNING` 期间照常服务、不与 `USER_SCRIPTS_UNAVAILABLE` 联动：读取浏览器事实从不执行 Service JavaScript。
   - 自带一套错误码，不扩展 V1 的 `ERROR_CODES`；两种能力都不引入任何网站或业务语义。

## 影响与边界

- Service 不需要为了知道"现在在哪个页面"而额外发一次请求，也不会因为想要页面事实而顺带拿到 Cookie。
- Bridge 需要新增 `scripting` 与 `cookies` 两个权限。权限只用于这两层事实的读取，且 Cookie 读取始终限定在一个明确 URL 上（不使用 `getAll({})` / `getAll({domain})`），不持久化、不写日志、不导出整个 Cookie 库。
- 这两层都只回答"浏览器里有什么"，不回答"这个请求应该怎么发"：SameSite 与第三方拦截不参与读取，是否需要、如何重放仍由 Service 决定。
- 传输层指纹与出口 IP 不在 Bridge 能力范围。

如果未来需要"多个 Work Tab 各自的页面事实"或"不需 `targetUrl` 的 Cookie 查询"，应作为新的架构变化处理，而不是把 target-specific 数据塞进 Page Context。

当前行为以 [Current](../current/README.md) 为准。
