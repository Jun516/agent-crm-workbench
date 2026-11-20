# Pi Runtime 消息状态与产品输出边界

本项目锁定 `@earendil-works/pi-agent-core` 和 `@earendil-works/pi-ai` 的 `1.3.0` 版本。消息类型见 `node_modules/@earendil-works/pi-ai/dist/types.d.ts`，循环接口见 `node_modules/@earendil-works/pi-agent-core/dist/types.d.ts`。CRM 适配实现位于 `lib/agent-runtime/pi/runtime.ts`。

| CRM 端口 | Pi 适配点 | 数据边界 |
| --- | --- | --- |
| `AgentRuntime.run` | `Agent.prompt` | CRM 传入任务、模型绑定、工具和取消信号；Pi 负责模型循环。 |
| `RuntimeTool.execute` | `AgentTool.execute` | CRM 工具许可与副作用政策在执行前检查；结果作为观察进入下一轮。 |
| `RuntimeMessage` | `AgentMessage` | `content` 只包含可见文本；`privateContinuation` 保存服务端续跑所需的原始 Assistant 内容块和 Provider 元数据。 |
| `AgentRuntimeEvent` | `AgentEvent` | 对外只暴露归一化生命周期；持久化产品事件另由 Workbench 写入。 |
| `RuntimeUsage` | Pi `Usage` | 输入、输出和缓存 Token 从 Assistant 消息累计；CRM 的成本归属仍以 `llm_calls` 为准。 |
| `AbortSignal` | `Agent.abort` | CRM 的取消状态由 Worker 观察并传播；发送队列仍在最终动作关口重新检查授权。 |

`privateContinuation` 仅写入服务角色可读的 `ai_agent_run_states.messages`。其中可含 Pi 的 `thinking` 内容块与签名，恢复时由 Pi 适配层还原；`RuntimeMessage.content`、`finalText`、Workbench 运行详情和产品事件都不得读取该字段。旧运行状态没有此字段时，适配层仍按原兼容路径恢复，但无法还原旧状态里已经丢失的 Provider 元数据。

Pi 在工具执行前等待 `tool_execution_start` 的订阅回调。Workbench 可以在该回调中复验租约，以阻止失去执行权的 Run 继续调用工具。每轮工具结果发出后，Pi 调用 `finishTurn`，CRM 在这里累计已完成轮次和 Token 用量，检查预算和停止策略。随后 Pi 等待 `turn_end` 回调及其回执。事件写入失败时，适配层终止本次调用并向调用方返回原始错误。

Workbench 自动写入后的继续执行，必须先采用本轮 `runtimeMessages`，再追加 CRM Harness 的执行观察，最后持久化。旧输入消息只代表进入本轮之前的上下文。回归测试覆盖两次连续写入和一次 JSON 持久化恢复；Pi 假 Provider 测试覆盖可见文本与私有思考分离及签名恢复。

恢复时，CRM 本次传入的 `systemPrompt` 是当前系统基线。Pi 1.3.0 初始化时优先采用历史消息开头的 system，因此适配层复制历史并更新首条 system 的文本。后续补充 system 指令、用户和工具历史及 Assistant 私有 continuation 都保留，当前工具集合及 schema 继续由 Pi 声明。没有首条 system 的旧记录和首次运行由 Pi 建立基线。显式空 prompt 会清除旧基线，重复恢复使用当次政策。

Workbench 在恢复前重新读取当前发布的组织记忆，而非冻结首次运行时的政策。`run-resumed-workbench-turn.test.ts` 的真实 Pi + 官方 faux provider 回归核对：模型实际收到的记忆 revision 与 `context_loaded` 事件一致，随后保存的 messages 使用同一基线。数据库 transport 和模型 gateway 为受控替身；此测试没有连接真实 Supabase 或外部模型，不代表真实 Key 端到端验收。

后续若要把结果改成结构化提交，提交格式应至少包含结论、证据定位、已执行动作、待确认动作、缺失信息和下一次唤醒条件。当前 `extractProductFinalAnswer` 仍是对无结构文本的兼容与防泄漏兜底，不能替代业务完成判定。
