import { useAuth } from "@/_core/hooks/useAuth";
import { LanguageSwitch, ThemeToggle } from "@/components/AppShell";
import { BrandMark } from "@/components/BrandMark";
import { EmailSignIn } from "@/components/EmailSignIn";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { startLogin } from "@/const";
import { t } from "@/i18n/messages";
import { canEnter } from "@/lib/contexts";
import {
  errorText,
  fmtDateTime,
  fmtDay,
  fmtDuration,
  groupFacts,
  groupFormatLabel,
  groupLanguageLabel,
  liveLabel,
  scheduleSummary,
  typeLabel,
} from "@/lib/format";
import { trpc } from "@/lib/trpc";
import { sharedFileDownloadUrl } from "@/lib/uploadFile";
import { visitorId } from "@/lib/visitor";
import type { GroupType } from "@shared/groupType";
import type { ClassScheduleEntry } from "@shared/schedule";
import { DEFAULT_SHARE_CAMPAIGN, parseShareCampaign, parseShareSource, type ShareTargetType } from "@shared/shareTracking";
import { useEffect, useMemo, useRef } from "react";
import { toast } from "sonner";
import { Link, useLocation, useParams, useSearch } from "wouter";

/**
 * Reads ?src= (or the older ?source=) and ?campaign= off the current public share link (tagged by
 * ShareBox), fires a best-effort "opened" event once the target has loaded and the session is
 * known, and hands back the channel/campaign/visitor id so the page's join/claim mutation and file
 * downloads carry the same attribution.
 *
 * One "opened" per tab session, link and identity: refreshes and the sign-in round trip don't
 * inflate it, but signing in records one more so the anonymous visit is tied to the account.
 */
function useShareAttribution(targetType: ShareTargetType, targetId: string, ready: boolean) {
  const { user, loading } = useAuth();
  const params = new URLSearchParams(useSearch());
  const channel = parseShareSource(params.get("src") ?? params.get("source"));
  const campaign = parseShareCampaign(params.get("campaign")) ?? DEFAULT_SHARE_CAMPAIGN[targetType];
  const visitor = useMemo(() => visitorId(), []);
  const logOpen = trpc.public.shareEvent.useMutation();
  const fired = useRef<string | null>(null);
  const identity = user ? `u:${user.id}` : "anon";
  useEffect(() => {
    if (!ready || loading || !targetId || fired.current === identity) return;
    fired.current = identity;
    const key = `resulio.opened:${targetType}:${targetId}`;
    try {
      if (sessionStorage.getItem(key) === identity) return;
      sessionStorage.setItem(key, identity);
    } catch {
      // Storage blocked: the ref above still keeps it to one event per page load.
    }
    logOpen.mutate({ targetType, targetId, channel: channel ?? "DIRECT", eventType: "OPENED", campaign, visitorId: visitor });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, loading, targetId, identity]);
  return { channel, campaign, visitorId: visitor };
}

