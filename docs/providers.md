# 模型与连续语音适配器

当前 UI 原型默认使用 mock 分析、模拟回复和文字访谈，明确显示“模拟／待业务审核”。默认配置为 `LLM_PROVIDER=mock` 与 `VOICE_PROVIDER=mock`；即使运行环境中已有 OpenAI 或 Gemini 密钥，也不会自动发起云端模型或语音请求。原型不需要本地模型、独立显卡或下载模型权重。

## Provider 边界

- `lib/provider-config.ts` 集中读取和校验 Provider 选择及所需配置。
- `lib/providers.ts` 暴露统一的 LLMProvider 能力，并包含 Mock 及云端实现；业务服务只调用 facade 和能力描述。
- Provider 只能返回候选事实与四类分析，且所有提取事实保持未核验。
- 权限、案例归属、数值规则、状态流转、收件人、发送批准和人工确认始终由业务层负责；模型输出不能改变这些值。
- 模型与实时语音分别选择，便于独立接入和验收。

## 当前原型配置

```dotenv
LLM_PROVIDER=mock
VOICE_PROVIDER=mock
```

mock 是显式选择，不是“缺少密钥后的隐式云端回退”。它不会调用网络，不要求 API 密钥，也不把模拟结果标记为真实服务结果。

## 后续云端配置

只有显式把 `LLM_PROVIDER` 或 `VOICE_PROVIDER` 设置为 `openai`／`gemini`，并同时提供该能力所需的密钥与准确模型名，程序才启用对应云端适配器：

- `OPENAI_API_KEY`：只在 Node 服务端读取，不发送给浏览器。
- `OPENAI_MODEL`：OpenAI 文字分析模型，必须显式配置。
- `OPENAI_REALTIME_MODEL`：OpenAI Realtime 模型，必须显式配置。

- `GEMINI_API_KEY`：只在 Node 服务端读取，不发送给浏览器。
- `GEMINI_MODEL`：分析模型的精确资源名。必须显式配置，程序不猜测当期可用型号。
- `GEMINI_LIVE_MODEL`：Live 模型的精确资源名。必须显式配置。
- `GEMINI_TIMEOUT_MS`：结构化分析超时，默认 30000 毫秒。

文字访谈与后台处理按所选 Provider 使用 OpenAI Responses REST API 或 Gemini Interactions REST API，均使用 JSON Schema 并设置 `store=false`。OpenAI 的拒答、不完整响应、HTTP 失败或结构不合法会明确失败，不会切换成模拟结果。

单个 InterviewAgent 负责自然下一问与候选事实；文字模式逐轮保存，语音模式结束后从最终客户转写提取并保存。上下文包含当前案例的已知事实、最近 60 条最终对话、建档州和语言、缺失项及冲突项。建档信息不伪装成对话来源，顾问更正有独立来源标记且不能被模型当成新客户陈述。原文中的常见邮箱、电话和日期形式会脱敏，但这不是通用去标识保证；示范阶段使用合成客户。

事实只允许预定义字段，模型不得设置人工确认。金额必须有同一条最终客户陈述中的明确数字、币种与周期；倍率、多个金额等歧义需要澄清。非金额值必须是引用原话中的片段。冲突保留双方来源，解除冲突要求新的最终客户澄清。报告步骤只读取已保存事实，不再提取或改写事实。四类分析的证据必须属于保存事实的来源。结构和来源校验不代表业务判断正确，结果仍需顾问／Charles 复核。

连续语音采用同源浏览器 WebSocket `GET /voice?token=...` 到 Node 服务端，再由服务端连接所选云端实时服务。短凭证由受限客户会话经 CSRF 保护的 `voiceToken` 操作签发，并只使用一次。浏览器只可发送 PCM 音频、最多 2000 字的文字、音频结束标记，或针对服务端刚下发 OpenAI item ID 的受限截断回执；模型、系统指令、工具和上游 URL 固定在服务端。Gemini 输入使用 16kHz PCM；OpenAI Realtime 输入和输出都使用 24kHz PCM。relay 在 `ready` 事件中声明采样率，浏览器据此重采样麦克风，不由客户代码选择上游格式。

建立 Live 连接前，业务 hook 会按当前 interview session 读取案例上下文，其中包含已知事实、问题优先级、已有最终转写及待澄清项。relay 将其限长后包在明确标注为“不可信数据”的 `<case_context>` 中；案例内容不能覆盖固定安全规则。固定指令要求模型一次只问一个最重要的缺口，不重复已有明确答案，尊重“不知道”和“不愿提供”，补清金额的数值／币种／周期以及日期精度，并对矛盾信息先中性复述再确认。全新 Live session 在 `setupComplete` 后由服务端发送一次受控开场指令，让模型直接提出首个问题；恢复既有 Live session 时不会重复开场。

自动语音活动检测在 setup 中显式启用，开始说话采用 `START_OF_ACTIVITY_INTERRUPTS`，因此客户插话时模型可中断当前回复；浏览器收到 `interrupted` 后立即清空未播放音频，且不会把被打断的音频保留为“重播上一条”。临时转写只显示，不进入事实库。正常 `turnComplete`（且 `interactionStatus` 不再为 `IN_PROGRESS`）后，relay 留出很短的转写收尾窗口，再把最终输入／输出转写持久化。turn ID 包含每次浏览器连接的随机 ID 与轮次，断线重连不会重复。

