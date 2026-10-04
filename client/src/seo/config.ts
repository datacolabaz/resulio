/**
 * The single source of public facts about Resulio for meta tags, JSON-LD, the sitemap and llms-full.txt.
 * Only verified facts go here. A `null` or empty value is left out of every output — never guess one.
 * Owner TODOs are listed in docs/SEO-AI-DISCOVERABILITY.md under "Facts to fill in".
 */
export const SITE = {
  url: "https://resulio.co",
  name: "Resulio",
  /** Square brand icon, 512×512. */
  logo: { path: "/brand/resulio-icon.png", width: 512, height: 512 },
  /** TODO(owner): a 1200×630 social preview image; until then the square logo is used with a small card. */
  ogImage: null as { path: string; width: number; height: number } | null,
  /** Already published in the privacy policy. */
  contactEmail: "datanalystelman@gmail.com",
  languages: ["az", "ru", "en"],
  /** TODO(owner): real public profiles of Resulio (LinkedIn company page, Instagram, Facebook, …). */
  sameAs: [] as string[],
  /** TODO(owner): ISO date, e.g. "2025-09". */
  foundingDate: null as string | null,
  /** TODO(owner): registered legal entity name, if any. */
  legalName: null as string | null,
  founder: {
    name: "Telman Abdulla",
    jobTitle: "Founder",
    /** TODO(owner): real public profiles of Telman Abdulla (LinkedIn, GitHub, …). */
    sameAs: [] as string[],
  },
};

export const absoluteUrl = (path: string) => `${SITE.url}${path === "/" ? "/" : path}`;
