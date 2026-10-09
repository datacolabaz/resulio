import { ErrorNote, Loading, Panel, StatCard } from "@/components/AppShell";
import { StatusBadge } from "@/components/StatusBadge";
import { t } from "@/i18n/messages";
import { fmtDay, fmtNumber } from "@/lib/format";
import { trpc } from "@/lib/trpc";
import { formatFileSize } from "@/lib/uploadFile";
import { Cloud, Database } from "lucide-react";
import { NoAccess, SettingsLink, UsageBar, useAdmin } from "./adminShared";
import { R2MigrationPanel } from "./AdminStorageR2";

type Group = { key: string; count: number; bytes: number };

function GroupList({ title, groups, label, total }: { title: string; groups: Group[]; label: (key: string) => string; total: number }) {
  return (
    <Panel title={title}>
      {!groups.length ? (
        <p className="text-sm text-muted-foreground">{t("admin.storage.empty")}</p>
      ) : (
        <ul className="space-y-3 text-sm">
          {groups.map((g) => (
            <li key={g.key} className="space-y-1">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                <span className="min-w-0 break-words font-medium">{label(g.key)}</span>
                <span className="tabular-nums">{formatFileSize(g.bytes)}</span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                <div className="h-full rounded-full bg-primary" style={{ width: `${total ? (g.bytes / total) * 100 : 0}%` }} />
              </div>
              <div className="text-xs text-muted-foreground">{t("admin.storage.fileCount", { count: fmtNumber(g.count) })}</div>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

export default function AdminStoragePage() {
  const { can } = useAdmin();
  const data = trpc.admin.storage.summary.useQuery(undefined, { enabled: can("storage.view") });
  if (!can("storage.view")) return <NoAccess />;
  if (data.error) return <ErrorNote error={data.error} />;
  if (!data.data) return <Loading />;
  const s = data.data;
  const ratio = s.softQuotaBytes ? s.totalBytes / s.softQuotaBytes : null;

  return (
    <div className="space-y-5">
      <div className="space-y-1.5">
        <h1 className="text-xl font-semibold tracking-tight">{t("admin.nav.storage")}</h1>
        <StatusBadge tone={s.backend.uploadsTo === "r2" ? "info" : "neutral"} icon={s.backend.uploadsTo === "r2" ? Cloud : Database}>
          {s.backend.uploadsTo === "r2" ? t("admin.storage.newFilesR2", { bucket: s.backend.r2Bucket ?? "" }) : t("admin.storage.newFilesDb")}
        </StatusBadge>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <StatCard label={t("admin.storage.total")} value={formatFileSize(s.totalBytes)} hint={t("admin.storage.fileCount", { count: fmtNumber(s.totalFiles) })} />
        <StatCard
          label={t("admin.storage.inDb")}
          value={formatFileSize(s.backend.inDatabase.bytes)}
          hint={
            s.backend.inBoth
              ? `${t("admin.storage.fileCount", { count: fmtNumber(s.backend.inDatabase.count) })} · ${t("admin.storage.alsoInR2", { count: fmtNumber(s.backend.inBoth) })}`
              : t("admin.storage.fileCount", { count: fmtNumber(s.backend.inDatabase.count) })
          }
        />
        <StatCard label={t("admin.storage.inR2")} value={formatFileSize(s.backend.inObjectStore.bytes)} hint={t("admin.storage.fileCount", { count: fmtNumber(s.backend.inObjectStore.count) })} />
      </div>

      <Panel title={t("admin.storage.backend")}>
        <p className="text-sm">
          {s.backend.uploadsTo === "r2" ? t("admin.storage.uploadsToR2", { bucket: s.backend.r2Bucket ?? "" }) : t("admin.storage.uploadsToDb")}
        </p>
        {!s.backend.r2Configured && <p className="mt-2 text-xs text-muted-foreground">{t("admin.storage.r2Off")}</p>}
        <div className="mt-4 space-y-1.5">
          {s.softQuotaBytes ? (
            <>
              <UsageBar ratio={ratio} label={t("admin.storage.softQuota")} />
              <p className="text-xs text-muted-foreground">{t("admin.dash.ofLimit", { used: formatFileSize(s.totalBytes), limit: formatFileSize(s.softQuotaBytes) })}</p>
            </>
          ) : (
            <p className="text-xs text-muted-foreground">{t("admin.dash.noQuota")}</p>
          )}
        </div>
        {can("storage.manage") && (
          <div className="mt-4 border-t pt-4">
            <SettingsLink />
          </div>
        )}
      </Panel>

      <R2MigrationPanel />

      <div className="grid gap-4 lg:grid-cols-2">
        <GroupList title={t("admin.storage.byType")} groups={s.byType} total={s.totalBytes} label={(k) => t(`admin.storage.type.${k as (typeof s.byType)[number]["key"]}`)} />
        <GroupList title={t("admin.storage.byFeature")} groups={s.byFeature} total={s.totalBytes} label={(k) => t(`admin.storage.feature.${k as (typeof s.byFeature)[number]["key"]}`)} />
      </div>

      <Panel title={t("admin.storage.byTeacher")}>
        {!s.byTeacher.length ? <p className="text-sm text-muted-foreground">{t("admin.storage.empty")}</p> : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase text-muted-foreground">
                <tr>
                  <th scope="col" className="py-2 pr-3">{t("admin.limits.teacher")}</th>
                  <th scope="col" className="pr-3 text-right">{t("admin.storage.col.count")}</th>
                  <th scope="col" className="text-right">{t("admin.storage.col.size")}</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {s.byTeacher.map((r) => (
                  <tr key={r.userId}>
                    <td className="py-2 pr-3">
                      <span className="block break-words font-medium">{r.name ?? `#${r.userId}`}</span>
                      {r.email && <span className="block break-all text-xs text-muted-foreground">{r.email}</span>}
                    </td>
                    <td className="pr-3 text-right tabular-nums">{fmtNumber(r.count)}</td>
                    <td className="text-right tabular-nums">{formatFileSize(r.bytes)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel title={t("admin.storage.largest")}>
        {!s.largest.length ? <p className="text-sm text-muted-foreground">{t("admin.storage.empty")}</p> : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[40rem] text-sm">
              <thead className="text-left text-xs uppercase text-muted-foreground">
                <tr>
                  <th scope="col" className="py-2 pr-3">{t("admin.storage.col.file")}</th>
                  <th scope="col" className="pr-3">{t("admin.storage.col.workspace")}</th>
                  <th scope="col" className="pr-3">{t("admin.storage.col.uploadedBy")}</th>
                  <th scope="col" className="pr-3">{t("admin.storage.col.date")}</th>
                  <th scope="col" className="text-right">{t("admin.storage.col.size")}</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {s.largest.map((f) => (
                  <tr key={f.id} className="align-top">
                    <td className="max-w-[16rem] py-2 pr-3">
                      <span className="block truncate font-medium" title={f.fileName}>{f.fileName}</span>
                      <span className="mt-0.5 flex flex-wrap items-center gap-1 text-xs text-muted-foreground" title={f.mimeType}>
                        {t(`admin.storage.type.${f.typeGroup}`)}
                        {f.inObjectStore && <StatusBadge tone="info">{t("admin.storage.inR2")}</StatusBadge>}
                      </span>
                    </td>
                    <td className="max-w-[12rem] truncate pr-3 text-muted-foreground" title={f.workspaceTitle ?? undefined}>{f.workspaceTitle ?? "—"}</td>
                    <td className="max-w-[10rem] truncate pr-3 text-muted-foreground">{f.uploaderName ?? "—"}</td>
                    <td className="whitespace-nowrap pr-3 text-muted-foreground">{fmtDay(f.createdAt)}</td>
                    <td className="whitespace-nowrap text-right tabular-nums">{formatFileSize(f.sizeBytes)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}
