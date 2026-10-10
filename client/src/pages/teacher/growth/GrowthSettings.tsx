import { Loading, Panel } from "@/components/AppShell";
import { Switch } from "@/components/ui/switch";
import { t } from "@/i18n/messages";
import { errorText } from "@/lib/format";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";

type Key = "riskEnabled" | "digestEnabled" | "parentReports";

const ROWS: { key: Key; label: "growth.settings.riskEnabled" | "growth.settings.digestEnabled" | "growth.settings.parentReports"; hint: "growth.settings.riskHint" | "growth.settings.digestHint" | "growth.settings.parentHint" }[] = [
  { key: "riskEnabled", label: "growth.settings.riskEnabled", hint: "growth.settings.riskHint" },
  { key: "digestEnabled", label: "growth.settings.digestEnabled", hint: "growth.settings.digestHint" },
  { key: "parentReports", label: "growth.settings.parentReports", hint: "growth.settings.parentHint" },
];

/** Risk radar and digest on/off, and the teacher's consent for parent reports. Thresholds and weights are fixed. */
export function GrowthSettingsTab() {
  const utils = trpc.useUtils();
  const settings = trpc.teacher.growth.settings.useQuery();
  const update = trpc.teacher.growth.updateSettings.useMutation({
    onSuccess: () => {
      toast.success(t("growth.settings.saved"));
      void utils.teacher.growth.settings.invalidate();
      void utils.teacher.growth.riskList.invalidate();
      void utils.teacher.growth.riskDetail.invalidate();
    },
    onError: (e) => toast.error(errorText(e)),
  });
  if (!settings.data) return <Loading />;
  return (
    <div className="space-y-5">
      <Panel>
        <ul className="divide-y">
          {ROWS.map((row) => (
            <li key={row.key} className="flex items-start justify-between gap-4 py-4">
              <div className="min-w-0">
                <label htmlFor={`growth-${row.key}`} className="font-medium">{t(row.label)}</label>
                <p className="mt-1 text-sm text-muted-foreground">{t(row.hint)}</p>
              </div>
              <Switch
                id={`growth-${row.key}`}
                checked={settings.data[row.key]}
                disabled={update.isPending || (row.key === "digestEnabled" && !settings.data.riskEnabled)}
                onCheckedChange={(checked) => update.mutate({ [row.key]: checked })}
              />
            </li>
          ))}
        </ul>
      </Panel>
      <GroupPractice />
    </div>
  );
}

function GroupPractice() {
  const utils = trpc.useUtils();
  const list = trpc.teacher.growth.groupPractice.useQuery();
  const update = trpc.teacher.growth.setGroupPractice.useMutation({
    onSuccess: () => {
      toast.success(t("growth.settings.saved"));
      void utils.teacher.growth.groupPractice.invalidate();
    },
    onError: (e) => toast.error(errorText(e)),
  });
  if (!list.data) return <Loading />;
  return (
    <Panel title={t("growth.settings.practice")}>
      <p className="mb-3 text-sm text-muted-foreground">{t("growth.settings.practiceHint")}</p>
      {!list.data.length ? (
        <p className="text-sm text-muted-foreground">{t("growth.weak.noGroups")}</p>
      ) : (
        <ul className="divide-y">
          {list.data.map((g) => (
            <li key={g.id} className="flex items-center justify-between gap-4 py-3">
              <label htmlFor={`practice-${g.id}`} className="min-w-0 break-words text-sm">{g.name}</label>
              <Switch id={`practice-${g.id}`} checked={g.selfPractice} disabled={update.isPending} onCheckedChange={(enabled) => update.mutate({ groupId: g.id, enabled })} />
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
