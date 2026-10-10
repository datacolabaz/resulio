import { ActivityChart, FirstSubmittersList } from "@/components/ActivityBlocks";
import { ProgressChart, RankingTable, TopicBars } from "@/components/AnalyticsBlocks";
import { AppShell, ChoiceChip, EmptyState, ErrorNote, Loading, Panel, Pill, StatCard } from "@/components/AppShell";
import { CompactShareLink, ShareBox, ShareFunnelSummary } from "@/components/ShareBox";
import { StatusBadge } from "@/components/StatusBadge";
import { GroupSyllabiPanel } from "@/components/syllabus/CrossLinks";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { SettingToggle } from "@/components/ui/setting-toggle";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { t } from "@/i18n/messages";
import { errorText, fmtDateTime, groupFactsLine, groupLevelLabel, liveLabel } from "@/lib/format";
import { LEVEL_OPTIONS, typeDraftOf, typeFieldKeys, typePayload, type LevelChoice } from "@/lib/groupForm";
import { groupCodeNotice } from "@/lib/groupCodeNotice";
import { joinSourceLabel } from "@/lib/joinSource";
import { liveStatus } from "@/lib/status";
import { trpc } from "@/lib/trpc";
import { GROUP_CLASS_MAX, GROUP_LEVEL_MAX, GROUP_TYPES, type GroupType } from "@shared/groupType";
import { GROUP_LANGUAGES, WEEK_DAYS, type ClassScheduleEntry, type GroupLanguage, type WeekDay } from "@shared/schedule";
import { SHARE_SOURCE_PARAM } from "@shared/shareTracking";
import { AlertTriangle, BookOpen, Info, School } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";
import { Link, useLocation, useParams, useSearch } from "wouter";

const fieldLabel = "text-foreground-secondary";
const selectCls = "mt-1 h-9 w-full rounded-md border border-input bg-card px-3 text-sm text-foreground";
const GROUP_FORMATS = ["ONLINE", "IN_PERSON", "HYBRID"] as const;
const JOIN_POLICIES = ["AUTO", "MANUAL"] as const;
type JoinPolicy = (typeof JOIN_POLICIES)[number];

const ACTIVITY_RANGES = [7, 14, 30] as const;

