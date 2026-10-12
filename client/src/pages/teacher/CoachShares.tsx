import { AppShell, EmptyState, ErrorNote, Loading, Panel } from "@/components/AppShell";
import { ResponsiveTable } from "@/components/ResponsiveTable";
import { useI18n } from "@/i18n/locale";
import { t } from "@/i18n/messages";
import { fmtDay } from "@/lib/format";
import { trpc } from "@/lib/trpc";
import { fileDownloadUrl, formatFileSize } from "@/lib/uploadFile";
import { Download } from "lucide-react";
import { Link, useParams } from "wouter";

/** "/teacher/coach-shares": materials students chose to share with this teacher (read-only). */
export function CoachSharesPage() {
  const q = trpc.teacher.coachShares.list.useQuery();
  return (
    <AppShell area="teaching" title={t("nav.coachShares")}>
      <div className="space-y-4">
        <p className="max-w-3xl text-sm text-muted-foreground">{t("coachShare.teacher.intro")}</p>
        {q.error ? (
          <ErrorNote error={q.error} />
        ) : !q.data ? (
          <Loading />
        ) : !q.data.length ? (
          <EmptyState title={t("nav.coachShares")} body={t("coachShare.teacher.empty")} />
        ) : (
          <Panel>
            <ResponsiveTable
              rows={q.data}
              rowKey={(r) => r.id}
              columns={[
                {
                  key: "material",
                  header: t("coachShare.teacher.material"),
                  card: "title",
                  cell: (r) => (
                    <Link href={`/teacher/coach-shares/${r.id}`} className="break-words text-link hover:underline">
                      {r.materialTitle}
                    </Link>
                  ),
                },
                { key: "student", header: t("coachShare.teacher.student"), cell: (r) => r.studentName ?? "—" },
                { key: "pages", header: t("coachShare.teacher.pages"), cell: (r) => (r.pageCount ? r.pageCount : "—") },
                { key: "shared", header: t("coachShare.teacher.sharedAt"), card: "aside", cell: (r) => fmtDay(r.createdAt) },
              ]}
            />
          </Panel>
        )}
      </div>
    </AppShell>
  );
}

/** "/teacher/coach-shares/:id": the file and the summaries the student prepared; nothing else. */
export function CoachShareViewPage() {
  const { id } = useParams<{ id: string }>();
  const { locale } = useI18n();
  const q = trpc.teacher.coachShares.get.useQuery({ shareId: id, locale });
  return (
    <AppShell area="teaching" title={t("nav.coachShares")}>
      <div className="space-y-4">
        <Link href="/teacher/coach-shares" className="text-sm text-link hover:underline">← {t("nav.coachShares")}</Link>
        {q.error ? (
          <ErrorNote error={q.error} />
        ) : !q.data ? (
          <Loading />
        ) : (
          <>
            <Panel>
              <h1 className="break-words text-xl font-semibold">{q.data.material.title}</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                {t("coachShare.teacher.sharedBy", { name: q.data.studentName ?? "—", date: fmtDay(q.data.sharedAt) })}
              </p>
              {q.data.material.fileId && (
                <a href={fileDownloadUrl(q.data.material.fileId)} className="mt-3 inline-flex items-center gap-1 text-sm text-link hover:underline">
                  <Download className="h-4 w-4" aria-hidden />
                  {q.data.material.fileName ?? t("coachShare.teacher.download")}
                  {q.data.material.sizeBytes ? <span className="text-muted-foreground"> ({formatFileSize(q.data.material.sizeBytes)})</span> : null}
                </a>
              )}
              <p className="mt-3 text-xs text-muted-foreground">{t("coachShare.teacher.readOnly")}</p>
            </Panel>
            {q.data.topics.map((topic) => (
              <Panel key={topic.id} title={`${topic.ord + 1}. ${topic.title}`}>
                {!topic.summary ? (
                  <p className="text-sm text-muted-foreground">{t("coachShare.teacher.noSummary")}</p>
                ) : (
                  <div className="space-y-3 text-sm">
                    {topic.summary.locale !== locale && <p className="text-xs text-muted-foreground">{t("coachShare.teacher.otherLanguage")}</p>}
                    {topic.summary.content.sections.map((s, i) => (
                      <section key={i} className="space-y-1">
                        {s.heading && <h3 className="font-medium">{s.heading}</h3>}
                        <ul className="list-disc space-y-1 pl-5">{s.points.map((p, j) => <li key={j}>{p.text}</li>)}</ul>
                      </section>
                    ))}
                    {!!topic.summary.content.concepts?.length && (
                      <dl className="grid gap-2 sm:grid-cols-2">
                        {topic.summary.content.concepts.map((c, i) => (
                          <div key={i} className="rounded-lg border border-border p-2">
                            <dt className="font-medium">{c.term}</dt>
                            <dd>{c.definition}</dd>
                          </div>
                        ))}
                      </dl>
                    )}
                  </div>
                )}
              </Panel>
            ))}
          </>
        )}
      </div>
    </AppShell>
  );
}
