import { useAuth } from "@/_core/hooks/useAuth";
import { ErrorNote, LanguageSwitch, Loading, ThemeToggle } from "@/components/AppShell";
import { BrandMark } from "@/components/BrandMark";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n/messages";
import { errorText } from "@/lib/format";
import { trpc } from "@/lib/trpc";
import { MCP_CONSENT_PATH, type McpScope } from "@shared/mcpConnector";
import { useState } from "react";
import { toast } from "sonner";
import { Link, Redirect, useSearch } from "wouter";

function ConsentCard({ children }: { children: React.ReactNode }) {
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

const selectCls = "h-10 w-full rounded-md border border-input bg-background px-3 text-sm";

/** /connect/claude?request=…: the OAuth consent screen the authorization endpoint sends the teacher to. */
export default function ConnectClaudePage() {
  const { user, loading } = useAuth();
  const request = new URLSearchParams(useSearch()).get("request") ?? "";
  const consent = trpc.mcpConnector.consent.useQuery({ request }, { enabled: Boolean(user) && request.length > 0 && request.length <= 64, retry: false });
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);
  const leave = (r: { redirectTo: string }) => {
    setLeaving(true);
    window.location.assign(r.redirectTo);
  };
  const approve = trpc.mcpConnector.approve.useMutation({ onSuccess: leave, onError: (e) => toast.error(errorText(e)) });
  const deny = trpc.mcpConnector.deny.useMutation({ onSuccess: leave, onError: (e) => toast.error(errorText(e)) });

  if (loading) return <Loading />;
  if (!user) return <Redirect to={`/?returnTo=${encodeURIComponent(`${MCP_CONSENT_PATH}?request=${encodeURIComponent(request)}`)}`} />;
  const d = consent.data;
  const busy = approve.isPending || deny.isPending || leaving;
  const chosen = workspaceId ?? d?.workspaces[0]?.id ?? null;

  return (
    <ConsentCard>
      {!request || consent.error?.message === "OAUTH_REQUEST_INVALID" ? (
        <p role="alert" className="mt-5 text-sm text-destructive">{t("connector.consent.invalid")}</p>
      ) : consent.error ? (
        <div className="mt-5">
          <ErrorNote error={consent.error} />
        </div>
      ) : !d ? (
        <Loading />
      ) : leaving ? (
        <p role="status" className="mt-5 text-sm text-muted-foreground">{t("connector.consent.redirecting")}</p>
      ) : !d.isTeacher ? (
        <p role="alert" className="mt-5 text-sm">{t("connector.consent.notTeacher")}</p>
      ) : d.entitlement.status !== "ACTIVE" ? (
        <div className="mt-5 space-y-3 text-sm">
          <p className="font-medium">{d.entitlement.status === "EXPIRED" ? t("connector.consent.expired") : t("connector.consent.notActive")}</p>
          <p className="text-muted-foreground">{t("connector.premiumNote")}</p>
          <div className="flex flex-wrap gap-2">
            <Button asChild>
              <Link href="/settings">{t("connector.consent.openSettings")}</Link>
            </Button>
            <Button variant="outline" disabled={busy} onClick={() => deny.mutate({ request })}>{t("connector.consent.deny")}</Button>
          </div>
        </div>
      ) : (
        <div className="mt-5 space-y-4">
          <h1 className="break-words text-xl font-semibold">{t("connector.consent.title", { client: d.clientName })}</h1>
          <div className="text-sm">
            <div className="font-medium">{t("connector.consent.scopesTitle")}</div>
            <ul className="mt-2 list-disc space-y-1 pl-5">
              {d.scopes.map((s: McpScope) => <li key={s}>{t(`connector.scope.${s}`)}</li>)}
            </ul>
          </div>
          {d.workspaces.length > 1 && (
            <label className="block space-y-1 text-sm">
              <span className="font-medium">{t("connector.consent.workspace")}</span>
              <select className={selectCls} value={chosen ?? ""} onChange={(e) => setWorkspaceId(e.target.value)}>
                {d.workspaces.map((w) => <option key={w.id} value={w.id}>{w.title}</option>)}
              </select>
            </label>
          )}
          <p className="text-xs text-muted-foreground">{t("connector.consent.noDelete")}</p>
          <p className="break-words text-xs text-muted-foreground">{t("connector.consent.redirect", { host: d.redirectHost })}</p>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button className="sm:flex-1" disabled={busy} onClick={() => approve.mutate({ request, workspaceId: chosen })}>{t("connector.consent.approve")}</Button>
            <Button variant="outline" className="sm:flex-1" disabled={busy} onClick={() => deny.mutate({ request })}>{t("connector.consent.deny")}</Button>
          </div>
        </div>
      )}
    </ConsentCard>
  );
}
