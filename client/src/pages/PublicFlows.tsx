import { useAuth } from "@/_core/hooks/useAuth";
import { LanguageSwitch, ThemeToggle } from "@/components/AppShell";
import { BrandMark } from "@/components/BrandMark";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { startLogin } from "@/const";
import { t } from "@/i18n/messages";
import { canEnter } from "@/lib/contexts";
import { errorText, fmtDateTime, fmtDay, fmtDuration, groupFormatLabel, groupLanguageLabel, liveLabel, scheduleSummary, typeLabel } from "@/lib/format";
import { trpc } from "@/lib/trpc";
import type { ClassScheduleEntry } from "@shared/schedule";
import { useState } from "react";
import { Link, useParams } from "wouter";

const TARGET_EXAM_CODES = ["IELTS", "GOETHE", "TELC", "TESTDAF", "DUOLINGO", "SAT", "AP", "IB", "PMP", "SCHOOL", "OTHER"] as const;

/**
 * Shown once, right after a student's first successful group join — optional and skippable, per
 * spec. `onDone` fires whether the student saved something or skipped; either way the server
 * stamps `studentOnboardedAt` so this never appears again for that user.
 */
function StudentOnboarding({ onDone }: { onDone: () => void }) {
  const [targetExam, setTargetExam] = useState("");
  const [targetScore, setTargetScore] = useState("");
  const [targetExamDate, setTargetExamDate] = useState("");
  const complete = trpc.auth.completeStudentOnboarding.useMutation({ onSuccess: onDone });
  const save = () => {
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    complete.mutate({
      timezone,
      targetExam: targetExam || undefined,
      targetScore: targetScore.trim() || undefined,
      targetExamDate: targetExamDate ? new Date(targetExamDate).toISOString() : undefined,
    });
  };
  return (
    <div className="mt-6 border-t pt-5 text-left">
      <h2 className="text-sm font-semibold">{t("public.onboarding.title")}</h2>
      <p className="mt-1 text-xs text-muted-foreground">{t("public.onboarding.lead")}</p>
      <div className="mt-3 grid gap-3">
        <label className="text-sm">
          <span className="text-foreground-secondary">{t("public.onboarding.examLabel")}</span>
          <select
            className="mt-1 h-9 w-full rounded-md border border-input bg-card px-3 text-sm text-foreground"
            value={targetExam}
            onChange={(e) => setTargetExam(e.target.value)}
          >
            <option value="">{t("public.onboarding.examUnset")}</option>
            {TARGET_EXAM_CODES.map((code) => (
              <option key={code} value={code}>{t(`public.onboarding.targetExam.${code}`)}</option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <span className="text-foreground-secondary">{t("public.onboarding.scoreLabel")}</span>
          <Input value={targetScore} maxLength={32} onChange={(e) => setTargetScore(e.target.value)} placeholder={t("public.onboarding.scorePlaceholder")} />
        </label>
        <label className="text-sm">
          <span className="text-foreground-secondary">{t("public.onboarding.dateLabel")}</span>
          <Input type="date" value={targetExamDate} onChange={(e) => setTargetExamDate(e.target.value)} />
        </label>
      </div>
      <div className="mt-4 flex gap-2">
        <Button size="sm" disabled={complete.isPending} onClick={save}>{t("public.onboarding.save")}</Button>
        <Button size="sm" variant="ghost" disabled={complete.isPending} onClick={onDone}>{t("public.onboarding.skip")}</Button>
      </div>
      {complete.error && <p role="alert" className="mt-2 text-sm text-destructive">{errorText(complete.error)}</p>}
    </div>
  );
}

/** Extra group facts shown on a join-preview screen, only for the fields the teacher chose to share. */
function GroupPreviewDetails({ g }: { g: { language?: string; format?: string; startDate?: string | Date | null; classSchedule?: ClassScheduleEntry[] } }) {
  const schedule = scheduleSummary(g.classSchedule);
  return (
    <dl className="mt-3 space-y-1 text-xs text-muted-foreground">
      {!!g.language && (
        <div className="flex gap-1"><dt className="font-medium text-foreground-secondary">{t("public.preview.language")}:</dt><dd>{groupLanguageLabel(g.language)}</dd></div>
      )}
      {!!g.format && (
        <div className="flex gap-1"><dt className="font-medium text-foreground-secondary">{t("public.preview.format")}:</dt><dd>{groupFormatLabel(g.format)}</dd></div>
      )}
      {!!schedule && (
        <div className="flex gap-1"><dt className="font-medium text-foreground-secondary">{t("public.preview.schedule")}:</dt><dd>{schedule}</dd></div>
      )}
      {!!g.startDate && <div>{t("public.preview.startsOn", { date: fmtDay(g.startDate) })}</div>}
    </dl>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-4 sm:p-6">
      <div className="w-full max-w-md rounded-3xl border bg-card p-6 sm:p-8">
        <div className="flex items-start justify-between gap-3">
          <BrandMark size={48} className="rounded-xl" />
          <div className="flex items-center gap-2">
            <LanguageSwitch />
            <ThemeToggle />
          </div>
        </div>
        {children}
      </div>
    </main>
  );
}

export function JoinGroupPage() {
  const { inviteCode = "" } = useParams<{ inviteCode: string }>();
  const { user, loading } = useAuth();
  const invite = trpc.public.invite.useQuery({ inviteCode }, { enabled: inviteCode.length >= 4, retry: false });
  const utils = trpc.useUtils();
  const join = trpc.student.join.useMutation({ onSuccess: () => utils.auth.me.invalidate() });
  const [onboardingDone, setOnboardingDone] = useState(false);
  const g = invite.data;
  return (
    <Card>
      <h1 className="mt-4 text-xl font-semibold">{t("public.join.title")}</h1>
      {invite.isLoading ? <p role="status" className="mt-3 text-sm text-muted-foreground">{t("common.loading")}</p> : !g ? (
        <p role="alert" className="mt-3 text-sm text-destructive">{t("public.join.notFound")}</p>
      ) : (
        <>
          <div className="mt-3 break-words text-lg">{g.name}</div>
          <p className="text-sm text-muted-foreground">{[g.subject, g.grade, g.teacherName].filter(Boolean).join(" · ")}</p>
          <GroupPreviewDetails g={g} />
          {!!g.description && <p className="mt-3 text-sm">{g.description}</p>}
          <div className="mt-6">
            {loading ? null : !user ? (
              <Button className="w-full" onClick={() => startLogin(`/join/${inviteCode}`)}>{t("common.signInGoogle")}</Button>
            ) : join.isSuccess ? (
              <div className="space-y-3 text-sm" role="status">
                <p className="text-success">{join.data.status === "ACTIVE" ? t("public.invite.joined") : t("public.join.sent")}</p>
                <Link href="/student/groups" className="text-link underline-offset-4 hover:underline">{t("public.myGroups")}</Link>
                {user && !user.studentOnboardedAt && !onboardingDone && <StudentOnboarding onDone={() => setOnboardingDone(true)} />}
              </div>
            ) : g.joinPolicy === "MANUAL" ? (
              <p role="alert" className="text-sm text-muted-foreground">{t("public.join.notAccepting")}</p>
            ) : (
              <>
                <Button className="w-full" disabled={join.isPending} onClick={() => join.mutate({ inviteCode })}>
                  {g.joinPolicy === "AUTO" ? t("public.join.joinNow") : t("public.join.request")}
                </Button>
                {join.error && <p role="alert" className="mt-2 text-sm text-destructive">{errorText(join.error)}</p>}
              </>
            )}
          </div>
        </>
      )}
    </Card>
  );
}

export function PublicEmailInvitePage() {
  const { token = "" } = useParams<{ token: string }>();
  const { user, loading } = useAuth();
  const invite = trpc.public.emailInvite.useQuery({ token }, { enabled: token.length >= 16, retry: false });
  const utils = trpc.useUtils();
  const accept = trpc.student.acceptEmailInvite.useMutation({ onSuccess: () => utils.auth.me.invalidate() });
  const [onboardingDone, setOnboardingDone] = useState(false);
  const g = invite.data;
  const returnTo = `/invite/${token}`;
  return (
    <Card>
      <h1 className="mt-4 text-xl font-semibold">{t("public.join.title")}</h1>
      {invite.isLoading ? <p role="status" className="mt-3 text-sm text-muted-foreground">{t("common.loading")}</p> : !g ? (
        <p role="alert" className="mt-3 text-sm text-destructive">{t("public.invite.notFound")}</p>
      ) : (
        <>
          <div className="mt-3 break-words text-lg">{g.name}</div>
          <p className="text-sm text-muted-foreground">{[g.subject, g.grade, g.teacherName].filter(Boolean).join(" · ")}</p>
          <GroupPreviewDetails g={g} />
          {!!g.description && <p className="mt-3 text-sm">{g.description}</p>}
          <p className="mt-3 text-xs text-muted-foreground">{t("public.invite.emailNote")}</p>
          <div className="mt-6">
            {loading ? null : !user ? (
              <Button className="w-full" onClick={() => startLogin(returnTo)}>{t("common.signInGoogle")}</Button>
            ) : accept.isSuccess ? (
              <div className="space-y-3 text-sm" role="status">
                <p className="text-success">{t("public.invite.joined")}</p>
                <Link href="/student/groups" className="text-link underline-offset-4 hover:underline">{t("public.myGroups")}</Link>
                {user && !user.studentOnboardedAt && !onboardingDone && <StudentOnboarding onDone={() => setOnboardingDone(true)} />}
              </div>
            ) : (
              <>
                <Button className="w-full" disabled={accept.isPending} onClick={() => accept.mutate({ token })}>{t("public.join.request")}</Button>
                {accept.error && <p role="alert" className="mt-2 text-sm text-destructive">{errorText(accept.error)}</p>}
              </>
            )}
          </div>
        </>
      )}
    </Card>
  );
}

export function PublicExamPage() {
  const { shareCode = "" } = useParams<{ shareCode: string }>();
  const { user, loading } = useAuth();
  const exam = trpc.public.exam.useQuery({ shareCode }, { enabled: shareCode.length >= 4, retry: false });
  const e = exam.data;
  const returnTo = `/exam/${shareCode}`;
  return (
    <Card>
      {exam.isLoading ? <p role="status" className="mt-4 text-sm text-muted-foreground">{t("common.loading")}</p> : !e ? (
        <p role="alert" className="mt-4 text-sm text-destructive">{t("public.exam.notFound")}</p>
      ) : (
        <>
          <div className="mt-4 text-xs uppercase tracking-wide text-link">{typeLabel(e.type)} · {liveLabel(e.liveStatus)}</div>
          <h1 className="mt-1 break-words text-2xl font-semibold">{e.title}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{[e.teacherName, e.subject].filter(Boolean).join(" · ")}</p>
          {e.description && <p className="mt-3 break-words text-sm text-foreground-secondary">{e.description}</p>}
          <dl className="mt-4 grid grid-cols-2 gap-2 text-sm">
            <div><dt className="text-muted-foreground">{t("builder.start")}</dt><dd>{fmtDateTime(e.startAt)}</dd></div>
            <div><dt className="text-muted-foreground">{t("builder.end")}</dt><dd>{fmtDateTime(e.endAt)}</dd></div>
            <div><dt className="text-muted-foreground">{t("common.duration")}</dt><dd>{fmtDuration(e.durationSeconds)}</dd></div>
            <div><dt className="text-muted-foreground">{t("student.questionCount")}</dt><dd>{e.questionCount}</dd></div>
          </dl>
          <div className="mt-6">
            {loading ? null : !user ? (
              <Button className="w-full" onClick={() => startLogin(returnTo)}>{t("common.signInGoogle")}</Button>
            ) : !canEnter(user, "learning") ? (
              <p className="text-sm text-foreground-secondary">
                {t("public.exam.joinFirst")}{" "}
                <Link href="/welcome" className="text-link underline-offset-4 hover:underline">{t("public.exam.joinLink")}</Link>
              </p>
            ) : (
              <>
                <Button asChild className="w-full">
                  <Link href={`/student/assessments/${e.id}`}>{t("common.continue")}</Link>
                </Button>
                <p className="mt-2 text-xs text-muted-foreground">{t("public.exam.assignedNote")}</p>
              </>
            )}
          </div>
        </>
      )}
    </Card>
  );
}

export function PublicTaskPage() {
  const { shareCode = "" } = useParams<{ shareCode: string }>();
  const { user, loading } = useAuth();
  const task = trpc.public.task.useQuery({ shareCode }, { enabled: shareCode.length >= 4, retry: false });
  const claim = trpc.student.claimTask.useMutation();
  const a = task.data;
  const returnTo = `/task/${shareCode}`;
  return (
    <Card>
      {task.isLoading ? <p role="status" className="mt-4 text-sm text-muted-foreground">{t("common.loading")}</p> : !a ? (
        <p role="alert" className="mt-4 text-sm text-destructive">{t("public.task.notFound")}</p>
      ) : (
        <>
          <h1 className="mt-4 break-words text-2xl font-semibold">{a.title}</h1>
          {a.description && <p className="mt-3 break-words text-sm text-foreground-secondary">{a.description}</p>}
          <p className="mt-3 text-sm text-muted-foreground">{t("modules.deadlineValue", { date: fmtDateTime(a.deadline) })}</p>
          <div className="mt-6">
            {loading ? null : !user ? (
              <Button className="w-full" onClick={() => startLogin(returnTo)}>{t("common.signInGoogle")}</Button>
            ) : claim.isSuccess ? (
              <div className="space-y-3 text-sm" role="status">
                <p className="text-success">{t("public.task.claimed")}</p>
                {canEnter(user, "learning") ? (
                  <Link href="/student/assignments" className="text-link underline-offset-4 hover:underline">{t("public.task.goToTasks")}</Link>
                ) : (
                  <p className="text-foreground-secondary">
                    {t("public.task.needsLearning")}{" "}
                    <Link href="/welcome" className="text-link underline-offset-4 hover:underline">{t("public.exam.joinLink")}</Link>
                  </p>
                )}
              </div>
            ) : (
              <>
                <Button className="w-full" disabled={claim.isPending} onClick={() => claim.mutate({ shareCode })}>{t("public.task.claim")}</Button>
                {claim.error && <p role="alert" className="mt-2 text-sm text-destructive">{errorText(claim.error)}</p>}
              </>
            )}
          </div>
        </>
      )}
    </Card>
  );
}

export function PublicMaterialPage() {
  const { shareCode = "" } = useParams<{ shareCode: string }>();
  const { user, loading } = useAuth();
  const material = trpc.public.material.useQuery({ shareCode }, { enabled: shareCode.length >= 4, retry: false });
  const claim = trpc.student.claimMaterial.useMutation();
  const m = material.data;
  const returnTo = `/material/${shareCode}`;
  return (
    <Card>
      {material.isLoading ? <p role="status" className="mt-4 text-sm text-muted-foreground">{t("common.loading")}</p> : !m ? (
        <p role="alert" className="mt-4 text-sm text-destructive">{t("public.material.notFound")}</p>
      ) : (
        <>
          <h1 className="mt-4 break-words text-2xl font-semibold">{m.title}</h1>
          {m.description && <p className="mt-3 break-words text-sm text-foreground-secondary">{m.description}</p>}
          <p className="mt-3 text-sm text-muted-foreground">{[m.subject, m.topic, m.fileName].filter(Boolean).join(" · ")}</p>
          <div className="mt-6">
            {loading ? null : !user ? (
              <Button className="w-full" onClick={() => startLogin(returnTo)}>{t("common.signInGoogle")}</Button>
            ) : claim.isSuccess ? (
              <div className="space-y-3 text-sm" role="status">
                <p className="text-success">{t("public.material.claimed")}</p>
                {canEnter(user, "learning") ? (
                  <Link href="/student/materials" className="text-link underline-offset-4 hover:underline">{t("public.material.goToMaterials")}</Link>
                ) : (
                  <p className="text-foreground-secondary">
                    {t("public.material.needsLearning")}{" "}
                    <Link href="/welcome" className="text-link underline-offset-4 hover:underline">{t("public.exam.joinLink")}</Link>
                  </p>
                )}
              </div>
            ) : (
              <>
                <Button className="w-full" disabled={claim.isPending} onClick={() => claim.mutate({ shareCode })}>{t("public.material.claim")}</Button>
                {claim.error && <p role="alert" className="mt-2 text-sm text-destructive">{errorText(claim.error)}</p>}
              </>
            )}
          </div>
        </>
      )}
    </Card>
  );
}
