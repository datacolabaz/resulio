import { useAuth } from "@/_core/hooks/useAuth";
import { ShareBox } from "@/components/ShareBox";
import { t } from "@/i18n/messages";
import { trpc } from "@/lib/trpc";
import { REFERRAL_CARD_SNOOZE_DAYS } from "@shared/const";
import { X } from "lucide-react";

/**
 * "Share Resulio, earn a commission" card, in its two placements:
 * - "onboarding": shown once, ever, right after first login; dismissed by any action (sharing or
 *   "not now") and never shown again.
 * - "dashboard": a persistent card, dismissible for REFERRAL_CARD_SNOOZE_DAYS days at a time; only
 *   rendered once the teacher has done something (a group, task or exam) -- the caller decides
 *   that and only mounts this component when it should show.
 *
 * Every user is auto-provisioned a referral link the moment they're looked up (see
 * `ensurePartnerProfile` on the server) -- there's no apply/review step before someone can share
 * it. An admin can still suspend an individual account after the fact if it's abused; that's the
 * only case where `status` isn't APPROVED here, and this card just stays quiet for that account.
 * No commission/earnings figure is shown anywhere, because this app has no payment system yet to
 * compute one from truthfully.
 */
export function ReferralCard({ variant }: { variant: "onboarding" | "dashboard" }) {
  const { user } = useAuth();
  const partner = trpc.partner.profile.useQuery(undefined, { enabled: !!user });
  const utils = trpc.useUtils();
  const dismissOnboarding = trpc.auth.dismissReferralOnboarding.useMutation({ onSuccess: () => utils.auth.me.invalidate() });
  const dismissCard = trpc.auth.dismissReferralCard.useMutation({ onSuccess: () => utils.auth.me.invalidate() });

  if (!user || partner.isLoading || !partner.isSuccess || !partner.data.referralCode) return null;
  if (variant === "onboarding" && user.referralOnboardingSeenAt) return null;
  if (variant === "dashboard") {
    const dismissedAt = user.referralCardDismissedAt ? new Date(user.referralCardDismissedAt).getTime() : null;
    if (dismissedAt && Date.now() - dismissedAt < REFERRAL_CARD_SNOOZE_DAYS * 86_400_000) return null;
  }

  const dismiss = () => (variant === "onboarding" ? dismissOnboarding.mutate() : dismissCard.mutate());
  const referralCode = partner.data.referralCode;

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
      <div className="mt-3">
        <ShareBox
          path={`/?ref=${referralCode}`}
          fileName={`resulio-referral-${referralCode}`}
          tracking={{ targetType: "REFERRAL", targetId: referralCode, campaign: variant === "onboarding" ? "onboarding" : "dashboard_card" }}
          onAction={dismiss}
        />
      </div>
    </div>
  );
}
