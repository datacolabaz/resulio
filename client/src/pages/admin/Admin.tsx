import { useAuth } from "@/_core/hooks/useAuth";
import { ErrorNote, LanguageSwitch, Loading, Panel } from "@/components/AppShell";
import { BrandMark } from "@/components/BrandMark";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { StatusBadge, type Tone } from "@/components/StatusBadge";
import { t } from "@/i18n/messages";
import { errorText, fmtDateTime } from "@/lib/format";
import { trpc } from "@/lib/trpc";
import { ADMIN_REASON_MIN, type AdminPermission } from "@shared/adminPermissions";
import { useState } from "react";
import { toast } from "sonner";
import { Link, Redirect, Route, Switch, useLocation } from "wouter";

/**
 * Minimal, functional admin console — list/suspend/unsuspend/revoke-sessions, an audit log
 * reader and a security-event reviewer. The server (adminProcedure) is the only real authority;
 * every check here is a UI convenience to hide controls the server would refuse anyway.
 */
function useAdmin() {
  const { user, loading } = useAuth();
  const can = (p: AdminPermission) => !!user?.admin?.permissions.includes(p);
  return { user, loading, can };
}

function AdminNav() {
  const [location] = useLocation();
  const tabs: Array<[string, string]> = [
    ["/admin/users", t("admin.nav.users")],
    ["/admin/audit", t("admin.nav.audit")],
    ["/admin/security", t("admin.nav.security")],
  ];
  return (
    <nav className="flex flex-wrap gap-1">
      {tabs.map(([href, label]) => (
        <Button key={href} asChild size="sm" variant={location === href ? "default" : "ghost"}>
          <Link href={href}>{label}</Link>
        </Button>
      ))}
    </nav>
  );
}

function AdminShell({ children }: { children: React.ReactNode }) {
  const { user, loading, logout } = useAuth();
  if (loading) return <div className="p-10 text-center text-muted-foreground">{t("app.loading")}</div>;
  if (!user) return <Redirect to={`/?returnTo=${encodeURIComponent("/admin/users")}`} />;
  if (!user.isAdmin) return <Redirect to="/welcome" />;
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b bg-card">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 p-4">
          <div className="flex items-center gap-3">
            <BrandMark size={32} className="rounded-lg" />
            <div>
              <div className="text-sm font-semibold">{t("admin.title")}</div>
              <div className="text-xs text-muted-foreground">{user.name}</div>
            </div>
          </div>
          <AdminNav />
          <div className="flex items-center gap-2">
            <Link href="/welcome" className="text-xs text-link underline-offset-4 hover:underline">{t("admin.backToApp")}</Link>
            <LanguageSwitch />
            <Button variant="outline" size="sm" onClick={() => void logout()}>{t("common.logout")}</Button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-5xl p-4 sm:p-6">{children}</main>
    </div>
  );
}

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

function AdminUsersPage() {
  const { can } = useAdmin();
  const utils = trpc.useUtils();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<number | null>(null);
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
      <Panel title={t("admin.nav.users")}>
        <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("admin.users.searchPlaceholder")} />
        {search.error && <ErrorNote error={search.error} />}
        {search.isLoading ? <Loading /> : (
          <ul className="mt-3 divide-y text-sm">
            {(search.data ?? []).map((u) => (
              <li key={u.id}>
                <button
                  type="button"
                  className="flex w-full flex-wrap items-center justify-between gap-2 py-2 text-left hover:bg-muted/40"
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
    <AdminShell>
      <Switch>
        <Route path="/admin" component={() => <Redirect to="/admin/users" />} />
        <Route path="/admin/users" component={AdminUsersPage} />
        <Route path="/admin/audit" component={AdminAuditPage} />
        <Route path="/admin/security" component={AdminSecurityPage} />
      </Switch>
    </AdminShell>
  );
}
