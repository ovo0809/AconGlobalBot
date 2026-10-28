# Aeconn Demo implementation contract

Source: Notion page 02, revision 2026-10-27, https://app.notion.com/p/406d9731c2408174a24dfa30ff68ee52

One Next.js / TypeScript application, Node 24 built-in SQLite, custom Node server for a same-origin voice WebSocket relay. Server owns sessions, scope, facts, versions and recipients. Default `mock` mode is a synthetic-data development checkpoint, not Charles acceptance. Charles v1 requires real AI and real continuous voice. OpenAI is the selected primary validation provider; Gemini adapters remain available. No local model, GPU, model-weight download, external queue or second service is required. Mail stays dry-run during development.

## Work ownership
- Root: package/config, lib/domain.ts, lib/db.ts, lib/service.ts, API routes, integration tests, docs, GitHub publication.
- UI agent: app/page.tsx, app/globals.css, app/layout.tsx, public UI assets, browser UX tests.
- Providers agent: lib/providers.ts, lib/voice-server.ts, lib/browser-voice.ts, server.ts, provider tests and official-source notes.
- Reports agent: lib/report.ts, lib/scenarios.ts, reports/rules tests, fonts and license assets, PDF verification.

## Browser API (root implements)
GET /api/bootstrap => Bootstrap (see lib/domain.ts). Always no-store.
POST /api/action with JSON, header x-csrf-token from Bootstrap.csrf. Returns {ok:true,...result}; failures {error:string} with non-2xx status. Refresh bootstrap after a mutation.
- login {email,password}; logout {}
- createClient {name,birthday,gender,phone,email,maritalStatus,state,language} => {clientId,caseId}
- createCase {clientId} => {caseId}
- enterClient {caseId} => {caseId}; entire device session becomes restricted, client-side immediately purge all internal state.
- chooseEntry {entry: life|annuity|ltc|disability_income}
- message {text,eventId}; textual answer saved as final, then the shared InterviewAgent reads the case context and returns strict `{reply,facts}`. Service validates every candidate fact and its final customer-message source before saving it.
- pause {}; resume {}; end {} => {caseId}; stop microphone/playback BEFORE awaiting end. Idempotent end restores original advisor WITHOUT PIN, performs a bounded voice/transcript drain, persists a SQLite report job and returns without waiting for extraction, analysis or PDF generation. The job performs idempotent final fact extraction before report analysis. Show hand-back/report-status UI; no automatic report expansion.
- report jobs run in the same Node process, use deterministic snapshots, and recover unfinished SQLite jobs after restart. Manual retry is permitted. `generateReport {caseId}` remains a guarded retry/admin path, not the normal blocking end flow.
- updateFact {caseId,key,value,currency?,period?,factStatus,reason} => new report version; factStatus enum in types.
- submitReview {caseId}; review {caseId,decision:approved|returned|amended|quote_handoff,reason} => version; Charles only; nonempty reason for changes/return.
- approveSend {caseId,version,snapshotId,recipientFingerprint} => dry-run jobs, never implicitly reviews; cancelSend {caseId,version}
- retryNotification {jobId}; unknown jobs cannot blindly retry.
- updateSettings {companyEmail,companyVerified,unreviewedSendPolicy}; updateUserEmail {userId,email,verified}; admin only.
- voiceToken {} => {token}; only restricted active case mode; POST checked CSRF.

GET /api/report?caseId=...&version=...&format=pdf => actual PDF, only owning advisor / assigned Charles, disallowed in client mode and for admin.
GET /api/notifications?caseId=... => jobs with complete body and attachment URL (also in bootstrap selected case).
GET /api/bootstrap?caseId=... selects internal case. Advisors only own clients; Charles only handed-off cases; admin gets settings/users, no business data.

## Provider integration
lib/provider-config.ts centralizes provider selection and validates required environment values. `LLM_PROVIDER` and `VOICE_PROVIDER` accept `mock|openai|gemini`. Default `mock` must not initiate cloud traffic even when cloud credentials exist. OpenAI requires explicit selection plus `OPENAI_API_KEY` and the relevant `OPENAI_MODEL` / `OPENAI_REALTIME_MODEL`; Gemini uses its existing key/model variables. Incomplete configuration is unavailable, never mock success.
lib/providers.ts defines Mock/OpenAI/Gemini LLM boundaries. The same InterviewAgent handles text turns and final transcript extraction, using shared context and strict `{reply,facts}` output. Report analysis reads saved facts and returns four analyses. Providers never own permission, scope, numeric validation, state, recipients, approval or human confirmation. Direct identity fields remain outside the model payload.
lib/voice-server.ts exports attachVoiceServer(httpServer, hooks). Hooks: consumeToken(token:string): {sessionId:string,caseId:string}|null; isActive(sessionId:string):boolean; persist(sessionId:string,event:{eventId:string,turnId:string,role:'user'|'assistant',text:string,interrupted?:boolean}):void; status(sessionId:string,state:string):void. Model/instructions locked server-side. Transport uses /voice?token= one-use short credential. Late events never reopen ended sessions. Expose closeVoiceSession(sessionId) for end; end permits bounded drain but closes input instantly.
server.ts loads env via @next/env, prepares Next, handles HTTP, attaches voice with hooks exported from lib/service.ts. Listen 127.0.0.1 by default. npm dev/start via tsx server.ts.
lib/browser-voice.ts exports a class with documented small UI interface. Supports microphone PCM stream, output audio playback, VAD state, interruption, subtitles, mute, stop all tracks and audio on end, pause/background handling, finite reconnect. OpenAI Realtime and Gemini Live remain provider choices. Real service/hardware tests are not complete without an approved key and target phone.

OpenAI key picker selected `AECON`, but local `.env.local` confirmation returned `not_approved/decline`; no key was created or written and no real API call was run. Do not guess a concrete OpenAI model name. Select a model exposed to the account during the approved validation run.

Ollama is a possible future Provider, not a current dependency. Do not add packages, installation steps or automatic model pulls for it. A future implementation requires separate quality, hardware, structured-output and voice evaluation; never treat a base URL swap as full compatibility.

## Report integration
lib/report.ts exports analyzeDemo(facts:ProfileField[]):AnalysisItem[], validateAnalyses(analyses, facts, messages):void, buildReport(input:ReportInput): ReportContent, renderPdf(report:ReportContent):Promise<Buffer>. ReportInput/ReportContent defined lib/domain.ts. Six sections, Chinese embedded font, pagination, immutable version content. No contact data guessed by LLM.
lib/scenarios.ts exports scenarios: {name:string,description:string,entry:Category,facts: Partial<ProfileField>[]}[] at least ten synthetic edge scenarios. Root seeds clients/cases/messages/facts with case-local references.

SQLite schema v2 adds `report_jobs` for durable in-process work and `interview_extractions` for idempotent final extraction. Startup recovers unfinished report jobs. A job failure stays visible and retryable; it does not mark the case as successfully reported. No external queue service is introduced.

## Verification / release
Historical baseline: 32 unit/API/protocol tests and 3 Chromium flows are recorded in docs/verification.md; these counts are not evidence for the newer InterviewAgent, OpenAI, or report-job work unless the verification record is explicitly updated after a fresh run. Required release checks remain unit/API permissions/CSRF/version/outbox/job recovery tests, typecheck, lint, production build, Playwright desktop/mobile UI, actual PDF render inspection and consistent SQLite backup/restore. Publish code to the requested GitHub repo with Actions CI; do not claim GitHub is a hosted Node server. Record real API, target-phone and policy results separately.
