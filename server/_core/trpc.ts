import { UNAUTHED_ERR_MSG, WORKSPACE_HEADER } from '@shared/const';
import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import type { AdminPermission } from "../../shared/adminPermissions";
import { partnerProfileOf, resolveWorkspace, workspaceExists } from "../modules/access";
import { authorizeAdmin, type AdminContext } from "../modules/admin/authz";
import { toTrpcError } from "../modules/errors";
import { recordSecurityEvent } from "../modules/securityEvents";
import type { TrpcContext } from "./context";
import { hitRateLimit } from "./rateLimit";
import { requestMeta } from "./requestMeta";

const t = initTRPC.context<TrpcContext>().create({
  transformer: superjson,
});

export const router = t.router;

/** Domain errors (AppError / known codes) become typed tRPC errors; unknown errors are not leaked. */
const domainErrors = t.middleware(async ({ next }) => {
  const result = await next();
  if (!result.ok && result.error.code === "INTERNAL_SERVER_ERROR" && result.error.cause) {
    throw toTrpcError(result.error.cause);
  }
  return result;
});

export const publicProcedure = t.procedure.use(domainErrors);

function refuseSuspended(ctx: TrpcContext, path: string): never {
  recordSecurityEvent({ type: "SUSPENDED_ACCESS", severity: "LOW", userId: ctx.user?.id, ipHash: requestMeta(ctx.req).ipHash, details: { path } });
  throw new TRPCError({ code: "FORBIDDEN", message: "ACCOUNT_SUSPENDED" });
}

/** Signed in and not suspended. auth.me and auth.logout stay public so a suspended user can still see why and sign out. */
const requireUser = t.middleware(async opts => {
  const { ctx, next, path } = opts;

  if (!ctx.user) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: UNAUTHED_ERR_MSG });
  }
  if (ctx.user.accountStatus === "SUSPENDED") refuseSuspended(ctx, path);

  return next({
    ctx: {
      ...ctx,
      user: ctx.user,
    },
  });
});

export const protectedProcedure = publicProcedure.use(requireUser);

/**
 * Teaching authority: the user must own the provider workspace named by the request header
 * (or, without a header, their first workspace). The header alone never grants access.
 */
export const teacherProcedure = protectedProcedure.use(async ({ ctx, next, path }) => {
  const header = ctx.req.headers?.[WORKSPACE_HEADER];
  const requested = typeof header === "string" && header.trim() ? header.trim() : null;
  const workspace = await resolveWorkspace(ctx.user.id, requested);
  if (!workspace) {
    if (requested && (await workspaceExists(requested).catch(() => false))) {
      recordSecurityEvent({
        type: "WORKSPACE_HEADER_SPOOF",
        severity: "MEDIUM",
        userId: ctx.user.id,
        workspaceId: requested,
        ipHash: requestMeta(ctx.req).ipHash,
        details: { path },
      });
    }
    throw new TRPCError({ code: "FORBIDDEN", message: "NO_WORKSPACE" });
  }
  return next({ ctx: { ...ctx, workspace, scope: { workspaceId: workspace.id, userId: ctx.user.id } } });
});

/**
 * Learning procedures act only on the caller's own records; group membership and
 * assignment access are enforced per resource in the attempts/groups modules.
 */
export const studentProcedure = protectedProcedure;

export const partnerProcedure = protectedProcedure.use(async ({ ctx, next }) => {
  const partner = await partnerProfileOf(ctx.user.id);
  if (partner?.status !== "APPROVED") throw new TRPCError({ code: "FORBIDDEN", message: "PARTNER_ONLY" });
  return next({ ctx: { ...ctx, partner } });
});

function limited(ctx: TrpcContext, key: string, limit: number, windowMs: number, name: string) {
  if (!hitRateLimit(key, limit, windowMs)) return;
  recordSecurityEvent({ type: "RATE_LIMIT_BLOCK", severity: "LOW", userId: ctx.user?.id, ipHash: requestMeta(ctx.req).ipHash, details: { limiter: name } });
  throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: "RATE_LIMITED" });
}

/** Fixed-window limit keyed by user (or IP for anonymous calls). */
export const rateLimit = (name: string, limit: number, windowMs: number) =>
  t.middleware(({ ctx, next }) => {
    const who = ctx.user ? `u:${ctx.user.id}` : `ip:${ctx.req.ip ?? "unknown"}`;
    limited(ctx, `${name}:${who}`, limit, windowMs, name);
    return next();
  });

const ADMIN_LIMITS = { query: 120, mutation: 20, subscription: 20 } as const;

/**
 * Platform administration. Every refusal (including anonymous calls) is recorded as a security
 * event; authorization is decided only by authorizeAdmin, never by client-sent values.
 */
export const adminProcedure = (permission: AdminPermission) =>
  publicProcedure.use(async ({ ctx, next, path, type }) => {
    const meta = requestMeta(ctx.req);
    if (!ctx.user) {
      recordSecurityEvent({ type: "ADMIN_ACCESS_DENIED", severity: "LOW", ipHash: meta.ipHash, details: { path, permission, reason: "UNAUTHENTICATED" } });
      throw new TRPCError({ code: "UNAUTHORIZED", message: UNAUTHED_ERR_MSG });
    }
    if (ctx.user.accountStatus === "SUSPENDED") refuseSuspended(ctx, path);
    const decision = await authorizeAdmin(ctx.user, ctx.session, permission);
    if (!decision.ok) {
      recordSecurityEvent({
        type: "ADMIN_ACCESS_DENIED",
        severity: decision.code === "REAUTH_REQUIRED" ? "LOW" : "MEDIUM",
        userId: ctx.user.id,
        ipHash: meta.ipHash,
        details: { path, permission, reason: decision.code },
      });
      throw new TRPCError({ code: "FORBIDDEN", message: decision.code });
    }
    limited(ctx, `admin:${type}:u:${ctx.user.id}`, ADMIN_LIMITS[type], 60_000, `admin:${type}`);
    const admin: AdminContext = { ...decision.admin, meta };
    return next({ ctx: { ...ctx, user: ctx.user, admin } });
  });
