import { t } from "@/i18n/messages";
import { MinusCircle } from "lucide-react";

export interface PenaltyView {
  ratio: number;
  wrongCount: number;
  closedEarned: number;
  penaltyPoints: number;
}

/** The wrong-answer rule of a result and what it took off; the score shown elsewhere is already net. */
export function ResultPenalty({ penalty }: { penalty: PenaltyView | null | undefined }) {
  if (!penalty) return null;
  return (
    <div className="flex items-start gap-3 rounded-xl border border-warning/40 bg-warning-surface p-3 text-sm text-foreground">
      <MinusCircle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden />
      <div className="space-y-0.5">
        <p className="font-medium">{t("result.penaltyRule", { ratio: penalty.ratio })}</p>
        <p>{t("result.penaltyDeducted", { points: penalty.penaltyPoints, count: penalty.wrongCount })}</p>
        <p className="text-xs text-muted-foreground">{t("result.penaltyClosed", { earned: penalty.closedEarned, net: Math.max(0, Math.round((penalty.closedEarned - penalty.penaltyPoints) * 100) / 100) })}</p>
      </div>
    </div>
  );
}
