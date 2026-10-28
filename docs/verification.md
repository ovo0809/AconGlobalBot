# 工程验证记录

## 2026-10-27（America/Los_Angeles）：移除费用界面

按用户要求移除“费用与用量”入口、面板组件和专属样式；案例只保留访谈记录、画像与来源、内部报告和通知预览四个业务标签。后台预算、SQLite 账本、权限和停止逻辑没有修改，当前仍为 mock。

- `npm run typecheck`、`npm run lint`、`npm run build`：通过。
- `npx tsx --test tests/ai-usage.test.ts`：7/7 通过，确认后台额度与记录行为保持。
- `npm run test:e2e`：7/7 通过。既有 4 条业务工作流正常；费用 UI 的 3 条检查已改为桌面、390×844 视口和受限客户模式均不展示费用入口或用量明细，即使响应包含非空 usage 数据。
- 本机生产服务已重新构建、启动并刷新现有页面；合成案例中只显示四个业务标签，费用入口已移除。
- `git diff --check`：通过。未调用真实付费 API；未执行目标手机测试。

以下费用面板截图／显示检查属于本次移除之前的历史证据，不代表当前界面。

## 2026-10-28 UTC：OpenAI 费用保护与用量记录

用户选定试用档：案例累计 $2、组织每天 $5、每月 $20；日／月按 UTC。当前运行及本机持久配置均保持 `LLM_PROVIDER=mock`、`VOICE_PROVIDER=mock`，没有执行付费 API 测试。

- `npm run typecheck`、`npm run lint`：通过。
- `npm test`：**79/79 通过**，包括费用账本 7 项及语音 relay 16 项。测试使用隔离 SQLite、假 HTTP 和本机 WebSocket；语音测试自然退出，没有使用 `--test-force-exit`。
- 新增覆盖：请求前额度预留、案例／日／月共同限制、缓存／音频／转写计价、重复 usage 去重、跨日结算、重启保留待核对金额、拒答仍记费用、预算拒绝发生在联网前、客户模式不返回内部用量。
- 语音保护覆盖：达到金额或时长阈值停止、停止时不提交待处理音频触发新回复、交错 response 不漏算或提前标为完成、持久化卡住时先关闭计费连接、缺少 usage 保留预留。以上均为假上游协议回归，不是实际语音或账单验证。
- `npm run build`：最终构建通过；`npm start` 以 mock 生产模式重新启动成功，保留现有案例数据。
- `npm run test:e2e`：**7/7 Chromium 流程通过**。新增 3 项费用界面检查：mock 零新增调用、历史待核对记录与 390×844 视口无水平溢出、受限客户模式不显示费用。费用 UI 的不同金额使用 stub bootstrap；权限和真实持久化另有 service／ledger 回归覆盖。
- 本机实际页面检查：合成案例中可见“费用与用量”、mock 提示及 $2／$5／$20 额度，记录为空；没有把模拟操作记为付费调用。
- `git diff --check`：通过。未增加依赖；忽略目录中的临时手工探针不进入项目 typecheck／lint。

**尚未执行**：真实 Responses／Realtime 用量核对、真实音频停止和延迟费用验证、OpenAI 账单对账、目标手机。当前仅验证应用保护逻辑；不能宣称供应商账单绝对封顶，也不更新 Charles 首版可用验收结论。配置和限制见 [usage.md](usage.md)。

## 2026-10-27 首版能力补齐

本轮代码保留原应用，新增 OpenAI Responses / Realtime 适配、共享 InterviewAgent 上下文、严格事实来源、持久后台报告任务和单进程所有权保护。

- `npm run typecheck`、`npm run lint`：通过，无警告。
- `npm test`：61/61 通过。新增测试覆盖 OpenAI 假 HTTP 结构化访谈与保存事实后报告、未知与金额歧义、顾问／客户／合成来源、最终／残留转写、自动后台任务、重启恢复、云端失败后显式重试、暂停／恢复后拒绝旧回复、运行进程所有权与崩溃回收。语音专项另覆盖终态错误停止媒体、持久化失败收尾、两轮重叠且逆序 ASR 的来源绑定、累计字幕和有限重连。
- `npm run build`：通过。中文合成 PDF 共 3 页，已用 Poppler 逐页渲染检查来源标签、中文、页码与边界；调整了整节分页与页脚保留空间。
- `npm run test:e2e`：4/4 Chromium 工作流通过，证明没有客户端 `generateReport` 请求时仍自动生成报告；文字云端失败后保留回答、相同 eventId 重试；预览与权限正常。
- 最终生产构建实际启动后，用合成客户执行登录→访谈→结束→独立后台报告：返回顾问原案例，任务 `ready`，PDF HTTP 200／111768 字节，邮件任务 0。运行配置仍为明确的 mock，未接通真实语音。
- OpenAI/Gemini 的功能回归仍使用假上游。本机安全密钥已写入 Git 忽略的 `.env.local`，未读取或记录密钥值。2026-10-27 21:01:44（America/Los_Angeles；UTC 2026-10-28 04:01:44）真实 `GET https://api.openai.com/v1/models` 返回 HTTP 200，证明认证成功；返回列表包含 `gpt-6-luna` 与 `gpt-realtime-2.1`，但模型可见不代表推理权限或质量通过。
- 2026-10-28 04:02:54Z，运行 `node --import tsx tmp/probe-interview.ts`，以 `LLM_PROVIDER=openai`、`OPENAI_MODEL=gpt-6-luna` 调用项目真实 `interviewWithProvider`。合成输入为“我希望为孩子准备家庭保障。我每年的收入是80000美元。”；OpenAI Responses 请求返回 HTTP 429，`credit_balance_exhausted`／`insufficient_quota`。没有真实 AI 回复或事实提取。脱敏原始记录位于本机 `tmp/validation/openai-connectivity.json` 与 `tmp/validation/openai-interview.json`，不含密钥。
- 未执行真实 Realtime 音频、目标手机、完整真实访谈→事实→后台报告／PDF 链路。当前阻碍是 API 可用余额／额度；认证通过不能标记为真实推理通过。
- 用户选择暂不充值并保留配置，因此本轮没有重试生成请求，也没有继续实时语音测试。
- 完整逐项状态和真机记录表见 [acceptance.md](acceptance.md)。本轮通过的是工程自动检查，不是 Charles 首版交付验收。

