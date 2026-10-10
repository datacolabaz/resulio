import { AppShell, ChoiceChip, EmptyState, ErrorNote, Loading, Panel } from "@/components/AppShell";
import { StatusBadge } from "@/components/StatusBadge";
import { Input } from "@/components/ui/input";
import { t } from "@/i18n/messages";
import { attemptLabel } from "@/lib/attemptLabel";
import { errorText, fmtDateTime, fmtDay, fmtDuration, fmtRelative } from "@/lib/format";
import { joinSourceLabel } from "@/lib/joinSource";
import { PARTICIPANT_STATUS, participantLabel } from "@/lib/status";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { INACTIVITY_THRESHOLDS, type ParticipantState } from "@shared/assessment";
import { Monitor } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Link, useParams } from "wouter";

type Report = RouterOutputs["teacher"]["assessments"]["participants"];
type Row = Report["participants"][number];

const REFRESH_MS = 30_000;
/** A heartbeat newer than this means the exam page is still open on the student's device. */
const PAGE_OPEN_MS = 2 * 60_000;

function RowDetail({ p, now }: { p: Row; now: number }) {
  const answered = t("participants.answered", { done: p.answeredCount, total: p.totalQuestionCount });
  switch (p.state) {
    case "IN_PROGRESS":
    case "INACTIVE": {
      const pageOpen = p.lastHeartbeatAt && now - new Date(p.lastHeartbeatAt).getTime() < PAGE_OPEN_MS;
      return (
        <>
          <div>{answered}</div>
          <div>{t("participants.lastActivity", { when: fmtRelative(p.lastActivityAt, now) })}</div>
          {p.remainingSeconds !== null && <div>{t("participants.remaining", { time: fmtDuration(p.remainingSeconds) })}</div>}
          {pageOpen && (
            <div className="inline-flex items-center gap-1 text-foreground-secondary">
              <Monitor className="h-3.5 w-3.5" aria-hidden /> {t("participants.pageOpen")}
            </div>
          )}
        </>
      );
    }
    case "AUTO_SUBMITTED":
      return (
        <>
          <div>{t("participants.autosaved", { done: p.answeredCount, total: p.totalQuestionCount })}</div>
          <div>{t("participants.notFinalSubmitted", { date: fmtDateTime(p.submittedAt) })}</div>
        </>
      );
    case "EXPIRED_NO_ANSWERS":
      return (
        <>
          <div>{t("participants.noAnswers", { total: p.totalQuestionCount })}</div>
          <div>{t("participants.started", { date: fmtDateTime(p.startedAt) })}</div>
        </>
      );
    case "COMPLETED":
    case "PENDING_REVIEW":
      return (
        <>
          <div>{answered}</div>
          <div>{t("participants.finished", { when: fmtRelative(p.submittedAt, now) })}</div>
        </>
      );
    case "VIEWED":
      return <div>{t("participants.viewed", { when: fmtRelative(p.viewedAt, now) })}</div>;
    default:
      return <div>{t("participants.notOpened")}</div>;
  }
}

/** Why the student is on this exam: "Qrup: X · kod linki ilə · 09.10.2026", or an individual pick. */
function RosterSourceLine({ source }: { source: Row["rosterSource"] }) {
  if (!source) return null;
  const text =
    source.kind === "GROUP"
      ? t("participants.viaGroup", { group: source.groupName, via: joinSourceLabel(source.joinedVia), date: fmtDay(source.joinedAt) })
      : t("participants.viaIndividual", { date: fmtDay(source.assignedAt) });
  const title = source.kind === "GROUP" ? [source.detail, fmtDateTime(source.joinedAt)].filter(Boolean).join(" · ") : fmtDateTime(source.assignedAt);
  return <div className="break-words text-xs text-muted-foreground" title={title}>{text}</div>;
}

function ResultCell({ p }: { p: Row }) {
  if (p.state === "EXPIRED_NO_ANSWERS") return <span className="text-muted-foreground">{t("participants.notSubmitted")}</span>;
  if (!p.resultId) return <span className="text-muted-foreground">—</span>;
  return (
    <Link href={`/teacher/results/${p.resultId}`} className="font-semibold text-link underline-offset-4 hover:underline">
      {p.percentage !== null ? `${p.percentage}%` : t("common.view")}
      {p.pendingReviewCount > 0 && <span className="ml-1 font-normal text-warning">{t("participants.toGrade", { count: p.pendingReviewCount })}</span>}
    </Link>
  );
}

