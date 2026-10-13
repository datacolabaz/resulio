import { useAuth } from "@/_core/hooks/useAuth";
import type { UiContext } from "@/lib/contexts";
import { trpc } from "@/lib/trpc";
import { addMarks, freshEntries, mergeMarks, type LocalMarks, type MarkKind, type WhatsNewAvailability, type WhatsNewEntry } from "@shared/whatsNew";
import { useCallback, useMemo, useSyncExternalStore } from "react";

const STORAGE_PREFIX = "resulio.whatsNew.";
const FLAG_STALE = 5 * 60_000;
const EMPTY: LocalMarks = {};

// One store per owner ("u<id>" or "landing"), shared by every component on the page.
const cache = new Map<string, LocalMarks>();
const listeners = new Set<() => void>();

function readMarks(owner: string): LocalMarks {
  if (!cache.has(owner)) {
    let marks = EMPTY;
    try {
      const raw = JSON.parse(window.localStorage.getItem(STORAGE_PREFIX + owner) ?? "{}");
      if (raw && typeof raw === "object" && !Array.isArray(raw)) marks = raw as LocalMarks;
    } catch {
      // Private mode or a corrupt value: start empty.
    }
    cache.set(owner, marks);
  }
  return cache.get(owner)!;
}

export function writeLocalMarks(owner: string, ids: readonly string[], kind: MarkKind, now = Date.now()) {
  const next = addMarks(readMarks(owner), ids, kind, now);
  cache.set(owner, next);
  try {
    window.localStorage.setItem(STORAGE_PREFIX + owner, JSON.stringify(next));
  } catch {
    // Storage full or blocked: the marks still hold for this page view.
  }
  listeners.forEach((l) => l());
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

export function useLocalMarks(owner: string): LocalMarks {
  return useSyncExternalStore(subscribe, () => readMarks(owner), () => EMPTY);
}

/** Which gated features this user can open, from the same queries the sidebar already makes (one shared cache). */
export function useWhatsNewAvailability(area?: UiContext): WhatsNewAvailability {
  const { user } = useAuth();
  const learning = area === "learning";
  const teaching = area === "teaching";
  const coach = trpc.student.coach.enabled.useQuery(undefined, { enabled: learning, staleTime: FLAG_STALE });
  const studentGrowth = trpc.student.growth.enabled.useQuery(undefined, { enabled: learning, staleTime: FLAG_STALE });
  const teacherGrowth = trpc.teacher.growth.enabled.useQuery(undefined, { enabled: teaching, staleTime: FLAG_STALE });
  const shares = trpc.teacher.coachShares.list.useQuery(undefined, { enabled: teaching, staleTime: FLAG_STALE, retry: false });
  const mcp = trpc.mcpConnector.status.useQuery(undefined, { enabled: !!user?.workspaces.length, staleTime: FLAG_STALE, retry: false });
  const studyCoach = learning && !!coach.data?.enabled;
  const sGrowth = learning && !!studentGrowth.data?.enabled;
  const tGrowth = teaching && !!teacherGrowth.data?.enabled;
  const coachShares = teaching && !!shares.data?.length;
  const mcpConnector = mcp.data?.entitlement.status === "ACTIVE";
  return useMemo(
    () => ({ studyCoach, studentGrowth: sGrowth, teacherGrowth: tGrowth, coachShares, mcpConnector }),
    [studyCoach, sGrowth, tGrowth, coachShares, mcpConnector],
  );
}

/**
 * Fresh "Yeniliklər" entries of both in-app audiences for the signed-in user (callers pick theirs),
 * plus the two marks. Nothing is fresh until the user's marks have loaded, so badges never flash.
 */
export function useWhatsNew(area?: UiContext): { fresh: WhatsNewEntry[]; markSeen: (ids: string[]) => void; dismiss: (ids: string[]) => void } {
  const { user } = useAuth();
  const available = useWhatsNewAvailability(area);
  const owner = user ? `u${user.id}` : "landing";
  const local = useLocalMarks(owner);
  const server = trpc.whatsNew.state.useQuery(undefined, { enabled: !!user, staleTime: FLAG_STALE, retry: false, refetchOnWindowFocus: false });
  const settled = !!user && (server.isFetched || server.isError);
  const serverReady = server.data?.ready === true;
  const sendSeen = trpc.whatsNew.markSeen.useMutation().mutate;
  const sendDismiss = trpc.whatsNew.dismiss.useMutation().mutate;

  const fresh = useMemo(
    () => (settled ? freshEntries(["student", "teacher"], { now: new Date(), available, state: mergeMarks(local, server.data?.items) }) : []),
    [settled, available, local, server.data],
  );

  const mark = useCallback(
    (ids: string[], kind: MarkKind) => {
      if (!ids.length) return;
      writeLocalMarks(owner, ids, kind);
      if (serverReady) (kind === "seen" ? sendSeen : sendDismiss)({ ids });
    },
    [owner, serverReady, sendSeen, sendDismiss],
  );

  return { fresh, markSeen: useCallback((ids) => mark(ids, "seen"), [mark]), dismiss: useCallback((ids) => mark(ids, "dismissed"), [mark]) };
}
