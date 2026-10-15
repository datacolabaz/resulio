/**
 * "Yeniliklər": one registry behind the sidebar "Yeni" badges, the cards on the student and teacher
 * home pages and the landing-page section. Adding a feature = one entry below plus its texts in
 * client/src/i18n/catalog/whatsNew.ts (`whatsNew.<id>.title`, `.body`; public entries also
 * `.landing` and `.point1…pointN`). Seen/dismissed marks live in `user_feature_seen` (localStorage
 * when signed out or before the migration). An entry disappears from the app by itself after its
 * window; drop "public" from `audiences` to take it off the landing page.
 */

export const WHATS_NEW_AUDIENCES = ["student", "teacher", "public"] as const;
export type WhatsNewAudience = (typeof WHATS_NEW_AUDIENCES)[number];
export type InAppAudience = Exclude<WhatsNewAudience, "public">;

/** Availability checks; each one is answered on the client by a query the app already makes. */
export const WHATS_NEW_REQUIREMENTS = ["studyCoach", "studentGrowth", "teacherGrowth", "coachShares", "mcpConnector"] as const;
export type WhatsNewRequirement = (typeof WHATS_NEW_REQUIREMENTS)[number];
export type WhatsNewAvailability = Partial<Record<WhatsNewRequirement, boolean>>;

export const WHATS_NEW_ICONS = ["sparkles", "target", "radar", "inbox", "userCheck", "bot"] as const;
export type WhatsNewIcon = (typeof WHATS_NEW_ICONS)[number];

export type WhatsNewEntry = {
  /** Stored in `user_feature_seen.featureId` (at most 64 characters); never rename a released id. */
  id: string;
  audiences: readonly WhatsNewAudience[];
  /** Release day in Baku, `YYYY-MM-DD`. */
  releasedAt: string;
  /** Badges and in-app cards show for this many days after the release (default 30). */
  days?: number;
  /** In-app page: the sidebar item with this href gets the badge, and opening it marks the entry seen. */
  route?: string;
  /** Where the card's button leads when it is not `route` itself (e.g. one panel of Settings). */
  href?: string;
  icon: WhatsNewIcon;
  cta: "try" | "view";
  /** Shown only when this check passes; no requirement = every user of the audience. */
  requires?: WhatsNewRequirement;
  /** Paid feature: the landing card says so. */
  premium?: boolean;
  /** Bullet points on the landing card: `whatsNew.<id>.point1` … `point<points>`. */
  points?: number;
};

export const DEFAULT_WHATS_NEW_DAYS = 30;
const DAY_MS = 86_400_000;

export const WHATS_NEW: readonly WhatsNewEntry[] = [
  {
    id: "topic-summary",
    audiences: ["teacher"],
    releasedAt: "2026-10-16",
    route: "/teacher/library",
    icon: "sparkles",
    cta: "try",
  },
  {
    id: "claude-connector",
    audiences: ["teacher", "public"],
    releasedAt: "2026-10-13",
    route: "/settings",
    href: "/settings#claude-connector",
    icon: "bot",
    cta: "try",
    requires: "mcpConnector",
    premium: true,
    points: 3,
  },
  { id: "study-coach", audiences: ["student", "public"], releasedAt: "2026-10-12", route: "/student/coach", icon: "sparkles", cta: "try", requires: "studyCoach", points: 3 },
  { id: "coach-shares", audiences: ["teacher"], releasedAt: "2026-10-12", route: "/teacher/coach-shares", icon: "inbox", cta: "view", requires: "coachShares" },
  { id: "growth-plan", audiences: ["student", "public"], releasedAt: "2026-10-11", route: "/student/growth", icon: "target", cta: "view", requires: "studentGrowth", points: 3 },
  { id: "risk-radar", audiences: ["teacher", "public"], releasedAt: "2026-10-11", route: "/teacher/growth", icon: "radar", cta: "view", requires: "teacherGrowth", points: 3 },
  { id: "group-approval", audiences: ["teacher", "public"], releasedAt: "2026-10-10", route: "/teacher/groups", icon: "userCheck", cta: "view", points: 3 },
];

export const WHATS_NEW_IDS = WHATS_NEW.map((e) => e.id) as [string, ...string[]];

export function isWhatsNewId(id: string): boolean {
  return WHATS_NEW.some((e) => e.id === id);
}

/** Midnight of the release day in Baku (UTC+4, no daylight saving). */
export function releaseTime(entry: WhatsNewEntry): number {
  return Date.parse(`${entry.releasedAt}T00:00:00+04:00`);
}

