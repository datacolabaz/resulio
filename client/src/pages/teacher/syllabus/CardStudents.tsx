import { ChoiceChip, ErrorNote, Loading } from "@/components/AppShell";
import { StatusBadge } from "@/components/StatusBadge";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useIsMobile } from "@/hooks/useMobile";
import { t } from "@/i18n/messages";
import { fmtDateTime, fmtRelative } from "@/lib/format";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { ProgressBar } from "@/pages/student/syllabus/common";
import { ChevronRight } from "lucide-react";
import { useRef, useState } from "react";
import { Link } from "wouter";
import { GrantStateBadge } from "./shared";

type SyllabusRow = RouterOutputs["teacher"]["syllabus"]["list"][number];
type Roster = RouterOutputs["teacher"]["syllabus"]["roster"];
type RosterRow = Roster["students"][number];
type Sort = "progress" | "activity";
const SORTS: Sort[] = ["progress", "activity"];

/** The tracking tab, scrolled to its student table. */
export const trackingPath = (syllabusId: string) => `/teacher/syllabus/${encodeURIComponent(syllabusId)}?tab=analytics&focus=students`;

function sourceText(r: RosterRow) {
  return [...r.groups, ...(r.individual ? [t("syllabus.roster.individual")] : [])].join(", ") || "—";
}

function Row({ r }: { r: RosterRow }) {
  return (
    <li className="flex items-start gap-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="break-words text-sm font-medium">{r.name}</span>
          {r.access === "NONE" ? <StatusBadge tone="neutral">{t("syllabus.roster.noAccess")}</StatusBadge> : <GrantStateBadge state={r.access} />}
        </div>
        <div className="break-words text-xs text-muted-foreground">
          {sourceText(r)}
          {" · "}
          {r.progressPct === null ? (
            t("syllabus.roster.notOpened")
          ) : r.lastActivityAt ? (
            <span title={fmtDateTime(r.lastActivityAt)}>{t("learn.lastActivity", { when: fmtRelative(r.lastActivityAt) })}</span>
          ) : null}
        </div>
      </div>
      {r.progressPct !== null && (
        <div className="w-16 shrink-0 space-y-1 pt-0.5 text-right">
          <div className="text-xs font-semibold tabular-nums">{r.progressPct}%</div>
          <ProgressBar value={r.progressPct} label={t("sa.col.progress")} />
        </div>
      )}
    </li>
  );
}

/** Mounted only while the popover/sheet is open, so the list page never loads the students. */
function RosterPanel({ s, onNavigate }: { s: SyllabusRow; onNavigate: () => void }) {
  const [sort, setSort] = useState<Sort>("progress");
  const q = trpc.teacher.syllabus.roster.useQuery({ id: s.id, sort }, { staleTime: 30_000, placeholderData: (prev) => prev });
  const sum = q.data?.summary ?? s.roster;
  const rows = q.data?.students ?? [];
  const more = sum.total - rows.length;
  return (
    <div className="space-y-2">
      <p className="text-xs text-foreground-secondary">{t("syllabus.roster.summary", { active: sum.students, pending: sum.pending, ended: sum.ended })}</p>
      <p className="text-xs text-muted-foreground">{t("syllabus.card.studentsHint")}</p>
      <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={t("syllabus.roster.sort")}>
        {SORTS.map((k) => (
          <ChoiceChip key={k} selected={sort === k} onClick={() => setSort(k)} className="px-2.5 py-1 text-xs">
            {t(`syllabus.roster.sort.${k}`)}
          </ChoiceChip>
        ))}
      </div>
      {q.error ? (
        <ErrorNote error={q.error} />
      ) : !q.data ? (
        <Loading />
      ) : !rows.length ? (
        <p className="py-2 text-sm text-muted-foreground">{t("syllabus.roster.empty")}</p>
      ) : (
        <ul className="max-h-80 divide-y divide-border overflow-y-auto overscroll-contain pr-1" aria-busy={q.isFetching}>
          {rows.map((r) => (
            <Row key={r.studentId} r={r} />
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-2 text-xs">
        <span className="text-muted-foreground">{more > 0 ? t("syllabus.roster.more", { count: more }) : ""}</span>
        <Link href={trackingPath(s.id)} onClick={onNavigate} className="inline-flex items-center gap-1 font-medium text-link hover:underline">
          {t("syllabus.roster.viewAll")}
          <ChevronRight className="h-3.5 w-3.5" aria-hidden />
        </Link>
      </div>
    </div>
  );
}

/**
 * The counts under a syllabus card. Sources (groups / individual), students and average progress
 * open the list of who they are: a popover on desktop, a bottom sheet on phones.
 */
export function CardStats({ s }: { s: SyllabusRow }) {
  const mobile = useIsMobile();
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLButtonElement | null>(null);
  const r = s.roster;
  const clickable = r.total > 0;
  const stat = (label: string, hint: string) =>
    clickable ? (
      <button
        type="button"
        title={hint}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={(e) => {
          opener.current = e.currentTarget;
          setOpen(true);
        }}
        className="rounded-sm underline decoration-dotted underline-offset-4 hover:text-foreground hover:decoration-solid focus-visible:outline-2 focus-visible:outline-link"
      >
        {label}
      </button>
    ) : (
      <span title={hint}>{label}</span>
    );
  const row = (
    <div className="flex flex-wrap gap-x-4 gap-y-1 px-4 pb-4 text-xs text-foreground-secondary">
      <span>{t("syllabus.count.modules", { count: s.moduleCount })}</span>
      <span>{t("syllabus.count.lessons", { count: s.lessonCount })}</span>
      {r.groups > 0 && stat(t("syllabus.card.groups", { count: r.groups }), t("syllabus.card.groupsHint"))}
      {r.individual > 0 && stat(t("syllabus.card.individual", { count: r.individual }), t("syllabus.card.individualHint"))}
      {stat(t("syllabus.card.students", { count: r.students }), t("syllabus.card.studentsHint"))}
      {r.enrolled > 0 && stat(t("syllabus.count.avgProgress", { pct: r.averageProgressPct }), t("syllabus.card.progressHint"))}
    </div>
  );
  const title = t("syllabus.card.showStudents", { title: s.title });
  const close = () => setOpen(false);

  if (mobile) {
    return (
      <>
        {row}
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetContent side="bottom" className="max-h-[85dvh] rounded-t-2xl" aria-describedby={undefined}>
            <SheetHeader className="pb-0 pr-10">
              <SheetTitle className="break-words">{s.title}</SheetTitle>
            </SheetHeader>
            <div className="px-4 pb-6">{open && <RosterPanel s={s} onNavigate={close} />}</div>
          </SheetContent>
        </Sheet>
      </>
    );
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverAnchor asChild>{row}</PopoverAnchor>
      <PopoverContent
        align="start"
        side="bottom"
        className="w-96 max-w-[calc(100vw-2rem)] rounded-2xl p-3 shadow-overlay"
        aria-label={title}
        onCloseAutoFocus={(e) => {
          e.preventDefault();
          opener.current?.focus();
        }}
      >
        <div className="mb-1 break-words font-semibold">{s.title}</div>
        {open && <RosterPanel s={s} onNavigate={close} />}
      </PopoverContent>
    </Popover>
  );
}
