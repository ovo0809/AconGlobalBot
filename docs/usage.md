# OpenAI 费用保护与用量

用户选定试用档：每案例 **2 USD**、整个 Demo 所属组织每天 **5 USD**、每月 **20 USD**。日／月按 UTC 切换，案例额度覆盖该案例全部访谈、重连、事实提取、报告生成与重试；不是每次重新进入页面就重置。

仓库提交的示例配置仍为 `LLM_PROVIDER=mock`、`VOICE_PROVIDER=mock`，因此克隆后不会自动发起网络调用。本机已由用户授权显式切换为 OpenAI 并配置 `whisper-1` 输入转写，用于限额内真实测试；密钥仍只保存在 Git 忽略的本机配置中。模拟操作不创建付费调用记录；历史付费记录也不会因切回 mock 而清零。上线这份账本前的请求没有回填为已核对用量。

## 后台记录与配置

按用户最新要求，顾问、Charles 和客户页面均不展示“费用与用量”入口、费用面板、金额或 token 明细。账本仍保存在服务端 SQLite，继续区分已知估算、预留或待核对金额和可用额度，不会把未结算金额当作零费用。既有内部接口权限不变：顾问／Charles 仅有本人／已分配案例明细，组织日／月只提供汇总，管理员没有案例明细，客户模式和匿名接口没有账本。

服务端配置，重启后生效：

```dotenv
LLM_PROVIDER=mock
VOICE_PROVIDER=mock
AI_CASE_BUDGET_USD=2
AI_DAILY_BUDGET_USD=5
AI_MONTHLY_BUDGET_USD=20
OPENAI_VOICE_MAX_SECONDS=1200
```

受控本机测试需要显式使用 `LLM_PROVIDER=openai`、`VOICE_PROVIDER=openai`，并可设置 `OPENAI_TRANSCRIPTION_MODEL=whisper-1`。示例文件继续保持 mock；不要把本机密钥或真实启用状态提交到仓库。

预算值必须为有限非负金额，设为 `0` 会阻止相应范围内的 OpenAI 调用。页面没有修改额度入口，客户和模型无法提高额度。更换模型需先增加经核实的费率及测试；没有费率的模型会在联网前被拒绝。保留的 Gemini 适配不在本轮 OpenAI 计费保护范围内，不能将这些额度当作 Gemini 或账户级通用限制。

## 计量和停止规则

- SQLite 保存调用和用量事件，金额采用整数微美元；与现有数据库一起备份。记录模型、用途、案例／访谈标识、请求标识、时间、token／音频分项、费率版本和状态，不保存密钥、提示词、客户原文或音频。
- 请求前在事务中同时检查案例、日、月余额并预留额度。并发调用共享同一账本。响应包含有效 usage 时，按完整输入（含历史）、输出、缓存和音频分项计价；响应拒答、被打断或输出格式失败也不能抹掉已发生的用量。
- 每次文字调用预留 $0.05，限制请求体最多 64,000 UTF-8 字节、输出最多 2,048 token。输出上限包含模型推理 token。完成后按返回 usage 结算，多余预留释放。
- 语音在建立 OpenAI 连接及生成首问前预留三层剩余额度。每轮输出最多 512 token，额外限制连接时长。接近预留额度或达到时长限制时停止转发音频、取消回复并终止连接，保留已有对话。
- Realtime 的每个 response 和客户转写分别计量并去重。`whisper-1` 只负责 Realtime 客户输入转写，当前按 **$0.006／分钟**估算；它不是负责上下文理解、下一问和语音回复的独立全链模型。Realtime 模型的输入、缓存、输出文字和输出音频仍按其 usage 另行计费。流式估算用于尽早停止；官方事件 usage 用于记录已知费用，不能只按最后一句转写时长计算整场费用。
- 发出请求后遇到网络失败、缺少／不合法 usage 或断线，保留未确认预留，标为待核对；重启不会清掉这些占用。待核对金额在跨日／跨月后仍占可用额度，以免通过重启或重连绕过保护。
- 超限阻止后续调用，文字回答先保存；后台任务保留失败状态，可在人工核对账单／调整额度后明确重试，不自动切成模拟 AI。待核对记录不能凭“没有收到回答”认定免费，本版没有自动冲销或客户端清零入口。

这是**应用级支出保护**，不是 OpenAI 账单的绝对硬封顶。实时上游处理、断线、延迟 usage、公开费率变化和其他使用同一账户密钥的程序都可能造成账单差异。必须保留这项限制，不能仅凭模拟测试宣称真实账单封顶已验收。

## 费率与验证边界

费率快照为 `openai-2026-10-28-whisper`，当前允许 `gpt-6-luna` 文字、`gpt-realtime-2.1` 语音，以及语音会话中的 `whisper-1` 或默认 `gpt-4o-mini-transcribe` 输入转写。`whisper-1` 只接受按时长计量，费率为 $0.006／分钟；`gpt-4o-mini-transcribe` 保留既有 token／时长计量兼容。更换转写模型只影响客户输入转写费用，不包含 Realtime 回复费用。

- [官方 API 价格](https://developers.openai.com/api/docs/pricing)
- [Responses 请求与 usage](https://developers.openai.com/api/reference/resources/responses/methods/create)
- [Realtime 事件](https://developers.openai.com/api/reference/resources/realtime/server-events)
- [Realtime 成本](https://developers.openai.com/api/docs/guides/voice-latency-cost)

早期密钥批准与余额不足阻塞已经解决，用户已授权使用合成客户进行限额内真实测试。本页不声明真实 API、真实音频费用停止或目标手机已经通过；模型、实际 usage、账单差异和设备证据以 [验收账本](acceptance.md) 与 [工程验证记录](verification.md) 的最新记录为准。