/** Live participant list for one assessment (also embedded in the detail page's participants tab). */
export function ParticipantsReport({ id }: { id: string }) {
  const utils = trpc.useUtils();
  const report = trpc.teacher.assessments.participants.useQuery({ id }, { refetchInterval: REFRESH_MS });
  const setThreshold = trpc.teacher.assessments.setInactivityThreshold.useMutation({
    onSuccess: () => utils.teacher.assessments.participants.invalidate({ id }),
    onError: (e) => toast.error(errorText(e)),
  });
  const [filter, setFilter] = useState<ParticipantState | "ALL">("ALL");
  const [query, setQuery] = useState("");
  const d = report.data;
  const now = d ? new Date(d.serverNow).getTime() + (Date.now() - report.dataUpdatedAt) : Date.now();

  const rows = useMemo(() => {
    // Names are Azerbaijani content whatever the UI language: "İ"/"ı" must fold the Azerbaijani way.
    const q = query.trim().toLocaleLowerCase("az");
    return (d?.participants ?? []).filter(
      (p) => (filter === "ALL" || p.state === filter) && (!q || p.name.toLocaleLowerCase("az").includes(q) || p.email?.toLowerCase().includes(q)),
    );
  }, [d, filter, query]);

  if (report.error) return <ErrorNote error={report.error} />;
  if (!d) return <Loading />;
  const states = (Object.keys(PARTICIPANT_STATUS) as ParticipantState[]).filter((s) => d.summary.counts[s] > 0);

  return (
    <Panel
      title={t("participants.title", { count: d.summary.total })}
      action={
        <label className="flex items-center gap-2 text-xs text-foreground-secondary">
          {t("participants.threshold")}
          <select
            className="rounded-md border border-input bg-card px-2 py-1 text-sm text-foreground"
            value={d.assessment.inactivityThresholdMinutes ?? "off"}
            disabled={setThreshold.isPending}
            onChange={(e) => {
              const v = e.target.value;
              setThreshold.mutate({ id, minutes: v === "off" ? null : (Number(v) as (typeof INACTIVITY_THRESHOLDS)[number]) });
            }}
          >
            {INACTIVITY_THRESHOLDS.map((m) => (
              <option key={m} value={m}>{t("participants.minutes", { count: m })}</option>
            ))}
            <option value="off">{t("participants.thresholdOff")}</option>
          </select>
        </label>
      }
    >
      <p className="mb-3 text-xs text-muted-foreground">
        {t("participants.inactiveExplain", { minutes: d.assessment.inactivityThresholdMinutes ?? "—" })}
      </p>

      <div className="mb-3 flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
        <div className="flex flex-wrap gap-1.5" role="group" aria-label={t("participants.filter")}>
          <ChoiceChip selected={filter === "ALL"} onClick={() => setFilter("ALL")}>{t("common.all")} · {d.summary.total}</ChoiceChip>
          {states.map((s) => {
            const Icon = PARTICIPANT_STATUS[s].icon;
            return (
              <ChoiceChip key={s} selected={filter === s} onClick={() => setFilter(s)}>
                {filter !== s && <Icon className="h-3.5 w-3.5" aria-hidden />}
                {participantLabel(s)} · {d.summary.counts[s]}
              </ChoiceChip>
            );
          })}
        </div>
        <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("participants.searchStudent")} className="md:w-56" aria-label={t("participants.searchStudentLabel")} />
      </div>

      {rows.length === 0 ? (
        <EmptyState title={t("participants.empty")} body={d.summary.total ? t("participants.emptyFilter") : t("participants.emptyAssign")} />
      ) : (
        <ul className="divide-y rounded-xl border">
          {rows.map((p) => {
            const st = PARTICIPANT_STATUS[p.state];
            return (
              <li key={p.studentId} className="grid gap-2 p-3 text-sm md:grid-cols-[minmax(0,1.3fr)_auto_minmax(0,1.6fr)_auto] md:items-center md:gap-4">
                <div className="min-w-0">
                  <div className="break-words font-medium">{p.name}</div>
                  {p.email && <div className="break-all text-xs text-muted-foreground">{p.email}</div>}
                  {!p.onRoster && <div className="text-xs text-warning">{t("participants.offRoster")}</div>}
                  <RosterSourceLine source={p.rosterSource} />
                </div>
                <StatusBadge tone={st.tone} icon={st.icon}>{participantLabel(p.state)}</StatusBadge>
                <div className="space-y-0.5 text-xs text-foreground-secondary">
                  <RowDetail p={p} now={now} />
                  {p.startedAt && p.state !== "EXPIRED_NO_ANSWERS" && (
                    <div className="text-muted-foreground">
                      {t("participants.started", { date: fmtDateTime(p.startedAt) })}
                      {p.attemptsUsed > 1 ? ` · ${attemptLabel(p.attemptsUsed)}` : ""}
                    </div>
                  )}
                </div>
                <div className="md:text-right"><ResultCell p={p} /></div>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

/** `/teacher/assessments/:id/participants` */
export function AssessmentParticipantsPage() {
  const { id = "" } = useParams<{ id: string }>();
  const detail = trpc.teacher.assessments.detail.useQuery({ id });
  return (
    <AppShell area="teaching" title={detail.data ? t("participants.pageTitle", { title: detail.data.title }) : t("common.participants")}>
      <div className="mx-auto max-w-5xl space-y-4">
        <Link href={`/teacher/assessments/${id}`} className="text-sm text-link underline-offset-4 hover:underline">{t("participants.backToExam")}</Link>
        <ParticipantsReport id={id} />
      </div>
    </AppShell>
  );
}
