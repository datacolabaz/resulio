#!/usr/bin/env node
/**
 * WCAG 2.1 contrast check for the semantic tokens in client/src/index.css (light and dark).
 * Text pairs need 4.5:1, interactive non-text pairs (borders, focus, icons, chart marks) 3:1.
 * Decorative pairs are reported but not enforced. Exit code 1 if any enforced pair fails.
 *
 * Usage: node scripts/check-contrast.mjs [--markdown]
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const css = readFileSync(fileURLToPath(new URL("../client/src/index.css", import.meta.url)), "utf8");

function block(selector) {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`Missing ${selector} block`);
  const body = css.slice(start, css.indexOf("\n}", start));
  const vars = {};
  for (const m of body.matchAll(/--([\w-]+):\s*(#[0-9A-Fa-f]{6})\b/g)) vars[m[1]] = m[2].toUpperCase();
  return vars;
}

const lum = (hex) => {
  const [r, g, b] = hex.slice(1).match(/../g).map((x) => {
    const c = parseInt(x, 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
};

const TEXT = 4.5;
const UI = 3;
const DECOR = 0;

/** [foreground token, background token, minimum, usage] */
const PAIRS = [
  // Primary / secondary / muted text on every surface it is used on
  ...["background", "card", "popover", "muted"].flatMap((bg) => [
    ["foreground", bg, TEXT, "Primary text"],
    ["foreground-secondary", bg, TEXT, "Secondary text"],
    ["muted-foreground", bg, TEXT, "Metadata, timestamps, helper, placeholder, disabled text"],
  ]),
  ["link", "background", TEXT, "Link / cyan label on page"],
  ["link", "card", TEXT, "Link / cyan label on card"],
  ["link", "muted", TEXT, "Link on table header / hover row"],
  ["link", "info-surface", TEXT, "Selected answer label on selected surface"],
  ["primary-foreground", "primary", TEXT, "Primary button"],
  ["primary-foreground", "primary-hover", TEXT, "Primary button hover"],
  ["secondary-foreground", "secondary", TEXT, "Secondary button"],
  ["secondary-foreground", "secondary-hover", TEXT, "Secondary button hover"],
  ["accent-foreground", "accent", TEXT, "Menu item hover"],
  ["brand-foreground", "brand", TEXT, "Text on brand cyan fill"],
  ["link-foreground", "link", TEXT, "Selected option key badge"],
  ["inverse-foreground", "foreground", TEXT, "Inverse chip (tooltips on dark)"],
  // Status: text on surface/page/card, and foreground on solid fills
  ...["success", "warning", "destructive", "info"].flatMap((s) => {
    const surface = s === "destructive" ? "danger-surface" : `${s}-surface`;
    return [
      [s, "card", TEXT, `${s} text/icon on card`],
      [s, "background", TEXT, `${s} text/icon on page`],
      [s, surface, TEXT, `${s} badge / callout`],
      [`${s}-foreground`, s, TEXT, `Text on solid ${s}`],
    ];
  }),
  ["neutral", "neutral-surface", TEXT, "Neutral badge (draft, archived)"],
  ["neutral", "card", TEXT, "Neutral text on card"],
  // Result review cards are tinted by status; their labels and metadata must stay readable
  ...["success-surface", "danger-surface", "warning-surface", "info-surface"].flatMap((bg) => [
    ["foreground", bg, TEXT, `Question text on ${bg} review card`],
    ["foreground-secondary", bg, TEXT, `Question meta on ${bg} review card`],
    ["muted-foreground", bg, TEXT, `"Your answer" label on ${bg} review card`],
  ]),
  ["sidebar-primary", "sidebar", TEXT, "Brand tagline in sidebar"],
  // Sidebar
  ["sidebar-foreground", "sidebar", TEXT, "Sidebar inactive item"],
  ["sidebar-muted", "sidebar", TEXT, "Sidebar footer / metadata"],
  ["sidebar-accent-foreground", "sidebar-accent", TEXT, "Sidebar active item"],
  ["sidebar-foreground", "sidebar-accent", TEXT, "Sidebar hover item"],
  ["sidebar-primary-foreground", "sidebar-primary", TEXT, "Sidebar primary button"],
  // Non-text interactive
  ["input", "card", UI, "Input / select / checkbox border on card"],
  ["input", "background", UI, "Input border on page"],
  ["input", "popover", UI, "Input border in modal"],
  ["border-strong", "card", UI, "Strong border"],
  ["ring", "background", UI, "Focus ring on page"],
  ["ring", "card", UI, "Focus ring on card"],
  ["ring", "popover", UI, "Focus ring in modal"],
  ["ring", "muted", UI, "Focus ring on muted surface"],
  ["sidebar-ring", "sidebar", UI, "Focus ring in sidebar"],
  ["sidebar-primary", "sidebar", UI, "Sidebar active indicator"],
  ["primary", "background", UI, "Primary button boundary on page"],
  ["primary", "card", UI, "Primary button / selected chip on card"],
  ["link", "muted", UI, "Progress bar fill on track"],
  ["link", "card", UI, "Selected answer border"],
  ["success", "card", UI, "Correct answer border"],
  ["destructive", "card", UI, "Wrong answer border"],
  ["warning", "card", UI, "Timer warning border"],
  ...[1, 2, 3, 4, 5].map((n) => [`chart-${n}`, "card", UI, `Chart series ${n}`]),
  // Decorative (reported only)
  ["border", "card", DECOR, "Card border (decorative)"],
  ["border-subtle", "card", DECOR, "Divider (decorative)"],
  ["chart-grid", "card", DECOR, "Chart grid line (decorative)"],
  ["card", "background", DECOR, "Card vs page"],
];

const markdown = process.argv.includes("--markdown");
let failures = 0;
const rows = [];
for (const [mode, vars] of [["Light", block(":root")], ["Dark", block(".dark")]]) {
  for (const [fg, bg, min, use] of PAIRS) {
    if (!vars[fg] || !vars[bg]) {
      failures++;
      rows.push({ mode, fg, bg, fgHex: vars[fg] ?? "?", bgHex: vars[bg] ?? "?", r: 0, min, use, status: "MISSING" });
      continue;
    }
    const r = ratio(vars[fg], vars[bg]);
    const status = min === DECOR ? "info" : r >= min ? "PASS" : "FAIL";
    if (status === "FAIL") failures++;
    rows.push({ mode, fg, bg, fgHex: vars[fg], bgHex: vars[bg], r, min, use, status });
  }
}

if (markdown) {
  console.log("| Mode | Foreground | Background | Ratio | Min | Result | Usage |");
  console.log("| --- | --- | --- | ---: | ---: | --- | --- |");
  for (const x of rows) {
    console.log(`| ${x.mode} | ${x.fg} ${x.fgHex} | ${x.bg} ${x.bgHex} | ${x.r.toFixed(2)} | ${x.min || "—"} | ${x.status} | ${x.use} |`);
  }
} else {
  for (const x of rows) {
    console.log(
      `${x.status.padEnd(7)} ${x.mode.padEnd(5)} ${x.r.toFixed(2).padStart(5)} (min ${x.min || "-"})  ${x.fg} ${x.fgHex} on ${x.bg} ${x.bgHex}  — ${x.use}`,
    );
  }
}
const enforced = rows.filter((x) => x.status !== "info").length;
console.log(`\n${enforced - failures}/${enforced} enforced pairs pass; ${failures} failing.`);
process.exit(failures ? 1 : 0);
