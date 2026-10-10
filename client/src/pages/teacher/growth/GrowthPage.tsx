import { AppShell, EmptyState, Loading } from "@/components/AppShell";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { t } from "@/i18n/messages";
import { errorText } from "@/lib/format";
import { trpc } from "@/lib/trpc";
import { RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { TopicMappingTab } from "./TopicMapping";
import { WeaknessMapTab } from "./WeaknessMap";
import { RiskRadarTab } from "./RiskRadar";
import { GrowthSettingsTab } from "./GrowthSettings";

/** Teacher Growth Engine page; the nav item and this page show only while the `growth_engine` flag is on. */
export function GrowthPage() {
  const flag = trpc.teacher.growth.enabled.useQuery(undefined, { staleTime: 5 * 60_000 });
  return (
    <AppShell area="teaching">
      {!flag.data ? (
        <Loading />
      ) : !flag.data.enabled ? (
        <EmptyState title={t("nav.growth")} body={t("error.GROWTH_NOT_AVAILABLE")} />
      ) : (
        <Tabs defaultValue="risk" className="min-h-screen">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <TabsList className="h-auto flex-wrap">
              <TabsTrigger value="risk">{t("growth.tab.risk")}</TabsTrigger>
              <TabsTrigger value="weakness">{t("growth.tab.weakness")}</TabsTrigger>
              <TabsTrigger value="topics">{t("growth.tab.topics")}</TabsTrigger>
              <TabsTrigger value="settings">{t("growth.tab.settings")}</TabsTrigger>
            </TabsList>
            <RecomputeButton />
          </div>
          <TabsContent value="risk" className="pt-3"><RiskRadarTab /></TabsContent>
          <TabsContent value="weakness" className="pt-3"><WeaknessMapTab /></TabsContent>
          <TabsContent value="topics" className="pt-3"><TopicMappingTab /></TabsContent>
          <TabsContent value="settings" className="pt-3"><GrowthSettingsTab /></TabsContent>
        </Tabs>
      )}
    </AppShell>
  );
}

function RecomputeButton() {
  const recompute = trpc.teacher.growth.recompute.useMutation({
    onSuccess: (r) => toast.success(t("growth.recomputeQueued", { count: r.queued })),
    onError: (e) => toast.error(errorText(e)),
  });
  return (
    <Button variant="outline" size="sm" disabled={recompute.isPending} onClick={() => recompute.mutate()}>
      <RefreshCw className="mr-1.5 h-4 w-4" aria-hidden />
      {t("growth.recompute")}
    </Button>
  );
}