export function withinWindow(entry: WhatsNewEntry, now: Date): boolean {
  const start = releaseTime(entry);
  const t = now.getTime();
  return t >= start && t < start + (entry.days ?? DEFAULT_WHATS_NEW_DAYS) * DAY_MS;
}

export function isAvailable(entry: WhatsNewEntry, available: WhatsNewAvailability): boolean {
  return !entry.requires || available[entry.requires] === true;
}

export type WhatsNewMark = { seenAt?: unknown; dismissedAt?: unknown };
export type WhatsNewState = Record<string, WhatsNewMark | undefined>;

export type MarkKind = "seen" | "dismissed";
/** Marks kept in localStorage (epoch milliseconds). */
export type LocalMarks = Record<string, { seenAt?: number; dismissedAt?: number }>;

/** Adds marks, keeping the first time of each. */
export function addMarks(marks: LocalMarks, ids: readonly string[], kind: MarkKind, now: number): LocalMarks {
  const field = kind === "seen" ? "seenAt" : "dismissedAt";
  const next = { ...marks };
  for (const id of ids) next[id] = { ...next[id], [field]: next[id]?.[field] ?? now };
  return next;
}

/**
 * Server marks joined with local ones. Local marks cover signed-out visitors, a server without
 * migration 0060 and the moment before a mutation returns; a mark from either side counts.
 */
export function mergeMarks(local: LocalMarks, server: readonly { featureId: string; seenAt: unknown; dismissedAt: unknown }[] = []): WhatsNewState {
  const state: WhatsNewState = { ...local };
  for (const row of server) {
    const mine = local[row.featureId];
    state[row.featureId] = { seenAt: row.seenAt ?? mine?.seenAt ?? null, dismissedAt: row.dismissedAt ?? mine?.dismissedAt ?? null };
  }
  return state;
}

/** Opening the page or closing the card both mean "the user knows": badge and card go away. */
export function isHandled(mark: WhatsNewMark | undefined): boolean {
  return !!(mark?.seenAt || mark?.dismissedAt);
}

/** Exact page or a page below it: `/student/coach` matches `/student/coach/m/1`, not `/student/coaching`. */
export function matchesRoute(route: string, path: string): boolean {
  const clean = path.split(/[?#]/)[0].replace(/\/+$/, "") || "/";
  return clean === route || clean.startsWith(`${route}/`);
}

const newestFirst = (a: WhatsNewEntry, b: WhatsNewEntry) => releaseTime(b) - releaseTime(a);

/** In-app entries to badge and show as cards: right audience, available, inside the window, not yet seen or dismissed. */
export function freshEntries(
  audiences: readonly InAppAudience[],
  opts: { now: Date; available: WhatsNewAvailability; state: WhatsNewState },
  entries: readonly WhatsNewEntry[] = WHATS_NEW,
): WhatsNewEntry[] {
  return entries
    .filter(
      (e) =>
        !!e.route &&
        e.audiences.some((a) => (audiences as readonly string[]).includes(a)) &&
        withinWindow(e, opts.now) &&
        isAvailable(e, opts.available) &&
        !isHandled(opts.state[e.id]),
    )
    .sort(newestFirst);
}

/** The fresh entry whose page is this sidebar item, if any. */
export function badgeFor(href: string, fresh: readonly WhatsNewEntry[], audience: InAppAudience): WhatsNewEntry | undefined {
  return fresh.find((e) => e.route === href && e.audiences.includes(audience));
}

/** Fresh entries whose page the user is on now; they get marked seen. */
export function entriesVisitedAt(path: string, fresh: readonly WhatsNewEntry[]): WhatsNewEntry[] {
  return fresh.filter((e) => !!e.route && matchesRoute(e.route, path));
}

/** Landing-page cards: every public entry, newest first (the section is static text for crawlers too). */
export function landingEntries(entries: readonly WhatsNewEntry[] = WHATS_NEW): WhatsNewEntry[] {
  return entries.filter((e) => e.audiences.includes("public")).sort(newestFirst);
}

/** The in-app audience a landing card speaks to ("for students" / "for teachers"). */
export function primaryAudience(entry: WhatsNewEntry): InAppAudience {
  return entry.audiences.includes("teacher") ? "teacher" : "student";
}

export const whatsNewKeys = (entry: WhatsNewEntry) => ({
  title: `whatsNew.${entry.id}.title`,
  body: `whatsNew.${entry.id}.body`,
  landing: `whatsNew.${entry.id}.landing`,
  points: Array.from({ length: entry.points ?? 0 }, (_, i) => `whatsNew.${entry.id}.point${i + 1}`),
});
