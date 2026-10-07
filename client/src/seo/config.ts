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
  /** Official partners, confirmed by the owner. Logos are the partners' own files from their websites, served locally. */
  partners: [
    {
      name: "sayt.az",
      url: "https://sayt.az",
      logo: { src: "/partners/sayt.az.svg", srcOnDark: "/partners/sayt.az-on-dark.svg", width: 131, height: 40 },
      color: "#7D3BE2",
      colorOnDark: "#60A5FA",
    },
    {
      name: "metbuat.az",
      url: "https://metbuat.az",
      logo: { src: "/partners/metbuat.az.png", srcOnDark: "/partners/metbuat.az-on-dark.png", width: 720, height: 134 },
      color: "#03B3C1",
      colorOnDark: "#03B3C1",
    },
    {
      name: "spotva.co",
      url: "https://spotva.co",
      logo: { src: "/partners/spotva.co.svg", srcOnDark: "/partners/spotva.co-on-dark.svg", width: 381, height: 96 },
      color: "#26453A",
      colorOnDark: "#DB8A2E",
    },
    {
      name: "tehvil.az",
      url: "https://tehvil.az",
      /** tehvil.az publishes only its square mark; its own site sets the name "Təhvil" next to it. */
      logo: { src: "/partners/tehvil.az.svg", width: 64, height: 64 },
      wordmark: "Təhvil",
      color: "#29473F",
      colorOnDark: "#F8F6F1",
    },
  ] as Partner[],
};

export type Partner = {
  name: string;
  url: string;
  logo: { src: string; srcOnDark?: string; width: number; height: number };
  /** Text set next to a mark-only logo, in the brand colour. */
  wordmark?: string;
  color: string;
  colorOnDark: string;
};

export const absoluteUrl = (path: string) => `${SITE.url}${path === "/" ? "/" : path}`;
