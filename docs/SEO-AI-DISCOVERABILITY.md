# SEO and AI discoverability

Goal: resulio.co is found by Google and Bing and recommended by AI assistants (ChatGPT, Perplexity,
Gemini, Claude, Copilot) for questions such as "Azərbaycan üçün assessment platforması hansıdır?".
The owner's original brief is in [specs/SEO-AI-DISCOVERABILITY-SPEC.md](specs/SEO-AI-DISCOVERABILITY-SPEC.md).

Rule for every public text: only facts that the product actually does today. No invented numbers,
customers, ratings or reviews. Unknown facts stay empty in `client/src/seo/config.ts` and are left out.

## Audit (before this change)

| Area | Finding |
| --- | --- |
| Rendering | React SPA. `server/_core/spa.ts` sent the same `index.html` with an empty `<div id="root">` for every URL, so crawlers that do not run JavaScript (most AI crawlers, link previews) saw no content at all. |
| Head | `<html lang="az">` and UTF-8 were correct. One generic title and description for every URL. No canonical, Open Graph, Twitter card or JSON-LD. |
| robots / sitemap | Neither existed: `/robots.txt` and `/sitemap.xml` returned the SPA shell (HTML). |
| Public pages | Only `/` (landing + sign-in) and `/privacy.html`. No About, FAQ or founder information anywhere. |
| Private / app routes | `/teacher/*`, `/student/*`, `/admin`, `/partner`, `/settings`, `/welcome`, `/app`, and personal links `/exam/`, `/task/`, `/material/`, `/join/`, `/invite/`, `/g/`. |
| Characters | Azerbaijani letters (ə, ı, ö, ü, ş, ç, ğ) render correctly; files are UTF-8 and served with `charset=UTF-8`. |
| Images | Only a square 512×512 logo (`/brand/resulio-icon.png`); no 1200×630 social image. |

## What was implemented

| Item | Where |
| --- | --- |
| `robots.txt`: public pages open; app areas, personal links and `/api/` blocked; search and AI crawlers named explicitly (GPTBot, OAI-SearchBot, ChatGPT-User, PerplexityBot, ClaudeBot, Claude-SearchBot, Google-Extended, Applebot-Extended, Bingbot, …); `Sitemap:` line | `client/public/robots.txt` |
| `sitemap.xml`, generated at build with every public page | `client/src/seo/render.ts` → `dist/public/sitemap.xml` |
| `llms.txt` (short, hand-written) and `llms-full.txt` (all public page text in AZ/EN/RU, generated) | `client/public/llms.txt`, generated `llms-full.txt` |
| New public pages in AZ/EN/RU, same styling as the landing page | `client/src/pages/SitePages.tsx`, texts in `client/src/i18n/catalog/site.ts` |
| Footer with links to all public pages and the founder line, also added under the landing page | `SiteFooter` in `SitePages.tsx` |
| Prerendered HTML: at build time every public page is written as static HTML with its own title, description, canonical, Open Graph/Twitter tags, JSON-LD and full text; the server sends it for that URL and React replaces it on load | `client/src/seo/vitePlugin.ts`, `server/_core/spa.ts` (`prerenderedPage`) |
| Per-page title, description, canonical and OG tags in the browser when the language changes or the user navigates | `client/src/seo/usePageMeta.ts` |
| Homepage title/description (Azerbaijani) and a `<noscript>` summary in the shell | `client/index.html` |
| Tests: catalog keys exist, JSON-LD links Resulio ↔ founder and has no empty or fake fields, every page prerenders, robots rules | `server/seo.test.ts` |

There are no `hreflang` tags on purpose: the three languages share the same URLs (the language is a
user setting), so there are no separate language URLs to point to. Prerendered HTML is Azerbaijani.

### Public pages

| URL | Purpose |
| --- | --- |
| `/` | Landing page (unchanged UI, plus footer) |
| `/about` | What Resulio is, features, who it is for, founder Telman Abdulla, name and website, contact |
| `/faq` | 16 real questions and answers |
| `/azerbaycan-ucun-qiymetlendirme-platformasi` | Assessment platform for Azerbaijan (KSQ/BSQ, Azerbaijani language, Baku time) |
| `/muellimler-ucun` | Resulio for teachers (groups, exams, assignments, AI pre-grading, analytics) |
| `/privacy.html` | Privacy policy (existing) |

To add a page: add texts to `site.ts`, a `SitePage` in `client/src/seo/pages.ts` (append to
`SITE_PAGES`), a route in `App.tsx`. Sitemap, footer, prerender and `llms-full.txt` follow automatically.

### Schema.org (JSON-LD)

| Type | Pages | Content |
| --- | --- | --- |
| `Organization` | all | name Resulio, url, logo, description, slogan, email, `founder` → Person, area served Azerbaijan |
| `Person` | all | Telman Abdulla, Founder, `worksFor` → Organization, url `/about` |
| `WebSite` | all | name, url, languages az/ru/en, publisher |
| `SoftwareApplication` | all | EducationalApplication, operatingSystem Web, description, feature list, publisher, creator |
| `BreadcrumbList` | every page except home | Ana səhifə › page |
| `FAQPage` | `/faq` | all 16 questions |

