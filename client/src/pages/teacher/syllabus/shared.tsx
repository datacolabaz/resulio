import { AppShell, EmptyState, ErrorNote, Loading } from "@/components/AppShell";
import { StatusBadge, type Tone } from "@/components/StatusBadge";
import { t, type MessageKey } from "@/i18n/messages";
import { errorText } from "@/lib/format";
import { publishState, type PublishShape, type SyllabusVisibility } from "@/lib/syllabusPublishState";
import { trpc } from "@/lib/trpc";
import type { SyllabusGrantState, SyllabusItemKind } from "@shared/syllabus";
import { BookOpen, ClipboardCheck, FolderOpen, Presentation, SquarePen } from "lucide-react";
import { toast } from "sonner";

export const fieldLabel = "text-foreground-secondary";
export const selectCls = "w-full rounded-lg border border-input bg-card px-3 py-2 text-sm text-foreground";

export const kindLabel = (kind: SyllabusItemKind) => t(`syllabus.kind.${kind}` as MessageKey);

export const KIND_ICON: Record<SyllabusItemKind, typeof BookOpen> = {
  THEORY: BookOpen,
  TEACHER_PRACTICE: Presentation,
  STUDENT_PRACTICE: SquarePen,
  ASSESSMENT: ClipboardCheck,
  RESOURCE: FolderOpen,
};
const SYLLABUS_TONE: Record<string, Tone> = { DRAFT: "neutral", PUBLISHED: "success", ARCHIVED: "neutral" };
export function SyllabusStatusBadge({ status }: { status: string }) {
  return <StatusBadge tone={SYLLABUS_TONE[status] ?? "neutral"}>{t(`syllabus.status.${status}` as MessageKey)}</StatusBadge>;
}

const VISIBILITY_TONE: Record<SyllabusVisibility, Tone> = { HIDDEN: "neutral", READY: "info", LIVE: "success", ARCHIVED: "neutral" };
/** "Not visible to students yet" / "Visible to students" (+ "changes not sent yet"), instead of draft/version jargon. */
export function SyllabusVisibilityBadges({ syllabus, activeGrants }: { syllabus: PublishShape; activeGrants: number | null }) {
  const { visibility, unsentChanges } = publishState(syllabus, activeGrants);
  return (
    <>
      <StatusBadge tone={VISIBILITY_TONE[visibility]}>{t(`syllabus.visibility.${visibility}` as MessageKey)}</StatusBadge>
      {unsentChanges && <StatusBadge tone="info">{t("syllabus.draftChanges")}</StatusBadge>}
    </>
  );
}

export function NodeStatusBadge({ status }: { status: string }) {
  return status === "DRAFT" ? <StatusBadge tone="warning">{t("syllabus.node.DRAFT")}</StatusBadge> : null;
}

const GRANT_TONE: Record<SyllabusGrantState, Tone> = { ACTIVE: "success", PENDING: "info", EXPIRED: "neutral", REVOKED: "danger" };
export function GrantStateBadge({ state }: { state: SyllabusGrantState }) {
  return <StatusBadge tone={GRANT_TONE[state]}>{t(`syllabus.grant.${state}` as MessageKey)}</StatusBadge>;
}

export const problemText = (p: { code: string; title?: string }) => {
  const base = errorText(new Error(p.code));
  return p.title ? `${base} (${p.title})` : base;
};

export const toastError = (e: unknown) => toast.error(errorText(e));

/** Every syllabus page: the teaching shell plus the workspace feature-flag gate. */
export function SyllabusShell({ title, children }: { title?: string; children: React.ReactNode }) {
  const flag = trpc.teacher.syllabus.enabled.useQuery(undefined, { staleTime: 5 * 60_000 });
  return (
    <AppShell area="teaching" title={title ?? t("nav.syllabus")}>
      {flag.isLoading ? (
        <Loading />
      ) : flag.error ? (
        <ErrorNote error={flag.error} />
      ) : !flag.data?.enabled ? (
        <EmptyState title={t("syllabus.unavailable.title")} body={t("syllabus.unavailable.body")} />
      ) : (
        children
      )}
    </AppShell>
  );
}

/** Invalidates the builder queries after any draft write. */
export function useSyllabusRefresh(id: string) {
  const utils = trpc.useUtils();
  return () => {
    void utils.teacher.syllabus.get.invalidate({ id });
    void utils.teacher.syllabus.list.invalidate();
    void utils.teacher.syllabus.publishPreview.invalidate({ id });
    void utils.teacher.syllabus.preview.invalidate({ id });
  };
}

export function useMaterials() {
  const q = trpc.teacher.tasks.materials.useQuery(undefined, { staleTime: 60_000 });
  const list = (q.data ?? []).map((m) => ({ id: m.id, title: m.title, fileId: m.fileId ?? null, url: m.meta.url }));
  return { list, byId: new Map(list.map((m) => [m.id, m])) };
}

export function linesToList(text: string, max = 30): string[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, max);
}
