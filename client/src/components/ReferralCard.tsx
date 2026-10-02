import { useAuth } from "@/_core/hooks/useAuth";
import { ShareBox } from "@/components/ShareBox";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n/messages";
import { trpc } from "@/lib/trpc";
import { REFERRAL_CARD_SNOOZE_DAYS } from "@shared/const";
import { X } from "lucide-react";
import { toast } from "sonner";

/**
 * "Share Resulio, earn a commission" card, in its two placements:
 * - "onboarding": shown once, ever, right after a teacher's first login; dismissed by any action
 *   (sharing or "not now") and never shown again.
 * - "dashboard": a persistent card on the teacher dashboard, dismissible for REFERRAL_CARD_SNOOZE_DAYS
 *   days at a time; only rendered once the teacher has done something (a group, task or exam) --
 *   the caller decides that and only mounts this component when it should show.
 *
 * Either way: a teacher who isn't an approved partner yet sees an invitation to apply, not a
 * live referral link (this app gates referral codes behind partner approval -- that review step
 * stays in place here, it is not bypassed by this card). No commission/earnings figure is shown
 * anywhere, because this app has no payment system yet to compute one from truthfully.
 */
export function ReferralCard({ variant }: { variant: "onboarding" | "dashboard" }) {
  const { user } = useAuth();
  const partner = trpc.partner.profile.useQuery(undefined, { enabled: !!user });
  const utils = trpc.useUtils();
  const dismissOnboarding = trpc.auth.dismissReferralOnboarding.useMutation({ onSuccess: () => utils.auth.me.invalidate() });
  const dismissCard = trpc.auth.dismissReferralCard.useMutation({ onSuccess: () => utils.auth.me.invalidate() });
  const apply = trpc.partner.requestProfile.useMutation({
    onSuccess: () => {
      toast.success(t("referral.applySent"));
      void utils.partner.profile.invalidate();
    },
  });

  // `partner.data` is legitimately `null` once the query has resolved for a teacher who has
  // never applied to the partner program -- that is the common case this card exists to reach,
  // so only "still loading" (or a fetch error) should suppress rendering, not "no profile yet".
  if (!user || partner.isLoading || !partner.isSuccess) return null;
  if (variant === "onboarding" && user.referralOnboardingSeenAt) return null;
  if (variant === "dashboard") {
    const dismissedAt = user.referralCardDismissedAt ? new Date(user.referralCardDismissedAt).getTime() : null;
    if (dismissedAt && Date.now() - dismissedAt < REFERRAL_CARD_SNOOZE_DAYS * 86_400_000) return null;
  }

  const dismiss = () => (variant === "onboarding" ? dismissOnboarding.mutate() : dismissCard.mutate());
  const status = partner.data?.status;
  const referralCode = status === "APPROVED" ? (partner.data?.referralCode ?? null) : null;

  return (
    <div className="rounded-xl border bg-muted/30 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">{t("referral.cardTitle")}</h3>
          <p className="mt-1 text-sm text-muted-foreground">{t("referral.cardBody")}</p>
        </div>
        <button type="button" onClick={dismiss} aria-label={t("common.dismiss")} className="shrink-0 text-muted-foreground hover:text-foreground">
          <X className="h-4 w-4" aria-hidden />
        </button>
      </div>
      {referralCode ? (
        <div className="mt-3">
          <ShareBox
            path={`/?ref=${referralCode}`}
            fileName={`resulio-referral-${referralCode}`}
            tracking={{ targetType: "REFERRAL", targetId: referralCode, campaign: variant === "onboarding" ? "onboarding" : "dashboard_card" }}
            onAction={dismiss}
          />
        </div>
      ) : status === "PENDING" || status === "INFO_REQUESTED" ? (
        <p className="mt-3 text-sm text-muted-foreground">{t("referral.pending")}</p>
      ) : (
        <div className="mt-3">
          <Button size="sm" disabled={apply.isPending} onClick={() => apply.mutate(undefined)}>{t("referral.apply")}</Button>
        </div>
      )}
    </div>
  );
}
