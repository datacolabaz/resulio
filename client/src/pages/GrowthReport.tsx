import { Loading } from "@/components/AppShell";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n/messages";
import { fmtDay, fmtNumber } from "@/lib/format";
import { trpc } from "@/lib/trpc";
import { Printer } from "lucide-react";
import { useParams } from "wouter";

/** Parent report behind a share link: read-only, no sign-in, print-friendly. */
export function GrowthReportPage() {
  const { token = "" } = useParams<{ token: string }>();
  const report = trpc.public.growthReport.useQuery({ token }, { enabled: token.length >= 16, retry: false });
  if (report.isLoading) return <Loading />;
  if (!report.data) {
    return (
      <main className="mx-auto max-w-2xl p-6">
        <p className="rounded-2xl border border-dashed border-border bg-card p-10 text-center text-sm text-muted-foreground">{t("report.notFound")}</p>
      </main>
    );
  }
  const r = report.data;
  return (
    <main className="mx-auto max-w-3xl space-y-6 p-6 print:p-0">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="break-words font-[family-name:var(--font-display)] text-2xl">{t("report.title")}: {r.studentName}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{r.teacher && `${t("report.from", { name: r.teacher })} · `}{t("report.generated", { date: fmtDay(r.generatedAt) })}</p>
        </div>
        <Button variant="outline" size="sm" className="print:hidden" onClick={() => window.print()}>
          <Printer className="mr-1.5 h-4 w-4" aria-hidden />
          {t("report.print")}
        </Button>
      </header>
      <section className="rounded-2xl border border-border bg-card p-5">
        <div className="text-xs uppercase tracking-wide text-muted-foreground">{t("report.average")}</div>
        <div className="mt-1 text-3xl tabular-nums">{r.average == null ? "—" : `${fmtNumber(r.average, 1)}%`}</div>
      </section>
      <section className="rounded-2xl border border-border bg-card p-5">
        <h2 className="mb-3 font-semibold">{t("report.results")}</h2>
        {!r.results.length ? (
          <p className="text-sm text-muted-foreground">{t("report.none")}</p>
        ) : (
          <ul className="divide-y">
            {r.results.map((x, i) => (
              <li key={i} className="flex flex-wrap justify-between gap-2 py-2 text-sm">
                <span className="min-w-0 break-words">{x.title}</span>
                <span className="text-muted-foreground">{fmtDay(x.completedAt)} · {x.percentage == null ? "—" : `${fmtNumber(x.percentage, 1)}%`}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <div className="grid gap-6 md:grid-cols-2">
        <TopicList title={t("report.strong")} items={r.strong} />
        <TopicList title={t("report.priority")} items={r.priority} />
      </div>
      <p className="text-xs text-muted-foreground">{t("report.validUntil", { date: fmtDay(r.expiresAt) })}</p>
    </main>
  );
}

function TopicList({ title, items }: { title: string; items: { label: string; mastery: number }[] }) {
  return (
    <section className="rounded-2xl border border-border bg-card p-5">
      <h2 className="mb-3 font-semibold">{title}</h2>
      {!items.length ? (
        <p className="text-sm text-muted-foreground">{t("report.none")}</p>
      ) : (
        <ul className="space-y-1 text-sm">
          {items.map((x) => (
            <li key={x.label} className="flex justify-between gap-2">
              <span className="min-w-0 break-words">{x.label}</span>
              <span className="tabular-nums text-muted-foreground">{Math.round(x.mastery)}%</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
