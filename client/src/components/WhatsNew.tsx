import { Button } from "@/components/ui/button";
import { t, type MessageKey } from "@/i18n/messages";
import type { UiContext } from "@/lib/contexts";
import { useWhatsNew } from "@/lib/whatsNew";
import { whatsNewKeys, type WhatsNewEntry, type WhatsNewIcon } from "@shared/whatsNew";
import { ArrowRight, Bot, Inbox, Radar, Sparkles, Target, UserCheck, X, type LucideIcon } from "lucide-react";
import { Link } from "wouter";

export const WHATS_NEW_ICON: Record<WhatsNewIcon, LucideIcon> = { sparkles: Sparkles, target: Target, radar: Radar, inbox: Inbox, userCheck: UserCheck, bot: Bot };

/** Texts of one registry entry; the i18n test checks every key exists. */
export function entryText(entry: WhatsNewEntry) {
  const keys = whatsNewKeys(entry);
  return {
    title: t(keys.title as MessageKey),
    body: t(keys.body as MessageKey),
    points: keys.points.map((k) => t(k as MessageKey)),
  };
}

/** The "Yeni" pill: brand cyan on navy text reads on the navy sidebar and on light and dark cards alike. */
export function NewBadge({ className = "" }: { className?: string }) {
  return (
    <span className={`inline-flex shrink-0 items-center rounded-full bg-brand px-2 py-0.5 text-[10px] font-bold uppercase leading-4 tracking-wide text-brand-foreground ${className}`}>
      {t("whatsNew.badge")}
    </span>
  );
}

/** Home-page "Yeniliklər": a swipeable row on phones, a grid from `sm`. Gone once every card is opened or closed. */
export function WhatsNewCards({ area }: { area: Extract<UiContext, "learning" | "teaching"> }) {
  const audience = area === "learning" ? "student" : "teacher";
  const { fresh, dismiss } = useWhatsNew(area);
  const items = fresh.filter((e) => e.audiences.includes(audience));
  if (!items.length) return null;
  return (
    <section aria-labelledby="whats-new-title" className="min-w-0 rounded-2xl border border-brand/40 bg-gradient-to-br from-brand/10 via-card to-card p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <div className="flex min-w-0 items-center gap-2">
          <Sparkles className="h-5 w-5 shrink-0 text-link" aria-hidden />
          <h2 id="whats-new-title" className="font-semibold">{t("whatsNew.title")}</h2>
          <span className="hidden truncate text-sm text-muted-foreground sm:inline">{t("whatsNew.lead")}</span>
        </div>
        {items.length > 1 && (
          <Button variant="ghost" size="sm" className="-mr-2 text-muted-foreground" onClick={() => dismiss(items.map((e) => e.id))}>
            {t("whatsNew.dismissAll")}
          </Button>
        )}
      </div>
      <ul className="-mx-4 mt-3 flex snap-x snap-mandatory scroll-px-4 gap-3 overflow-x-auto px-4 pb-2 sm:mx-0 sm:grid sm:grid-cols-2 sm:overflow-visible sm:px-0 sm:pb-0 xl:grid-cols-3">
        {items.map((entry) => (
          <li key={entry.id} className="w-[82%] max-w-sm shrink-0 snap-start sm:w-auto sm:max-w-none">
            <WhatsNewCard entry={entry} onDismiss={() => dismiss([entry.id])} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function WhatsNewCard({ entry, onDismiss }: { entry: WhatsNewEntry; onDismiss: () => void }) {
  const Icon = WHATS_NEW_ICON[entry.icon];
  const { title, body } = entryText(entry);
  return (
    <article className="flex h-full flex-col rounded-xl border border-border bg-card p-4 shadow-sm">
      <div className="flex items-start justify-between gap-2">
        <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand/15 text-link" aria-hidden>
          <Icon className="h-5 w-5" />
        </span>
        <NewBadge />
      </div>
      <h3 className="mt-3 break-words font-semibold">{title}</h3>
      <p className="mt-1 text-sm text-muted-foreground">{body}</p>
      <div className="mt-auto flex items-center gap-2 pt-4">
        <Button asChild size="sm">
          <Link href={entry.href ?? entry.route ?? "/"}>
            {t(entry.cta === "try" ? "whatsNew.cta.try" : "whatsNew.cta.view")}
            <ArrowRight className="h-4 w-4" aria-hidden />
          </Link>
        </Button>
        <Button variant="ghost" size="sm" className="text-muted-foreground" aria-label={t("whatsNew.dismissAria", { title })} onClick={onDismiss}>
          <X className="h-4 w-4" aria-hidden />
          {t("whatsNew.dismiss")}
        </Button>
      </div>
    </article>
  );
}
