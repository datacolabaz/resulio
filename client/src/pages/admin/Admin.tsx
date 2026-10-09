import { ErrorNote, Loading, Panel } from "@/components/AppShell";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { StatusBadge, type Tone } from "@/components/StatusBadge";
import { t } from "@/i18n/messages";
import { errorText, fmtDateTime } from "@/lib/format";
import { trpc } from "@/lib/trpc";
import { ADMIN_REASON_MIN } from "@shared/adminPermissions";
import { useState } from "react";
import { toast } from "sonner";
import { Redirect, Route, Switch, useLocation } from "wouter";
import { AiAnalyticsPage, AiLogsPage, AiPricingPage } from "./AdminAi";
import AiLimitsPage from "./AdminAiLimits";
import AdminAnnouncementsPage from "./AdminAnnouncements";
import AdminDashboardPage from "./AdminDashboard";
import { AdminLayout } from "./AdminLayout";
import AdminSettingsPage from "./AdminSettings";
import AdminStoragePage from "./AdminStorage";
import { useAdmin } from "./adminShared";

/**
 * Admin console: dashboard, users, teacher AI limits, AI usage, storage, announcements, the audit log
 * and security events. The server (adminProcedure) is the only real authority; every check here is
 * a UI convenience to hide controls the server would refuse anyway.
 */
const STATUS_TONE: Record<string, Tone> = { ACTIVE: "success", SUSPENDED: "danger" };

