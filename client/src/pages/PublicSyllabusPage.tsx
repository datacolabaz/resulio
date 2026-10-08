import { useAuth } from "@/_core/hooks/useAuth";
import { LanguageSwitch, Pill, ThemeToggle } from "@/components/AppShell";
import { BrandMark } from "@/components/BrandMark";
import { EmailSignIn } from "@/components/EmailSignIn";
import { JoinRequestStatusBadge } from "@/components/syllabus/JoinRequestStatus";
import { Bullets, ModuleDetailsBlocks } from "@/components/syllabus/ModuleDetailsBlocks";
import { CourseTimingPills, durationText } from "@/components/syllabus/Timing";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { startLogin } from "@/const";
import { t } from "@/i18n/messages";
import { errorText, fmtDateTime, groupLanguageLabel } from "@/lib/format";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { GroupPreviewDetails } from "@/pages/PublicFlows";
import { useSharePageMeta } from "@/seo/usePageMeta";
import { JOIN_MESSAGE_MAX, syllabusPageTitle } from "@shared/syllabusJoin";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Link, useParams } from "wouter";

type Page = RouterOutputs["public"]["syllabus"];
type Viewer = NonNullable<Page["viewer"]>;
type UpcomingGroup = Page["groups"][number];
type Intent = { type: "GROUP"; groupId: string } | { type: "INDIVIDUAL" } | { type: "JOIN" };

/** `?intent=` survives the Google sign-in round trip, so the visitor lands back on the step they chose. */
const intentParam = (i: Intent) => (i.type === "GROUP" ? `group:${i.groupId}` : i.type === "INDIVIDUAL" ? "individual" : "join");
function readIntent(): Intent | null {
  const raw = new URLSearchParams(window.location.search).get("intent") ?? "";
  if (raw === "individual") return { type: "INDIVIDUAL" };
  if (raw === "join") return { type: "JOIN" };
  if (raw.startsWith("group:") && raw.length > 6) return { type: "GROUP", groupId: raw.slice(6) };
  return null;
}
function clearIntentParam() {
  const url = new URL(window.location.href);
  if (!url.searchParams.has("intent")) return;
  url.searchParams.delete("intent");
  window.history.replaceState(window.history.state, "", url);
}
const scrollToJoin = () => {
  const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  document.getElementById("join")?.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
};

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-screen bg-background p-4 text-foreground sm:p-6">
      <div className="mx-auto w-full max-w-3xl space-y-5">
        <div className="flex items-start justify-between gap-3">
          <BrandMark size={44} className="rounded-xl" />
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

function Programme({ s }: { s: Page["syllabus"] }) {
  const hasFinal = s.finalProjects.length > 0 || s.finalAssessments.length > 0;
  return (
    <section aria-labelledby="programme" className="space-y-3">
      <h2 id="programme" className="text-lg font-semibold">{t("sylShare.page.programme")}</h2>
      <ol className="space-y-3">
        {s.modules.map((m, i) => (
          <li key={i} className="rounded-2xl border border-border bg-card p-4 sm:p-5">
            <div className="text-xs font-medium uppercase tracking-wide text-link">{t("sylShare.page.module", { n: i + 1 })}</div>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <h3 className="break-words text-base font-semibold">{m.title}</h3>
              {m.duration && <Pill>{durationText(m.duration)}</Pill>}
            </div>
            {m.lessons.length > 0 && (
              <div className="mt-3">
                <h4 className="text-sm font-medium text-foreground-secondary">{t("sylShare.page.lessonList")}</h4>
                <ol className="ml-5 mt-1 list-decimal space-y-1 text-sm marker:text-muted-foreground">
                  {m.lessons.map((l, j) => (
                    <li key={j} className="break-words">
                      {l.title}
                      {l.projects.length > 0 && (
                        <ul className="ml-4 mt-1 list-disc text-xs text-foreground-secondary">
                          {l.projects.map((p, k) => <li key={k} className="break-words">{p}</li>)}
                        </ul>
                      )}
                    </li>
                  ))}
                </ol>
              </div>
            )}
            {m.projects.length > 0 && (
              <div className="mt-3">
                <h4 className="text-sm font-medium text-foreground-secondary">{t("sylShare.page.projects")}</h4>
                <Bullets items={m.projects} />
              </div>
            )}
            {m.assessments.length > 0 && (
              <div className="mt-3">
                <h4 className="text-sm font-medium text-foreground-secondary">{t("sylShare.page.assessments")}</h4>
                <Bullets items={m.assessments} />
              </div>
            )}
            <ModuleDetailsBlocks details={m.details} as="h4" className="mt-3" />
          </li>
        ))}
      </ol>
      {hasFinal && (
        <div className="rounded-2xl border border-border bg-card p-4 sm:p-5">
          <h3 className="text-base font-semibold">{t("sylShare.page.final")}</h3>
          {s.finalProjects.length > 0 && <div className="mt-2"><Bullets items={s.finalProjects} /></div>}
          {s.finalAssessments.length > 0 && <div className="mt-2"><Bullets items={s.finalAssessments} /></div>}
        </div>
      )}
    </section>
  );
}

