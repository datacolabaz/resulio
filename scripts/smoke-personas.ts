// Local browser smoke-test personas. Never for production: refuses non-local databases and NODE_ENV=production.
// Creates users covering every context combination, joins them to the seeded demo group (run `pnpm db:seed`
// first) and prints a session cookie per persona, signed with the local SESSION_SECRET of the dev server.
//
// Usage: DATABASE_URL=mysql://...@127.0.0.1:3307/resulio_dev SESSION_SECRET=<dev secret> pnpm exec tsx scripts/smoke-personas.ts
import { and, eq } from "drizzle-orm";
import { groupMembers, groups, partnerProfiles, providerWorkspaces, users } from "../drizzle/schema";
import { sdk } from "../server/_core/sdk";
import { getUserByOpenId, requireDb } from "../server/db";

const url = new URL(process.env.DATABASE_URL ?? "mysql://invalid");
if (!["127.0.0.1", "localhost"].includes(url.hostname) || process.env.NODE_ENV === "production") {
  console.error("smoke-personas only runs against a local development database");
  process.exit(2);
}

type Persona = { openId: string; name: string; workspace?: boolean; member?: boolean; partner?: "APPROVED" | "PENDING" };
const PERSONAS: Persona[] = [
  { openId: "demo-student", name: "Demo Tələbə" },
  { openId: "demo-teacher", name: "Demo Müəllim" },
  { openId: "smoke-both", name: "Smoke Tələbə+Müəllim", workspace: true, member: true },
  { openId: "smoke-all", name: "Smoke Tələbə+Müəllim+Partnyor", workspace: true, member: true, partner: "APPROVED" },
  { openId: "smoke-pending-partner", name: "Smoke Gözləyən Partnyor", member: true, partner: "PENDING" },
  { openId: "smoke-new", name: "Smoke Yeni İstifadəçi" },
];

async function main() {
  const db = requireDb();
  const [demoGroup] = await db
    .select({ id: groups.id })
    .from(groups)
    .innerJoin(providerWorkspaces, eq(providerWorkspaces.id, groups.providerWorkspaceId))
    .innerJoin(users, eq(users.id, providerWorkspaces.ownerUserId))
    .where(eq(users.openId, "demo-teacher"))
    .limit(1);
  if (!demoGroup) throw new Error("Run `pnpm db:seed` first (demo teacher group not found)");

  const out: Record<string, string> = {};
  for (const p of PERSONAS) {
    let user = await getUserByOpenId(p.openId);
    if (!user) {
      await db.insert(users).values({ openId: p.openId, name: p.name, email: `${p.openId}@example.test`, loginMethod: "demo" });
      user = (await getUserByOpenId(p.openId))!;
    }
    if (p.workspace) {
      const id = `ws_smoke_${user.id}`;
      const [ws] = await db.select().from(providerWorkspaces).where(eq(providerWorkspaces.id, id));
      if (!ws) await db.insert(providerWorkspaces).values({ id, ownerUserId: user.id, title: `${p.name} məkanı` });
    }
    if (p.member) {
      const [m] = await db
        .select()
        .from(groupMembers)
        .where(and(eq(groupMembers.groupId, demoGroup.id), eq(groupMembers.userId, user.id)));
      if (!m) await db.insert(groupMembers).values({ groupId: demoGroup.id, userId: user.id, status: "ACTIVE" });
    }
    if (p.partner) {
      const [pp] = await db.select().from(partnerProfiles).where(eq(partnerProfiles.userId, user.id));
      if (!pp) {
        await db.insert(partnerProfiles).values({
          userId: user.id,
          status: p.partner,
          referralCode: `SMOKE${user.id}`,
          approvedAt: p.partner === "APPROVED" ? new Date() : null,
        });
      }
    }
    out[p.openId] = await sdk.createSessionToken(user.openId, { name: user.name ?? "", expiresInMs: 7 * 24 * 3600_000 });
  }
  console.log(JSON.stringify(out, null, 2));
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
