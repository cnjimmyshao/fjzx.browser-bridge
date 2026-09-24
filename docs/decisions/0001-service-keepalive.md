# ADR 0001：由 Service 维持 Bridge WebSocket 活动

日期：2026-09-23。状态：**维护者已同意方向，机制已实现并有当前版本真实验证**；本文件记录取舍，不代表维护者已验收或允许合并。

## 依据与决定

#9 记录 MV3 Service Worker 空闲回收使连接及重连 timer 一并消失的问题。#18 的外部 POC 报告建议由 Service 每 20 秒发送一次 KEEPALIVE，无需 ACK。维护者同意优先按此最小方向落实；正式范围与批准来源见 [#9 的确认评论](https://github.com/cnjimmyshao/fjzx.browser-bridge/issues/9#issuecomment-5797484474)，POC 交接见 [#18 的回复](https://github.com/cnjimmyshao/fjzx.browser-bridge/issues/18#issuecomment-5797489118)。

Service 在既有 WebSocket 上每 20 秒发送 `{"type":"KEEPALIVE"}`，发送循环与连接生命周期绑定。Bridge 不回 ACK、RESULT 或 STATUS，不占 Job 槽，不改变 IDLE/RUNNING/NOT_READY，不读写 Work Tab 绑定，不保存历史；仅为保持浏览器接收消息活动。每条 Service 连接仅一个发送循环，断开或发送失败时清理，重新连接后恢复。Bridge 不新增自发保活 timer、alarms、offscreen、Native Messaging、健康评分或 Job 重试机制。

显式识别并静默处理 KEEPALIVE 是本轮采用的普通实现方式，避免长期依赖 UNKNOWN_TYPE 警告路径；不另设业务状态或应答协议。

## 理由及限制

Chrome 官方说明自 116 起，收发 WebSocket 消息会重置 Extension Service Worker 的空闲计时；[官方示例](https://developer.chrome.com/blog/chrome-116-beta-whats-new-for-extensions#websocket_support_in_service_workers)使用小于 30 秒的 20 秒周期。采用 Service 发送不意味着浏览器自身发送在技术上不可能，而是本项目已确认的职责分配。

复位发生在**收到消息**时，而不是在 Bridge 处理完这帧之后。因此 KEEPALIVE 不需要任何处理时限保证，也不需要绕过入站帧共用的就绪等待；这是它被实现为「识别后立即返回」而不是一条独立快路径的原因。

KEEPALIVE 维持的是已有连接的活动，不是唤醒已终止 Worker 的通道，也不是连接健康检查。浏览器退出、系统休眠、网络中断或异常终止不在此机制的在线保证内；不承诺离线期间保存或重放 RESULT/Job。恢复仍由现有连接逻辑及 Service 的浏览器监督职责承担，不顺带批准新恢复方案。

#18 的原始报告基于 `eab69a2` 的扩展副本，原脚本和结果位于执行者外部工作目录，本轮未重算其数字。旧报告中的实测与绝对性表述按来源保留，本 ADR 不将其扩大成跨环境保证，也不把旧报告当作当前版本的验证。

## 落地与验证

Current 已按 §3.1（空闲回收与保活机制）与 §8.7（KEEPALIVE 帧）同步；实现见 `src/lib/protocol.js` 与 `src/lib/bridge-state.js`，Node 回归见 `tests/protocol.test.js`、`tests/bridge-state.test.js`。

真实浏览器验证入口为 `npm run poc:keepalive`（= `node tests/poc/keepalive-poc.mjs`），覆盖 #18 的 A–F 场景并另加 G（Service 断开与重连）：基线回收、≥10 分钟保活、长空闲后 GET_STATUS/EXECUTE、停止保活后的回收、RUNNING 与 NOT_READY 无干扰、发送循环清理与重连恢复。生命周期测量窗口不附着 Worker DevTools，也不以持续 GET_STATUS 等额外活动替代被测保活。

结果、环境与未覆盖项见 [Research：当前版本 KEEPALIVE 实测](../research/2026-09-23-keepalive-verification.md) 与 [evidence/keepalive-poc.json](../research/evidence/keepalive-poc.json)。本次为单一 Chrome for Testing 版本、单一 Windows 机器、headless 模式下的结果。

## 收尾

#18 按可复现 POC 与证据完整性验收；#9 按正式实现及当前运行结果验收。仅有本 ADR、旧测试报告、PR 或 Review 无 Finding 均不等于完成。合并与关闭 #9/#18 需要维护者验收，本文件不授予该权限。
