# Phase 1b verification — localisation, dates, accessibility, theme

Local only. Nothing was deployed, no production database was contacted, no production migration or legacy
audit query was run, and no production domain / OAuth / billing / feature-flag setting was changed.

## Final check run

| Check | Command | Result |
|---|---|---|
| Type check | `pnpm check` | pass |
| Unit tests | `pnpm test` | 113/113 (8 files; includes `server/i18n.test.ts`, `server/dates.test.ts`) |
| DB integration | `pnpm test:db` (`TEST_DATABASE_URL` → local `resulio_it`) | 53/53 |
| Migration replay | `pnpm db:verify` | 5 migrations → 23 tables, matches snapshot 0004 |
| Migration rehearsal | `pnpm db:rehearse` (local disposable MySQL, port 3307) | 113/113 |
| Contrast | `pnpm contrast` | 164/164 enforced pairs |
| Build | `pnpm build` | pass (large-chunk warning is pre-existing) |
| Browser smoke | `node scripts/browser-smoke.mjs` | 55 checks: 52 pass, 3 N/A, 0 fail — [results](browser-smoke-results.md) |

The browser run includes the localisation smoke (`I18N-01..04`), keyboard/accessibility checks (`A11Y-01..03`),
scroll (`SCROLL-01..02`), narrow widths (`CARD-01`, `MOB-05`), theme (`THEME-01..04`) and screenshots (`SHOT-*`).
`SMOKE_ONLY=<regex>` reruns a subset without rewriting the report.

## 1. Fixed issues

| # | Issue | Fix | Verified by |
|---|---|---|---|
| 1 | Dates rendered as `2026 M09 29` | One formatter, `client/src/lib/dates.ts` (below) | `dates.test.ts`, `I18N-01..03` |
| 2 | Hard-coded Azerbaijani UI text | All UI text in `client/src/i18n/catalog/*`; static + runtime checks | `i18n.test.ts`, `I18N-01/02/04` |
| 3 | Activity card labels cut off on narrow screens | Buckets wrap (`auto-fill minmax(8.5rem,1fr)`, `break-words`); titles `line-clamp-2` + `title` | `CARD-01` at 320/360/390/768/1024/1366 |
| 4 | Page kept old scroll position on navigation | `ScrollReset` in `App.tsx`: pathname change → top; back/forward, query tabs, in-session question change, popovers untouched | `SCROLL-01/02` |
| 5 | Nested interactive elements | `Button asChild` + `Link`; cards are a single link without inner buttons | `i18n.test.ts` static rule, `A11Y-01` (30 pages) |
| 6 | Multiple choice not exposed as radios | Native radios in `role="radiogroup"` labelled by the prompt; review page is text only | `A11Y-02` |

Found and fixed during browser QA:

- Pages with a table whose header had `sr-only` text overflowed by 89px at 320px (the absolutely positioned
  text escaped the scroll wrapper). Wrappers are now `relative overflow-x-auto` (assessment list, question stats,
  group students).
- Sidebar: `aria-label="Əsas naviqasiya"` moved from the `<aside>` to the `<nav>` so it is a named navigation landmark.
- Exam session used `bg-muted` as page background; in dark mode cards looked sunken. Now `bg-background`.
- Tabbed pages (`assessment detail`, `group detail`, `analytics`, `library`) keep at least one viewport of height,
  so switching to a short tab does not clamp the scroll position.
- `index.html` had `maximum-scale=1` (blocks zoom, WCAG 1.4.4) — removed.
- Partner page title now matches its navigation label ("Partner paneli").

## 2. Dates

- Single module `client/src/lib/dates.ts`: `formatDateTime`, `formatDay`, `formatTime`, `formatRelative`, `formatDuration`.
  UI code goes through the locale-bound wrappers in `lib/format.ts` (`fmtDateTime`, `fmtWindow`, `fmtRelative`, …).
- Pattern is assembled from numeric `Intl` parts, never from the locale's own pattern (Chromium's `az` data
  produces `2026 M09 29`): az/ru `29.09.2026, 21:34`, en `Sep 29, 2026, 21:34`, always 24-hour.
- Values are absolute instants rendered in the viewer's time zone (optional `timeZone` override); invalid/empty → `—`.
- Enforcement: `i18n.test.ts` fails on `toLocaleString/DateString/TimeString` or `Intl.DateTimeFormat` outside `lib/dates.ts`.
- Browser: 34 en-format dates across 21 teacher pages, 30 az-format dates, zero `M09`, zero cross-locale formats.

## 3. Localisation audit

- Catalogue: `[az, en, ru]` tuples; `i18n.test.ts` checks duplicate keys, empty entries, matching placeholders,
  plural forms, and no Azerbaijani letters in en/ru.
- Static scan of `client/src` (comments stripped): Azerbaijani letters, JSX text, literal
  `placeholder`/`aria-label`/`title`/`alt`.
- Runtime scan (`I18N-01/02`): English locale, every visible text node plus `aria-label`/`placeholder`/`title`/`alt`
  and `document.title`, minus strings stored in the database (names, titles, questions, options). 21 teacher pages,
  10 student pages and an active exam session: zero leftovers.
