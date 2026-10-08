import { useI18n } from "@/i18n/locale";
import { trpc } from "@/lib/trpc";
import { syncWebPush, webPushSupported, type WebPushApi } from "@/lib/webPush";
import { useCallback, useEffect, useMemo } from "react";

/**
 * Keeps this browser's push subscription in sync while permission is granted: on load, when the
 * signed-in account changes (sign-in attaches the subscription, sign-out detaches it) and when the
 * language changes. Returns a function that syncs immediately, used right after the user allows.
 */
export function useWebPushSync() {
  const utils = trpc.useUtils();
  const { locale } = useI18n();
  const me = trpc.auth.me.useQuery(undefined, { retry: false, refetchOnWindowFocus: false, enabled: webPushSupported() });
  const userId = me.data?.id ?? null;
  const api = useMemo<WebPushApi>(
    () => ({
      config: () => utils.client.webPush.config.query(),
      subscribe: (input) => utils.client.webPush.subscribe.mutate(input),
    }),
    [utils],
  );

  const sync = useCallback((force = false) => syncWebPush(api, { userId, locale, force }), [api, userId, locale]);

  useEffect(() => {
    if (me.isLoading || !webPushSupported() || Notification.permission !== "granted") return;
    void sync();
  }, [me.isLoading, sync]);

  return sync;
}