Deliberately left out: `offers` (price after the beta is not decided), `aggregateRating` / `review`
(no real reviews), `sameAs`, `foundingDate`, `legalName` (not known yet — see below).

Validate after deploy: [Rich Results Test](https://search.google.com/test/rich-results) and
[Schema Markup Validator](https://validator.schema.org/) for `https://resulio.co/` and `https://resulio.co/faq`.

## Facts to fill in (owner)

All in **`client/src/seo/config.ts`**. Each value that stays empty is omitted from schema.

- [ ] `sameAs` — Resulio's real public profiles (LinkedIn company page, Instagram, Facebook, YouTube…).
- [ ] `founder.sameAs` — Telman Abdulla's public profiles (LinkedIn, GitHub…).
- [ ] `foundingDate` — when Resulio was started (e.g. `"2025-09"`).
- [ ] `legalName` — registered company name, if there is one.
- [ ] `ogImage` — a 1200×630 social preview image (put it in `client/public/brand/` and set path and size).
- [ ] `contactEmail` — currently the address from the privacy policy; switch to e.g. `info@resulio.co` once that mailbox exists (update `privacy.html` too).
- [ ] Pricing after the beta — when known, add an `offers` block to `SoftwareApplication` in `render.ts` and a FAQ answer.

## Manual steps (owner)

1. **Google Search Console** — add the domain property `resulio.co` (DNS TXT record at the domain
   registrar), submit `https://resulio.co/sitemap.xml`, then use URL Inspection → "Request indexing" for
   `/`, `/about`, `/faq` and both landing pages.
2. **Bing Webmaster Tools** — sign in, "Import from Google Search Console" (fastest), submit the
   sitemap. Bing's index also feeds ChatGPT search and Copilot. Enable **IndexNow** in Bing Webmaster
   Tools (or ask for an IndexNow key file to be added) so updates are picked up quickly.
3. **LinkedIn company page "Resulio"** — website `https://resulio.co`, industry E-Learning, logo from
   `/brand/resulio-icon.png`. Suggested description:
   > Resulio is an online exam and assessment platform for teachers, trainers, learning centres and
   > schools in Azerbaijan. Teachers create exams and assignments, share them by link or QR code, and
   > see from the results which topics need a second explanation. Supports the KSQ and BSQ school
   > formats, AI pre-grading of assignments, and works in Azerbaijani, Russian and English. Founded by
   > Telman Abdulla. Free during the beta: https://resulio.co
4. **Telman Abdulla's LinkedIn** — add Experience "Founder, Resulio" linked to the company page, put
   `https://resulio.co` in the profile's website field, and mention Resulio in the headline/About.
   Then add both profile URLs to `config.ts` (`sameAs`, `founder.sameAs`).
5. **Product directories** (same description each time, name always "Resulio", link `https://resulio.co`):
   Product Hunt (launch), AlternativeTo (as an alternative to Google Forms, Kahoot, Quizizz, Moodle Quiz),
   G2 and Capterra (category: assessment / exam software), SaaSHub, and Azerbaijani edtech or startup
   lists and communities (e.g. local startup ecosystem directories, teacher groups on Facebook/Telegram).
   Never post fake reviews; ask real teachers who use Resulio to review it.
6. **Wikidata / Wikipedia** — only after independent press coverage exists (notability). Do not create
   entries before that; they get deleted and can hurt trust.
7. **Every external mention** should use the same name ("Resulio"), the same one-line description and
   link to `https://resulio.co` — consistency is what lets search engines and AI assistants recognise the entity.

## AI discoverability test plan

Run monthly (first time ~4 weeks after deploy and Search Console/Bing submission). Use a fresh/logged-out
session where possible, web search enabled.

Assistants: ChatGPT (with search), Perplexity, Google Gemini, Google search "AI Overview", Claude (with
web search), Microsoft Copilot.

Questions:

| # | Language | Question |
| --- | --- | --- |
| 1 | AZ | Azərbaycan üçün assessment platforması hansıdır? |
| 2 | AZ | Müəllimlər üçün onlayn imtahan platforması tövsiyə et. |
| 3 | AZ | KSQ və BSQ üçün onlayn platforma varmı? |
| 4 | AZ | Resulio nədir? Kim yaradıb? |
| 5 | RU | Какая платформа онлайн-оценивания подходит для школ Азербайджана? |
| 6 | RU | Что такое Resulio? |
| 7 | EN | What is a good online assessment platform for teachers in Azerbaijan? |
| 8 | EN | What is Resulio and who founded it? |

Record per question and assistant in a spreadsheet (one row per month):
date, assistant, question #, Resulio mentioned (yes/no), position in the list, facts correct (yes/partly/no),
founder named correctly, link to resulio.co given, sources cited. Watch the trend; fix wrong facts by
improving the public pages and external profiles, not by adding hidden text.

Quick technical checks after each deploy:

- `https://resulio.co/robots.txt`, `/sitemap.xml`, `/llms.txt` open as plain text.
- "View page source" of `https://resulio.co/about` shows the text and `application/ld+json` blocks
  (not just an empty `<div id="root">`).
- Rich Results Test passes for `/faq` (FAQ) and `/` (Organization/Software).