- Switching language (`I18N-04`) updates shell, page, `html[lang]` and `document.title` without reload; persisted.

Intentionally not translated:

| String | Where | Why |
|---|---|---|
| `Azərbaycanca` | language switch (`lang="az"`) | Endonym: each language is named in itself |
| `<title>` / meta description in `index.html` | first paint only | Replaced at runtime by the translated `document.title`; Azerbaijani is the default market |
| KSQ / BSQ | assessment types | Official Azerbaijani acronyms used as-is in every language |
| Resulio, AI, `AZ · RU · EN` | brand / landing | Brand, product term, language codes |
| Notification text | notification list | Stored as text by the server (in-memory store) — known issue below |
| Teacher/student content | everywhere | User-generated; never translated |

## 4. Theme tokens

Defined once in `client/src/index.css` (`:root` light, `.dark` dark) and exposed to Tailwind via `@theme inline`.
Components use semantic utilities only; `i18n.test.ts` fails on palette utilities (`bg-slate-*` …) or `[#hex]`.

| Token | Light | Dark | Use |
|---|---|---|---|
| background | `#F7F8FB` | `#0B1220` | page |
| card / popover | `#FFFFFF` / `#FFFFFF` | `#131C2E` / `#1A2540` | panels, raised layers |
| muted | `#F1F5F9` | `#1E2A45` | table header, hover, skeleton |
| foreground / secondary / muted-foreground | `#111827` / `#475569` / `#5B677B` | `#F1F5F9` / `#CBD5E1` / `#94A3B8` | text levels |
| primary / primary-foreground | `#0B1220` / `#F7F8FB` | `#00C2D7` / `#0B1220` | primary action (dark: cyan with navy text) |
| link | `#0E7490` | `#67E8F9` | links, selected state |
| input / border-strong | `#8391A7` | `#6B7A99` | form borders (3:1) |
| ring | `#0E7490` | `#00C2D7` | focus |
| destructive | `#B93A2B` | `#F4877A` | error, danger |
| success / warning / info (+ `-surface`) | `#047857` / `#B45309` / `#0E7490` | `#34D399` / `#FCD34D` / `#67E8F9` | status |
| chart-1 / chart-2 | `#0891B2` / `#C2692A` | `#00C2D7` / `#F4A261` | data series |
| sidebar | `#0B1220` | `#0B1220` | navy in both modes |

Status is always icon + text + colour (`StatusBadge` with `lib/status.ts`).

## 5. Light / Dark / System

- Choices: **Açıq rejim**, **Tünd rejim**, **Sistem ayarı** (Settings radios and account-menu radio items).
- First visit follows the OS (`THEME-01`); an explicit choice is stored in `localStorage["resulio.theme"]` and survives reload (`THEME-02`).
- No flash: an inline script in `<head>` applies `.dark` + `color-scheme` (and `lang`) before any stylesheet;
  the first animation frame is already dark under OS-dark and after a reload with a stored dark choice.
- Switching mid-exam from another tab kept the question, saved answers, timer (1198s → 1197s) and open submit dialog, without reload (`THEME-03`).
  Switching from the account menu kept an open "new group" dialog with typed input and the workspace context (`THEME-04`).

## 6. Contrast (`pnpm contrast`, 164/164)

| Pair | Light | Dark | Min |
|---|---|---|---|
| foreground on background | 16.70 | 17.09 | 4.5 |
| muted-foreground on card | 5.72 | 6.64 | 4.5 |
| link on card | 5.36 | — (`#67E8F9` on page 12.92) | 4.5 |
| primary button text | 17.63 | 8.65 | 4.5 |
| destructive on card | 5.67 | 6.97 | 4.5 |
| input border on card | 3.19 | 3.95 | 3 |
| focus ring on card / muted | 5.36 / 4.89 | 7.86 / 6.59 | 3 |
| chart-1 / chart-2 on card | 3.68 / 3.93 | 7.86 / 8.26 | 3 |

Chart axis labels use `muted-foreground` (dark fill measured in the browser: `rgb(148,163,184)` on `#131C2E`, 6.64:1).
Informational only: card vs page and chart grid lines (decorative).

## 7. Accessibility

- Multiple choice: `radiogroup` labelled by the prompt, native radios with `checked` exposed; Tab reaches the group,
  Space/Arrow keys select, visible 2px `#0E7490` outline on the option. Accessibility tree:
  `radiogroup "Azərbaycanın paytaxtı hansıdır?" → radio "B. Bakı" [checked]`. The session never shows or marks the correct answer; the result review has no selectable controls.
- Keyboard: 30 consecutive tab stops on the teacher dashboard all show a focus indicator; Enter follows a nav link; Space opens the account menu.
- After "Next", focus moves to the new question region (`preventScroll`), announced as "Sual 2 / 5".
- No nested interactive elements on 30 pages. Zoom is no longer blocked.
- Not done: a manual pass with a real screen reader (NVDA / VoiceOver). Checks are programmatic.

