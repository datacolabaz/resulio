import { translate, type Locale, type MessageKey } from "../i18n/messages";
import { absoluteUrl, SITE } from "./config";
import { FEATURES, HOME, SITE_PAGES, type SitePage } from "./pages";

/**
 * Build-time output for crawlers: JSON-LD, head tags, static page HTML, sitemap and llms-full.txt.
 * Prerendered pages are Azerbaijani (the primary language); the app switches language client-side
 * on the same URLs, so there are no hreflang alternates.
 */
const LOCALE: Locale = "az";
const tx = (key: MessageKey, locale: Locale = LOCALE) => translate(locale, key);

const ORG_ID = `${SITE.url}/#organization`;
const FOUNDER_ID = `${SITE.url}/#founder`;
const WEBSITE_ID = `${SITE.url}/#website`;
const APP_ID = `${SITE.url}/#software`;

const nonEmpty = <T extends Record<string, unknown>>(o: T) =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined && !(Array.isArray(v) && v.length === 0)));

/** Organization, founder, website and product — the same on every page. */
export function siteJsonLd() {
  return {
    "@context": "https://schema.org",
    "@graph": [
      nonEmpty({
        "@type": "Organization",
        "@id": ORG_ID,
        name: SITE.name,
        legalName: SITE.legalName,
        url: absoluteUrl("/"),
        logo: { "@type": "ImageObject", url: absoluteUrl(SITE.logo.path), width: SITE.logo.width, height: SITE.logo.height },
        description: tx("site.definition"),
        slogan: tx("brand.tagline"),
        email: SITE.contactEmail,
        foundingDate: SITE.foundingDate,
        founder: { "@id": FOUNDER_ID },
        areaServed: { "@type": "Country", name: "Azerbaijan" },
        sameAs: SITE.sameAs,
      }),
      nonEmpty({
        "@type": "Person",
        "@id": FOUNDER_ID,
        name: SITE.founder.name,
        jobTitle: SITE.founder.jobTitle,
        worksFor: { "@id": ORG_ID },
        url: absoluteUrl("/about"),
        sameAs: SITE.founder.sameAs,
      }),
      {
        "@type": "WebSite",
        "@id": WEBSITE_ID,
        url: absoluteUrl("/"),
        name: SITE.name,
        inLanguage: SITE.languages,
        publisher: { "@id": ORG_ID },
      },
      {
        "@type": "SoftwareApplication",
        "@id": APP_ID,
        name: SITE.name,
        url: absoluteUrl("/"),
        applicationCategory: "EducationalApplication",
        operatingSystem: "Web",
        description: translate("en", "site.definition"),
        inLanguage: SITE.languages,
        featureList: FEATURES.map((key) => translate("en", key)),
        publisher: { "@id": ORG_ID },
        creator: { "@id": FOUNDER_ID },
      },
    ],
  };
}

/** Breadcrumbs for every page but home, plus FAQPage where the FAQ is the page's main content. */
export function pageJsonLd(page: SitePage) {
  const graph: object[] = [];
  if (page.id !== "home") {
    graph.push({
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: tx(HOME.nav), item: absoluteUrl("/") },
        { "@type": "ListItem", position: 2, name: tx(page.nav), item: absoluteUrl(page.path) },
      ],
    });
  }
  if (page.id === "faq") {
    graph.push({
      "@type": "FAQPage",
      inLanguage: LOCALE,
      mainEntity: page.sections.flatMap((s) => s.faq ?? []).map(({ q, a }) => ({
        "@type": "Question",
        name: tx(q),
        acceptedAnswer: { "@type": "Answer", text: tx(a) },
      })),
    });
  }
  return graph.length ? { "@context": "https://schema.org", "@graph": graph } : null;
}

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** `</script>` inside a string must not end the JSON-LD block early. */
export const jsonLdScript = (data: object) => `<script type="application/ld+json">${JSON.stringify(data).replace(/</g, "\\u003c")}</script>`;

/** Per-page head tags; the shell's generic title and description are replaced, not duplicated. */
export function pageHead(page: SitePage) {
  const title = escapeHtml(tx(page.title));
  const description = escapeHtml(tx(page.description));
  const url = absoluteUrl(page.path);
  const image = SITE.ogImage ?? SITE.logo;
  const tags = [
    `<link rel="canonical" href="${url}" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:locale" content="az_AZ" />`,
    `<meta property="og:title" content="${title}" />`,
    `<meta property="og:description" content="${description}" />`,
    `<meta property="og:url" content="${url}" />`,
    `<meta property="og:image" content="${absoluteUrl(image.path)}" />`,
    `<meta property="og:image:width" content="${image.width}" />`,
    `<meta property="og:image:height" content="${image.height}" />`,
    `<meta name="twitter:card" content="${SITE.ogImage ? "summary_large_image" : "summary"}" />`,
    `<meta name="twitter:title" content="${title}" />`,
    `<meta name="twitter:description" content="${description}" />`,
    `<meta name="twitter:image" content="${absoluteUrl(image.path)}" />`,
  ];
  const ld = pageJsonLd(page);
  if (ld) tags.push(jsonLdScript(ld));
  return { title, description, tags: tags.join("\n    ") };
}

