import { t } from "@/i18n/messages";
import { trpc } from "@/lib/trpc";
import { Sparkles } from "lucide-react";
import { Link } from "wouter";

/** Student home: topics due for review in the AI Study Coach (only with reminders on). */
export function CoachHomeCard() {
  const q = trpc.student.coach.review.home.useQuery(undefined, { staleTime: 60_000, retry: false });
  const s = q.data;
  if (!s || (!s.due && !s.openMistakes)) return null;
  return (
    <Link href="/student/coach" className="flex items-start gap-3 rounded-2xl border border-info/40 bg-info-surface p-4 hover:border-link">
      <Sparkles className="mt-0.5 h-5 w-5 shrink-0 text-info" aria-hidden />
      <span className="min-w-0">
        <span className="block font-medium">{t("coach.home.title")}</span>
        <span className="block text-sm text-muted-foreground">
          {[s.due ? t("coach.home.due", { count: s.due }) : "", s.openMistakes ? t("coach.home.mistakes", { count: s.openMistakes }) : ""].filter(Boolean).join(" · ")}
        </span>
      </span>
    </Link>
  );
}
