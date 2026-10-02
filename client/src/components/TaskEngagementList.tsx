import { StatusBadge } from "@/components/StatusBadge";
import { t } from "@/i18n/messages";
import { fmtDateTime, shareChannelLabel } from "@/lib/format";
import type { RouterOutputs } from "@/lib/trpc";

type Engagement = RouterOutputs["teacher"]["tasks"]["engagement"];

/**
 * Per-student view of one task, "Drive-style": which channel each identified student came through,
 * when they first opened it, how many times they downloaded its files, and whether they submitted.
 * Visitors who never signed in can't be named, so they're summarised in one aggregate line.
 */
export function TaskEngagementList({ data }: { data: Engagement | undefined }) {
  if (!data) return null;
  const { students, anonymous, accessMode } = data;
  const restricted = accessMode === "GROUPS";
  const active = students.filter((s) => s.openedAt || s.downloadCount > 0 || s.submittedAt || s.joinedAt);
  // In restricted mode the roster is exactly the selected groups' members, so these are the ones still to reach.
  const notOpened = restricted ? students.filter((s) => s.onRoster && !s.openedAt && !s.downloadCount && !s.submittedAt) : [];
  return (
    <div className="mt-3 rounded-lg border bg-muted/30 p-3">
      <h4 className="text-xs font-medium text-foreground-secondary">{t("modules.engagementTitle")}</h4>
      {!active.length && <p className="mt-1 text-xs text-muted-foreground">{t("modules.engagementEmpty")}</p>}
      {notOpened.length > 0 && (
        <div className="mt-2 text-xs">
          <p className="font-medium text-foreground-secondary">{t("modules.engagementNotOpenedMembers", { count: notOpened.length })}</p>
          <p className="mt-0.5 break-words text-muted-foreground">{notOpened.map((s) => s.name ?? s.email ?? `#${s.studentId}`).join(", ")}</p>
        </div>
      )}
      {students.length > 0 && (
        <div className="overflow-x-auto">
          <table className="mt-2 w-full text-xs">
            <thead>
              <tr className="text-left text-muted-foreground">
                <th className="py-1 pr-2 font-normal">{t("common.student")}</th>
                <th className="py-1 pr-2 font-normal">{t("share.funnelChannel")}</th>
                <th className="py-1 pr-2 font-normal">{t("modules.engagementOpened")}</th>
                <th className="py-1 pr-2 font-normal">{t("modules.engagementDownloads")}</th>
                <th className="py-1 font-normal">{t("modules.engagementSubmission")}</th>
              </tr>
            </thead>
            <tbody>
              {students.map((s) => (
                <tr key={s.studentId} className="border-t border-border/60 align-top">
                  <td className="py-1.5 pr-2">
                    <div className="min-w-0 break-words font-medium">{s.name ?? s.email ?? `#${s.studentId}`}</div>
                    {!s.onRoster && (
                      <div className={restricted ? "text-destructive" : "text-muted-foreground"}>
                        {restricted ? t("modules.engagementNoAccess") : t("modules.engagementViaLink")}
                      </div>
                    )}
                  </td>
                  <td className="py-1.5 pr-2">{s.channel ? shareChannelLabel(s.channel) : s.openedAt ? t("modules.engagementDashboard") : "—"}</td>
                  <td className="py-1.5 pr-2">
                    {s.openedAt ? (
                      <>
                        <div>{fmtDateTime(s.openedAt)}</div>
                        {s.openCount > 1 && <div className="text-muted-foreground">{t("modules.engagementOpenCount", { count: s.openCount })}</div>}
                      </>
                    ) : (
                      <span className="text-muted-foreground">{t("modules.notViewedShort")}</span>
                    )}
                  </td>
                  <td className="py-1.5 pr-2" title={s.lastDownloadAt ? t("modules.engagementLastDownload", { date: fmtDateTime(s.lastDownloadAt) }) : undefined}>
                    {s.downloadCount}
                  </td>
                  <td className="py-1.5">
                    {s.submittedAt ? (
                      <>
                        {s.submissionStatus === "LATE" ? <StatusBadge tone="warning">{t("student.late")}</StatusBadge> : <StatusBadge tone="success">{t("student.onTime")}</StatusBadge>}
                        <div className="mt-0.5 text-muted-foreground">{fmtDateTime(s.submittedAt)}</div>
                      </>
                    ) : (
                      <StatusBadge tone="neutral">{t("modules.engagementNotSubmitted")}</StatusBadge>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {(anonymous.opens > 0 || anonymous.downloads > 0) && (
        <p className="mt-2 text-xs text-muted-foreground">
          {t("modules.engagementAnonymous", { visitors: anonymous.visitors, opens: anonymous.opens, downloads: anonymous.downloads })}
        </p>
      )}
    </div>
  );
}