/** Plain semantic HTML of a page; React replaces it on load, crawlers without JavaScript read it as is. */
export function pageBody(page: SitePage) {
  const p = (key: MessageKey) => `<p>${escapeHtml(tx(key))}</p>`;
  const sections = page.sections
    .map((s) => {
      const parts: string[] = [];
      if (s.heading) parts.push(`<h2>${escapeHtml(tx(s.heading))}</h2>`);
      for (const key of s.paragraphs ?? []) parts.push(p(key));
      if (s.items) {
        const tag = s.ordered ? "ol" : "ul";
        parts.push(`<${tag}>${s.items.map((key) => `<li>${escapeHtml(tx(key))}</li>`).join("")}</${tag}>`);
      }
      for (const { q, a } of s.faq ?? []) parts.push(`<h3>${escapeHtml(tx(q))}</h3>`, p(a));
      if (s.email) parts.push(`<p><a href="mailto:${SITE.contactEmail}">${SITE.contactEmail}</a></p>`);
      return `<section>${parts.join("")}</section>`;
    })
    .join("");
  const links = SITE_PAGES.map((x) => `<li><a href="${x.path}">${escapeHtml(tx(x.nav))}</a></li>`).join("");
  return [
    `<header><a href="/"><img src="${SITE.logo.path}" alt="${SITE.name}" width="44" height="44" /> ${SITE.name}</a> — ${escapeHtml(tx("brand.tagline"))}</header>`,
    `<main>`,
    page.id !== "home" ? `<nav aria-label="${escapeHtml(tx("site.breadcrumb"))}"><a href="/">${escapeHtml(tx(HOME.nav))}</a> › ${escapeHtml(tx(page.nav))}</nav>` : "",
    page.eyebrow ? p(page.eyebrow) : "",
    `<h1>${escapeHtml(tx(page.h1))}</h1>`,
    p(page.lead),
    sections,
    `</main>`,
    `<footer><p>${escapeHtml(tx("site.definitionShort"))}</p><ul>${links}<li><a href="/privacy.html">${escapeHtml(tx("site.nav.privacy"))}</a></li></ul><p>${escapeHtml(tx("site.footer.founder"))}</p></footer>`,
  ].join("");
}

/** The shell with this page's head and content; `shell` is the built index.html. */
export function prerender(shell: string, page: SitePage) {
  const head = pageHead(page);
  const html = shell
    .replace(/<title>[^<]*<\/title>/, `<title>${head.title}</title>`)
    .replace(/<meta name="description" content="[^"]*" \/>/, `<meta name="description" content="${head.description}" />\n    ${head.tags}`)
    .replace(`<div id="root"></div>`, `<div id="root"><div data-prerender>${pageBody(page)}</div></div>`);
  if (!html.includes(`<link rel="canonical"`) || !html.includes(`<h1>`)) throw new Error(`prerender: shell markers not found for ${page.path}`);
  return html;
}

export function sitemapXml(lastmod: string) {
  const urls = SITE_PAGES.map(
    (page) => `  <url>\n    <loc>${absoluteUrl(page.path)}</loc>\n    <lastmod>${lastmod}</lastmod>\n  </url>`,
  ).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

/** Every public page in all three languages as Markdown, for AI assistants (llmstxt.org convention). */
export function llmsFullTxt() {
  const out: string[] = [`# ${SITE.name}`, "", `> ${translate("en", "site.definition")}`, ""];
  out.push(`- Website: ${absoluteUrl("/")}`, `- Founder: ${SITE.founder.name}`, `- Contact: ${SITE.contactEmail}`, `- Languages: Azerbaijani, Russian, English`, "");
  for (const locale of ["en", "az", "ru"] as Locale[]) {
    for (const page of SITE_PAGES) {
      out.push(`## ${translate(locale, page.h1)} (${locale})`, "", `URL: ${absoluteUrl(page.path)}`, "", translate(locale, page.lead), "");
      for (const s of page.sections) {
        if (s.heading) out.push(`### ${translate(locale, s.heading)}`, "");
        for (const key of s.paragraphs ?? []) out.push(translate(locale, key), "");
        (s.items ?? []).forEach((key, i) => out.push(`${s.ordered ? `${i + 1}.` : "-"} ${translate(locale, key)}`));
        if (s.items) out.push("");
        for (const { q, a } of s.faq ?? []) out.push(`**${translate(locale, q)}**`, "", translate(locale, a), "");
        if (s.email) out.push(SITE.contactEmail, "");
      }
    }
  }
  return out.join("\n");
}
