# Aeconn AI Agent · 顾问访谈 Demo

面向 Aeconn 真人保险顾问的中文本地 Demo：建立合成客户档案 → 受限客户访谈 → 结束并交还手机 → 内部报告与中文 PDF → 顾问确认两份邮件预览 → Charles 复核。

实现依据：[Notion「02｜可直接复制给 Codex 的开发 Prompt」V1.3](https://app.notion.com/p/406d9731c2408174a24dfa30ff68ee52)。这是合成数据 UI 原型，不是获准处理真实客户资料的生产系统。当前分析回复和语音选择器都默认 `mock`，邮件默认 dry-run；云端 AI 与真实连续语音需后续显式启用并在目标手机验收。

项目文档：[产品需求 PRD](PRD.md) · [MVP 范围与交付状态](mvp.md) · [工程验证记录](docs/verification.md)

![顾问工作区，1440×900 合成数据演示](docs/screenshots/advisor-desktop-1440x900.png)

[查看 390×844 客户助手截图](docs/screenshots/client-mobile-390x844.png)

## 启动

需要 **Node.js 24.x** 和 Git。依赖版本由 `package-lock.json` 锁定。当前原型不需要 API 密钥、本地模型、独立显卡、模型权重、Docker 或额外数据库服务。

Windows PowerShell：

```powershell
git clone https://github.com/ovo0809/AconGlobalBot.git
Set-Location AconGlobalBot
Copy-Item .env.example .env.local
npm ci
npm run dev
```

macOS / Linux：

```bash
git clone https://github.com/ovo0809/AconGlobalBot.git
cd AconGlobalBot
cp .env.example .env.local
npm ci
npm run dev
```

打开 **http://127.0.0.1:3000**。首次访问自动建立 SQLite schema v1 和 12 个合成案例。

生产模式本地验证：`npm run build` 后运行 `npm start`。自定义 Node 服务同时承载 Next.js 页面、API、SQLite 和语音 WebSocket；不能用 GitHub Pages 承载这些服务。

## 演示账号

| 身份 | 邮箱 | 权限 |
| --- | --- | --- |
| 林顾问 | advisor1@aeconn.example | 仅本人客户与案例 |
| 陈顾问 | advisor2@aeconn.example | 与林顾问数据隔离 |
| Charles | charles@aeconn.example | 仅已交给他的案例 |
| 管理员 | admin@aeconn.example | 账号邮箱及配置，无业务资料权限 |

本地演示密码均为 `AeconnDemo!2026`，可在**首次建库前**用 `DEMO_PASSWORD` 替换。更改环境变量不会修改已存在账号的密码。所有 `.example` / `.invalid` 邮箱为占位，不发送邮件。不要在公开服务器使用这些默认账号密码。

## 跑通一次完整流程

1. 以顾问登录，点击新建客户，填写姓名、生日、性别、电话、邮箱、婚姻状态六项合成资料，并说明采集用途。
2. 开始客户访谈。此时服务端将同一设备会话改为受限模式，原顾问 cookie 也无法读取客户列表、报告、收件人或复核接口。
3. 选择人寿、伤残保险、年金或长期护理。入口只影响提问顺序；每个报告均检查四类需求。
4. 缺少实时服务配置时使用文字回答。财务金额请明确币种及月／年／一次性周期；可以回答“不知道”或“不愿提供”。暂停后必须主动恢复。
5. 点击结束，停止音频并返回原顾问当前案例，无 PIN。页面提示交还手机，系统无法判断持机人是否已经更换；报告不自动展开或朗读。
6. 明确打开内部报告，核对事实与来源。修正事实需理由，会创建新报告版本；历史版本与 PDF 保留。
7. 邮件预览显示公司和归属顾问两份完整正文及同版本 PDF。点击确认只创建两份 **未发送** dry-run 记录；取消只保存报告。客户邮箱不接收报告。
8. 提交 Charles 复核，然后以 Charles 登录。确认、退回补问、修改意见与进入现有报价流程均需理由，保留复核版本；系统不报价。

## 功能状态

| 功能 | 状态 |
| --- | --- |
| 服务端会话、CSRF、顾问隔离、管理员隔离、客户模式限制 | 已实现并自动测试 |
| 六字段建档、12 个合成场景、文字访谈、未知／拒答、事实来源 | 已实现并自动测试 |
| 四类别规则、六块报告、中文分页 PDF、版本与复核 | 已实现；规则标记 `demo_unapproved`，未做业务正确率验收 |
| 模型分析 | 当前 `LLM_PROVIDER=mock`；Gemini 结构化适配器保留但未开启，真实服务未验证 |
| 连续语音 | 当前 `VOICE_PROVIDER=mock`；Gemini Live 适配器保留但未开启，本地假上游协议通过，真实服务与手机待验收 |
| 邮件 | 完整 dry-run 正文／PDF 已实现；真实传输接口有策略保护，但未配置真实发送服务 |
| 备份／恢复 | SQLite online backup，包含数据库内 PDF 与版本，自动测试通过 |

详细证据与限制见 [验证记录](docs/verification.md)、[决策记录](decisions.md)、[模型及语音配置](docs/providers.md)、[PDF 验证](docs/report-validation.md)。

## 后续启用云端 AI 与连续语音

当前 UI 原型保持下面两项默认值，即使系统环境中已有 Gemini 密钥也不会自动调用网络：

```dotenv
LLM_PROVIDER=mock
VOICE_PROVIDER=mock
```

进入云端服务验证阶段时，才在本机 `.env.local` 显式选择 Gemini，并填写密钥与准确模型名。不要上传 GitHub，也不要粘贴到聊天记录：

```dotenv
LLM_PROVIDER=gemini
VOICE_PROVIDER=gemini
GEMINI_API_KEY=你在本机安全设置的密钥
GEMINI_MODEL=当前账户可用的准确分析模型名
GEMINI_LIVE_MODEL=当前账户可用的准确Live模型名
```

只有 Provider 选择器与所需配置同时满足时，云端能力才启用；分析和连续语音可以分别验证。型号需要从供应商当前控制台确认，代码不猜测或固定未经验证的型号。姓名、电话、邮箱和完整生日等建档字段不直接提交给分析模型；用户在自由文本内主动透露的身份信息不能保证完全自动去除，因此仍只使用合成资料。

模型 Provider 只产生候选事实和分析。权限、案例归属、状态、收件人、发送批准和人工确认仍由业务层控制。未来如有离线或成本需求，可以在同一边界新增 Ollama Provider；当前没有实现、安装或自动拉取 Ollama 模型，也不保证只替换 URL 就能获得同等质量、延迟或连续语音能力。

手机测试需受信任 HTTPS，电脑 localhost 能录音不代表手机通过局域网 HTTP 能录音。默认只监听回环地址。受控测试步骤见 [迁移与 HTTPS](docs/operations.md)；不应直接将默认 Demo 暴露到互联网。

## 检查与维护

```bash
npm run typecheck
npm run lint
npm test
npm run build
npx playwright install chromium
npm run test:e2e
```

GitHub Actions 会重复运行这些检查及 Chromium 浏览器测试。`.env*`、SQLite 文件、日志、测试数据库和输出目录均被 Git 忽略。

```bash
npm run backup -- ./data/backups/manual.sqlite
npm run restore -- ./data/backups/manual.sqlite ./data/restored.sqlite
```

恢复不覆盖原数据库。停止旧服务后，将 `.env.local` 的 `DATABASE_PATH` 改为新的数据库文件，再启动并核对案例、版本和权限。迁移到新电脑必须重新执行 `npm ci`，不要复制 `node_modules`。详见 [运维说明](docs/operations.md)。

## 代码结构

- `app/`：响应式界面和服务端 API。
- `lib/service.ts` / `lib/db.ts`：权限、状态机、来源、SQLite schema、批准与 Outbox。
- `lib/report.ts` / `lib/scenarios.ts`：独立示范规则、合成数据、报告和 PDF。
- `lib/provider-config.ts` / `lib/providers.ts`：集中选择 Provider，隔离 Mock／Gemini 实现与业务逻辑。
- `lib/voice-server.ts` / `lib/browser-voice.ts`：实时语音的服务端中继与浏览器边界。
- `lib/mail.ts`：预览、发送策略、accepted/delivered/unknown 边界及对账流程。
- `scripts/`、`tests/`、`.github/workflows/`：备份恢复、自动验证、CI。

中文 PDF 字体为 Noto Sans CJK SC，遵循随附 SIL Open Font License；见 `public/fonts/OFL.txt`。
