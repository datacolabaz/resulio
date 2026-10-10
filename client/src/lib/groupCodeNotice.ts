import type { JoinPolicy } from "@shared/groupJoinPolicy";

export type GroupCodeNotice = "OPEN" | "APPROVAL" | "LIMIT_REACHED" | "SELF_JOIN_OFF" | "CODE_OFF";

/**
 * Which explanation the invite dialog shows beside the group code/link. Mirrors the order of the
 * server's `inviteCodeRejection`, so the text never promises a join the link would refuse.
 */
export function groupCodeNotice(
  group: {
    joinPolicy: JoinPolicy;
    codeActive: boolean;
    codeExpiresAt: string | Date | null;
    codeUsage: { uses: number; maxUses: number | null };
  },
  now = new Date(),
): GroupCodeNotice {
  if (!group.codeActive) return "CODE_OFF";
  if (group.codeExpiresAt && new Date(group.codeExpiresAt).getTime() <= now.getTime()) return "CODE_OFF";
  if (group.joinPolicy === "MANUAL") return "SELF_JOIN_OFF";
  const { uses, maxUses } = group.codeUsage;
  if (maxUses !== null && uses >= maxUses) return "LIMIT_REACHED";
  return group.joinPolicy === "APPROVAL" ? "APPROVAL" : "OPEN";
}
