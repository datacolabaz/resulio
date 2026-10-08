import { Panel } from "@/components/AppShell";
import { JoinRequestStatusBadge } from "@/components/syllabus/JoinRequestStatus";
import { t } from "@/i18n/messages";
import { fmtDateTime } from "@/lib/format";
import { trpc } from "@/lib/trpc";
import { Link } from "wouter";

const SHOWN = 5;

/** Student dashboard: the latest course requests sent from public syllabus pages; nothing when there are none. */
export function MyJoinRequests() {
  const q = trpc.student.syllabus.myJoinRequests.useQuery(undefined, { retry: false, staleTime: 60_000 });
  const rows = (q.data ?? []).filter((r) => r.status !== "CANCELLED").slice(0, SHOWN);
  if (!rows.length) return null;
  return (
    <Panel title={t("sylShare.mine.title")}>
      <ul className="divide-y divide-border">
        {rows.map((r) => (
          <li key={r.id} className="flex flex-wrap items-center gap-2 py-2 text-sm">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="break-words font-medium">{r.syllabusTitle}</span>
                <JoinRequestStatusBadge status={r.status} />
              </div>
              <div className="mt-0.5 break-words text-xs text-muted-foreground">
                {[r.type === "GROUP" ? t("sylShare.join.requestGroup", { group: r.groupName ?? "—" }) : t("sylShare.join.requestIndividual"), t("sylShare.join.sentAt", { date: fmtDateTime(r.createdAt) })].join(" · ")}
              </div>
              {r.decisionNote && <div className="mt-0.5 break-words text-xs text-foreground-secondary">{t("sylShare.join.teacherNote", { note: r.decisionNote })}</div>}
            </div>
            {r.path && <Link href={r.path} className="text-sm text-link underline-offset-4 hover:underline">{t("sylShare.mine.open")}</Link>}
          </li>
        ))}
      </ul>
    </Panel>
  );
}
