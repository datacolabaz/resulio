import { AppShell, EmptyState, Loading, Panel, Pill } from "@/components/AppShell";
import { Button } from "@/components/ui/button";
import { API_BASE } from "@/const";
import { t } from "@/i18n/messages";
import { fmtWindow } from "@/lib/format";
import { trpc } from "@/lib/trpc";
import type { LessonStatus } from "@shared/lessonIntegration";
import { Link } from "wouter";

function statusPill(status: LessonStatus) {
  const cls = status === "CANCELLED" ? "text-destructive" : status === "LIVE" ? "text-success" : "text-foreground-secondary";
  return <Pill className={cls}>{t(`lessons.status.${status}`)}</Pill>;
}

/** The student's own online lessons; "Qoşul" goes through the server's gated join route, never a raw provider link. */
export function StudentLessonsPage() {
  const list = trpc.student.lessons.list.useQuery();

  return (
    <AppShell area="learning">
      <div className="space-y-5">
        <h1 className="font-[family-name:var(--font-display)] text-2xl">{t("lessons.list.title")}</h1>

        {list.isLoading ? (
          <Loading />
        ) : !list.data?.length ? (
          <EmptyState title={t("lessons.list.empty")} body={t("lessons.student.emptyBody")} />
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            {list.data.map((lesson) => (
              <Panel key={lesson.id} title={lesson.title} action={statusPill(lesson.status)}>
                <div className="space-y-2 text-sm">
                  <p className="text-foreground-secondary">{fmtWindow(lesson.startsAt, lesson.endsAt)}</p>
                  <div className="flex flex-wrap items-center gap-2 pt-1">
                    {lesson.status !== "CANCELLED" && lesson.meeting?.status === "CREATED" && (
                      <Button asChild size="sm">
                        <a href={`${API_BASE}/api/lessons/${lesson.id}/join`}>{t("lessons.student.join")}</a>
                      </Button>
                    )}
                    <Link href={`/student/lessons/${lesson.id}`} className="text-sm font-medium text-link underline underline-offset-4">
                      {t("lessons.list.openDetail")}
                    </Link>
                  </div>
                </div>
              </Panel>
            ))}
          </div>
        )}
      </div>
    </AppShell>
  );
}
