# 数据、迁移与受控 HTTPS

## 数据布局与一致性备份

代码、规则、合成场景保存在 Git；环境配置在未跟踪的 `.env.local`；SQLite 默认 `data/aeconn.sqlite`。PDF 存在 SQLite BLOB 中，与报告版本一起备份。SQLite 使用 WAL、外键与幂等唯一约束；当前 schema 版本通过 `PRAGMA user_version=2` 标识，首次访问自动迁移／建库。

服务运行中使用 `npm run backup -- <新文件路径>`，脚本调用 Node 官方 SQLite online backup 并进行 `integrity_check`。不要仅复制写入中的 `.sqlite` 主文件。备份同时包含账号哈希、会话、案例、最终转写、事实、最终提取标记、报告任务、报告、批准、通知和审计记录，请按敏感资料保管，即使当前只是合成数据。

恢复使用 `npm run restore -- <备份> <尚不存在的新路径>`，拒绝覆盖已有数据库。先停止原服务，再设置 `DATABASE_PATH` 指向恢复文件。应用版本与 schema 必须匹配。

官方 API 依据：[Node.js 24 SQLite backup](https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html#sqlitebackupsourceDb-path-options)。

## 迁移检查

1. 在原电脑执行一致性备份，保留应用 Git 提交号、模型名称、规则版本和必要环境配置。
2. 新电脑安装 Node 24、克隆同一提交、执行 `npm ci`，不复制 `node_modules`。
3. 用 restore 写入新路径，配置环境，先用相同模型／规则启动。
4. 检查两个顾问隔离、Charles 队列、历史最终消息、报告版本、PDF、两份 dry-run 任务及备份完整性。
5. 然后单独验收模型切换、真实语音及新手机设备；更换设备后必须重新验证麦克风、浏览器和实时会话行为。

## 报告后台任务与重启

访谈结束时，服务端先完成有界语音收尾并保存确定转写，再把报告任务持久化到 SQLite `report_jobs`。同一 Node 24 进程中的后台任务先做幂等最终事实提取，再生成分析、报告和 PDF；不需要 Redis、外部队列或独立 worker 服务。

- 正常结束接口不等待报告与 PDF 完成；顾问界面读取任务／案例状态。
- 进程重启后恢复未完成任务。恢复前先确认使用的是同一 SQLite 文件和兼容的应用版本。
- 失败任务必须保持可见，不得显示成已生成；修复配置或暂时性错误后再使用受控重试。
- 备份和恢复后要核对未完成任务、最终转写、事实、报告版本与 PDF 是否一致，避免在两个进程同时打开同一数据库并重复处理。

启动时先取得 `<DATABASE_PATH>.runtime.sqlite` 中的本机进程所有权；SQLite 事务保证两个启动进程不能同时取得所有权。已有活跃进程时拒绝第二实例；进程正常退出时释放，异常退出后下一次启动可回收死亡进程的所有权。所有权文件只是运行保护，不作为业务数据库备份或跨电脑复制。只有取得所有权后才恢复未完成报告和 finishing 会话。

此机制只支持单机单进程恢复，不支持多个应用实例或不同主机共享数据库和工作负载。

## OpenAI 验证准入

默认开发模式保持 `LLM_PROVIDER=mock` 与 `VOICE_PROVIDER=mock`，避免无意联网。进入受控 OpenAI 验证时，本机使用 Git 忽略的 `.env.local` 显式设置：

```dotenv
LLM_PROVIDER=openai
VOICE_PROVIDER=openai
OPENAI_API_KEY=<仅存在于本机环境>
OPENAI_MODEL=gpt-6-luna
OPENAI_REALTIME_MODEL=gpt-realtime-2.1
```

安全密钥已写入本机环境且未进入 Git。不要读取、打印、提交、粘贴或复制密钥到文档。真实模型列表请求 HTTP 200，只证明认证成功；项目真实 InterviewAgent 请求随后因 `credit_balance_exhausted`／`insufficient_quota` 返回 HTTP 429，没有生成回复或事实。模型列表中可见 `gpt-6-luna`、`gpt-realtime-2.1` 不等于推理或实时语音已验收。Gemini 变量与适配器继续保留，可作为单独验证的可选 Provider。

下一步先在对应 API 账户补充可用余额／额度，再用同一合成输入重试文字 InterviewAgent；成功后继续验证完整访谈、最终事实、后台报告与 PDF。随后再单独验证实时音频，最后进入手机矩阵。模拟测试、认证请求、真实推理、实时音频和目标手机测试必须分别记录；任何一层通过都不能替代下一层。

## 手机 HTTPS

默认监听 `127.0.0.1`。如要通过可信反向代理测试：

1. 先建立独立测试数据库，仅使用合成数据；首次建库前设置不少于 16 位的新 `DEMO_PASSWORD`。
2. 将本地 HTTPS 反向代理指向 `127.0.0.1:3000`，代理必须支持 `/voice` WebSocket Upgrade，使用目标手机信任的证书。
3. 代理转发 Host／Origin 应保持一致；配置 `HTTPS_PROXY_ORIGIN=https://你的受控测试域名`。如确实需要非回环绑定，还必须设置 `HOST` 和 `ALLOW_NETWORK_DEMO=true`。
4. 确认服务器不暴露其他端口，不将 `.env.local`、SQLite 或备份放到公开静态目录。
5. 逐项验证麦克风授权、连续多轮、共享上下文下一问、字幕、打断、静音、断线、暂停、结束即时停音频和确定快照，再记录真实设备／浏览器版本。

本项目没有自动开公网隧道、申请域名或发布公网服务。没有在真实手机测试前，不保证后台、锁屏或软键盘行为。

## 邮件故障

数据库 Outbox 以 case_id + report_version + recipient + notification_type 唯一。两个目标独立记录，批准绑定版本与收件人指纹；正文与 PDF 缺失会失败。真实适配器接入后，必须先持久化 unknown 再请求服务商，用幂等键对账；accepted 不能视为 delivered。超时状态未知时禁止盲目重发。默认 dry-run 不进行网络投递。
