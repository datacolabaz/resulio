import { AppShell, EmptyState, ErrorNote, Loading, Panel } from "@/components/AppShell";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n/messages";
import { errorText } from "@/lib/format";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { ShieldCheck } from "lucide-react";
import { Link } from "wouter";
import { toast } from "sonner";

export type CoachStatus = RouterOutputs["student"]["coach"]["status"];

const PRIVACY_SECTIONS = ["stored", "who", "ai", "delete", "minimal", "limits"] as const;

/** The privacy notice: shown before first use and linked from the coach settings. */
export function PrivacyNotice({ accepted, onAccepted }: { accepted: boolean; onAccepted?: () => void }) {
  const utils = trpc.useUtils();
  const accept = trpc.student.coach.acceptConsent.useMutation({
    onSuccess: () => {
      void utils.student.coach.status.invalidate();
      onAccepted?.();
    },
    onError: (e) => toast.error(errorText(e)),
  });
  return (
    <Panel title={t("coach.privacy.title")}>
      <p className="mb-4 max-w-3xl text-sm text-muted-foreground">{t("coach.privacy.intro")}</p>
      <div className="space-y-4">
        {PRIVACY_SECTIONS.map((s) => (
          <section key={s}>
            <h3 className="text-sm font-semibold">{t(`coach.privacy.${s}.title`)}</h3>
            <p className="mt-1 max-w-3xl text-sm text-muted-foreground">{t(`coach.privacy.${s}.body`)}</p>
          </section>
        ))}
      </div>
      <div className="mt-5 flex flex-wrap items-center gap-3">
        {accepted ? (
          <span className="flex items-center gap-2 text-sm text-success">
            <ShieldCheck className="h-4 w-4" aria-hidden />
            {t("coach.privacy.accepted")}
          </span>
        ) : (
          <Button disabled={accept.isPending} onClick={() => accept.mutate()}>{t("coach.privacy.accept")}</Button>
        )}
      </div>
    </Panel>
  );
}

/**
 * Wraps every coach page: the flag, the privacy notice before first use, then the page itself.
 * `title` is the page heading; children get the status (settings, quota, limits).
 */
export function CoachShell({ title, intro, back, children }: { title: string; intro?: string; back?: string; children: (status: CoachStatus) => React.ReactNode }) {
  const enabled = trpc.student.coach.enabled.useQuery(undefined, { staleTime: 5 * 60_000 });
  const status = trpc.student.coach.status.useQuery(undefined, { enabled: !!enabled.data?.enabled });
  return (
    <AppShell area="learning">
      <div className="mx-auto max-w-4xl space-y-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            {back && (
              <Link href={back} className="text-sm text-link hover:underline">
                {t("coach.back")}
              </Link>
            )}
            <h1 className="font-[family-name:var(--font-display)] text-2xl break-words">{title}</h1>
            {intro && <p className="mt-1 max-w-3xl text-sm text-muted-foreground">{intro}</p>}
          </div>
          {status.data?.settings.consentAt && (
            <Link href="/student/coach/settings" className="text-sm text-link hover:underline">
              {t("coach.settings.link")}
            </Link>
          )}
        </div>
        {!enabled.data ? (
          <Loading />
        ) : !enabled.data.enabled ? (
          <EmptyState title={t("nav.coach")} body={t("coach.notEnabled")} />
        ) : status.error ? (
          <ErrorNote error={status.error} />
        ) : !status.data ? (
          <Loading />
        ) : !status.data.settings.consentAt ? (
          <PrivacyNotice accepted={false} />
        ) : (
          children(status.data)
        )}
      </div>
    </AppShell>
  );
}

/** The student's coach quota in one line, with a warning from 80 %. */
export function QuotaLine({ quota }: { quota: CoachStatus["quota"] }) {
  const daily = quota.daily.limit ? t("coach.quota.daily", { used: quota.daily.used, limit: quota.daily.limit }) : null;
  const monthly = quota.monthly.limit ? t("coach.quota.monthly", { pct: Math.round(quota.monthly.ratio * 100) }) : null;
  if (!daily && !monthly) return null;
  return (
    <p className={`text-xs ${quota.blocked ? "text-destructive" : quota.warn ? "text-warning" : "text-muted-foreground"}`}>
      {[daily, monthly].filter(Boolean).join(" · ")}
      {quota.blocked && ` · ${t("coach.quota.blocked")}`}
    </p>
  );
}
