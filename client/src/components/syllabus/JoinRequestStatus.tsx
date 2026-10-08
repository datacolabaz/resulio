import { StatusBadge, type Tone } from "@/components/StatusBadge";
import { t } from "@/i18n/messages";
import type { JoinRequestStatus } from "@shared/syllabusJoin";

const TONE: Record<JoinRequestStatus, Tone> = { PENDING: "warning", ACCEPTED: "success", REJECTED: "danger", CANCELLED: "neutral" };

/** Status of a syllabus join request (public page, student dashboard, teacher list). */
export function JoinRequestStatusBadge({ status }: { status: JoinRequestStatus }) {
  return <StatusBadge tone={TONE[status]}>{t(`sylShare.status.${status}`)}</StatusBadge>;
}
