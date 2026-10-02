import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { catalog, domains } from "../client/src/i18n/catalog";
import { interpolate, translate, type MessageKey } from "../client/src/i18n/messages";

const CLIENT_SRC = join(__dirname, "..", "client", "src");
const AZ_LETTERS = /[əıŞşÇçĞğÖöÜüİƏ]/;

/** Unreachable template leftovers (no route, not imported by app code) and generated UI primitives. */
const SCAN_EXCLUDE = [
  "components/ui/",
  "i18n/catalog/",
  "pages/ComponentShowcase.tsx",
  "components/AIChatBox.tsx",
  "components/ManusDialog.tsx",
  "components/Map.tsx",
  "components/DashboardLayout.tsx",
  "components/DashboardLayoutSkeleton.tsx",
];

/** Literal UI text that is intentionally not translated. Each entry: file, exact text, reason. */
const ALLOWED_LITERALS: { file: string; text: string; reason: string }[] = [
  { file: "i18n/messages.ts", text: "Azərbaycanca", reason: "language endonym: each language is named in itself" },
  { file: "components/BrandMark.tsx", text: "Resulio", reason: "brand name" },
  { file: "pages/Home.tsx", text: "Resulio", reason: "brand name" },
  { file: "components/landing/BrowserFrame.tsx", text: "resulio.co/app", reason: "decorative fake address bar in a product-preview mockup, identical in every language" },
  { file: "pages/teacher/TeacherModules.tsx", text: "AI", reason: "product term, identical in every language" },
  { file: "pages/teacher/ExamBuilder.tsx", text: "AI", reason: "product term, identical in every language" },
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

const files = sourceFiles(CLIENT_SRC)
  .map((path) => ({ path, rel: relative(CLIENT_SRC, path).split(sep).join("/") }))
  .filter(({ rel }) => !SCAN_EXCLUDE.some((x) => rel.startsWith(x)))
  .map((f) => ({ ...f, code: stripComments(readFileSync(f.path, "utf8")) }));

function stripComments(code: string) {
  return code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1").replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "");
}

function allowed(rel: string, text: string) {
  return ALLOWED_LITERALS.some((a) => a.file === rel && text.includes(a.text));
}

function untranslatedLiterals(rel: string, code: string): string[] {
  const jsxText = />\s*([A-Za-zÀ-ž][^<>{}]*[A-Za-zÀ-ž.!?…])\s*</g;
  const attr = /\b(placeholder|aria-label|title|alt)="([^"]*[A-Za-zÀ-ž]{2,}[^"]*)"/g;
  const hits: string[] = [];
  for (const m of code.matchAll(jsxText)) {
    const text = m[1].trim();
    // TypeScript generics and unions can look like tags, e.g. `(q) => void | Promise<void>`.
    if (/[=;()|]|&&/.test(text) || !/[a-z]{2}/i.test(text)) continue;
    if (!allowed(rel, text)) hits.push(`${rel}: >${text}<`);
  }
  for (const m of code.matchAll(attr)) if (!allowed(rel, m[2])) hits.push(`${rel}: ${m[1]}="${m[2]}"`);
  return hits;
}

const placeholders = (s: string) =>
  [...s.matchAll(/\{(\w+)(\|[^}]*)?\}/g)].map((m) => m[1]).filter((v, i, all) => all.indexOf(v) === i).sort();