以下为上一版历史检查记录，保留用于比较。

验证日期：2026-10-27。环境：Windows / Node.js 24.19.0；依赖锁定于 package-lock.json。数据均为合成数据，没有调用真实模型、录入真实客户资料或发送邮件。

## 自动检查

- `npm run typecheck`：通过。
- `npm run lint`：通过。
- `npm test`：32/32 通过，覆盖报告规则、来源、结构、中文分页 PDF、真实 Request/Response 会话权限、CSRF 与回环 Host 归一化、四入口、财务未知／拒答、版本、复核、邮件策略、部分失败与 unknown 对账、完整应用 SQLite online backup／恢复、假上游 WebSocket 协议及原型模式禁止云端请求。
- `npm run build`：通过，无构建警告。数据库为运行时数据，不参与 Next 文件追踪。
- `npm run test:e2e`：3 条 Chromium 流程通过，见下文。
- `npm audit --audit-level=moderate`：0 vulnerabilities（当前锁定依赖检查结果）。

初始基准提交 `7a67d47` 为 29 项自动测试。本轮 Provider 边界更新增加 3 项回归测试并重新运行全套检查：缺省／mock 模式即使存在云端密钥也不请求模型；分析与语音必须分别显式开启；mock 语音不会连接上游。使用假 HTTP／本地 WebSocket 验证，未访问真实云端。项目依赖和锁文件未增加 Ollama 或其他本地模型运行时。

## 浏览器验证

1. 顾问真实账号登录、六字段建档、进入客户模式、内部 DOM 移除、直接访问报告返回 403、文字访谈、暂停、刷新恢复、结束后直接返回当前案例、交还手机提示、报告不自动打开、生成后台报告、真实 PDF 链接、两份完整 dry-run 邮件。
2. Charles 仅看到交接案例，带理由复核生成新版本；退出后切换管理员，业务资料不可见，发送政策可配置。
3. 同一浏览器两个标签页：客户模式变更广播清除另一页缓存的内部报告；聚焦、返回和重新可见时先展示中性加载页，再按服务端模式恢复。

截图：

- [1440×900 顾问工作区](screenshots/advisor-desktop-1440x900.png)
- [390×844 客户助手](screenshots/client-mobile-390x844.png)

这些是浏览器视口测试，不是真实手机验收。已检查水平溢出、关键控制可见和内容裁切；真实手机软键盘、锁屏、后台、VoiceOver/TalkBack 等仍需目标设备测试。

## 实际运行与附件

`npm start` 生产模式实际启动成功；`GET /` 和 `/api/bootstrap` 返回 200，后者为 no-store JSON。备份脚本在运行中执行成功，恢复到新的文件成功；不会覆盖原数据库。

PDF 使用嵌入的 Noto Sans CJK SC。自动生成的普通／长报告已用 Poppler 渲染检查中文、分页、页码及无裁切；pdfplumber 提取核对客户名、client_id、case_id、顾问姓名／ID／邮箱、时间、版本、复核状态、快照、规则、六部分正文和精确复核意见。旧版本 PDF 在事实修正后仍保持字节不变。

## 真实与模拟的区别

| 部分 | 本次验证 |
| --- | --- |
| 权限、SQLite、正文、PDF、批准、版本、复核 | 真实应用代码与持久化自动验证 |
| 规则初筛 | 确定性 `demo_unapproved` 示例；没有业务正确率结论 |
| Gemini 结构化提取／分析 | 适配器与结构校验；没有密钥，真实 API 未调用 |
| Gemini Live | 本地假上游 WebSocket 测试，不能证明供应商或设备效果 |
| 邮件传输 | 默认真实生成预览；传输边界使用假服务测试，不发真实邮件 |

未执行：真实连续多轮音频、真实 Gemini 成本／延迟／质量、目标手机回声与打断、真实断网重连、麦克风硬件、受控 HTTPS 代理、真实邮件服务和真实收件人投递。浏览器 SpeechSynthesis 重播不计作实时语音通过。

仍待甲方：未复核草稿是否允许实际发送、正式语言范围、原始音频留存政策、Charles 批准的业务规则、脱敏案例及独立业务验收。