/** Day-by-day opens/submissions, a per-student table and first submitters of recent tasks. */
function GroupActivityTab({ groupId }: { groupId: string }) {
  const [days, setDays] = useState<(typeof ACTIVITY_RANGES)[number]>(14);
  const q = trpc.teacher.groups.activity.useQuery({ groupId, days });
  if (q.error) return <ErrorNote error={q.error} />;
  if (!q.data) return <Loading />;
  const { students, tasks } = q.data;
  return (
    <div className="space-y-4">
      <Panel
        title={t("motivation.chartTitle")}
        action={
          <div className="flex gap-1.5">
            {ACTIVITY_RANGES.map((n) => (
              <ChoiceChip key={n} selected={days === n} onClick={() => setDays(n)}>{t("motivation.lastDays", { count: n })}</ChoiceChip>
            ))}
          </div>
        }
      >
        <ActivityChart data={q.data.days} />
        <p className="mt-1 text-xs text-muted-foreground">{t("motivation.opensHint")}</p>
      </Panel>
      <Panel title={t("motivation.studentsTitle")}>
        {!students.length ? (
          <p className="text-sm text-muted-foreground">{t("groups.noStudents")}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase text-muted-foreground">
                <tr>
                  <th scope="col" className="py-2">#</th>
                  <th scope="col">{t("common.student")}</th>
                  <th scope="col">{t("motivation.col.submitted")}</th>
                  <th scope="col">{t("motivation.col.onTime")}</th>
                  <th scope="col">{t("motivation.col.firstPlaces")}</th>
                  <th scope="col">{t("motivation.col.opened")}</th>
                  <th scope="col">{t("motivation.col.lastSubmission")}</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {students.map((s) => (
                  <tr key={s.studentId}>
                    <td className="py-2 pr-2 font-semibold">{s.rank}</td>
                    <td className="break-words pr-3">{s.name ?? s.email ?? `#${s.studentId}`}</td>
                    <td className="pr-3">{t("motivation.ofTasks", { done: s.submitted, total: q.data.taskCount })}</td>
                    <td className="pr-3">{s.submitted ? `${s.onTimeRate}%` : "—"}</td>
                    <td className="pr-3">{s.firstPlaces}</td>
                    <td className="pr-3">{s.opened}</td>
                    <td className="whitespace-nowrap text-muted-foreground">{s.lastSubmittedAt ? fmtDateTime(s.lastSubmittedAt) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
      <Panel title={t("motivation.firstSubmittersTitle")}>
        {!tasks.length ? (
          <p className="text-sm text-muted-foreground">{t("motivation.noGroupTasks")}</p>
        ) : (
          <ul className="divide-y">
            {tasks.map((task) => (
              <li key={task.id} className="space-y-1.5 py-2.5">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="min-w-0 break-words font-medium">{task.title}</span>
                  <span className="text-xs text-muted-foreground">
                    {t("motivation.ofTasks", { done: task.submittedCount, total: students.length })} · {t("modules.deadlineValue", { date: fmtDateTime(task.deadline) })}
                  </span>
                </div>
                <FirstSubmittersList items={task.firstSubmitters} />
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}

export function GroupsPage() {
  const groups = trpc.teacher.groups.list.useQuery();
  const overview = trpc.teacher.groups.overview.useQuery();
  const [open, setOpen] = useState(false);
  const [, nav] = useLocation();
  return (
    <AppShell area="teaching">
      <div className="space-y-5">
        <div className="flex justify-end"><Button onClick={() => setOpen(true)}>{t("groups.new")}</Button></div>
        {groups.isLoading ? (
          <Loading />
        ) : !groups.data?.length ? (
          <EmptyState title={t("groups.empty")} body={t("groups.emptyBody")} action={<Button onClick={() => setOpen(true)}>{t("groups.create")}</Button>} />
        ) : (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {groups.data.map((g) => {
              const o = overview.data?.find((x) => x.groupId === g.id);
              return (
                <Link key={g.id} href={`/teacher/groups/${g.id}`} className="rounded-2xl border bg-card p-5 transition hover:shadow-card">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="break-words font-semibold">{g.name}</div>
                      <div className="text-xs text-muted-foreground">{[t(`groups.type.${g.groupType}`), groupFactsLine(g)].filter(Boolean).join(" · ")}</div>
                    </div>
                    {g.pendingCount > 0 && <StatusBadge tone="warning" className="shrink-0">{t("groups.requestsCount", { count: g.pendingCount })}</StatusBadge>}
                  </div>
                  <dl className="mt-4 grid grid-cols-3 gap-2 text-center text-sm">
                    <div className="flex flex-col-reverse"><dt className="text-xs text-muted-foreground">{t("groups.statStudents")}</dt><dd className="text-lg font-semibold">{g.studentCount}</dd></div>
                    <div className="flex flex-col-reverse"><dt className="text-xs text-muted-foreground">{t("groups.statExams")}</dt><dd className="text-lg font-semibold">{o?.examCount ?? 0}</dd></div>
                    <div className="flex flex-col-reverse"><dt className="text-xs text-muted-foreground">{t("groups.statAverage")}</dt><dd className="text-lg font-semibold">{o ? `${o.averageScore}%` : "—"}</dd></div>
                  </dl>
                </Link>
              );
            })}
          </div>
        )}
      </div>
      <GroupFormDialog open={open} onOpenChange={setOpen} onCreated={(id) => nav(`/teacher/groups/${id}?invite=1`)} />
    </AppShell>
  );
}

interface GroupFormInitial {
  id: string;
  name: string;
  groupType: GroupType;
  subject: string;
  grade: string;
  level: string;
  description: string | null;
  language: string;
  format: (typeof GROUP_FORMATS)[number];
  startDate: string | Date | null;
  classSchedule: ClassScheduleEntry[];
  scheduleVisible: boolean;
  scoresVisibleToGroup: boolean;
}

const TYPE_ICONS = { SCHOOL: School, COURSE: BookOpen } as const;

/** Two-option segmented control (a radio group: arrow keys move the choice, as with native radios). */
function GroupTypeSwitch({ value, onChange }: { value: GroupType; onChange: (v: GroupType) => void }) {
  const labelId = useId();
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  function onKeyDown(e: React.KeyboardEvent, index: number) {
    const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = (index + step + GROUP_TYPES.length) % GROUP_TYPES.length;
    onChange(GROUP_TYPES[next]);
    refs.current[next]?.focus();
  }
  return (
    <div className="text-sm">
      <span id={labelId} className={fieldLabel}>{t("groups.type.label")}</span>
      <div role="radiogroup" aria-labelledby={labelId} className="mt-1 grid grid-cols-2 gap-1 rounded-lg border border-input bg-muted p-1">
        {GROUP_TYPES.map((type, i) => {
          const selected = value === type;
          const Icon = TYPE_ICONS[type];
          return (
            <button
              key={type}
              ref={(el) => { refs.current[i] = el; }}
              type="button"
              role="radio"
              aria-checked={selected}
              tabIndex={selected ? 0 : -1}
              onClick={() => onChange(type)}
              onKeyDown={(e) => onKeyDown(e, i)}
              className={`flex min-h-9 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-center font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                selected ? "bg-card text-foreground shadow-sm ring-1 ring-input" : "text-foreground-secondary hover:text-foreground"
              }`}
            >
              <Icon className={`h-4 w-4 shrink-0 ${selected ? "text-primary" : ""}`} aria-hidden />
              {t(`groups.type.${type}`)}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** `startDate` ↔ a bare YYYY-MM-DD for <input type="date">; the server stores it as a timestamp. */
function dateOnly(value: string | Date | null | undefined): string {
  if (!value) return "";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
}

function GroupFormDialog({
  open,
  onOpenChange,
  initial,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  initial?: GroupFormInitial;
  onCreated?: (id: string) => void;
}) {
  const utils = trpc.useUtils();
  const defaults = trpc.teacher.groups.newGroupDefaults.useQuery(undefined, { enabled: open && !initial });
  const [typeTouched, setTypeTouched] = useState(false);
  const [f, setF] = useState({
    name: initial?.name ?? "",
    ...typeDraftOf(initial, "COURSE"),
    description: initial?.description ?? "",
    // Legacy free-text language values (from before this became a dropdown) don't match a known
    // option, so they fall back to unset rather than silently submitting an invalid value.
    language: ((GROUP_LANGUAGES as readonly string[]).includes(initial?.language ?? "") ? initial!.language : "") as GroupLanguage | "",
    format: initial?.format ?? ("ONLINE" as (typeof GROUP_FORMATS)[number]),
    startDate: dateOnly(initial?.startDate),
    classSchedule: initial?.classSchedule ?? ([] as ClassScheduleEntry[]),
    scheduleVisible: initial?.scheduleVisible ?? false,
    scoresVisibleToGroup: initial?.scoresVisibleToGroup ?? true,
  });
  const defaultType = defaults.data?.groupType;
  useEffect(() => {
    if (!initial && !typeTouched && defaultType) setF((prev) => ({ ...prev, groupType: defaultType }));
  }, [defaultType]);
  const done = () => { void utils.teacher.groups.invalidate(); onOpenChange(false); };
  const create = trpc.teacher.groups.create.useMutation({
    onSuccess: (g) => { onCreated?.(g.id); done(); },
    onError: (e) => toast.error(errorText(e)),
  });
  const update = trpc.teacher.groups.update.useMutation({ onSuccess: done, onError: (e) => toast.error(errorText(e)) });
  const payload = () => {
    const { groupType, subject, grade, levelChoice, levelText, ...rest } = f;
    return { ...rest, ...typePayload({ groupType, subject, grade, levelChoice, levelText }), startDate: f.startDate ? new Date(f.startDate).toISOString() : null };
  };
  const keys = typeFieldKeys(f.groupType);
  function toggleDay(day: WeekDay) {
    setF((prev) => ({
      ...prev,
      classSchedule: prev.classSchedule.some((e) => e.day === day)
        ? prev.classSchedule.filter((e) => e.day !== day)
        : [...prev.classSchedule, { day, time: "09:00" }],
    }));
  }
  function setDayTime(day: WeekDay, time: string) {
    setF((prev) => ({ ...prev, classSchedule: prev.classSchedule.map((e) => (e.day === day ? { ...e, time } : e)) }));
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader><DialogTitle>{initial ? t("groups.editTitle") : t("groups.newTitle")}</DialogTitle></DialogHeader>
        <DialogBody className="grid content-start gap-3">
          <GroupTypeSwitch
            value={f.groupType}
            onChange={(groupType) => {
              setTypeTouched(true);
              setF({ ...f, groupType });
            }}
          />
          <label className="text-sm"><span className={fieldLabel}>{t("common.required", { label: t("common.name") })}</span><Input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-sm">
              <span className={fieldLabel}>{t(keys.subject)}</span>
              <Input maxLength={120} value={f.subject} placeholder={t(keys.subjectPlaceholder)} onChange={(e) => setF({ ...f, subject: e.target.value })} />
            </label>
            {f.groupType === "SCHOOL" ? (
              <label className="text-sm">
                <span className={fieldLabel}>{t(keys.second)}</span>
                <Input maxLength={GROUP_CLASS_MAX} value={f.grade} placeholder={t("groups.field.classPlaceholder")} onChange={(e) => setF({ ...f, grade: e.target.value })} />
              </label>
            ) : (
              <div className="grid content-start gap-2 text-sm">
                <label>
                  <span className={fieldLabel}>{t(keys.second)}</span>
                  <select className={selectCls} value={f.levelChoice} onChange={(e) => setF({ ...f, levelChoice: e.target.value as LevelChoice })}>
                    <option value="">{t("common.selectPlaceholder")}</option>
                    {LEVEL_OPTIONS.map((level) => (
                      <option key={level} value={level}>{groupLevelLabel(level)}</option>
                    ))}
                    <option value="OTHER">{t("groups.level.other")}</option>
                  </select>
                </label>
                {f.levelChoice === "OTHER" && (
                  <Input
                    aria-label={t("groups.level.otherLabel")}
                    maxLength={GROUP_LEVEL_MAX}
                    value={f.levelText}
                    placeholder={t("groups.level.otherPlaceholder")}
                    onChange={(e) => setF({ ...f, levelText: e.target.value })}
                  />
                )}
              </div>
            )}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <label className="text-sm">
              <span className={fieldLabel}>{t("common.language")}</span>
              <select
                className={selectCls}
                value={f.language}
                onChange={(e) => setF({ ...f, language: e.target.value as GroupLanguage | "" })}
              >
                <option value="">{t("common.selectPlaceholder")}</option>
                {GROUP_LANGUAGES.map((code) => (
                  <option key={code} value={code}>{t(`groupLanguage.${code}`)}</option>
                ))}
              </select>
            </label>
            <label className="text-sm">
              <span className={fieldLabel}>{t("common.format")}</span>
              <select
                className={selectCls}
                value={f.format}
                onChange={(e) => setF({ ...f, format: e.target.value as (typeof GROUP_FORMATS)[number] })}
              >
                {GROUP_FORMATS.map((v) => (
                  <option key={v} value={v}>{t(`groups.format.${v}`)}</option>
                ))}
              </select>
            </label>
          </div>
          <label className="text-sm"><span className={fieldLabel}>{t("common.description")}</span><Textarea rows={2} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></label>
          <div className="rounded-xl border p-3">
            <div className="grid gap-3 sm:grid-cols-[auto_1fr]">
              <label className="text-sm"><span className={fieldLabel}>{t("common.startDate")}</span><Input type="date" value={f.startDate} onChange={(e) => setF({ ...f, startDate: e.target.value })} /></label>
              <div className="text-sm">
                <span className={fieldLabel}>{t("groups.scheduleLabel")}</span>
                <div className="mt-1 flex flex-wrap items-center gap-2">
                  {WEEK_DAYS.map((day) => {
                    const entry = f.classSchedule.find((e) => e.day === day);
                    return (
                      <div key={day} className="flex items-center gap-1.5">
                        <ChoiceChip selected={!!entry} onClick={() => toggleDay(day)}>{t(`weekday.short.${day}`)}</ChoiceChip>
                        {entry && (
                          <input
                            type="time"
                            aria-label={t(`weekday.full.${day}`)}
                            value={entry.time}
                            onChange={(e) => setDayTime(day, e.target.value)}
                            className="h-9 rounded-md border border-input bg-card px-2 text-sm text-foreground"
                          />
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
            <SettingToggle
              variant="plain"
              className="mt-3"
              id="schedule-visible"
              label={t("groups.scheduleVisibleLabel")}
              hint={t("groups.scheduleVisibleHint")}
              checked={f.scheduleVisible}
              onCheckedChange={(v) => setF({ ...f, scheduleVisible: v })}
            />
          </div>
          <SettingToggle
            id="scores-visible"
            label={t("groups.scoresVisibleLabel")}
            hint={t("groups.scoresVisibleHint")}
            checked={f.scoresVisibleToGroup}
            onCheckedChange={(v) => setF({ ...f, scoresVisibleToGroup: v })}
          />
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t("common.cancel")}</Button>
          <Button
            disabled={f.name.trim().length < 2 || create.isPending || update.isPending}
            onClick={() => (initial ? update.mutate({ id: initial.id, patch: payload() }) : create.mutate(payload()))}
          >
            {t("common.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EmailInviteStatusBadge({ status }: { status: "PENDING" | "ACCEPTED" | "REVOKED" | "EXPIRED" }) {
  const tone = status === "ACCEPTED" ? "success" : status === "PENDING" ? "warning" : "neutral";
  return <StatusBadge tone={tone}>{t(`groups.emailInviteStatus.${status}`)}</StatusBadge>;
}

function EmailInviteSection({ groupId }: { groupId: string }) {
  const utils = trpc.useUtils();
  const [email, setEmail] = useState("");
  const [freshLink, setFreshLink] = useState<{ token: string; email: string } | null>(null);
  const list = trpc.teacher.groups.emailInviteList.useQuery({ groupId });
  const refresh = () => { void utils.teacher.groups.emailInviteList.invalidate({ groupId }); };
  const create = trpc.teacher.groups.emailInviteCreate.useMutation({
    onSuccess: (res) => { setFreshLink({ token: res.token, email }); setEmail(""); refresh(); },
    onError: (e) => toast.error(errorText(e)),
  });
  const revoke = trpc.teacher.groups.emailInviteRevoke.useMutation({ onSuccess: refresh, onError: (e) => toast.error(errorText(e)) });
  const resend = trpc.teacher.groups.emailInviteResend.useMutation({
    onSuccess: (res, vars) => {
      const invitedEmail = list.data?.find((i) => i.id === vars.inviteId)?.email ?? "";
      setFreshLink({ token: res.token, email: invitedEmail });
      refresh();
    },
    onError: (e) => toast.error(errorText(e)),
  });

  return (
    <section aria-labelledby="invite-email-token">
      <h3 id="invite-email-token" className="mb-2 text-sm font-medium">{t("groups.inviteByEmailLink")}</h3>
      <div className="flex gap-2">
        <Input
          type="email"
          aria-labelledby="invite-email-token"
          placeholder={t("groups.emailPlaceholder")}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <Button disabled={!email.includes("@") || create.isPending} onClick={() => create.mutate({ groupId, email })}>
          {t("groups.sendInvite")}
        </Button>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">{t("groups.emailLinkNote")}</p>

      {freshLink && (
        <div className="mt-3 rounded-xl border bg-muted/40 p-3">
          <p className="mb-2 text-xs text-foreground-secondary">{t("groups.emailLinkReady", { email: freshLink.email })}</p>
          <ShareBox path={`/invite/${freshLink.token}`} fileName={`resulio-invite-${freshLink.token.slice(0, 8)}`} />
        </div>
      )}

      {!!list.data?.length && (
        <ul className="mt-4 divide-y text-sm">
          {list.data.map((inv) => (
            <li key={inv.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <div className="min-w-0">
                <div className="break-all">{inv.email}</div>
                <div className="text-xs text-muted-foreground">{fmtDateTime(inv.createdAt)}</div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <EmailInviteStatusBadge status={inv.displayStatus} />
                {(inv.displayStatus === "PENDING" || inv.displayStatus === "EXPIRED") && (
                  <Button size="sm" variant="outline" disabled={resend.isPending} onClick={() => resend.mutate({ groupId, inviteId: inv.id })}>
                    {t("groups.resendInvite")}
                  </Button>
                )}
                {inv.displayStatus === "PENDING" && (
                  <Button size="sm" variant="ghost" className="text-destructive" disabled={revoke.isPending} onClick={() => revoke.mutate({ groupId, inviteId: inv.id })}>
                    {t("groups.revokeInvite")}
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

type InviteLinkStatus = "ACTIVE" | "USED" | "EXPIRED" | "REVOKED";
type FreshInviteLink = { id: string; label: string; token: string; expiresAt: string | Date };
const INVITE_LINK_EXPIRY_DAYS = [1, 3, 7, 14, 30] as const;

function InviteLinkStatusBadge({ status }: { status: InviteLinkStatus }) {
  const tone = status === "USED" ? "success" : status === "ACTIVE" ? "info" : "neutral";
  return <StatusBadge tone={tone}>{t(`groups.inviteLinkStatus.${status}`)}</StatusBadge>;
}

/**
 * Single-use links: each one admits exactly one student, instantly. Raw links exist only in the
 * create/reissue response (the server keeps a hash), so they're listed here until the dialog closes;
 * an older link can be reissued to get a copyable one again.
 */
function InviteLinksSection({ groupId }: { groupId: string }) {
  const utils = trpc.useUtils();
  const [byName, setByName] = useState(false);
  const [count, setCount] = useState(5);
  const [names, setNames] = useState("");
  const [days, setDays] = useState<number>(7);
  const [fresh, setFresh] = useState<FreshInviteLink[]>([]);
  const list = trpc.teacher.groups.inviteLinkList.useQuery({ groupId });
  const refresh = () => {
    void utils.teacher.groups.inviteLinkList.invalidate({ groupId });
    void utils.teacher.groups.shareFunnel.invalidate({ groupId });
  };
  const create = trpc.teacher.groups.inviteLinkCreate.useMutation({
    onSuccess: (rows) => { setFresh(rows); setNames(""); refresh(); },
    onError: (e) => toast.error(errorText(e)),
  });
  const revoke = trpc.teacher.groups.inviteLinkRevoke.useMutation({ onSuccess: refresh, onError: (e) => toast.error(errorText(e)) });
  const reissue = trpc.teacher.groups.inviteLinkReissue.useMutation({
    onSuccess: (row) => { setFresh([row]); refresh(); },
    onError: (e) => toast.error(errorText(e)),
  });
  const labels = names.split("\n").map((s) => s.trim()).filter(Boolean);
  const canCreate = byName ? labels.length > 0 && labels.length <= 50 : count >= 1 && count <= 50;
  const urlOf = (token: string) => `${window.location.origin}/g/${token}?src=${SHARE_SOURCE_PARAM.COPY_LINK}`;
  const copyAll = async () => {
    try {
      await navigator.clipboard.writeText(fresh.map((f) => (f.label ? `${f.label}: ${urlOf(f.token)}` : urlOf(f.token))).join("\n"));
      toast.success(t("share.copied"));
    } catch {
      toast.error(t("share.copyFailed"));
    }
  };

  return (
    <section aria-labelledby="invite-single-use">
      <h3 id="invite-single-use" className="mb-1 text-sm font-medium">{t("groups.inviteLinks.title")}</h3>
      <p className="mb-3 text-xs text-muted-foreground">{t("groups.inviteLinks.hint")}</p>
      <div className="space-y-3 rounded-xl border p-3">
        <div className="flex flex-wrap gap-2">
          <ChoiceChip selected={!byName} onClick={() => setByName(false)}>{t("groups.inviteLinks.byCount")}</ChoiceChip>
          <ChoiceChip selected={byName} onClick={() => setByName(true)}>{t("groups.inviteLinks.byName")}</ChoiceChip>
        </div>
        {byName ? (
          <label className="block text-sm">
            <span className={fieldLabel}>{t("groups.inviteLinks.namesLabel")}</span>
            <Textarea rows={4} value={names} placeholder={t("groups.inviteLinks.namesPlaceholder")} onChange={(e) => setNames(e.target.value)} />
            <span className="mt-1 block text-xs text-muted-foreground">{t("groups.inviteLinks.namesHint", { count: labels.length })}</span>
          </label>
        ) : (
          <label className="block text-sm">
            <span className={fieldLabel}>{t("groups.inviteLinks.countLabel")}</span>
            <Input type="number" min={1} max={50} value={count} onChange={(e) => setCount(Math.max(0, Math.min(50, Number(e.target.value) || 0)))} />
          </label>
        )}
        <label className="block text-sm">
          <span className={fieldLabel}>{t("groups.inviteLinks.expiryLabel")}</span>
          <select
            className="mt-1 h-9 w-full rounded-md border border-input bg-card px-3 text-sm text-foreground"
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
          >
            {INVITE_LINK_EXPIRY_DAYS.map((d) => (
              <option key={d} value={d}>{t("groups.inviteLinks.expiryDays", { count: d })}</option>
            ))}
          </select>
        </label>
        <Button
          disabled={!canCreate || create.isPending}
          onClick={() => create.mutate(byName ? { groupId, labels, expiresInDays: days } : { groupId, count, expiresInDays: days })}
        >
          {t("groups.inviteLinks.generate")}
        </Button>
      </div>

      {fresh.length > 0 && (
        <div className="mt-3 space-y-2 rounded-xl border bg-muted/40 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-foreground-secondary">{t("groups.inviteLinks.freshNote")}</p>
            {fresh.length > 1 && <Button size="sm" variant="outline" onClick={() => void copyAll()}>{t("groups.inviteLinks.copyAll")}</Button>}
          </div>
          <ul className="space-y-2">
            {fresh.map((f) => (
              <li key={f.id} className="space-y-1">
                {!!f.label && <div className="break-words text-xs font-medium">{f.label}</div>}
                <CompactShareLink path={`/g/${f.token}`} tracking={{ targetType: "GROUP", targetId: `link:${f.id}` }} />
              </li>
            ))}
          </ul>
        </div>
      )}

      {!!list.data?.length && (
        <ul className="mt-4 max-h-72 divide-y overflow-y-auto text-sm">
          {list.data.map((l) => (
            <li key={l.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <div className="min-w-0">
                <div className="break-words">{l.label || t("groups.inviteLinks.unlabeled")}</div>
                <div className="text-xs text-muted-foreground">
                  {l.status === "USED" && l.usedBy
                    ? t("groups.inviteLinks.usedBy", { name: l.usedBy.name ?? l.usedBy.email ?? `#${l.usedBy.id}`, date: fmtDateTime(l.usedAt) })
                    : t("groups.inviteLinks.expiresAt", { date: fmtDateTime(l.expiresAt) })}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <InviteLinkStatusBadge status={l.status} />
                {l.status !== "USED" && (
                  <Button size="sm" variant="outline" disabled={reissue.isPending} onClick={() => reissue.mutate({ groupId, linkId: l.id, expiresInDays: days })}>
                    {t("groups.inviteLinks.reissue")}
                  </Button>
                )}
                {l.status === "ACTIVE" && (
                  <Button size="sm" variant="ghost" className="text-destructive" disabled={revoke.isPending} onClick={() => revoke.mutate({ groupId, linkId: l.id })}>
                    {t("groups.revokeInvite")}
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function GroupCodeNoticeCallout(props: Parameters<typeof groupCodeNotice>[0]) {
  const notice = groupCodeNotice(props);
  const open = notice === "OPEN" || notice === "LIMIT_REACHED";
  const Icon = open ? AlertTriangle : Info;
  return (
    <p
      role="note"
      data-notice={notice}
      className={`mb-3 flex items-start gap-2 rounded-xl border p-3 text-xs text-foreground ${open ? "border-warning/40 bg-warning-surface" : "bg-muted"}`}
    >
      <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${open ? "text-warning" : "text-muted-foreground"}`} aria-hidden />
      <span className="min-w-0 break-words">{t(`groups.codeNotice.${notice}`, { uses: props.codeUsage.uses, max: props.codeUsage.maxUses ?? 0 })}</span>
    </p>
  );
}

function InviteDialog({
  open,
  onOpenChange,
  groupId,
  inviteCode,
  joinPolicy,
  codeActive,
  codeExpiresAt,
  codeUsage,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  groupId: string;
  inviteCode: string;
  joinPolicy: JoinPolicy;
  codeActive: boolean;
  codeExpiresAt: string | Date | null;
  codeUsage: { uses: number; maxUses: number | null };
}) {
  const utils = trpc.useUtils();
  const [email, setEmail] = useState("");
  const [expiryInput, setExpiryInput] = useState(() => (codeExpiresAt ? new Date(codeExpiresAt).toISOString().slice(0, 10) : ""));
  const [maxUsesInput, setMaxUsesInput] = useState(() => (codeUsage.maxUses === null ? "" : String(codeUsage.maxUses)));
  const maxUses = Number(maxUsesInput);
  const maxUsesValid = Number.isInteger(maxUses) && maxUses >= 1 && maxUses <= 10_000;
  const onGroupChange = () => void utils.teacher.groups.invalidate();
  const shareFunnel = trpc.teacher.groups.shareFunnel.useQuery({ groupId }, { enabled: open });
  const add = trpc.teacher.groups.addMember.useMutation({
    onSuccess: () => { toast.success(t("groups.studentAdded")); setEmail(""); onGroupChange(); },
    onError: (e) => toast.error(errorText(e)),
  });
  const setPolicy = trpc.teacher.groups.setJoinPolicy.useMutation({ onSuccess: onGroupChange, onError: (e) => toast.error(errorText(e)) });
  const setActive = trpc.teacher.groups.setInviteCodeActive.useMutation({ onSuccess: onGroupChange, onError: (e) => toast.error(errorText(e)) });
  const setExpiry = trpc.teacher.groups.setInviteCodeExpiry.useMutation({ onSuccess: onGroupChange, onError: (e) => toast.error(errorText(e)) });
  const setMaxUses = trpc.teacher.groups.setInviteCodeMaxUses.useMutation({ onSuccess: onGroupChange, onError: (e) => toast.error(errorText(e)) });
  const regenerate = trpc.teacher.groups.regenerateInviteCode.useMutation({
    onSuccess: () => { toast.success(t("groups.codeRegenerated")); setExpiryInput(""); onGroupChange(); },
    onError: (e) => toast.error(errorText(e)),
  });
  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(inviteCode);
      toast.success(t("groups.codeCopied"));
    } catch {
      toast.error(t("share.copyFailed"));
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader><DialogTitle>{t("groups.inviteTitle")}</DialogTitle></DialogHeader>
        <DialogBody className="space-y-5">
          <InviteLinksSection groupId={groupId} />
          <section aria-labelledby="invite-link">
            <h3 id="invite-link" className="mb-1 text-sm font-medium">{t("groups.inviteByLink")}</h3>
            <p className="mb-2 text-xs text-muted-foreground">{t("groups.inviteByLinkMultiUse")}</p>
            <GroupCodeNoticeCallout joinPolicy={joinPolicy} codeActive={codeActive} codeExpiresAt={codeExpiresAt} codeUsage={codeUsage} />
            <ShareBox
              path={`/join/${inviteCode}`}
              fileName={`resulio-group-${inviteCode}`}
              tracking={{ targetType: "GROUP", targetId: inviteCode, campaign: "group_join" }}
              onTracked={() => void shareFunnel.refetch()}
            />
            <div className="mt-3 flex items-center gap-2">
              <span className="text-xs text-foreground-secondary">{t("groups.inviteCodeLabel")}:</span>
              <code className="rounded bg-muted px-2 py-1 font-mono text-sm">{inviteCode}</code>
              <Button variant="outline" size="sm" onClick={() => void copyCode()}>{t("groups.copyCode")}</Button>
            </div>
            <p className="mt-2 text-xs text-foreground-secondary">
              {codeUsage.maxUses === null
                ? t("groups.codeUses", { uses: codeUsage.uses })
                : t("groups.codeUsesOfMax", { uses: codeUsage.uses, max: codeUsage.maxUses })}
            </p>
            <ShareFunnelSummary data={shareFunnel.data} />

            <div className="mt-3 rounded-xl border p-3">
              <label className="text-sm">
                <span className={fieldLabel}>{t("groups.joinPolicyLabel")}</span>
                <select
                  className="mt-1 h-9 w-full rounded-md border border-input bg-card px-3 text-sm text-foreground"
                  value={joinPolicy}
                  disabled={setPolicy.isPending}
                  onChange={(e) => setPolicy.mutate({ groupId, joinPolicy: e.target.value as JoinPolicy })}
                >
                  {JOIN_POLICIES.map((p) => (
                    <option key={p} value={p}>{t(`groups.joinPolicy.${p}`)}</option>
                  ))}
                </select>
              </label>
              <p className="mt-2 text-xs text-muted-foreground">{t(`groups.joinPolicyHint.${joinPolicy}`)}</p>
            </div>

            <SettingToggle
              className="mt-3"
              id="code-active"
              label={t("groups.codeActiveLabel")}
              hint={t("groups.codeActiveHint")}
              checked={codeActive}
              disabled={setActive.isPending}
              onCheckedChange={(v) => setActive.mutate({ groupId, active: v })}
            />

            <div className="mt-3 flex flex-wrap items-end gap-2 rounded-xl border p-3">
              <label className="flex-1 text-sm">
                <span className={fieldLabel}>{t("groups.codeExpiryLabel")}</span>
                <Input type="date" value={expiryInput} onChange={(e) => setExpiryInput(e.target.value)} />
              </label>
              <Button
                variant="outline"
                size="sm"
                disabled={setExpiry.isPending || !expiryInput}
                onClick={() => setExpiry.mutate({ groupId, expiresAt: new Date(expiryInput).toISOString() })}
              >
                {t("groups.codeExpirySet")}
              </Button>
              {!!codeExpiresAt && (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={setExpiry.isPending}
                  onClick={() => { setExpiryInput(""); setExpiry.mutate({ groupId, expiresAt: null }); }}
                >
                  {t("groups.codeExpiryClear")}
                </Button>
              )}
            </div>

            <div className="mt-3 rounded-xl border p-3">
              <div className="flex flex-wrap items-end gap-2">
                <label className="flex-1 text-sm">
                  <span className={fieldLabel}>{t("groups.codeMaxUsesLabel")}</span>
                  <Input
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={10_000}
                    placeholder={t("groups.codeMaxUsesPlaceholder")}
                    value={maxUsesInput}
                    onChange={(e) => setMaxUsesInput(e.target.value)}
                  />
                </label>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={setMaxUses.isPending || !maxUsesValid || maxUses === codeUsage.maxUses}
                  onClick={() => setMaxUses.mutate({ groupId, maxUses })}
                >
                  {t("groups.codeExpirySet")}
                </Button>
                {codeUsage.maxUses !== null && (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={setMaxUses.isPending}
                    onClick={() => { setMaxUsesInput(""); setMaxUses.mutate({ groupId, maxUses: null }); }}
                  >
                    {t("groups.codeMaxUsesClear")}
                  </Button>
                )}
              </div>
              <p className="mt-2 text-xs text-muted-foreground">{t("groups.codeMaxUsesHint")}</p>
            </div>

            <Button
              variant="outline"
              size="sm"
              className="mt-2"
              disabled={regenerate.isPending}
              onClick={() => confirm(t("groups.regenerateConfirm")) && regenerate.mutate({ groupId })}
            >
              {t("groups.regenerateCode")}
            </Button>
          </section>
          <section aria-labelledby="invite-email">
            <h3 id="invite-email" className="mb-2 text-sm font-medium">{t("groups.inviteByEmail")}</h3>
            <div className="flex gap-2">
              <Input type="email" aria-labelledby="invite-email" placeholder={t("groups.emailPlaceholder")} value={email} onChange={(e) => setEmail(e.target.value)} />
              <Button disabled={!email.includes("@") || add.isPending} onClick={() => add.mutate({ groupId, email })}>{t("common.add")}</Button>
            </div>
            <p className="mt-2 text-xs text-muted-foreground">{t("groups.emailNote")}</p>
          </section>
          <EmailInviteSection groupId={groupId} />
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

export function GroupDetailPage() {
  const { id = "" } = useParams<{ id: string }>();
  const search = useSearch();
  const [, nav] = useLocation();
  const utils = trpc.useUtils();
  const group = trpc.teacher.groups.detail.useQuery({ id });
  const analytics = trpc.teacher.groups.analytics.useQuery({ id });
  const [inviteOpen, setInviteOpen] = useState(() => new URLSearchParams(search).get("invite") === "1");
  const [editOpen, setEditOpen] = useState(false);
  useEffect(() => {
    if (new URLSearchParams(search).get("invite") === "1") nav(`/teacher/groups/${id}`, { replace: true });
  }, []);
  const onDone = () => void utils.teacher.groups.invalidate();
  const approve = trpc.teacher.groups.approveMember.useMutation({ onSuccess: onDone, onError: (e) => toast.error(errorText(e)) });
  const remove = trpc.teacher.groups.removeMember.useMutation({ onSuccess: onDone, onError: (e) => toast.error(errorText(e)) });
  const g = group.data;
  const active = g?.members.filter((m) => m.status === "ACTIVE") ?? [];
  const pending = g?.members.filter((m) => m.status === "PENDING") ?? [];
  const ga = analytics.data;

  return (
    <AppShell area="teaching" title={g?.name}>
      {group.error ? (
        <ErrorNote error={group.error} />
      ) : !g ? (
        <Loading />
      ) : (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="text-sm text-muted-foreground">{[t(`groups.type.${g.groupType}`), groupFactsLine(g)].filter(Boolean).join(" · ")}</div>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setEditOpen(true)}>{t("common.edit")}</Button>
              <Button onClick={() => setInviteOpen(true)}>{t("groups.invite")}</Button>
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <StatCard label={t("common.students")} value={active.length} hint={pending.length ? t("groups.pendingHint", { count: pending.length }) : undefined} />
            <StatCard label={t("home.averageScore")} value={ga ? `${ga.averageScore}%` : "—"} />
            <StatCard label={t("common.exams")} value={ga?.history.length ?? 0} />
          </div>
          <GroupSyllabiPanel groupId={id} />

          <Tabs defaultValue="students" className="min-h-screen">
            <TabsList className="h-auto flex-wrap">
              <TabsTrigger value="students">{t("common.students")}</TabsTrigger>
              <TabsTrigger value="requests">{pending.length > 0 ? t("groups.tab.requestsCount", { count: pending.length }) : t("groups.tab.requests")}</TabsTrigger>
              <TabsTrigger value="assessments">{t("common.exams")}</TabsTrigger>
              <TabsTrigger value="tasks">{t("groups.tab.tasks")}</TabsTrigger>
              <TabsTrigger value="analytics">{t("common.analytics")}</TabsTrigger>
              <TabsTrigger value="activity">{t("motivation.tab")}</TabsTrigger>
            </TabsList>
            <TabsContent value="activity" className="pt-3">
              <GroupActivityTab groupId={id} />
            </TabsContent>
            <TabsContent value="students" className="pt-3">
              <Panel>
                {!active.length ? (
                  <p className="text-sm text-muted-foreground">{t("groups.noStudents")}</p>
                ) : (
                  <div className="relative overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="text-left text-xs uppercase text-muted-foreground">
                        <tr>
                          <th scope="col" className="py-2">{t("common.name")}</th>
                          <th scope="col">{t("common.email")}</th>
                          <th scope="col">{t("groups.joined")}</th>
                          <th scope="col">{t("groups.joinedVia")}</th>
                          <th scope="col"><span className="sr-only">{t("groups.remove")}</span></th>
                        </tr>
                      </thead>
                      <tbody className="divide-y">
                        {active.map((m) => (
                          <tr key={m.studentId}>
                            <td className="break-words py-2 pr-3">{m.name ?? "—"}</td>
                            <td className="break-all pr-3 text-muted-foreground">{m.email}</td>
                            <td className="whitespace-nowrap pr-3 text-muted-foreground">{fmtDateTime(m.joinedAt)}</td>
                            <td
                              className="pr-3 text-foreground-secondary"
                              title={m.joinSource ? [m.joinSource.detail, fmtDateTime(m.joinSource.joinedAt)].filter(Boolean).join(" · ") : undefined}
                            >
                              <div>{joinSourceLabel(m.joinSource?.joinedVia)}</div>
                              {m.joinSource?.detail && <div className="break-words text-xs text-muted-foreground">{m.joinSource.detail}</div>}
                            </td>
                            <td className="text-right">
                              <Button
                                size="sm"
                                variant="ghost"
                                className="text-destructive hover:bg-danger-surface hover:text-destructive"
                                aria-label={t("groups.removeStudent", { name: m.name ?? m.email ?? "" })}
                                onClick={() => confirm(t("groups.removeConfirm")) && remove.mutate({ groupId: id, studentId: m.studentId })}
                              >
                                {t("groups.remove")}
                              </Button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Panel>
            </TabsContent>
            <TabsContent value="requests" className="pt-3">
              <Panel>
                {!pending.length ? (
                  <p className="text-sm text-muted-foreground">{t("groups.noRequests")}</p>
                ) : (
                  <ul className="divide-y">
                    {pending.map((m) => (
                      <li key={m.studentId} className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-sm">
                        <span className="min-w-0 break-words">{m.name} <span className="break-all text-muted-foreground">{m.email}</span></span>
                        <span className="flex gap-2">
                          <Button size="sm" onClick={() => approve.mutate({ groupId: id, studentId: m.studentId })}>{t("groups.approve")}</Button>
                          <Button size="sm" variant="outline" onClick={() => remove.mutate({ groupId: id, studentId: m.studentId })}>{t("groups.reject")}</Button>
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </Panel>
            </TabsContent>
            <TabsContent value="assessments" className="pt-3">
              <Panel>
                {!ga?.history.length ? (
                  <p className="text-sm text-muted-foreground">{t("groups.noExams")}</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="text-left text-xs uppercase text-muted-foreground">
                        <tr>
                          <th scope="col" className="py-2">{t("common.exam")}</th>
                          <th scope="col">{t("common.status")}</th>
                          <th scope="col">{t("common.participation")}</th>
                          <th scope="col">{t("common.average")}</th>
                          <th scope="col">{t("common.median")}</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y">
                        {ga.history.map((h) => (
                          <tr key={h.id}>
                            <td className="break-words py-2 pr-3"><Link href={`/teacher/assessments/${h.id}`} className="text-link underline-offset-4 hover:underline">{h.title}</Link></td>
                            <td className="pr-3"><StatusBadge {...liveStatus(h.liveStatus)}>{liveLabel(h.liveStatus)}</StatusBadge></td>
                            <td>{h.participationRate}%</td>
                            <td className="font-semibold">{h.averageScore}%</td>
                            <td>{h.medianScore}%</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Panel>
            </TabsContent>
            <TabsContent value="tasks" className="pt-3">
              <Panel>
                {!ga?.taskProgress.length ? (
                  <p className="text-sm text-muted-foreground">{t("groups.noTasks")}</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="text-left text-xs uppercase text-muted-foreground">
                        <tr>
                          <th scope="col" className="py-2">{t("modules.task")}</th>
                          <th scope="col">{t("modules.deadline")}</th>
                          <th scope="col">{t("groups.completion")}</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y">
                        {ga.taskProgress.map((tp) => (
                          <tr key={tp.id}>
                            <td className="break-words py-2 pr-3">
                              <Link href="/teacher/modules" className="text-link underline-offset-4 hover:underline">{tp.title}</Link>
                            </td>
                            <td className="whitespace-nowrap pr-3 text-muted-foreground">{fmtDateTime(tp.deadline)}</td>
                            <td className="flex items-center gap-2 pr-3">
                              <span className="font-semibold">{tp.submittedCount}/{tp.targetCount}</span>
                              {!!tp.lateCount && <StatusBadge tone="warning">{t("groups.lateCount", { count: tp.lateCount })}</StatusBadge>}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Panel>
            </TabsContent>
            <TabsContent value="analytics" className="space-y-5 pt-3">
              {!ga ? <Loading /> : (
                <>
                  <div className="grid gap-5 lg:grid-cols-2">
                    <Panel title={t("groups.progress")}><ProgressChart data={ga.progress.map((p) => ({ label: p.label.slice(0, 16), value: p.averageScore }))} /></Panel>
                    <Panel title={t("common.ranking")}><RankingTable rows={ga.ranking} resultLink={false} /></Panel>
                  </div>
                  <div className="grid gap-5 lg:grid-cols-2">
                    <Panel title={t("common.topics")}><TopicBars rows={ga.topics} /></Panel>
                    <Panel title={t("groups.hardest")}>
                      <ul className="space-y-2 text-sm">
                        {ga.weakQuestions.map((q) => (
                          <li key={q.questionId} className="flex justify-between gap-3">
                            <span className="line-clamp-2 min-w-0 break-words" title={q.text}>{q.text}</span>
                            <span className="shrink-0 font-semibold text-destructive">{q.accuracyPercentage}%</span>
                          </li>
                        ))}
                        {!ga.weakQuestions.length && <li className="text-muted-foreground">{t("home.notEnoughData")}</li>}
                      </ul>
                    </Panel>
                  </div>
                </>
              )}
            </TabsContent>
          </Tabs>
          <InviteDialog
            open={inviteOpen}
            onOpenChange={setInviteOpen}
            groupId={id}
            inviteCode={g.inviteCode}
            joinPolicy={g.joinPolicy}
            codeActive={g.codeActive}
            codeExpiresAt={g.codeExpiresAt}
            codeUsage={g.codeUsage}
          />
          {editOpen && <GroupFormDialog open={editOpen} onOpenChange={setEditOpen} initial={g} />}
        </div>
      )}
    </AppShell>
  );
}