/** Collects a mandatory reason (server enforces the same minimum) before a high-risk admin action. */
function ReasonDialog({
  open,
  onOpenChange,
  title,
  onConfirm,
  pending,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  title: string;
  onConfirm: (reason: string) => void;
  pending: boolean;
}) {
  const [reason, setReason] = useState("");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader><DialogTitle>{title}</DialogTitle></DialogHeader>
        <label className="text-sm">
          <span className="text-foreground-secondary">{t("admin.reasonLabel")}</span>
          <Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t("admin.reasonPlaceholder")} />
        </label>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t("common.cancel")}</Button>
          <Button disabled={reason.trim().length < ADMIN_REASON_MIN || pending} onClick={() => onConfirm(reason.trim())}>
            {t("common.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AdminUsersPage({ params }: { params: { id?: string } }) {
  const { can } = useAdmin();
  const utils = trpc.useUtils();
  const [, navigate] = useLocation();
  const [query, setQuery] = useState("");
  const parsed = Number(params.id);
  const selected = Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  const setSelected = (id: number | null) => navigate(id === null ? "/admin/users" : `/admin/users/${id}`);
  const [action, setAction] = useState<"suspend" | "unsuspend" | "revoke" | null>(null);
  const search = trpc.admin.users.search.useQuery({ query: query.trim() || undefined }, { enabled: can("users.search") });
  const detail = trpc.admin.users.get.useQuery({ userId: selected ?? 0 }, { enabled: selected !== null && can("users.view") });

  const refresh = () => { void utils.admin.users.search.invalidate(); void utils.admin.users.get.invalidate(); };
  const suspend = trpc.admin.users.suspend.useMutation({ onSuccess: () => { toast.success(t("admin.users.suspended")); refresh(); setAction(null); }, onError: (e) => toast.error(errorText(e)) });
  const unsuspend = trpc.admin.users.unsuspend.useMutation({ onSuccess: () => { toast.success(t("admin.users.unsuspended")); refresh(); setAction(null); }, onError: (e) => toast.error(errorText(e)) });
  const revoke = trpc.admin.users.revokeSessions.useMutation({ onSuccess: () => { toast.success(t("admin.users.sessionsRevoked")); refresh(); setAction(null); }, onError: (e) => toast.error(errorText(e)) });

  if (!can("users.search")) return <Panel><p className="text-sm text-muted-foreground">{t("admin.noAccess")}</p></Panel>;

  const d = detail.data;
  const pending = suspend.isPending || unsuspend.isPending || revoke.isPending;

  return (
    <div className="space-y-5">
      {selected !== null && (
        <Panel title={t("admin.users.detailTitle")} action={<Button variant="ghost" size="sm" onClick={() => setSelected(null)}>{t("common.close")}</Button>}>
          {detail.error ? <ErrorNote error={detail.error} /> : !d ? <Loading /> : (
            <div className="space-y-3 text-sm">
              <div><span className="text-foreground-secondary">{t("common.name")}:</span> {d.name ?? "—"}</div>
              <div><span className="text-foreground-secondary">{t("common.email")}:</span> {d.email}</div>
              <div><span className="text-foreground-secondary">{t("common.status")}:</span> <StatusBadge tone={STATUS_TONE[d.accountStatus] ?? "neutral"}>{d.accountStatus}</StatusBadge></div>
              <div><span className="text-foreground-secondary">{t("admin.users.roles")}:</span> {d.roles.length ? d.roles.join(", ") : "—"}</div>
              <div><span className="text-foreground-secondary">{t("groups.joined")}:</span> {fmtDateTime(d.createdAt)}</div>
              {can("users.suspend") && (
                <div className="flex flex-wrap gap-2 pt-2">
                  {d.accountStatus === "ACTIVE" ? (
                    <Button variant="outline" className="text-destructive" onClick={() => setAction("suspend")}>{t("admin.users.suspend")}</Button>
                  ) : (
                    <Button variant="outline" onClick={() => setAction("unsuspend")}>{t("admin.users.unsuspend")}</Button>
                  )}
                  {can("users.revokeSessions") && <Button variant="outline" onClick={() => setAction("revoke")}>{t("admin.users.revokeSessions")}</Button>}
                </div>
              )}
            </div>
          )}
        </Panel>
      )}

      <Panel title={t("admin.nav.users")}>
        <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("admin.users.searchPlaceholder")} />
        {search.error && <ErrorNote error={search.error} />}
        {search.isLoading ? <Loading /> : (
          <ul className="mt-3 divide-y text-sm">
            {(search.data ?? []).map((u) => (
              <li key={u.id}>
                <button
                  type="button"
                  aria-current={u.id === selected ? "true" : undefined}
                  className={`flex w-full flex-wrap items-center justify-between gap-2 py-2 text-left hover:bg-muted/40 ${u.id === selected ? "bg-muted/60" : ""}`}
                  onClick={() => setSelected(u.id)}
                >
                  <span className="min-w-0">
                    <span className="block break-words font-medium">{u.name ?? "—"}</span>
                    <span className="block break-all text-xs text-muted-foreground">{u.email}</span>
                  </span>
                  <StatusBadge tone={STATUS_TONE[u.accountStatus] ?? "neutral"}>{u.accountStatus}</StatusBadge>
                </button>
              </li>
            ))}
            {!search.data?.length && <li className="py-3 text-muted-foreground">{t("admin.users.noResults")}</li>}
          </ul>
        )}
      </Panel>

      <ReasonDialog
        open={action !== null}
        onOpenChange={(v) => !v && setAction(null)}
        title={action === "suspend" ? t("admin.users.suspend") : action === "unsuspend" ? t("admin.users.unsuspend") : t("admin.users.revokeSessions")}
        pending={pending}
        onConfirm={(reason) => {
          if (selected === null || !action) return;
          if (action === "suspend") suspend.mutate({ userId: selected, reason });
          if (action === "unsuspend") unsuspend.mutate({ userId: selected, reason });
          if (action === "revoke") revoke.mutate({ userId: selected, reason });
        }}
      />
    </div>
  );
}

