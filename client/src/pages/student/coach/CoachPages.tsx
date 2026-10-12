import { Panel } from "@/components/AppShell";
import { Switch } from "@/components/ui/switch";
import { t } from "@/i18n/messages";
import { errorText } from "@/lib/format";
import { trpc } from "@/lib/trpc";
import { RECALL_MODES, type RecallMode } from "@shared/coach";
import { toast } from "sonner";
import { CoachLibrary } from "./CoachLibrary";
import { CoachShell, PrivacyNotice, QuotaLine, type CoachStatus } from "./CoachShell";

export { CoachMaterialPage } from "./CoachMaterial";
export { CoachTextEditorPage } from "./CoachTextEditor";

const selectClass = "mt-1 w-full max-w-xs rounded-lg border border-input bg-card px-3 py-2 text-foreground";

/** "/student/coach": the student's own materials. */
export function CoachLibraryPage() {
  return (
    <CoachShell title={t("nav.coach")} intro={t("coach.intro")}>
      {(status) => <CoachLibrary status={status} />}
    </CoachShell>
  );
}

/** "/student/coach/settings": preferences and the privacy notice. */
export function CoachSettingsPage() {
  return (
    <CoachShell title={t("coach.settings.title")} back="/student/coach">
      {(status) => (
        <>
          <CoachPreferences status={status} />
          <PrivacyNotice accepted />
        </>
      )}
    </CoachShell>
  );
}

function CoachPreferences({ status }: { status: CoachStatus }) {
  const utils = trpc.useUtils();
  const save = trpc.student.coach.saveSettings.useMutation({
    onSuccess: () => void utils.student.coach.status.invalidate(),
    onError: (e) => toast.error(errorText(e)),
  });
  return (
    <Panel title={t("coach.settings.preferences")}>
      <div className="space-y-4">
        <label className="block text-sm font-medium">
          {t("coach.settings.recall")}
          <select className={selectClass} value={status.settings.recallMode} disabled={save.isPending} onChange={(e) => save.mutate({ recallMode: e.target.value as RecallMode })}>
            {RECALL_MODES.map((m) => <option key={m} value={m}>{t(`coach.recall.${m}`)}</option>)}
          </select>
          <span className="mt-1 block text-xs font-normal text-muted-foreground">{t("coach.settings.recallHint")}</span>
        </label>
        <label className="flex items-center gap-2 text-sm">
          <Switch checked={status.settings.reminders} disabled={save.isPending} onCheckedChange={(reminders) => save.mutate({ reminders })} />
          {t("coach.settings.reminders")}
        </label>
        <QuotaLine quota={status.quota} />
      </div>
    </Panel>
  );
}
