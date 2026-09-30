import { t } from "@/i18n/messages";
import type { RouterOutputs } from "@/lib/trpc";

export type Me = NonNullable<RouterOutputs["auth"]["me"]>;
export type UiContext = "learning" | "teaching" | "partner";

export const CONTEXT_HOME: Record<UiContext, string> = {
  learning: "/student",
  teaching: "/teacher",
  partner: "/partner",
};

export const contextLabel = (ctx: UiContext) => t(`context.${ctx}`);

/** Mirrors the server rule; the server re-checks every request against real records. */
export function canEnter(user: Me, ctx: UiContext) {
  if (ctx === "learning") return user.activeMemberships + user.pendingMemberships > 0;
  return user.contexts[ctx];
}

export function availableContexts(user: Me): UiContext[] {
  return (["learning", "teaching", "partner"] as const).filter((c) => canEnter(user, c));
}

/** Where a signed-in user lands: explicit return path, then last valid context, then onboarding. */
export function entryPath(user: Me, returnTo = "/app") {
  if (returnTo !== "/app") return returnTo;
  return user.defaultContext ? CONTEXT_HOME[user.defaultContext] : "/welcome";
}

const WORKSPACE_KEY = "resulio.workspace";

/** Client hint only: the server verifies that the user owns this workspace. */
export function getActiveWorkspaceId(): string | null {
  try {
    return localStorage.getItem(WORKSPACE_KEY);
  } catch {
    return null;
  }
}

export function setActiveWorkspaceId(id: string | null) {
  try {
    if (id) localStorage.setItem(WORKSPACE_KEY, id);
    else localStorage.removeItem(WORKSPACE_KEY);
  } catch {
    // storage unavailable (private mode): the server falls back to the first owned workspace
  }
}