function AdminAuditPage() {
  const { can } = useAdmin();
  const list = trpc.admin.audit.list.useQuery({ limit: 50 }, { enabled: can("audit.viewSupport") });
  if (!can("audit.viewSupport")) return <Panel><p className="text-sm text-muted-foreground">{t("admin.noAccess")}</p></Panel>;
  return (
    <Panel title={t("admin.nav.audit")}>
      {list.error ? <ErrorNote error={list.error} /> : list.isLoading ? <Loading /> : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase text-muted-foreground">
              <tr>
                <th scope="col" className="py-2">{t("admin.audit.action")}</th>
                <th scope="col">{t("admin.audit.target")}</th>
                <th scope="col">{t("admin.audit.reason")}</th>
                <th scope="col">{t("admin.audit.when")}</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {(list.data ?? []).map((row) => (
                <tr key={row.id}>
                  <td className="py-2 pr-3 font-medium">{row.action}</td>
                  <td className="pr-3 text-muted-foreground">{row.targetType} #{row.targetId}</td>
                  <td className="max-w-xs truncate pr-3 text-muted-foreground" title={row.reason ?? ""}>{row.reason ?? "—"}</td>
                  <td className="whitespace-nowrap text-muted-foreground">{fmtDateTime(row.createdAt)}</td>
                </tr>
              ))}
              {!list.data?.length && (
                <tr><td colSpan={4} className="py-3 text-muted-foreground">{t("admin.audit.empty")}</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

const SEVERITY_TONE: Record<string, Tone> = { LOW: "neutral", MEDIUM: "warning", HIGH: "danger" };

function AdminSecurityPage() {
  const { can } = useAdmin();
  const utils = trpc.useUtils();
  const list = trpc.admin.security.list.useQuery({ limit: 50 }, { enabled: can("security.view") });
  const [reviewing, setReviewing] = useState<number | null>(null);
  const review = trpc.admin.security.review.useMutation({
    onSuccess: () => { toast.success(t("admin.security.reviewed")); void utils.admin.security.list.invalidate(); setReviewing(null); },
    onError: (e) => toast.error(errorText(e)),
  });
  if (!can("security.view")) return <Panel><p className="text-sm text-muted-foreground">{t("admin.noAccess")}</p></Panel>;
  return (
    <Panel title={t("admin.nav.security")}>
      {list.error ? <ErrorNote error={list.error} /> : list.isLoading ? <Loading /> : (
        <ul className="divide-y text-sm">
          {(list.data ?? []).map((ev) => (
            <li key={ev.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
              <span className="min-w-0">
                <span className="mr-2 font-medium">{ev.type}</span>
                <span className="text-xs text-muted-foreground">{fmtDateTime(ev.lastSeenAt)}</span>
              </span>
              <span className="flex items-center gap-2">
                <StatusBadge tone={SEVERITY_TONE[ev.severity] ?? "neutral"}>{ev.severity}</StatusBadge>
                <StatusBadge tone={ev.status === "REVIEW_REQUIRED" ? "warning" : "neutral"}>{ev.status}</StatusBadge>
                {can("security.review") && ev.status === "REVIEW_REQUIRED" && (
                  <Button size="sm" variant="outline" onClick={() => setReviewing(ev.id)}>{t("admin.security.review")}</Button>
                )}
              </span>
            </li>
          ))}
          {!list.data?.length && <li className="py-3 text-muted-foreground">{t("admin.security.empty")}</li>}
        </ul>
      )}
      <ReasonDialog
        open={reviewing !== null}
        onOpenChange={(v) => !v && setReviewing(null)}
        title={t("admin.security.review")}
        pending={review.isPending}
        onConfirm={(reason) => reviewing !== null && review.mutate({ id: reviewing, status: "REVIEWED", reason })}
      />
    </Panel>
  );
}

export default function AdminRoutes() {
  return (
    <AdminLayout>
      <Switch>
        <Route path="/admin" component={AdminDashboardPage} />
        <Route path="/admin/users" component={AdminUsersPage} />
        <Route path="/admin/users/:id" component={AdminUsersPage} />
        <Route path="/admin/teachers/ai-limits" component={AiLimitsPage} />
        <Route path="/admin/teachers">{() => <Redirect to="/admin/teachers/ai-limits" />}</Route>
        <Route path="/admin/ai" component={AiAnalyticsPage} />
        <Route path="/admin/ai/logs" component={AiLogsPage} />
        <Route path="/admin/ai/pricing" component={AiPricingPage} />
        <Route path="/admin/ai/limits" component={AiLimitsPage} />
        <Route path="/admin/storage" component={AdminStoragePage} />
        <Route path="/admin/settings" component={AdminSettingsPage} />
        <Route path="/admin/audit" component={AdminAuditPage} />
        <Route path="/admin/security" component={AdminSecurityPage} />
        <Route path="/admin/announcements" component={AdminAnnouncementsPage} />
        <Route>{() => <Redirect to="/admin" />}</Route>
      </Switch>
    </AdminLayout>
  );
}
