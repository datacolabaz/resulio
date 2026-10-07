import type { MessageKey } from "../i18n/messages";

/**
 * Public marketing pages. One description drives the React pages, the prerendered HTML that crawlers
 * read without JavaScript, the sitemap, JSON-LD and llms-full.txt, so they can never disagree.
 */
export type FaqItem = { q: MessageKey; a: MessageKey };

export type Section = {
  heading?: MessageKey;
  paragraphs?: MessageKey[];
  items?: MessageKey[];
  ordered?: boolean;
  faq?: FaqItem[];
  /** Adds the public contact email after the paragraphs. */
  email?: boolean;
  /** Adds the official partner links (SITE.partners) after the paragraphs. */
  partners?: boolean;
};

export type SitePage = {
  id: "home" | "about" | "faq" | "assessmentPlatform" | "forTeachers";
  path: string;
  title: MessageKey;
  description: MessageKey;
  /** Short name for breadcrumbs and footer links. */
  nav: MessageKey;
  eyebrow?: MessageKey;
  h1: MessageKey;
  lead: MessageKey;
  sections: Section[];
};

export const FEATURES: MessageKey[] = [
  "site.feature.questionTypes",
  "site.feature.schoolFormats",
  "site.feature.groups",
  "site.feature.sharing",
  "site.feature.session",
  "site.feature.grading",
  "site.feature.analytics",
  "site.feature.tasks",
  "site.feature.aiGrading",
  "site.feature.ai",
  "site.feature.notifications",
  "site.feature.languages",
];

const faq = (...ids: string[]): FaqItem[] => ids.map((id) => ({ q: `site.faq.q.${id}` as MessageKey, a: `site.faq.a.${id}` as MessageKey }));

export const FAQ = faq("what", "who", "azerbaijan", "questionTypes", "join", "timing", "grading", "aiGrading", "tasks", "analytics", "price", "languages", "ai", "install", "privacy", "founder");

export const HOME: SitePage = {
  id: "home",
  path: "/",
  title: "site.meta.home.title",
  description: "site.meta.home.description",
  nav: "site.nav.home",
  eyebrow: "landing.hero.eyebrow",
  h1: "landing.hero.headline",
  lead: "landing.hero.body",
  sections: [
    { heading: "site.glance.title", paragraphs: ["site.definition"] },
    { heading: "site.glance.features", items: FEATURES },
    { heading: "site.faq.title", faq: faq("what", "who", "azerbaijan", "price", "founder") },
    { heading: "site.partners.title", paragraphs: ["site.partners.lead"], partners: true },
  ],
};

export const ABOUT: SitePage = {
  id: "about",
  path: "/about",
  title: "site.meta.about.title",
  description: "site.meta.about.description",
  nav: "site.nav.about",
  h1: "site.about.h1",
  lead: "site.definition",
  sections: [
    { heading: "site.about.whatTitle", paragraphs: ["site.glance.doesValue"], items: FEATURES },
    { heading: "site.about.whoTitle", paragraphs: ["site.about.whoBody"] },
    { heading: "site.about.founderTitle", paragraphs: ["site.about.founderBody"] },
    { heading: "site.about.nameTitle", paragraphs: ["site.about.nameBody"] },
    { heading: "site.glance.languages", paragraphs: ["site.glance.languagesValue"] },
    { heading: "site.glance.start", paragraphs: ["site.glance.startValue"] },
    { heading: "site.about.contactTitle", paragraphs: ["site.about.contactBody"], email: true },
  ],
};

export const FAQ_PAGE: SitePage = {
  id: "faq",
  path: "/faq",
  title: "site.meta.faq.title",
  description: "site.meta.faq.description",
  nav: "site.nav.faq",
  h1: "site.faq.title",
  lead: "site.faq.lead",
  sections: [{ faq: FAQ }],
};

export const ASSESSMENT_PLATFORM: SitePage = {
  id: "assessmentPlatform",
  path: "/azerbaycan-ucun-qiymetlendirme-platformasi",
  title: "site.meta.assessmentPlatform.title",
  description: "site.meta.assessmentPlatform.description",
  nav: "site.nav.assessmentPlatform",
  h1: "site.lp.az.h1",
  lead: "site.lp.az.lead",
  sections: [
    { heading: "site.lp.az.localTitle", items: ["site.lp.az.local1", "site.lp.az.local2", "site.lp.az.local3", "site.lp.az.local4", "site.lp.az.local5"] },
    { heading: "site.lp.az.stepsTitle", items: ["site.lp.az.step1", "site.lp.az.step2", "site.lp.az.step3", "site.lp.az.step4"], ordered: true },
    { heading: "site.lp.featuresTitle", items: FEATURES },
    { heading: "site.faq.title", faq: faq("azerbaijan", "who", "price", "founder") },
  ],
};

export const FOR_TEACHERS: SitePage = {
  id: "forTeachers",
  path: "/muellimler-ucun",
  title: "site.meta.forTeachers.title",
  description: "site.meta.forTeachers.description",
  nav: "site.nav.forTeachers",
  h1: "site.lp.teachers.h1",
  lead: "site.lp.teachers.lead",
  sections: [
    { heading: "site.lp.teachers.groupsTitle", paragraphs: ["site.feature.groups"] },
    { heading: "site.lp.teachers.examsTitle", items: ["site.feature.questionTypes", "site.feature.schoolFormats", "site.feature.sharing", "site.feature.session", "site.feature.tasks"] },
    { heading: "site.lp.teachers.aiTitle", paragraphs: ["site.feature.aiGrading", "site.feature.ai"] },
    { heading: "site.lp.teachers.insightTitle", paragraphs: ["site.lp.teachers.insightBody", "site.feature.analytics"] },
    { heading: "site.lp.teachers.accountTitle", paragraphs: ["site.lp.teachers.accountBody"] },
    { heading: "site.faq.title", faq: faq("who", "grading", "aiGrading", "tasks", "price") },
  ],
};

/** Every page with its own URL; the order is the footer and sitemap order. */
export const SITE_PAGES: SitePage[] = [HOME, ABOUT, FAQ_PAGE, ASSESSMENT_PLATFORM, FOR_TEACHERS];
