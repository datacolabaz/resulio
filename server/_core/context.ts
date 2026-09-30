import type { CreateExpressContextOptions } from "@trpc/server/adapters/express";
import type { User } from "../../drizzle/schema";
import { sdk, type SessionTimes } from "./sdk";

export type TrpcContext = {
  req: CreateExpressContextOptions["req"];
  res: CreateExpressContextOptions["res"];
  user: User | null;
  /** Token times of the current session; absent for server-side callers such as tests and scripts. */
  session?: SessionTimes | null;
};

export async function createContext(opts: CreateExpressContextOptions): Promise<TrpcContext> {
  try {
    const { user, session } = await sdk.authenticateRequest(opts.req);
    return { req: opts.req, res: opts.res, user, session };
  } catch {
    // Authentication is optional for public procedures.
    return { req: opts.req, res: opts.res, user: null, session: null };
  }
}
