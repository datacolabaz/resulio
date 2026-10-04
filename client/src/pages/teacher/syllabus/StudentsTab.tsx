import { EmptyState, ErrorNote, Loading, Panel, Pill } from "@/components/AppShell";
import { StatusBadge } from "@/components/StatusBadge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { t, type MessageKey } from "@/i18n/messages";
import { fmtDateTime, fmtDuration, fmtRelative } from "@/lib/format";
import { nodeVisual, pct } from "@/lib/syllabusLearn";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { NodeIcon, ProgressBar, statusText } from "@/pages/student/syllabus/common";
import type { SyllabusGrantState } from "@shared/syllabus";
import { Check, Hourglass, KeyRound, RotateCcw, Undo2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import type { Tree } from "./SyllabusDetail";
import { fieldLabel, GrantStateBadge, toastError } from "./shared";

type StudentRow = RouterOutputs["teacher"]["syllabus"]["students"][number];
type Approval = RouterOutputs["teacher"]["syllabus"]["approvals"][number];
type Detail = RouterOutputs["teacher"]["syllabus"]["student"];

function useStudentsRefresh(id: string) {
  const utils = trpc.useUtils();
  return () => {
    void utils.teacher.syllabus.students.invalidate({ id });
    void utils.teacher.syllabus.approvals.invalidate({ id });
    void utils.teacher.syllabus.student.invalidate();
  };
}

/** Per-student progress, the approval queue, manual unlocks and teacher-practice marks. */
export function StudentsTab({ tree }: { tree: Tree }) {
  const id = tree.syllabus.id;
  const students = trpc.teacher.syllabus.students.useQuery({ id });
  const [open, setOpen] = useState<StudentRow | null>(null);
  if (!tree.syllabus.currentVersionId) return <EmptyState title={t("syllabus.students.notPublishedTitle")} body={t("syllabus.students.notPublishedBody")} />;
  return (
    <div className="space-y-4">
      <ApprovalQueue id={id} />
      <Panel title={t("syllabus.students.title")}>
        {students.error ? (
          <ErrorNote error={students.error} />
        ) : !students.data ? (
          <Loading />
        ) : !students.data.length ? (
          <p className="text-sm text-muted-foreground">{t("syllabus.students.empty")}</p>
        ) : (
          <ul className="divide-y divide-border">
            {students.data.map((s) => (
              <li key={s.studentId} className="flex flex-wrap items-center gap-3 py-3">
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="break-words font-medium">{s.name}</span>
                    {s.access !== "NONE" && <GrantStateBadge state={s.access as SyllabusGrantState} />}
                    {s.enrollment?.status === "COMPLETED" && <StatusBadge tone="success">{t("learn.completed")}</StatusBadge>}
                    {s.enrollment?.versionLabel && <Pill>{s.enrollment.versionLabel}</Pill>}
                  </div>
                  {s.enrollment ? (
                    <>
                      <div className="flex max-w-md items-center gap-2">
                        <ProgressBar value={s.enrollment.progressPct} label={t("learn.overallProgress")} />
                        <span className="shrink-0 text-xs tabular-nums">{s.enrollment.progressPct}%</span>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {t("learn.lessonsDone", { done: s.enrollment.completedLessons, total: s.enrollment.totalLessons })}
                        {s.enrollment.currentLessonTitle ? ` · ${s.enrollment.currentLessonTitle}` : ""}
                        {s.enrollment.lastActivityAt ? ` · ${t("learn.lastActivity", { when: fmtRelative(s.enrollment.lastActivityAt) })}` : ""}
                      </p>
                    </>
                  ) : (
                    <p className="text-xs text-muted-foreground">{t("syllabus.students.notStarted")}</p>
                  )}
                </div>
                {s.enrollment && (
                  <Button size="sm" variant="outline" onClick={() => setOpen(s)}>
                    {t("syllabus.students.details")}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Panel>
      {open && <StudentDialog id={id} row={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

function approvalTarget(a: Approval) {
  if (a.targetType === "SYLLABUS") return t("syllabus.students.approval.syllabus");
  return t(a.targetType === "LESSON" ? "syllabus.students.approval.lesson" : "syllabus.students.approval.module", { title: a.title });
}

function ApprovalQueue({ id }: { id: string }) {
  const q = trpc.teacher.syllabus.approvals.useQuery({ id });
  const refresh = useStudentsRefresh(id);
  const [returning, setReturning] = useState<Approval | null>(null);
  const [note, setNote] = useState("");
  const decide = trpc.teacher.syllabus.decideApproval.useMutation({
    onSuccess: (_r, v) => {
      toast.success(v.decision === "APPROVED" ? t("syllabus.students.approved") : t("syllabus.students.returned"));
      setReturning(null);
      setNote("");
      refresh();
    },
    onError: toastError,
  });
  if (q.error) return <ErrorNote error={q.error} />;
  if (!q.data?.length) return null;
  const send = (a: Approval, decision: "APPROVED" | "RETURNED", text = "") =>
    decide.mutate({ id, studentId: a.studentId, targetType: a.targetType, targetId: a.targetId, decision, note: text });
  return (
    <Panel title={t("syllabus.students.queueTitle", { count: q.data.length })}>
      <ul className="space-y-2">
        {q.data.map((a) => (
          <li key={`${a.enrollmentId}:${a.targetType}:${a.targetId}`} className="flex flex-wrap items-center gap-3 rounded-xl border border-border p-3">
            <Hourglass className="h-4 w-4 shrink-0 text-warning" aria-hidden />
            <div className="min-w-0 flex-1">
              <div className="break-words font-medium">{a.studentName}</div>
              <div className="break-words text-sm text-foreground-secondary">{approvalTarget(a)}</div>
              {a.since && <div className="text-xs text-muted-foreground">{fmtRelative(a.since)}</div>}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" disabled={decide.isPending} onClick={() => send(a, "APPROVED")}>
                <Check className="h-4 w-4" aria-hidden />
                {t("syllabus.students.approve")}
              </Button>
              <Button size="sm" variant="outline" disabled={decide.isPending} onClick={() => setReturning(a)}>
                <Undo2 className="h-4 w-4" aria-hidden />
                {t("syllabus.students.return")}
              </Button>
            </div>
          </li>
        ))}
      </ul>
      <Dialog open={!!returning} onOpenChange={(v) => !v && setReturning(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("syllabus.students.returnTitle")}</DialogTitle>
          </DialogHeader>
          {returning && <p className="text-sm text-foreground-secondary">{returning.studentName} · {approvalTarget(returning)}</p>}
          <label className="block text-sm">
            <span className={fieldLabel}>{t("syllabus.students.returnNote")}</span>
            <Textarea className="mt-1" rows={3} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} />
          </label>
          <DialogFooter>
            <Button variant="outline" onClick={() => setReturning(null)}>{t("common.cancel")}</Button>
            <Button disabled={decide.isPending || !returning} onClick={() => returning && send(returning, "RETURNED", note)}>
              {t("syllabus.students.return")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Panel>
  );
}

type UnlockTarget = { type: "MODULE" | "LESSON"; id: string; title: string };

function StudentDialog({ id, row, onClose }: { id: string; row: StudentRow; onClose: () => void }) {
  const q = trpc.teacher.syllabus.student.useQuery({ id, studentId: row.studentId });
  const refresh = useStudentsRefresh(id);
  const [target, setTarget] = useState<UnlockTarget | null>(null);
  const [reason, setReason] = useState("");
  const unlock = trpc.teacher.syllabus.manualUnlock.useMutation({
    onSuccess: () => {
      toast.success(t("syllabus.students.unlocked"));
      setTarget(null);
      setReason("");
      refresh();
    },
    onError: toastError,
  });
  const revoke = trpc.teacher.syllabus.revokeUnlock.useMutation({ onSuccess: refresh, onError: toastError });
  const mark = trpc.teacher.syllabus.markTeacherPractice.useMutation({
    onSuccess: (r) => {
      toast.success(t("syllabus.students.marked", { count: r.marked }));
      refresh();
    },
    onError: toastError,
  });
  const d = q.data;
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="break-words">{row.name}</DialogTitle>
        </DialogHeader>
        <DialogBody className="space-y-4">
          {q.error ? (
            <ErrorNote error={q.error} />
          ) : !d ? (
            <Loading />
          ) : (
            <div className="space-y-4">
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <ProgressBar value={d.path.progressPct} label={t("learn.overallProgress")} />
                  <span className="shrink-0 text-sm font-semibold tabular-nums">{d.path.progressPct}%</span>
                </div>
                <p className="text-xs text-muted-foreground">{t("learn.lessonsDone", { done: d.path.completedLessons, total: d.path.totalLessons })}</p>
              </div>
              <ol className="space-y-3">
                {d.path.modules.map((m, mi) => (
                  <li key={m.id} className="rounded-xl border border-border p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <NodeIcon visual={nodeVisual(m.status, m.id === d.path.currentModuleId)} />
                      <span className="text-xs text-muted-foreground">{t("learn.moduleN", { n: mi + 1 })}</span>
                      <span className="min-w-0 flex-1 break-words font-medium">{m.title}</span>
                      <span className="text-xs tabular-nums text-muted-foreground">{pct(m.completedLessons, m.totalLessons)}%</span>
                      {m.status === "LOCKED" && (
                        <Button size="sm" variant="outline" onClick={() => setTarget({ type: "MODULE", id: m.id, title: m.title })}>
                          <KeyRound className="h-4 w-4" aria-hidden />
                          {t("syllabus.students.unlock")}
                        </Button>
                      )}
                    </div>
                    <ul className="mt-2 space-y-1.5">
                      {m.lessons.map((l, li) => (
                        <LessonLine
                          key={l.id}
                          n={li + 1}
                          lesson={l}
                          info={d.lessons.find((x) => x.id === l.id)}
                          current={l.id === d.path.currentLessonId}
                          onUnlock={() => setTarget({ type: "LESSON", id: l.id, title: l.title })}
                          onMark={(itemId, group) => mark.mutate(group && row.viaGroupId ? { id, itemId, groupId: row.viaGroupId } : { id, itemId, studentIds: [row.studentId] })}
                          canMarkGroup={!!row.viaGroupId}
                          marking={mark.isPending}
                        />
                      ))}
                    </ul>
                  </li>
                ))}
              </ol>
              <UnlockList detail={d} onRevoke={(unlockId) => revoke.mutate({ id, studentId: row.studentId, unlockId })} busy={revoke.isPending} />
            </div>
          )}
          {target && (
            <div className="space-y-2 rounded-xl border border-border bg-muted/40 p-3">
              <p className="text-sm font-medium break-words">{t("syllabus.students.unlockTitle", { title: target.title })}</p>
              <p className="text-xs text-muted-foreground">{t("syllabus.students.unlockHelp")}</p>
              <label className="block text-sm">
                <span className={fieldLabel}>{t("syllabus.students.reason")}</span>
                <Textarea className="mt-1" rows={2} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} />
              </label>
              <div className="flex flex-wrap justify-end gap-2">
                <Button size="sm" variant="outline" onClick={() => setTarget(null)}>{t("common.cancel")}</Button>
                <Button
                  size="sm"
                  disabled={reason.trim().length < 3 || unlock.isPending}
                  onClick={() => unlock.mutate({ id, studentId: row.studentId, targetType: target.type, targetId: target.id, reason })}
                >
                  {t("syllabus.students.unlock")}
                </Button>
              </div>
            </div>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{t("common.close")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function LessonLine({
  n,
  lesson,
  info,
  current,
  onUnlock,
  onMark,
  canMarkGroup,
  marking,
}: {
  n: number;
  lesson: Detail["path"]["modules"][number]["lessons"][number];
  info: Detail["lessons"][number] | undefined;
  current: boolean;
  onUnlock: () => void;
  onMark: (itemId: string, group: boolean) => void;
  canMarkGroup: boolean;
  marking: boolean;
}) {
  const teacherItems = (info?.items ?? []).filter((i) => i.kind === "TEACHER_PRACTICE" && i.state !== "MET" && i.state !== "NOT_REQUIRED");
  return (
    <li className="rounded-lg px-2 py-1.5 hover:bg-muted/50">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <NodeIcon visual={nodeVisual(lesson.status, current)} className="h-4 w-4" />
        <span className="text-xs text-muted-foreground">{t("learn.lessonN", { n })}</span>
        <span className="min-w-0 flex-1 break-words">{lesson.title}</span>
        <span className="text-xs text-muted-foreground">{statusText(lesson.status)}</span>
        {info?.unlockSource === "MANUAL" && <Pill>{t("syllabus.students.manual")}</Pill>}
        {lesson.status === "LOCKED" && (
          <Button size="sm" variant="ghost" onClick={onUnlock}>
            <KeyRound className="h-4 w-4" aria-hidden />
            {t("syllabus.students.unlock")}
          </Button>
        )}
      </div>
      {info && (info.openedAt || info.activeSeconds > 0) && (
        <p className="ml-6 text-xs text-muted-foreground">
          {info.openedAt ? t("syllabus.students.openedAt", { at: fmtDateTime(info.openedAt) }) : ""}
          {info.activeSeconds > 0 ? ` · ${t("syllabus.students.activeTime", { time: fmtDuration(info.activeSeconds) })}` : ""}
        </p>
      )}
      {lesson.status !== "LOCKED" &&
        teacherItems.map((i) => (
          <div key={i.itemId} className="ml-6 mt-1 flex flex-wrap items-center gap-2 text-xs">
            <span className="min-w-0 flex-1 break-words text-foreground-secondary">{t("syllabus.kind.TEACHER_PRACTICE" as MessageKey)} · {i.title}</span>
            <Button size="sm" variant="outline" disabled={marking} onClick={() => onMark(i.itemId, false)}>
              {t("syllabus.students.markCovered")}
            </Button>
            {canMarkGroup && (
              <Button size="sm" variant="ghost" disabled={marking} onClick={() => onMark(i.itemId, true)}>
                {t("syllabus.students.markGroup")}
              </Button>
            )}
          </div>
        ))}
    </li>
  );
}

function UnlockList({ detail, onRevoke, busy }: { detail: Detail; onRevoke: (id: string) => void; busy: boolean }) {
  if (!detail.manualUnlocks.length) return null;
  const titleOf = (type: string, targetId: string) =>
    type === "MODULE"
      ? (detail.path.modules.find((m) => m.id === targetId)?.title ?? "—")
      : (detail.path.modules.flatMap((m) => m.lessons).find((l) => l.id === targetId)?.title ?? "—");
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-medium">{t("syllabus.students.unlocksTitle")}</h3>
      <ul className="space-y-1.5">
        {detail.manualUnlocks.map((u) => (
          <li key={u.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm">
            <KeyRound className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
            <div className="min-w-0 flex-1">
              <div className="break-words">{titleOf(u.targetType, u.targetId)}</div>
              <div className="break-words text-xs text-muted-foreground">{u.reason} · {fmtDateTime(u.createdAt)}</div>
            </div>
            {u.revokedAt ? (
              <Pill>{t("syllabus.students.unlockRevoked")}</Pill>
            ) : (
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => onRevoke(u.id)}>
                <RotateCcw className="h-4 w-4" aria-hidden />
                {t("syllabus.access.revoke")}
              </Button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
