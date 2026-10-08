import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isMessageKey } from "../client/src/i18n/messages";
import { SITE } from "../client/src/seo/config";
import { SITE_PAGES } from "../client/src/seo/pages";
import { llmsFullTxt, pageJsonLd, prerender, siteJsonLd, sitemapXml } from "../client/src/seo/render";
import { prerenderedPage } from "./_core/spa";

const PUBLIC = join(__dirname, "..", "client", "public");
const shell = `<html lang="az"><head><title>x</title>\n<meta name="description" content="y" />\n</head><body><div id="root"></div></body></html>`;

const ldBlocks = (html: string) =>
  [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));

describe("public site pages", () => {
  it("only reference existing catalog keys", () => {
    const keys = SITE_PAGES.flatMap((p) => [
      p.title, p.description, p.nav, p.h1, p.lead, ...(p.eyebrow ? [p.eyebrow] : []),
      ...p.sections.flatMap((s) => [...(s.heading ? [s.heading] : []), ...(s.paragraphs ?? []), ...(s.items ?? []), ...(s.faq ?? []).flatMap((f) => [f.q, f.a])]),
    ]);
    expect(keys.filter((k) => !isMessageKey(k))).toEqual([]);
  });

  it("links Resulio to its founder in JSON-LD and leaves out unknown facts", () => {
    const graph = siteJsonLd()["@graph"] as Record<string, unknown>[];
    const org = graph.find((n) => n["@type"] === "Organization")!;
    const person = graph.find((n) => n["@type"] === "Person")!;
    expect(org.name).toBe("Resulio");
    expect(org.founder).toEqual({ "@id": person["@id"] });
    expect(person).toMatchObject({ name: "Telman Abdulla", worksFor: { "@id": org["@id"] } });
    for (const node of graph) for (const value of Object.values(node)) expect(value === null || (Array.isArray(value) && value.length === 0)).toBe(false);
    expect(graph.some((n) => "aggregateRating" in n || "review" in n)).toBe(false);
  });

  it("prerenders head, JSON-LD and text for every page", () => {
    for (const page of SITE_PAGES) {
      const html = prerender(shell, page);
      expect(html).toContain(`<link rel="canonical" href="https://resulio.co${page.path}" />`);
      expect(html.match(/<title>/g)).toHaveLength(1);
      expect(html.match(/<meta name="description"/g)).toHaveLength(1);
      expect(html).toMatch(/<div id="root"><div data-prerender><header>.*<h1>.+<\/h1>.*<\/div><\/div>/);
      expect(html).toContain("Telman Abdulla");
      ldBlocks(html);
    }
    expect(pageJsonLd(SITE_PAGES.find((p) => p.id === "faq")!)?.["@graph"].map((n: any) => n["@type"])).toEqual(["BreadcrumbList", "FAQPage"]);
    expect(pageJsonLd(SITE_PAGES.find((p) => p.id === "home")!)).toBeNull();
  });

  it("names the official partners on every page, in llms.txt and llms-full.txt", () => {
    const domains = ["sayt.az", "metbuat.az", "spotva.co", "tehvil.az"];
    const llms = readFileSync(join(PUBLIC, "llms.txt"), "utf8");
    const full = llmsFullTxt();
    for (const domain of domains) {
      const link = `<a href="https://${domain}" target="_blank" rel="noopener">${domain}</a>`;
      for (const page of SITE_PAGES) expect(prerender(shell, page)).toContain(link);
      expect(prerender(shell, SITE_PAGES[0])).toContain(`alt="${domain} logo"`);
      expect(llms).toContain(`[${domain}](https://${domain})`);
      expect(full).toContain(`[${domain}](https://${domain})`);
    }
    expect(prerender(shell, SITE_PAGES[0])).toContain("<h2>Rəsmi tərəfdaşlar</h2>");
  });

  it("serves every partner logo from the site itself", () => {
    for (const { logo } of SITE.partners) {
      for (const src of [logo.src, logo.srcOnDark].filter(Boolean) as string[]) {
        expect(src).toMatch(/^\/partners\//);
        expect(existsSync(join(PUBLIC, src))).toBe(true);
      }
    }
  });

  it("hides prerendered text from JavaScript visitors before first paint", () => {
    const index = readFileSync(join(__dirname, "..", "client", "index.html"), "utf8");
    const head = index.slice(index.indexOf("<head>"), index.indexOf("</head>"));
    const addJs = head.indexOf(`<script>document.documentElement.classList.add("js");</script>`);
    expect(addJs).toBeGreaterThan(-1);
    expect(head).toContain("html.js [data-prerender]{display:none!important}");
    expect(addJs).toBeLessThan(head.search(/<link|<style|<script(?!>document\.documentElement\.classList\.add)/));
  });

  it("lists every page in the sitemap and llms-full.txt", () => {
    const xml = sitemapXml("2026-01-01");
    const full = llmsFullTxt();
    for (const page of SITE_PAGES) {
      expect(xml).toContain(`<loc>https://resulio.co${page.path}</loc>`);
      expect(full).toContain(`https://resulio.co${page.path}`);
    }
  });
});

describe("static hosting", () => {
  it("serves prerendered pages by path and nothing else", () => {
    const dist = mkdtempSync(join(tmpdir(), "seo-"));
    mkdirSync(join(dist, "_pages"));
    writeFileSync(join(dist, "_pages", "index.html"), "home");
    writeFileSync(join(dist, "_pages", "about.html"), "about");
    expect(prerenderedPage(dist, "/")).toBe(join(dist, "_pages", "index.html"));
    expect(prerenderedPage(dist, "/about")).toBe(join(dist, "_pages", "about.html"));
    expect(prerenderedPage(dist, "/about/")).toBe(join(dist, "_pages", "about.html"));
    for (const p of ["/teacher", "/../about", "/about/x", "/ABOUT"]) expect(prerenderedPage(dist, p)).toBeNull();
  });

  it("robots.txt keeps private areas out and lets AI crawlers in", () => {
    const robots = readFileSync(join(PUBLIC, "robots.txt"), "utf8").replace(/\r\n/g, "\n");
    for (const bot of ["GPTBot", "OAI-SearchBot", "ChatGPT-User", "PerplexityBot", "ClaudeBot", "Claude-SearchBot", "Google-Extended", "Applebot-Extended", "Bingbot"]) {
      expect(robots).toContain(`User-agent: ${bot}\n`);
    }
    for (const path of ["/teacher", "/student", "/admin", "/task/", "/invite/", "/material/", "/syllabus/", "/api/"]) expect(robots).toContain(`Disallow: ${path}\n`);
    for (const page of SITE_PAGES.filter((p) => p.path !== "/")) expect(robots).not.toContain(`Disallow: ${page.path}\n`);
    expect(robots).toContain("Sitemap: https://resulio.co/sitemap.xml");
  });

  it("robots.txt lets link-preview bots read shared syllabus links and nothing else private", () => {
    const robots = readFileSync(join(PUBLIC, "robots.txt"), "utf8").replace(/\r\n/g, "\n");
    const groups = robots.split(/\n\s*\n/).filter((g) => g.includes("User-agent:"));
    const groupOf = (bot: string) => groups.find((g) => g.split("\n").some((l) => l.trim().toLowerCase() === `user-agent: ${bot.toLowerCase()}`))!;
    const all = groupOf("*");
    const disallows = (g: string) => g.split("\n").filter((l) => l.startsWith("Disallow:"));
    for (const bot of ["facebookexternalhit", "Twitterbot", "LinkedInBot", "TelegramBot", "WhatsApp"]) {
      const group = groupOf(bot);
      expect(group).not.toBe(all);
      expect(group).toContain("Allow: /syllabus/\n");
      expect(group).not.toContain("Disallow: /syllabus/");
      expect(disallows(group)).toEqual(disallows(all).filter((l) => l !== "Disallow: /syllabus/"));
    }
    for (const bot of ["Googlebot", "Bingbot", "GPTBot"]) expect(groupOf(bot)).toContain("Disallow: /syllabus/\n");
  });
});