function RequestDialog({
  code,
  syllabusTitle,
  target,
  onClose,
}: {
  code: string;
  syllabusTitle: string;
  target: { type: "GROUP"; group: UpcomingGroup } | { type: "INDIVIDUAL" } | null;
  onClose: () => void;
}) {
  const { user } = useAuth();
  const utils = trpc.useUtils();
  const [message, setMessage] = useState("");
  const send = trpc.student.syllabus.joinRequest.useMutation({
    onSuccess: (res) => {
      toast.success(t(res.created ? "sylShare.join.sent" : "sylShare.join.alreadySent"));
      void utils.public.syllabus.invalidate({ code });
      void utils.student.syllabus.myJoinRequests.invalidate();
      setMessage("");
      onClose();
    },
  });
  const typeText = target?.type === "GROUP" ? t("sylShare.form.typeGroup", { group: target.group.name }) : t("sylShare.join.requestIndividual");
  return (
    <Dialog open={!!target} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("sylShare.form.title")}</DialogTitle>
          <DialogDescription>{t("sylShare.form.note")}</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <form
            id="syllabus-join-request"
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (!target) return;
              send.mutate({ code, type: target.type, groupId: target.type === "GROUP" ? target.group.id : null, message: message.trim() });
            }}
          >
            <dl className="grid gap-2 text-sm">
              <div><dt className="text-muted-foreground">{t("sylShare.form.name")}</dt><dd className="break-words font-medium">{user?.name || user?.email || "—"}</dd></div>
              <div><dt className="text-muted-foreground">{t("sylShare.form.syllabus")}</dt><dd className="break-words font-medium">{syllabusTitle}</dd></div>
              <div><dt className="text-muted-foreground">{t("sylShare.form.type")}</dt><dd className="break-words font-medium">{typeText}</dd></div>
            </dl>
            <label className="block text-sm">
              <span className="mb-1 block font-medium">{t("sylShare.form.message")}</span>
              <Textarea
                value={message}
                maxLength={JOIN_MESSAGE_MAX}
                rows={4}
                placeholder={t("sylShare.form.messagePlaceholder")}
                onChange={(e) => setMessage(e.target.value)}
              />
            </label>
            {send.error && <p role="alert" className="text-sm text-destructive">{errorText(send.error)}</p>}
          </form>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{t("common.cancel")}</Button>
          <Button type="submit" form="syllabus-join-request" disabled={send.isPending || !target}>{t("sylShare.form.submit")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function MyRequests({ code, viewer }: { code: string; viewer: Viewer }) {
  const utils = trpc.useUtils();
  const cancel = trpc.student.syllabus.cancelJoinRequest.useMutation({
    onSuccess: () => {
      toast.success(t("sylShare.join.cancelled"));
      void utils.public.syllabus.invalidate({ code });
      void utils.student.syllabus.myJoinRequests.invalidate();
    },
    onError: (e) => toast.error(errorText(e)),
  });
  if (!viewer.requests.length) return null;
  return (
    <div className="rounded-2xl border border-border bg-card p-4">
      <h3 className="text-sm font-semibold">{t("sylShare.join.myRequests")}</h3>
      <ul className="mt-2 divide-y divide-border">
        {viewer.requests.map((r) => (
          <li key={r.id} className="flex flex-wrap items-center gap-2 py-2 text-sm">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="break-words font-medium">
                  {r.type === "GROUP" ? t("sylShare.join.requestGroup", { group: r.groupName ?? "—" }) : t("sylShare.join.requestIndividual")}
                </span>
                <JoinRequestStatusBadge status={r.status} />
              </div>
              <div className="mt-0.5 text-xs text-muted-foreground">{t("sylShare.join.sentAt", { date: fmtDateTime(r.createdAt) })}</div>
              {r.decisionNote && <div className="mt-0.5 break-words text-xs text-foreground-secondary">{t("sylShare.join.teacherNote", { note: r.decisionNote })}</div>}
            </div>
            {r.status === "PENDING" && (
              <Button size="sm" variant="outline" disabled={cancel.isPending} onClick={() => confirm(t("sylShare.join.cancelConfirm")) && cancel.mutate({ requestId: r.id })}>
                {t("sylShare.join.cancel")}
              </Button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function JoinSection({ page, onRequest }: { page: Page; onRequest: (i: Intent) => void }) {
  const { user } = useAuth();
  const viewer = page.viewer;
  const pendingFor = (groupId: string | null) => viewer?.requests.some((r) => r.status === "PENDING" && r.groupId === groupId) ?? false;
  const isOwner = !!viewer?.isOwner;
  return (
    <section id="join" aria-labelledby="join-title" className="scroll-mt-4 space-y-3">
      <h2 id="join-title" className="text-lg font-semibold">{t("sylShare.join.title")}</h2>
      {viewer?.hasAccess && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-success/40 bg-success-surface p-4 text-sm">
          <span className="text-success">{t("sylShare.join.hasAccess")}</span>
          {viewer.syllabusId && (
            <Button asChild size="sm"><Link href={`/student/syllabus/${encodeURIComponent(viewer.syllabusId)}`}>{t("sylShare.join.openSyllabus")}</Link></Button>
          )}
        </div>
      )}
      {page.groups.length > 0 ? (
        <>
          <p className="text-sm text-muted-foreground">{t("sylShare.join.groupsIntro")}</p>
          <ul className="grid gap-3 sm:grid-cols-2">
            {page.groups.map((g) => {
              const member = viewer?.memberGroupIds.includes(g.id);
              const pending = pendingFor(g.id);
              return (
                <li key={g.id} className="flex flex-col rounded-2xl border border-border bg-card p-4">
                  <div className="break-words font-semibold">{g.name}</div>
                  <GroupPreviewDetails g={g} />
                  <div className="mt-auto pt-4">
                    {member ? (
                      <p className="text-sm text-success">{t("sylShare.join.member")}</p>
                    ) : pending ? (
                      <JoinRequestStatusBadge status="PENDING" />
                    ) : (
                      <Button className="w-full" disabled={isOwner} onClick={() => onRequest({ type: "GROUP", groupId: g.id })}>{t("sylShare.join.groupCta")}</Button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      ) : (
        <div className="rounded-2xl border border-border bg-card p-4">
          <p className="text-sm text-foreground-secondary">{t("sylShare.join.noGroups")}</p>
          {!viewer?.hasAccess && (
            <div className="mt-3">
              {pendingFor(null) ? (
                <JoinRequestStatusBadge status="PENDING" />
              ) : (
                <Button disabled={isOwner} onClick={() => onRequest({ type: "INDIVIDUAL" })}>{t("sylShare.join.individualCta")}</Button>
              )}
            </div>
          )}
        </div>
      )}
      {isOwner && <p className="text-xs text-muted-foreground">{t("sylShare.page.ownerCta")}</p>}
      {viewer && <MyRequests code={page.code} viewer={viewer} />}
      {!user && (
        <div id="join-sign-in" className="rounded-2xl border border-border bg-card p-4">
          <p className="mb-3 text-sm text-foreground-secondary">{t("sylShare.join.signIn")}</p>
          <Button className="w-full" onClick={() => startLogin(`/syllabus/${encodeURIComponent(page.code)}${window.location.search}`)}>{t("common.signInGoogle")}</Button>
          <EmailSignIn />
        </div>
      )}
    </section>
  );
}

/**
 * Public page of a shared syllabus (`/syllabus/<code>`): the published outline and a way to ask
 * the teacher to join an upcoming group or for individual participation. Grants no access itself.
 */
export default function PublicSyllabusPage() {
  const { code = "" } = useParams<{ code: string }>();
  const { user, loading } = useAuth();
  const query = trpc.public.syllabus.useQuery({ code }, { enabled: code.length > 0 && !loading, retry: false });
  const page = query.data;
  const [intent, setIntent] = useState<Intent | null>(() => readIntent());
  const [target, setTarget] = useState<{ type: "GROUP"; group: UpcomingGroup } | { type: "INDIVIDUAL" } | null>(null);

  const s = page?.syllabus;
  const description = (s?.description || (s ? t("sylShare.page.metaDescription", { title: s.title, teacher: s.teacher.name }) : "")).slice(0, 200);
  useSharePageMeta(s ? syllabusPageTitle(s.title) : null, description);

  const request = (next: Intent) => {
    if (!user) {
      setIntent(next);
      const url = new URL(window.location.href);
      url.searchParams.set("intent", intentParam(next));
      window.history.replaceState(window.history.state, "", url);
      requestAnimationFrame(() => document.getElementById("join-sign-in")?.scrollIntoView({ block: "center" }));
      return;
    }
    if (next.type === "JOIN") return scrollToJoin();
    if (next.type === "INDIVIDUAL") return setTarget({ type: "INDIVIDUAL" });
    const group = page?.groups.find((g) => g.id === next.groupId);
    if (group) setTarget({ type: "GROUP", group });
  };

  // Back from signing in (Google round trip or the in-page e-mail form): continue with what they chose.
  useEffect(() => {
    if (!intent || !user || !page?.viewer) return;
    setIntent(null);
    clearIntentParam();
    const v = page.viewer;
    if (v.isOwner) return;
    const pending = (groupId: string | null) => v.requests.some((r) => r.status === "PENDING" && r.groupId === groupId);
    if (intent.type === "GROUP") {
      const group = page.groups.find((g) => g.id === intent.groupId);
      if (group && !v.memberGroupIds.includes(group.id) && !pending(group.id)) setTarget({ type: "GROUP", group });
      else scrollToJoin();
    } else if (intent.type === "INDIVIDUAL" && !page.groups.length && !v.hasAccess && !pending(null)) {
      setTarget({ type: "INDIVIDUAL" });
    } else {
      requestAnimationFrame(scrollToJoin);
    }
  }, [intent, user, page]);

  if (loading || query.isLoading) {
    return <Frame><p role="status" className="text-sm text-muted-foreground">{t("common.loading")}</p></Frame>;
  }
  if (!page || !s) {
    return (
      <Frame>
        <div className="rounded-3xl border bg-card p-6 sm:p-8">
          <h1 className="text-xl font-semibold">{t("sylShare.page.notFoundTitle")}</h1>
          <p role="alert" className="mt-2 text-sm text-foreground-secondary">{query.error?.message === "RATE_LIMITED" ? errorText(query.error) : t("sylShare.page.notFoundBody")}</p>
        </div>
      </Frame>
    );
  }
  const isOwner = !!page.viewer?.isOwner;
  const facts = [
    s.subject && { label: t("syllabus.field.subject"), value: s.subject },
    s.level && { label: t("syllabus.field.level"), value: s.level },
    s.language && { label: t("syllabus.field.language"), value: groupLanguageLabel(s.language) },
  ].filter((f): f is { label: string; value: string } => !!f);
  return (
    <Frame>
      {isOwner && <p role="status" className="rounded-2xl border border-info/40 bg-info-surface p-3 text-sm text-info">{t("sylShare.page.ownerBanner")}</p>}
      <header className="rounded-3xl border bg-card p-5 sm:p-8">
        <div className="text-xs font-medium uppercase tracking-wide text-link">{t("sylShare.page.eyebrow")}</div>
        <h1 className="mt-1 break-words text-2xl font-semibold sm:text-3xl">{s.title}</h1>
        <div className="mt-3 flex items-center gap-2 text-sm">
          {s.teacher.avatarUrl && <img src={s.teacher.avatarUrl} alt="" className="h-8 w-8 rounded-full border object-cover" referrerPolicy="no-referrer" />}
          <span className="text-muted-foreground">{t("sylShare.page.teacher")}:</span>
          <span className="break-words font-medium">{s.teacher.name}</span>
        </div>
        {s.description && <p className="mt-4 whitespace-pre-line break-words text-sm text-foreground-secondary">{s.description}</p>}
        <div className="mt-4 flex flex-wrap gap-2">
          <CourseTimingPills timing={s.courseTiming} />
          {!!s.estimatedDurationLabel && <Pill>{s.estimatedDurationLabel}</Pill>}
          {s.estimatedHours !== null && <Pill>{t("sylShare.page.hours", { hours: s.estimatedHours })}</Pill>}
          <Pill>{t("sylShare.page.modules", { count: s.moduleCount })}</Pill>
          <Pill>{t("sylShare.page.lessons", { count: s.lessonCount })}</Pill>
        </div>
        {facts.length > 0 && (
          <dl className="mt-4 grid gap-2 text-sm sm:grid-cols-3">
            {facts.map((f) => (
              <div key={f.label}><dt className="text-muted-foreground">{f.label}</dt><dd className="break-words font-medium">{f.value}</dd></div>
            ))}
          </dl>
        )}
        <div className="mt-6">
          <Button size="lg" className="w-full sm:w-auto" disabled={isOwner} onClick={() => (user ? scrollToJoin() : request({ type: "JOIN" }))}>
            {t("sylShare.page.cta")}
          </Button>
          {isOwner && <p className="mt-2 text-xs text-muted-foreground">{t("sylShare.page.ownerCta")}</p>}
        </div>
      </header>
      <Programme s={s} />
      <JoinSection page={page} onRequest={request} />
      <RequestDialog code={page.code} syllabusTitle={s.title} target={target} onClose={() => setTarget(null)} />
    </Frame>
  );
}
