import { LanguageSwitch, ThemeToggle } from "@/components/AppShell";
import { BrandMark } from "@/components/BrandMark";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n/messages";
import { SITE } from "@/seo/config";
import { ABOUT, ASSESSMENT_PLATFORM, FAQ_PAGE, FOR_TEACHERS, HOME, SITE_PAGES, type SitePage } from "@/seo/pages";
import { usePageMeta } from "@/seo/usePageMeta";
import { Link } from "wouter";

/** Footer links to every public page; shared by the landing page and the public site pages. */
export function SiteFooter() {
  return (
    <footer className="border-t border-border">
      <div className="mx-auto max-w-6xl space-y-4 px-4 py-8 text-sm sm:px-6">
        <p className="text-foreground-secondary">{t("site.definitionShort")}</p>
        <nav aria-label={t("site.nav.public")}>
          <ul className="flex flex-wrap gap-x-5 gap-y-2">
            {SITE_PAGES.map((page) => (
              <li key={page.path}>
                <Link href={page.path} className="text-link hover:underline">
                  {t(page.nav)}
                </Link>
              </li>
            ))}
            <li>
              <a href="/privacy.html" className="text-link hover:underline">
                {t("site.nav.privacy")}
              </a>
            </li>
          </ul>
        </nav>
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <p id="footer-partners" className="font-semibold text-foreground-secondary">
            {t("site.partners.title")}:
          </p>
          <PartnerLinks aria-labelledby="footer-partners" className="flex flex-wrap gap-x-4 gap-y-1" />
        </div>
        <p className="text-muted-foreground">{t("site.footer.founder")}</p>
      </div>
    </footer>
  );
}

function PartnerLinks(props: React.HTMLAttributes<HTMLUListElement>) {
  return (
    <ul {...props}>
      {SITE.partners.map((partner) => (
        <li key={partner.url}>
          <a href={partner.url} target="_blank" rel="noopener" className="text-link hover:underline">
            {partner.name}
          </a>
        </li>
      ))}
    </ul>
  );
}

function SitePageView({ page }: { page: SitePage }) {
  usePageMeta(page);
  return (
    <div className="relative min-h-screen overflow-x-hidden bg-background text-foreground">
      <div className="absolute inset-x-0 top-0 h-1 bg-brand" aria-hidden />
      <header className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-4 py-6 sm:px-6">
        <Link href="/" className="flex items-center gap-3">
          <BrandMark size={44} className="rounded-xl" />
          <div>
            <div className="text-xl font-semibold tracking-tight">Resulio</div>
            <div className="text-xs text-link">{t("brand.tagline")}</div>
          </div>
        </Link>
        <div className="flex items-center gap-2">
          <LanguageSwitch />
          <ThemeToggle />
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-4 pb-20 pt-4 sm:px-6">
        <nav aria-label={t("site.breadcrumb")} className="text-sm text-muted-foreground">
          <Link href="/" className="hover:underline">
            {t(HOME.nav)}
          </Link>
          <span aria-hidden> › </span>
          <span aria-current="page">{t(page.nav)}</span>
        </nav>
        <h1 className="mt-4 break-words text-3xl font-semibold leading-tight sm:text-4xl">{t(page.h1)}</h1>
        <p className="mt-5 text-lg text-foreground-secondary">{t(page.lead)}</p>

        {page.sections.map((section, i) => (
          <section key={i} className="mt-12">
            {section.heading && <h2 className="text-2xl font-semibold leading-tight">{t(section.heading)}</h2>}
            {section.paragraphs?.map((key) => (
              <p key={key} className="mt-4 text-foreground-secondary">
                {t(key)}
              </p>
            ))}
            {section.items &&
              (section.ordered ? (
                <ol className="mt-4 list-decimal space-y-2 pl-6 text-foreground-secondary">
                  {section.items.map((key) => (
                    <li key={key}>{t(key)}</li>
                  ))}
                </ol>
              ) : (
                <ul className="mt-4 list-disc space-y-2 pl-6 text-foreground-secondary">
                  {section.items.map((key) => (
                    <li key={key}>{t(key)}</li>
                  ))}
                </ul>
              ))}
            {section.faq && (
              <div className="mt-4 space-y-6">
                {section.faq.map(({ q, a }) => (
                  <div key={q}>
                    <h3 className="font-semibold">{t(q)}</h3>
                    <p className="mt-2 text-foreground-secondary">{t(a)}</p>
                  </div>
                ))}
              </div>
            )}
            {section.email && (
              <p className="mt-2">
                <a href={`mailto:${SITE.contactEmail}`} className="text-link hover:underline">
                  {SITE.contactEmail}
                </a>
              </p>
            )}
            {section.partners && <PartnerLinks className="mt-4 list-disc space-y-2 pl-6" />}
          </section>
        ))}

        <div className="mt-14">
          <Button asChild size="lg">
            <Link href="/">{t("site.nav.start")}</Link>
          </Button>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}

export const AboutPage = () => <SitePageView page={ABOUT} />;
export const FaqPage = () => <SitePageView page={FAQ_PAGE} />;
export const AssessmentPlatformPage = () => <SitePageView page={ASSESSMENT_PLATFORM} />;
export const ForTeachersPage = () => <SitePageView page={FOR_TEACHERS} />;
