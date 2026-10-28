# Aeconn Demo implementation contract

Source: Notion page 02, revision 2026-10-27, https://app.notion.com/p/406d9731c2408174a24dfa30ff68ee52

One Next.js / TypeScript application, Node 24 built-in SQLite, custom Node server for a same-origin Gemini Live WebSocket relay. Server owns sessions, scope, facts, versions and recipients. Defaults: loopback only, synthetic data, mock analysis, dry-run mail. No actual email is sent during development.

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
- message {text,eventId}; textual answer saved as final, server asks the next missing question.
- pause {}; resume {}; end {} => {caseId}; stop microphone/playback BEFORE awaiting end. Idempotent end restores original advisor WITHOUT PIN; show hand-back prompt, no automatic report expansion.
- generateReport {caseId} => {version}; manual retry permitted; deterministic snapshot idempotence. UI calls after end and on retry.
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
lib/providers.ts exports async analyzeWithProvider(input: {messages: Message[], facts: ProfileField[]}) returning {facts?: ProfileField[], analyses: AnalysisItem[], provider:string}; no PII fields passed. Missing key uses explicitly marked mock. Prefer report.ts analyzeDemo(facts) for fallback; exact interface coordinate with report agent.
lib/voice-server.ts exports attachVoiceServer(httpServer, hooks). Hooks: consumeToken(token:string): {sessionId:string,caseId:string}|null; isActive(sessionId:string):boolean; persist(sessionId:string,event:{eventId:string,turnId:string,role:'user'|'assistant',text:string,interrupted?:boolean}):void; status(sessionId:string,state:string):void. Model/instructions locked server-side. Transport uses /voice?token= one-use short credential. Late events never reopen ended sessions. Expose closeVoiceSession(sessionId) for end; end permits bounded drain but closes input instantly.
server.ts loads env via @next/env, prepares Next, handles HTTP, attaches voice with hooks exported from lib/service.ts. Listen 127.0.0.1 by default. npm dev/start via tsx server.ts.
lib/browser-voice.ts exports a class with documented small UI interface; coordinate directly with UI agent. Supports microphone PCM stream, output audio playback, VAD state, interruption, subtitles, mute, stop all tracks and audio on end, pause/background handling, finite reconnect. Clearly state true service/hardware tests not run without credentials.

## Report integration
lib/report.ts exports analyzeDemo(facts:ProfileField[]):AnalysisItem[], validateAnalyses(analyses, facts, messages):void, buildReport(input:ReportInput): ReportContent, renderPdf(report:ReportContent):Promise<Buffer>. ReportInput/ReportContent defined lib/domain.ts. Six sections, Chinese embedded font, pagination, immutable version content. No contact data guessed by LLM.
lib/scenarios.ts exports scenarios: {name:string,description:string,entry:Category,facts: Partial<ProfileField>[]}[] at least ten synthetic edge scenarios. Root seeds clients/cases/messages/facts with case-local references.

## Verification / release
Unit + API permissions/CSRF/version/outbox integration tests, typecheck, lint, production build, Playwright desktop/mobile UI, actual PDF render inspection, consistent SQLite backup/restore. Publish code to requested GitHub repo with Actions CI; do not claim GitHub is a hosted Node server. Record all untested cloud/device/policy items.
