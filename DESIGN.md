# Design

## Source of truth
- Status: Active
- Last refreshed: 2026-10-30
- Primary surfaces: advisor/reviewer workspace, client interview, report, login, settings, deleted cases.
- Evidence reviewed: `PRD.md`, `mvp.md`, `app/page.tsx`, `app/globals.css`, desktop/mobile screenshots, existing Playwright flows. User direction: 高级感、私人定制感; retain working Aeconn Demo.
- Reference: Wix Design System layout guidance (via Wix plugin): consistency, inclusive layouts, deliberate hierarchy/white space, related content kept together. This is a local Next.js redesign, not a Wix migration or deployment.

## Brand
- Personality: calm private advisory studio; attentive, discreet, precise.
- Trust signals: real client identity, clear case status, visible reviewer confirmation, accurate AI/demo indicators.
- Avoid: invented credentials, premium tiers, performance claims, financial outcomes, ornamental dashboards, oversized pills, loud gold gradients.

## Product goals
- Make the selected client's dossier and next action immediately clear.
- Give clients a focused, reassuring interview; give advisors readable records and reports.
- No backend, AI, usage-limit, authorization, source-provenance or mail behavior changes.
- Success: visible desktop/mobile improvement with all existing workflows usable.

## Personas and jobs
- Advisor: select/create a case, interview or record a meeting, inspect facts/report, approve preview.
- Client: answer one question at a time, pause/end easily, read subtitles.
- Charles: distinguish review queue from client list and check the assigned report.
- Context: desktop Chrome/Edge and touch/mobile browsers. No physical-device acceptance inferred from screenshots.

## Information architecture
- Keep 客户 / 复核 / 设置 / 已删除案例 with current role restrictions.
- Desktop: branded navigation, compact client list, main dossier workspace.
- Case: quiet metadata header, prominent client identity, grouped actions, tabs, readable content.
- Client interview (2026-10-30 revision): a single centered window, maximum 880px wide, replaces the asymmetric brand/chat split. Keep restrained branding in the header; welcome choices, conversation and controls share the same center axis. This supersedes the previous two-column client shell shown in the user's screenshot.
- Client interview never exposes advisor details, reports or knowledge cards.

## Design principles
- Hierarchy before decoration: one strong action, quiet secondary actions, restrained danger actions.
- Personalization uses existing client/advisor/case data only; no invented statistics.
- Reuse controls and handlers; style must not simulate actions or replace real UI with a mockup.
- Keep copy concrete and Chinese-first; small English brand labels are decorative only.

## Visual language
- Color: warm paper #F7F5F0; panels #FFFEFB; ink #21332D; deep green #203B34; muted text #68736C; brass #A18047; borders #E3E3D9.
- Typography: native system sans body, Georgia/Chinese serif fallback for editorial headings and names. No remote font dependency. Body 15–16px, metadata 12–13px, dossier names 30–36px desktop.
- Rhythm: 4/8px base; desktop section padding 28–36px; compact 16–20px mobile.
- Shapes: 8–12px controls, 16px larger panels; fine borders, low elevation, no repeated heavy shadows.
- Motion: short color/opacity transitions only; honor reduced motion; no perpetual decorative animations.
- Imagery: monogram and abstract CSS linework only; no stock portraits or generated customer pictures.

## Components
- Reuse Brand, Icon, current tabs/buttons/forms, case rows, report sections, chat, recording and reconciliation panels.
- Changes: expanded desktop rail, refined identity header/action grouping, case counters, timeline treatment, bespoke client welcome and conversation shell.
- CSS owner: `app/globals.css`; markup/content owner: `app/page.tsx`. Keep scoped states and accessible names stable.

## Accessibility
- Target WCAG AA contrast for text; visible keyboard focus, real labels, correct button semantics.
- Touch controls at least 44px where practical; metadata smaller than body but not essential instructions.
- Preserve status/error text, interrupted/incomplete reply labels, disabled/loading states.
- No hidden functionality behind hover alone; reduced-motion behavior.

## Responsive behavior
- >=1280px: full navigation with text; compact client list; flexible main panel.
- 761–1279px: narrow navigation and controlled action wrapping; readable labels.
- <=760px: existing list/detail navigation and bottom rail, safe-area padding; no horizontal page overflow.
- 390/844 and 1440/900 are screenshot checkpoints; inspect 768 and 1024 widths too.
- Client window: centered horizontally and vertically within available desktop/tablet height; at 886px wide retain one column. On phones use the full viewport with safe-area padding. Only the conversation/welcome content scrolls; header and active pause/end/input controls stay reachable, including short 390×667 viewports.

## Interaction states
- Empty: useful next step and calm illustration/monogram, no fake metrics.
- Loading: preserve existing busy indicators and disabled actions.
- Error/offline: keep readable recovery copy and saved-answer retry behavior.
- Success: subtle confirmation; do not automatically open a report after handing back.

## Content voice
- Warm, clear, professional; avoid technical/provider details in decorative headlines.
- Keep demo / synthetic labels and permission information accurate.
- Retain accessible action labels used in existing flows; add context around them when useful.

## Implementation constraints
- Node/Next/React/CSS already in project; no new packages, remote fonts, local models or Wix migration.
- Preserve all prior dirty work. No API-key edits, paid calls, usage-limit changes or GitHub publication in this task.
- Test existing flows, typecheck/lint/build, screenshot desktop/client/mobile/reviewer; use isolated synthetic fixtures and mock providers.

## Open questions
- User has not provided a separate brand kit; colors/typography above are the first implementation direction and can be adjusted after seeing the Demo.
- Real target-phone visual/interaction acceptance remains separate from browser viewport checks.