describe("message catalog", () => {
  it("defines every key exactly once across domain files", () => {
    const seen = new Map<string, string>();
    const duplicates: string[] = [];
    for (const [domain, entries] of Object.entries(domains)) {
      for (const key of Object.keys(entries)) {
        if (seen.has(key)) duplicates.push(`${key} (${seen.get(key)} and ${domain})`);
        seen.set(key, domain);
      }
    }
    expect(duplicates).toEqual([]);
  });

  it("has a non-empty az, en and ru text for every key", () => {
    const empty = Object.entries(catalog).filter(([, entry]) => entry.length !== 3 || entry.some((s) => !s.trim()));
    expect(empty.map(([k]) => k)).toEqual([]);
  });

  it("uses the same placeholders in every language", () => {
    const mismatched = Object.entries(catalog)
      .filter(([, [az, en, ru]]) => {
        const p = placeholders(az).join();
        return placeholders(en).join() !== p || placeholders(ru).join() !== p;
      })
      .map(([k]) => k);
    expect(mismatched).toEqual([]);
  });

  it("keeps Azerbaijani letters out of English and Russian text", () => {
    const leaks = Object.entries(catalog)
      .filter(([, [, en, ru]]) => AZ_LETTERS.test(en) || AZ_LETTERS.test(ru))
      .map(([k]) => k);
    expect(leaks).toEqual([]);
  });

  it("picks plural forms per language", () => {
    expect(translate("en", "common.studentsCount", { count: 1 })).toBe("1 student");
    expect(translate("en", "common.studentsCount", { count: 5 })).toBe("5 students");
    expect(translate("ru", "common.studentsCount", { count: 1 })).toBe("1 студент");
    expect(translate("ru", "common.studentsCount", { count: 3 })).toBe("3 студента");
    expect(translate("ru", "common.studentsCount", { count: 11 })).toBe("11 студентов");
    expect(translate("az", "common.studentsCount", { count: 5 })).toBe("5 tələbə");
    expect(interpolate("{name}", {})).toBe("{name}");
  });

  it("has the approved theme labels", () => {
    const labels = (["theme.light", "theme.dark", "theme.system"] as MessageKey[]).map((k) => translate("az", k));
    expect(labels).toEqual(["Açıq rejim", "Tünd rejim", "Sistem ayarı"]);
  });
});

describe("client source", () => {
  it("has no hard-coded Azerbaijani UI text outside the catalog", () => {
    const hits = files.flatMap(({ rel, code }) =>
      code
        .split("\n")
        .filter((line) => AZ_LETTERS.test(line) && !allowed(rel, line))
        .map((line) => `${rel}: ${line.trim()}`),
    );
    expect(hits).toEqual([]);
  });

  it("has no untranslated JSX text or accessible-name literals", () => {
    expect(untranslatedLiterals("x.tsx", `<p>Save changes</p><button aria-label="Delete">`)).toEqual([
      "x.tsx: >Save changes<",
      'x.tsx: aria-label="Delete"',
    ]);
    const hits = files.filter((f) => f.rel.endsWith(".tsx")).flatMap(({ rel, code }) => untranslatedLiterals(rel, code));
    expect(hits).toEqual([]);
  });

  it("never nests interactive elements", () => {
    const linkWrapsButton = /<(Link|a)\b[^>]*>\s*<(Button|button)\b/g;
    const buttonWrapsLink = /<(Button|button)\b(?![^>]*\basChild\b)[^>]*>\s*<(Link|a)\b/g;
    const hits = files.flatMap(({ rel, code }) =>
      [...code.matchAll(linkWrapsButton), ...code.matchAll(buttonWrapsLink)].map((m) => `${rel}: ${m[0].replace(/\s+/g, " ")}`),
    );
    expect(hits).toEqual([]);
  });

  it("formats dates only through lib/dates", () => {
    const direct = /\.toLocale(Date|Time)?String\(|new Intl\.DateTimeFormat\(/;
    const hits = files.filter(({ rel, code }) => rel !== "lib/dates.ts" && direct.test(code)).map(({ rel }) => rel);
    expect(hits).toEqual([]);
  });

  it("uses semantic colour tokens instead of palette utilities or raw colours", () => {
    const palette =
      /\b(bg|text|border|ring|fill|stroke|from|to|via|outline|accent|divide|decoration|placeholder)-(slate|gray|zinc|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|white|black)(-\d{2,3})?\b|\[#[0-9a-fA-F]{3,8}\]/;
    const hits = files.flatMap(({ rel, code }) =>
      code.split("\n").filter((line) => palette.test(line)).map((line) => `${rel}: ${line.trim().slice(0, 120)}`),
    );
    expect(hits).toEqual([]);
  });
});
