# 模型与连续语音适配器

本 Demo 默认使用 `mock:demo_unapproved` 分析和文字访谈，明确显示“模拟／待业务审核”。未配置云端模型时不会伪装成真实分析或真实连续语音。

## 配置

- `GEMINI_API_KEY`：只在 Node 服务端读取，不发送给浏览器。
- `GEMINI_MODEL`：分析模型的精确资源名。必须显式配置，程序不猜测当期可用型号。
- `GEMINI_LIVE_MODEL`：Live 模型的精确资源名。必须显式配置。
- `GEMINI_TIMEOUT_MS`：结构化分析超时，默认 30000 毫秒。

分析使用 Gemini Interactions REST API 与 JSON Schema，并显式设置 `store=false`，不使用服务端对话历史存储。发往云端的数据只保留允许的业务事实和最近 40 条最终客户消息；姓名、邮箱、电话、完整生日等直接字段不发送，消息中的常见邮箱、电话和日期形式会再脱敏。模型只可提取预定义业务字段，提取结果一律保持未核验，并必须引用当前案例的最终客户消息。服务端仍会验证事实格式、四个类别不重复、状态在允许集合内、证据 ID 属于当前案例。结构正确不代表业务判断正确，结果仍需 Charles 复核。

连续语音采用同源浏览器 WebSocket `GET /voice?token=...` 到 Node 服务端，再由服务端连接 Gemini Live。短凭证由受限客户会话经 CSRF 保护的 `voiceToken` 操作签发，并只使用一次。浏览器只可发送 16kHz PCM 音频、最多 2000 字的文字或音频结束标记；模型、系统指令、工具和上游 URL 固定在服务端。输出 24kHz PCM 在浏览器播放。

客户开口触发 Live 的自动语音活动检测后，模型可中断当前回复；浏览器立即停止未播放完的音频。临时转写只显示，不进入事实库。最终输入／输出转写以 session、turn 和 role 组成幂等事件 ID 后持久化。点击结束时浏览器先停止所有媒体轨道与播音，再调用结束接口；服务端最多等待 1.5 秒收尾最终转写，超时后关闭连接并由报告标记末轮可能不完整。会话结束后的事件不会重新开启案例。

## 运行与安全

自定义 Next.js 服务只监听 `127.0.0.1`。如需受信任的手机测试，必须同时配置 `HOST`、`ALLOW_NETWORK_DEMO=true`、至少 16 位且不等于演示默认值的 `DEMO_PASSWORD`，以及以 `https://` 开头的 `HTTPS_PROXY_ORIGIN`，并在受控 HTTPS 反向代理后运行。浏览器麦克风在非 localhost 场景通常要求安全上下文。

原始音频只在内存中转，不写数据库。服务端不记录完整提示词、API 密钥或音频。默认邮件仍为 dry-run。

## 已验证与待验证

自动测试覆盖：身份字段过滤和文本脱敏、四类别及案例内证据验证、未配置状态、同源 WebSocket 检查、一次性凭证消费、缺少云端配置时清晰失败。

尚未执行：真实 Gemini API 调用、真实 Live 音频、手机麦克风、回声消除效果、锁屏／后台恢复、网络重连时序和真实 HTTPS 代理。配置密钥后仍需用普通话在实际目标手机上逐项验收，不能把自动测试视为真实服务通过。

## 官方依据（2026-10-27 核对）

- Gemini Structured Outputs：https://ai.google.dev/gemini-api/docs/structured-output
- Gemini Interactions API：https://ai.google.dev/api/interactions-api
- Gemini Interactions 存储控制：https://ai.google.dev/gemini-api/docs/interactions-overview
- Gemini Live WebSocket 入门：https://ai.google.dev/gemini-api/docs/live-api/get-started-websocket
- Gemini Live WebSocket 参考：https://ai.google.dev/api/live
- Gemini Live 能力与打断：https://ai.google.dev/gemini-api/docs/live-api/capabilities
- Next.js Custom Server：https://nextjs.org/docs/app/guides/custom-server
