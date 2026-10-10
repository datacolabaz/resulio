import { t } from "@/i18n/messages";
import type { GroupJoinSource } from "@shared/groupJoinSource";

/** Teacher-facing name of how a student joined a group; no record reads as "Unknown". */
export const joinSourceLabel = (via: GroupJoinSource | null | undefined) => t(`joinSource.${via ?? "UNKNOWN"}`);
