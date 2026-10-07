import { t } from "@/i18n/messages";
import { SITE, type Partner } from "@/seo/config";
import { ArrowUpRight } from "lucide-react";

const logoClass = "h-7 w-auto max-w-full object-contain";

function PartnerLogo({ partner }: { partner: Partner }) {
  const { logo } = partner;
  const alt = `${partner.name} logo`;
  return (
    <span className="flex h-10 max-w-full items-center justify-center gap-2">
      {logo.srcOnDark ? (
        <>
          <img src={logo.src} alt={alt} width={logo.width} height={logo.height} loading="lazy" decoding="async" className={`${logoClass} dark:hidden`} />
          <img src={logo.srcOnDark} alt={alt} width={logo.width} height={logo.height} loading="lazy" decoding="async" className={`${logoClass} hidden dark:block`} />
        </>
      ) : (
        <img src={logo.src} alt={alt} width={logo.width} height={logo.height} loading="lazy" decoding="async" className={logoClass} />
      )}
      {partner.wordmark && (
        <span aria-hidden className="text-2xl font-extrabold tracking-tight text-[var(--partner)] dark:text-[var(--partner-dark)]">
          {partner.wordmark}
        </span>
      )}
    </span>
  );
}

/** Official partners as logo cards; each opens the partner's site in a new tab. */
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
              style={{ "--partner": partner.color, "--partner-dark": partner.colorOnDark } as React.CSSProperties}
              className="group flex h-full flex-col items-center justify-center gap-3 rounded-2xl border border-border bg-card px-5 py-6 shadow-card outline-none transition-colors hover:border-[var(--partner)] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring dark:hover:border-[var(--partner-dark)]"
            >
              <PartnerLogo partner={partner} />
              <span aria-hidden className="flex items-center gap-1 text-xs text-muted-foreground transition-colors group-hover:text-foreground">
                {partner.name}
                <ArrowUpRight className="h-3.5 w-3.5" />
              </span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}
