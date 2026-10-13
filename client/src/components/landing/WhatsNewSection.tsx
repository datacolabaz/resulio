import { Pill } from "@/components/AppShell";
import { entryText, NewBadge, WHATS_NEW_ICON } from "@/components/WhatsNew";
import { t } from "@/i18n/messages";
import { useLocalMarks, writeLocalMarks } from "@/lib/whatsNew";
import { isHandled, landingEntries, primaryAudience, withinWindow, type InAppAudience, type WhatsNewEntry } from "@shared/whatsNew";
import { CheckCircle2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

const OWNER = "landing";

/**
 * Landing "Yeni nə var": every public registry entry, grouped for students and teachers. The "Yeni"
 * pill shows inside the entry's window until this browser has once scrolled the section into view
 * (kept in localStorage); the cards themselves always stay, they are also the crawlable text.
 */
export function WhatsNewSection({ action }: { action?: React.ReactNode }) {
  const entries = landingEntries();
  const marks = useLocalMarks(OWNER);
  // Decided once per visit, so the pills do not vanish while the visitor is looking at them.
  const [seenBefore] = useState(() => new Set(entries.filter((e) => isHandled(marks[e.id])).map((e) => e.id)));
  const ref = useRef<HTMLElement>(null);
  const now = new Date();

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (records) => {
        if (!records.some((r) => r.isIntersecting)) return;
        writeLocalMarks(OWNER, entries.map((e) => e.id), "seen");
        observer.disconnect();
      },
      { threshold: 0.3 },
    );
    observer.observe(el);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const groups = (["student", "teacher"] as InAppAudience[])
    .map((audience) => ({ audience, items: entries.filter((e) => primaryAudience(e) === audience) }))
    .filter((g) => g.items.length);

  return (
    <section id="whats-new" ref={ref} aria-labelledby="whats-new-heading" className="scroll-mt-8">
      <div className="mx-auto max-w-2xl text-center">
        <p className="text-sm font-semibold uppercase tracking-[0.2em] text-link">{t("whatsNew.landing.eyebrow")}</p>
        <h2 id="whats-new-heading" className="mt-2 break-words text-2xl font-semibold leading-tight sm:text-3xl">{t("whatsNew.landing.title")}</h2>
        <p className="mt-4 text-foreground-secondary">{t("whatsNew.landing.lead")}</p>
      </div>
      <div className="mt-10 space-y-10">
        {groups.map(({ audience, items }) => (
          <div key={audience}>
            <h3 className="mb-4 text-sm font-semibold uppercase tracking-wide text-muted-foreground">{t(audience === "student" ? "whatsNew.audience.student" : "whatsNew.audience.teacher")}</h3>
            <ul className={`grid gap-5 sm:grid-cols-2 ${items.length >= 3 ? "lg:grid-cols-3" : ""}`}>
              {items.map((entry) => (
                <LandingCard key={entry.id} entry={entry} isNew={withinWindow(entry, now) && !seenBefore.has(entry.id)} />
              ))}
            </ul>
          </div>
        ))}
      </div>
      {action && <div className="mt-10 flex justify-center">{action}</div>}
    </section>
  );
}

function LandingCard({ entry, isNew }: { entry: WhatsNewEntry; isNew: boolean }) {
  const Icon = WHATS_NEW_ICON[entry.icon];
  const { title, body, points } = entryText(entry);
  return (
    <li className="flex min-w-0 flex-col rounded-2xl border border-border bg-card p-6 shadow-sm motion-safe:transition-transform motion-safe:hover:-translate-y-0.5">
      <div className="flex items-start justify-between gap-3">
        <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-brand/25 to-brand/5 text-link" aria-hidden>
          <Icon className="h-6 w-6" />
        </span>
        <span className="flex flex-wrap justify-end gap-1.5">
          {entry.premium && <Pill>{t("whatsNew.premium")}</Pill>}
          {isNew && <NewBadge />}
        </span>
      </div>
      <h4 className="mt-4 break-words text-lg font-semibold">{title}</h4>
      <p className="mt-2 text-sm text-foreground-secondary">{body}</p>
      {points.length > 0 && (
        <ul className="mt-4 space-y-2 text-sm">
          {points.map((p) => (
            <li key={p} className="flex gap-2">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden />
              <span className="min-w-0">{p}</span>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}