/** Extra group facts shown on a join-preview screen, only for the fields the teacher chose to share. */
function GroupPreviewDetails({
  g,
}: {
  g: { groupType: GroupType; subject: string; grade: string; level: string; language?: string; format?: string; startDate?: string | Date | null; classSchedule?: ClassScheduleEntry[] };
}) {
  const schedule = scheduleSummary(g.classSchedule);
  return (
    <dl className="mt-3 space-y-1 text-xs text-muted-foreground">
      {groupFacts(g).map((f) => (
        <div key={f.label} className="flex gap-1"><dt className="font-medium text-foreground-secondary">{f.label}:</dt><dd className="min-w-0 break-words">{f.value}</dd></div>
      ))}
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

/**
 * Shown instead of the retry button once a join/accept attempt has failed — retrying never helps
 * for any of these error codes (already a member, expired/inactive code, not accepting, …), so
 * this always gives the student a way out instead of leaving them stuck on a dead-end screen.
 */
function JoinErrorNote({ error }: { error: unknown }) {
  const code = error instanceof Error ? error.message : undefined;
  const alreadyMember = code === "ALREADY_MEMBER";
  return (
    <div className="space-y-3">
      <p role="alert" className={`text-sm ${alreadyMember ? "text-foreground-secondary" : "text-destructive"}`}>
        {alreadyMember ? t("public.join.alreadyMemberNote") : errorText(error)}
      </p>
      <Button asChild className="w-full" variant={alreadyMember ? "default" : "outline"}>
        <Link href="/student/groups">{t("public.myGroups")}</Link>
      </Button>
    </div>
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

/** Why the group's invite link turns people away right now, shown before anyone signs in or presses Join. */
function InviteRejectionNote({ rejection }: { rejection: "INVITE_CODE_INACTIVE" | "INVITE_CODE_EXPIRED" | "GROUP_NOT_ACCEPTING" }) {
  if (rejection === "GROUP_NOT_ACCEPTING") return <p role="alert" className="text-sm text-muted-foreground">{t("public.join.notAccepting")}</p>;
  return (
    <div className="space-y-3">
      <p role="alert" className="text-sm text-destructive">{t(rejection === "INVITE_CODE_EXPIRED" ? "public.join.codeExpired" : "public.join.codeInactive")}</p>
      <Button asChild className="w-full" variant="outline"><Link href="/student/groups">{t("public.myGroups")}</Link></Button>
    </div>
  );
}

export function JoinGroupPage() {
  const { inviteCode = "" } = useParams<{ inviteCode: string }>();
  const { user, loading } = useAuth();
  const [, navigate] = useLocation();
  const invite = trpc.public.invite.useQuery({ inviteCode }, { enabled: inviteCode.length >= 4, retry: false });
  const utils = trpc.useUtils();
  const join = trpc.student.join.useMutation({
    onSuccess: async (res) => {
      // The learning-area guard reads the session, so it must know about the new membership first.
      await Promise.all([utils.auth.me.invalidate(), utils.student.groups.invalidate()]);
      toast.success(t("public.join.joinedToast", { group: res.groupName }));
      navigate(`/student/groups?group=${encodeURIComponent(res.groupId)}`);
    },
  });
  const g = invite.data;
  const { channel, campaign, visitorId: vid } = useShareAttribution("GROUP", inviteCode, Boolean(g));
  return (
    <Card>
      <h1 className="mt-4 text-xl font-semibold">{t("public.join.title")}</h1>
      {invite.isLoading ? <p role="status" className="mt-3 text-sm text-muted-foreground">{t("common.loading")}</p> : !g ? (
        <p role="alert" className="mt-3 text-sm text-destructive">{t("public.join.notFound")}</p>
      ) : (
        <>
          <div className="mt-3 break-words text-lg">{g.name}</div>
          <p className="text-sm text-muted-foreground">{[t(`groups.type.${g.groupType}`), g.teacherName].filter(Boolean).join(" · ")}</p>
          <GroupPreviewDetails g={g} />
          {!!g.description && <p className="mt-3 text-sm">{g.description}</p>}
          <div className="mt-6">
            {loading ? null : join.isSuccess ? (
              <div className="space-y-3 text-sm" role="status">
                <p className="text-success">{t("public.invite.joined")}</p>
                <Link href={`/student/groups?group=${encodeURIComponent(join.data.groupId)}`} className="text-link underline-offset-4 hover:underline">{t("public.myGroups")}</Link>
              </div>
            ) : g.rejection ? (
              <InviteRejectionNote rejection={g.rejection} />
            ) : !user ? (
              <>
                <p className="mb-3 text-xs text-muted-foreground">{t("public.join.instantNote")}</p>
                <Button className="w-full" onClick={() => startLogin(`/join/${inviteCode}${window.location.search}`)}>{t("common.signInGoogle")}</Button>
                <EmailSignIn />
              </>
            ) : join.error ? (
              <JoinErrorNote error={join.error} />
            ) : (
              <>
                <p className="mb-3 text-xs text-muted-foreground">{t("public.join.instantNote")}</p>
                <Button className="w-full" disabled={join.isPending} onClick={() => join.mutate({ inviteCode, channel, campaign, visitorId: vid })}>
                  {t("public.join.joinNow")}
                </Button>
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
          <p className="text-sm text-muted-foreground">{[t(`groups.type.${g.groupType}`), g.teacherName].filter(Boolean).join(" · ")}</p>
          <GroupPreviewDetails g={g} />
          {!!g.description && <p className="mt-3 text-sm">{g.description}</p>}
          <p className="mt-3 text-xs text-muted-foreground">{t("public.invite.emailNote")}</p>
          <div className="mt-6">
            {loading ? null : !user ? (
              <>
                <Button className="w-full" onClick={() => startLogin(returnTo)}>{t("common.signInGoogle")}</Button>
                <EmailSignIn />
              </>
            ) : accept.isSuccess ? (
              <div className="space-y-3 text-sm" role="status">
                <p className="text-success">{t("public.invite.joined")}</p>
                <Link href="/student/groups" className="text-link underline-offset-4 hover:underline">{t("public.myGroups")}</Link>
              </div>
            ) : accept.error ? (
              <JoinErrorNote error={accept.error} />
            ) : (
              <Button className="w-full" disabled={accept.isPending} onClick={() => accept.mutate({ token })}>{t("public.join.joinNow")}</Button>
            )}
          </div>
        </>
      )}
    </Card>
  );
}

/**
 * Single-use invite link (/g/<token>). The first student to sign in and press "join" is added to
 * the group at once; after that the link only works for that same student. Nothing about the
 * group is shown once the link is dead.
 */
export function InviteLinkPage() {
  const { token = "" } = useParams<{ token: string }>();
  const { user, loading } = useAuth();
  const preview = trpc.public.inviteLink.useQuery({ token }, { enabled: token.length >= 16 && !loading, retry: false });
  const utils = trpc.useUtils();
  const redeem = trpc.student.redeemInviteLink.useMutation({
    onSuccess: () => {
      void utils.auth.me.invalidate();
      void utils.public.inviteLink.invalidate();
    },
  });
  const p = preview.data;
  const live = p && (p.state === "ACTIVE" || p.state === "REDEEMED_BY_YOU") ? p : null;
  const { channel, campaign, visitorId: vid } = useShareAttribution("GROUP", live ? `link:${live.linkId}` : "", Boolean(live));
  const returnTo = `/g/${token}${window.location.search}`;
  const signIn = (
    <>
      <Button className="w-full" onClick={() => startLogin(returnTo)}>{t("common.signInGoogle")}</Button>
      <EmailSignIn />
    </>
  );
  const joined = (
    <div className="space-y-3 text-sm" role="status">
      <p className="text-success">{t("public.inviteLink.joined")}</p>
      <Button asChild className="w-full"><Link href="/student/groups">{t("public.myGroups")}</Link></Button>
    </div>
  );
  return (
    <Card>
      <h1 className="mt-4 text-xl font-semibold">{t("public.join.title")}</h1>
      {loading || preview.isLoading ? (
        <p role="status" className="mt-3 text-sm text-muted-foreground">{t("common.loading")}</p>
      ) : !p || p.state === "NOT_FOUND" ? (
        <p role="alert" className="mt-3 text-sm text-destructive">{t("public.inviteLink.notFound")}</p>
      ) : !live ? (
        <div className="mt-3 space-y-3">
          <p role="alert" className="text-base font-medium text-destructive">{t(`public.inviteLink.state.${p.state as "USED" | "EXPIRED" | "REVOKED"}`)}</p>
          <p className="text-sm text-foreground-secondary">{t("public.inviteLink.deadHint")}</p>
          {!user && (
            <div className="pt-2">
              <p className="mb-2 text-xs text-muted-foreground">{t("public.inviteLink.wasItYou")}</p>
              {signIn}
            </div>
          )}
        </div>
      ) : (
        <>
          <div className="mt-3 break-words text-lg">{live.group.name}</div>
          <p className="text-sm text-muted-foreground">{[t(`groups.type.${live.group.groupType}`), live.group.teacherName].filter(Boolean).join(" · ")}</p>
          <GroupPreviewDetails g={live.group} />
          {!!live.group.description && <p className="mt-3 text-sm">{live.group.description}</p>}
          <p className="mt-3 text-xs text-muted-foreground">{t("public.inviteLink.singleUseNote")}</p>
          <div className="mt-6">
            {!user ? signIn : live.state === "REDEEMED_BY_YOU" || redeem.isSuccess ? joined : redeem.error ? (
              <JoinErrorNote error={redeem.error} />
            ) : (
              <Button className="w-full" disabled={redeem.isPending} onClick={() => redeem.mutate({ token, channel, campaign, visitorId: vid })}>
                {t("public.join.joinNow")}
              </Button>
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
  useShareAttribution("EXAM", shareCode, Boolean(e));
  const returnTo = `/exam/${shareCode}${window.location.search}`;
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
              <>
                <Button className="w-full" onClick={() => startLogin(returnTo)}>{t("common.signInGoogle")}</Button>
                <EmailSignIn />
              </>
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
  const page = task.data;
  const a = page?.task;
  const { channel, campaign, visitorId: vid } = useShareAttribution("TASK", shareCode, Boolean(page));
  const returnTo = `/task/${shareCode}${window.location.search}`;
  return (
    <Card>
      {task.isLoading ? <p role="status" className="mt-4 text-sm text-muted-foreground">{t("common.loading")}</p> : !page ? (
        <p role="alert" className="mt-4 text-sm text-destructive">{t("public.task.notFound")}</p>
      ) : !a ? (
        <>
          <h1 className="mt-4 break-words text-xl font-semibold">
            {page.access === "SIGN_IN_REQUIRED" ? t("public.task.signInTitle") : t("public.task.noAccessTitle")}
          </h1>
          <p className="mt-3 text-sm text-foreground-secondary">
            {page.access === "SIGN_IN_REQUIRED" ? t("public.task.signInBody") : t("public.task.noAccessBody")}
          </p>
          {user?.email && page.access === "DENIED" && (
            <p className="mt-3 break-words text-xs text-muted-foreground">{t("public.task.signedInAs", { email: user.email })}</p>
          )}
          <div className="mt-6">
            {loading ? null : (
              <>
                <Button className="w-full" variant={user ? "outline" : "default"} onClick={() => startLogin(returnTo)}>
                  {user ? t("public.task.switchAccount") : t("common.signInGoogle")}
                </Button>
                {!user && <EmailSignIn />}
              </>
            )}
          </div>
        </>
      ) : (
        <>
          {page.accessMode === "GROUPS" && (
            <p className="mt-4 text-xs font-medium uppercase tracking-wide text-link">{t("public.task.restrictedNote")}</p>
          )}
          <h1 className="mt-4 break-words text-2xl font-semibold">{a.title}</h1>
          {a.description && <p className="mt-3 break-words text-sm text-foreground-secondary">{a.description}</p>}
          <p className="mt-3 text-sm text-muted-foreground">{t("modules.deadlineValue", { date: fmtDateTime(a.deadline) })}</p>
          {a.attachments.length > 0 && (
            <div className="mt-3 space-y-1.5">
              <p className="text-xs font-medium text-foreground-secondary">{t("public.task.attachments")}</p>
              {a.attachments.map((file) => (
                <a
                  key={file.fileId}
                  href={sharedFileDownloadUrl(file.fileId, { targetType: "TASK", shareCode, channel, campaign, visitorId: vid })}
                  className="block rounded-lg border border-border bg-muted px-3 py-1.5 text-sm text-link underline-offset-2 hover:underline"
                >
                  {t("common.download")}: {file.name}
                </a>
              ))}
            </div>
          )}
          <div className="mt-6">
            {loading ? null : !user ? (
              <>
                <Button className="w-full" onClick={() => startLogin(returnTo)}>{t("common.signInGoogle")}</Button>
                <EmailSignIn />
              </>
            ) : page.access === "OWNER" ? (
              <p className="text-sm text-foreground-secondary" role="status">{t("public.task.ownerNote")}</p>
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
                <Button className="w-full" disabled={claim.isPending} onClick={() => claim.mutate({ shareCode, channel, campaign, visitorId: vid })}>{t("public.task.claim")}</Button>
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
  const { channel, campaign, visitorId: vid } = useShareAttribution("MATERIAL", shareCode, Boolean(m));
  const returnTo = `/material/${shareCode}${window.location.search}`;
  return (
    <Card>
      {material.isLoading ? <p role="status" className="mt-4 text-sm text-muted-foreground">{t("common.loading")}</p> : !m ? (
        <p role="alert" className="mt-4 text-sm text-destructive">{t("public.material.notFound")}</p>
      ) : (
        <>
          <h1 className="mt-4 break-words text-2xl font-semibold">{m.title}</h1>
          {m.description && <p className="mt-3 break-words text-sm text-foreground-secondary">{m.description}</p>}
          <p className="mt-3 text-sm text-muted-foreground">{[m.subject, m.topic].filter(Boolean).join(" · ")}</p>
          {m.fileId && (
            <a
              href={sharedFileDownloadUrl(m.fileId, { targetType: "MATERIAL", shareCode, channel, campaign, visitorId: vid })}
              className="mt-3 inline-block rounded-lg border border-border bg-muted px-3 py-1.5 text-sm text-link underline-offset-2 hover:underline"
            >
              {t("common.download")}: {m.fileName}
            </a>
          )}
          <div className="mt-6">
            {loading ? null : !user ? (
              <>
                <Button className="w-full" onClick={() => startLogin(returnTo)}>{t("common.signInGoogle")}</Button>
                <EmailSignIn />
              </>
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
                <Button className="w-full" disabled={claim.isPending} onClick={() => claim.mutate({ shareCode, channel, campaign, visitorId: vid })}>{t("public.material.claim")}</Button>
                {claim.error && <p role="alert" className="mt-2 text-sm text-destructive">{errorText(claim.error)}</p>}
              </>
            )}
          </div>
        </>
      )}
    </Card>
  );
}
