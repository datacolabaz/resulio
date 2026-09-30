import type { Tone } from "@/components/StatusBadge";
import { t } from "@/i18n/messages";
import type { ParticipantState } from "@shared/assessment";
import type { LucideIcon } from "lucide-react";
import {
  Archive,
  CalendarClock,
  CheckCircle2,
  Circle,
  Clock,
  Eye,
  Hourglass,
  Lock,
  MinusCircle,
  PauseCircle,
  PencilLine,
  PlayCircle,
  TimerOff,
  XCircle,
} from "lucide-react";

export type StatusStyle = { tone: Tone; icon: LucideIcon };

export const LIVE_STATUS: Record<string, StatusStyle> = {
  DRAFT: { tone: "neutral", icon: PencilLine },
  SCHEDULED: { tone: "info", icon: CalendarClock },
  ACTIVE: { tone: "success", icon: PlayCircle },
  COMPLETED: { tone: "neutral", icon: Lock },
};

export const ITEM_STATUS: Record<string, StatusStyle> = {
  CORRECT: { tone: "success", icon: CheckCircle2 },
  WRONG: { tone: "danger", icon: XCircle },
  UNANSWERED: { tone: "neutral", icon: MinusCircle },
  PENDING_REVIEW: { tone: "warning", icon: Clock },
};

export const VERSION_STATUS: Record<string, StatusStyle> = {
  PUBLISHED: { tone: "success", icon: CheckCircle2 },
  ARCHIVED: { tone: "neutral", icon: Archive },
};

/**
 * Teacher-facing participant states. Wording never claims abandonment: an open session with no
 * recent activity is "inactive", because the system cannot tell a crash from a pause.
 */
export const PARTICIPANT_STATUS: Record<ParticipantState, StatusStyle> = {
  INACTIVE: { tone: "warning", icon: PauseCircle },
  IN_PROGRESS: { tone: "info", icon: PlayCircle },
  PENDING_REVIEW: { tone: "warning", icon: Clock },
  COMPLETED: { tone: "success", icon: CheckCircle2 },
  AUTO_SUBMITTED: { tone: "neutral", icon: Hourglass },
  EXPIRED_NO_ANSWERS: { tone: "danger", icon: TimerOff },
  VIEWED: { tone: "neutral", icon: Eye },
  NOT_STARTED: { tone: "neutral", icon: Circle },
};

export const participantLabel = (s: ParticipantState) => t(`participant.${s}`);

export const liveStatus = (s: string): StatusStyle => LIVE_STATUS[s] ?? LIVE_STATUS.DRAFT;
export const itemStatus = (s: string): StatusStyle => ITEM_STATUS[s] ?? ITEM_STATUS.UNANSWERED;