Live setup 启用 context window compression 与 session resumption。relay 保存 Google 返回的可恢复 handle，收到 GoAway／上游断线时最多有限重连，并在可恢复时继续同一个 Live session；浏览器侧也只有有限次数的下游重连，不会无限循环。点击暂停或结束时浏览器先停止麦克风轨道、采集节点和播音，再发送音频结束标记。服务端最多等待 1.5 秒收尾；若仍没有正常完成事件，只保存 `final=false` 的残留转写供人工审查，标记 `transcript_incomplete`，这些残留不得成为事实来源。会话结束后的事件不会重新开启案例。

OpenAI Realtime 使用服务端 Bearer 鉴权连接 `/v1/realtime`，API key 不到浏览器。session 锁定 24kHz PCM、服务端 VAD、自动响应及自动打断，并开启输入转写。`input_audio_buffer.speech_started` 到达后，relay 立即要求浏览器停播；浏览器只可回报当前 assistant item 已实际播放的毫秒数，relay 验证 item ID 和上限后发送 `conversation.item.truncate`，使云端对话历史移除未听到的尾部。最终客户转写与助手转写分别以 OpenAI `item_id` 作为 source item ID 保存；输入转写异步晚到时仍按 item ID 归属，不靠事件到达顺序猜测。

## 运行与安全

自定义 Next.js 服务只监听 `127.0.0.1`。如需受信任的手机测试，必须同时配置 `HOST`、`ALLOW_NETWORK_DEMO=true`、至少 16 位且不等于演示默认值的 `DEMO_PASSWORD`，以及以 `https://` 开头的 `HTTPS_PROXY_ORIGIN`，并在受控 HTTPS 反向代理后运行。浏览器麦克风在非 localhost 场景通常要求安全上下文。

原始音频只在内存中转，不写数据库。服务端不记录完整提示词、API 密钥或音频。默认邮件仍为 dry-run。

## 已验证与待验证

自动测试覆盖：身份字段过滤和文本脱敏、四类别及案例内证据验证、未配置状态、同源 WebSocket 检查、一次性凭证消费、缺少云端配置时清晰失败；Gemini Live 假上游验证案例上下文只由服务端写入 setup、受控主动首问、自动 VAD／打断配置、最终转写、断线唯一 turn ID、超时残留 `final=false`、session resumption 以及恢复时不重复首问。OpenAI 假上游验证 Bearer 服务端连接、24kHz 输入／输出、案例指令、主动首问、自动 VAD、speech-started 停播、受限截断、source item ID、最终字幕和正常 drain。浏览器单测验证获取短凭证失败时麦克风轨道与 AudioContext 会立即释放。

尚未执行：真实 OpenAI Realtime 调用、真实 Gemini API 调用、真实云端音频、手机麦克风、回声消除效果、锁屏／后台恢复、网络重连时序和真实 HTTPS 代理。用户曾授权安全创建 OpenAI key，但本机写入确认未获批准，因此没有创建或写入 key，也没有进行真实调用。浏览器的 OpenAI 截断毫秒数使用实际 `AudioContext.currentTime` 并限制在已收到音频长度内，但不同手机的系统输出缓冲、蓝牙延迟和回声路径仍可能造成少量偏差；只有目标手机真机测试能验证听感与截断精度。以后配置密钥后仍需用普通话在实际目标手机上逐项验收，不能把假上游自动测试视为真实服务通过。

## Ollama 与其他本地 Provider

Provider 边界允许未来按需增加本地实现，但当前仓库没有 Ollama 适配器、依赖、安装脚本或自动模型下载。当前原型和下一阶段云端验证都不依赖 Ollama。

如果未来需要评估 Ollama，必须单独选择模型并验证硬件占用、延迟、结构化输出、中文质量、数据边界和运维方式。不同 API 不能假定只替换服务地址即可兼容；本地文本模型也不自动具备与 Gemini Live 相同的连续音频、转写、打断或回声处理能力。

## 官方依据（2026-10-27 核对）

- Gemini Structured Outputs：https://ai.google.dev/gemini-api/docs/structured-output
- Gemini Interactions API：https://ai.google.dev/api/interactions-api
- Gemini Interactions 存储控制：https://ai.google.dev/gemini-api/docs/interactions-overview
- Gemini Live WebSocket 入门：https://ai.google.dev/gemini-api/docs/live-api/get-started-websocket
- Gemini Live WebSocket 参考：https://ai.google.dev/api/live
- Gemini Live 能力与打断：https://ai.google.dev/gemini-api/docs/live-api/capabilities
- Gemini Live 会话管理：https://ai.google.dev/gemini-api/docs/live-api/session-management
- Gemini Live 最佳实践：https://ai.google.dev/gemini-api/docs/live-api/best-practices
- OpenAI Realtime WebSocket：https://developers.openai.com/api/docs/guides/voice-websockets
- OpenAI Realtime 对话与 24kHz 音频：https://developers.openai.com/api/docs/guides/realtime-conversations
- OpenAI Realtime 服务端事件：https://developers.openai.com/api/reference/resources/realtime/server-events
- OpenAI Realtime 客户端事件与音频截断：https://developers.openai.com/api/reference/resources/realtime/client-events
- OpenAI Structured Outputs：https://developers.openai.com/api/docs/guides/structured-outputs?api-mode=responses
- Next.js Custom Server：https://nextjs.org/docs/app/guides/custom-server