## 8. Mobile

- 30 teacher and student pages at 320px and 390px (60 combinations): no horizontal scrolling (`MOB-05`).
- Activity cards at 320/360/390/768/1024/1366: labels inside the card, nothing truncated without a full-text label (`CARD-01`).
- Existing phone flows still pass: landing, drawer, exam answer/submit, teacher dashboard and participants (`MOB-01..04`).
- Exam session at 360×420: autosave and "Next" do not reset scroll (`SCROLL-02`).

## 9. Screenshots (`docs/verification/screenshots/`)

| Surface | Light | Dark |
|---|---|---|
| Teacher dashboard | `shot-teacher-light.png` | `shot-teacher-dark.png` |
| Student home | `shot-student-light.png` | `shot-student-dark.png` |
| Active exam | `shot-exam-light.png` | `shot-exam-dark.png` |
| Mobile teacher | `shot-mobile-teacher-light.png` | `shot-mobile-teacher-dark.png` |
| Mobile exam | `shot-mobile-exam-light.png` | `shot-mobile-exam-dark.png` |

Also: `shot-dark-*.png` (analytics, charts, participants, builder, settings, landing), `theme-03-dialog-dark.png`,
`theme-04-dialog-dark.png`, `i18n-01-teacher-en.png`, `i18n-04-en.png`, `i18n-04-ru.png`, `card-01-320.png`,
`a11y-02-keyboard-selected.png`, `a11y-02-review.png`.

## 10. Cleanup

| File | Action | Reason |
|---|---|---|
| `vite.config.ts.bak` | Deleted | Unreferenced template backup (still loaded the removed Manus runtime plugin) |
| `.codemod-colors.cjs`, `.colors.txt` | Deleted in Phase 1a | Codemod helper and its output |

The repository root has no temporary files. Diagnostic scripts used during QA lived in the OS temp folder.

## 11. Local services

Both were stopped after the final run. Credentials of the disposable local MySQL users are kept outside the
repository; `<local-password>` below stands for them. `SESSION_SECRET` can be any local value of 32+ characters,
but it must be the one `scripts/smoke-personas.ts` used to mint `smoke-tokens.json`.

Restart (PowerShell):

```powershell
$env:PATH = "$env:USERPROFILE\.tools\node-v24.21.0-win-x64;$env:PATH"

# MySQL 8.4 (disposable, 127.0.0.1:3307, databases resulio_dev and resulio_it)
cd "$env:USERPROFILE\.tools\mysql-test"
& "..\mysql-8.4.11-winx64\bin\mysqld.exe" "--defaults-file=my.ini" --console

# Dev server (second terminal, repo root) — http://localhost:3000
$env:NODE_ENV = "development"
$env:DATABASE_URL = "mysql://resulio_test:<local-password>@127.0.0.1:3307/resulio_dev"
$env:SESSION_SECRET = "<local session secret>"
$env:PORT = "3000"
pnpm exec tsx server/_core/index.ts
```

Stop:

```powershell
& "$env:USERPROFILE\.tools\mysql-8.4.11-winx64\bin\mysqladmin.exe" -h 127.0.0.1 -P 3307 -u root -p shutdown
# dev server: Ctrl+C in its terminal
```

Browser smoke (needs both running):

```powershell
$env:SMOKE_DATABASE_URL = "mysql://resulio_test:<local-password>@127.0.0.1:3307/resulio_dev"
$env:SMOKE_TOKENS_FILE = "$env:USERPROFILE\.tools\mysql-test\smoke-tokens.json"
$env:PLAYWRIGHT_BROWSERS_PATH = "$env:USERPROFILE\.tools\smoke-browser\browsers"
node scripts/browser-smoke.mjs
```

## 12. Known issues

1. Notifications are stored as Azerbaijani text by the server (in-memory store), so they do not follow the language switch.
   Store a message key + parameters when notifications move to MySQL.
2. Unreachable template files remain (`ComponentShowcase`, `AIChatBox`, `ManusDialog`, `Map`, `DashboardLayout`,
   `DashboardLayoutSkeleton`); they are excluded from the scans and contain hard-coded colours. Recommend deleting.
3. No manual screen-reader pass yet; Russian was smoke-tested on the shell only (catalogue completeness is tested).
4. The focus check treats any box-shadow as a focus indicator; it cannot judge visual strength.
5. Dates use the viewer's device time zone; there is no per-user or per-workspace time-zone setting.
6. On a phone the exam's question navigator sits at the bottom of the screen with empty space above it on short questions (layout choice, not a defect).
7. Real Google sign-in, material downloads and assignment activity remain untested locally (N/A rows in the smoke report).
8. Build warns about a large client chunk (pre-existing).

## 13. Next task

Immutable Assessment Versions + Question Bank Snapshot Model + Assessment Assignment Version Binding + Student
Session Version Binding. The production path stays: backup → isolated restored copy → legacy audit query pack →
review → teacher mapping decision → migration preview → production window decision. 0002/0003 do not run in
production before the legacy audit results are reviewed.
