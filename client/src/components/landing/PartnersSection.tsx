import { t } from "@/i18n/messages";
import { SITE } from "@/seo/config";
import { ArrowUpRight } from "lucide-react";

/** Official partners as text wordmark cards; each opens the partner's site in a new tab. */
export function PartnersSection() {
  return (
    <section id="partners" aria-labelledby="partners-title">
      <div className="mx-auto max-w-2xl text-center">
        <h2 id="partners-title" className="text-2xl font-semibold leading-tight sm:text-3xl">
          {t("site.partners.title")}
        </h2>
        <p className="mt-4 text-foreground-secondary">{t("site.partners.lead")}</p>
      </div>
      <ul className="mt-8 grid grid-cols-1 gap-4 min-[420px]:grid-cols-2 lg:grid-cols-4">
        {SITE.partners.map((partner) => (
          <li key={partner.url}>
            <a
              href={partner.url}
              target="_blank"
              rel="noopener"
              className="group flex h-full min-h-20 items-center justify-center gap-1.5 rounded-2xl border border-border bg-card px-5 py-6 text-lg font-semibold tracking-tight text-foreground shadow-card transition-colors outline-none hover:border-link hover:text-link focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring"
            >
              <span className="break-all">{partner.name}</span>
              <ArrowUpRight
                aria-hidden
                className="h-4 w-4 shrink-0 text-muted-foreground transition-colors group-hover:text-link"
              />
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}
