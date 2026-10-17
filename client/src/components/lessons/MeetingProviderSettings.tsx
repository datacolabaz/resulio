import { Panel } from "@/components/AppShell";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n/messages";
import { errorText } from "@/lib/format";
import { trpc } from "@/lib/trpc";
import type { MeetingProvider } from "@shared/lessonIntegration";
import { CheckCircle2, Video, XCircle } from "lucide-react";
import { useEffect } from "react";
import { toast } from "sonner";

const PANEL_ID = "lesson-integration";
const RETURN_TO = "/settings#lesson-integration";

const PROVIDER_LABEL: Record<MeetingProvider, () => string> = {
  GOOGLE_MEET: () => t("lessons.provider.googleMeet"),
  ZOOM: () => t("lessons.provider.zoom"),
};

const PROVIDER_SLUG: Record<MeetingProvider, "google-meet" | "zoom"> = { GOOGLE_MEET: "google-meet", ZOOM: "zoom" };

/** Reads and clears the `?lessonOauth=...&provider=...` the OAuth callback redirects back with. */
function useOAuthCallbackToast(onDone: () => void) {
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const outcome = params.get("lessonOauth");
    if (!outcome) return;
    if (outcome === "connected") toast.success(t("lessons.settings.connectSuccess"));
    else if (outcome === "cancelled") toast(t("lessons.settings.connectCancelled"));
    else toast.error(t("lessons.settings.connectFailed"));
    params.delete("lessonOauth");
    params.delete("provider");
    const search = params.toString();
    window.history.replaceState(null, "", `${window.location.pathname}${search ? `?${search}` : ""}${window.location.hash}`);
    onDone();
    // Only on first mount: this consumes a one-time redirect result.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

/** Settings → "Onlayn dərs platformaları". One row per provider: connect, status, disconnect. */
export function MeetingProviderSettings() {
  const utils = trpc.useUtils();
  const workspace = trpc.teacher.workspace.useQuery();
  const status = trpc.teacher.lessons.connections.status.useQuery();
  useOAuthCallbackToast(() => void utils.teacher.lessons.connections.status.invalidate());
  const disconnect = trpc.teacher.lessons.connections.disconnect.useMutation({
    onSuccess: () => {
      toast.success(t("lessons.settings.disconnected"));
      void utils.teacher.lessons.connections.status.invalidate();
    },
    onError: (e) => toast.error(errorText(e)),
  });

  const connect = (provider: MeetingProvider) => {
    const workspaceId = workspace.data?.id;
    const params = new URLSearchParams({ returnTo: RETURN_TO, ...(workspaceId ? { workspaceId } : {}) });
    window.location.href = `/api/lessons/oauth/${PROVIDER_SLUG[provider]}/start?${params.toString()}`;
  };

  return (
    <Panel id={PANEL_ID} title={t("lessons.settings.title")} className="scroll-mt-20">
      <p className="text-sm text-muted-foreground">{t("lessons.settings.description")}</p>
      <ul className="mt-4 divide-y">
        {(status.data ?? []).map((row) => (
          <li key={row.provider} className="flex flex-wrap items-center justify-between gap-3 py-3">
            <div className="flex min-w-0 items-center gap-3">
              <Video className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden />
              <div className="min-w-0">
                <div className="font-medium">{PROVIDER_LABEL[row.provider]()}</div>
                <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
                  {row.connected ? (
                    <CheckCircle2 className="h-4 w-4 shrink-0 text-success" aria-hidden />
                  ) : (
                    <XCircle className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                  )}
                  <span className="truncate">
                    {row.status === "ERROR"
                      ? t("lessons.settings.errorStatus")
                      : row.connected && row.accountEmail
                        ? t("lessons.settings.connectedAs", { email: row.accountEmail })
                        : row.connected
                          ? t("lessons.settings.connected")
                          : t("lessons.settings.notConnected")}
                  </span>
                </div>
              </div>
            </div>
            {row.connected ? (
              <Button variant="outline" size="sm" disabled={disconnect.isPending} onClick={() => disconnect.mutate({ provider: row.provider })}>
                {t("lessons.settings.disconnect")}
              </Button>
            ) : (
              <Button size="sm" onClick={() => connect(row.provider)}>
                {t("lessons.settings.connect")}
              </Button>
            )}
          </li>
        ))}
      </ul>
    </Panel>
  );
}
