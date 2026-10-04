import { Pill } from "@/components/AppShell";
import { t, type MessageKey } from "@/i18n/messages";
import { difficultyLabel, fmtDateTime } from "@/lib/format";
import { safeHref } from "@/lib/syllabus";
import { fileDownloadUrl } from "@/lib/uploadFile";
import type { SyllabusItemKind } from "@shared/syllabus";
import { Download, ExternalLink, FolderOpen, Lightbulb } from "lucide-react";
import { useState } from "react";
import { Markdown, TheoryView, type MaterialRef, type VideoSignal } from "./TheoryView";

type Content = Record<string, unknown>;
const str = (c: Content, k: string) => (typeof c[k] === "string" ? (c[k] as string) : "");
const list = (c: Content, k: string) => (Array.isArray(c[k]) ? (c[k] as unknown[]) : []);

function Attachments({ items }: { items: unknown[] }) {
  const files = items.filter((a): a is { fileId: string; name: string } => !!a && typeof (a as { fileId?: unknown }).fileId === "string");
  if (!files.length) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {files.map((f) => (
        <a key={f.fileId} href={fileDownloadUrl(f.fileId)} className="inline-flex max-w-full items-center gap-2 rounded-lg border border-border bg-card px-3 py-1.5 text-sm hover:bg-muted">
          <Download className="h-4 w-4 shrink-0" aria-hidden />
          <span className="min-w-0 truncate">{f.name}</span>
        </a>
      ))}
    </div>
  );
}

/** Hints are opened one at a time, the way a student uses them. */
export function Hints({ hints }: { hints: string[] }) {
  const [shown, setShown] = useState(0);
  const visible = hints.filter((h) => h.trim());
  if (!visible.length) return null;
  return (
    <div className="space-y-2">
      {visible.slice(0, shown).map((h, i) => (
        <div key={i} className="flex gap-2 rounded-lg border border-info/40 bg-info-surface p-2 text-sm">
          <Lightbulb className="mt-0.5 h-4 w-4 shrink-0 text-info" aria-hidden />
          <span className="whitespace-pre-wrap">{h}</span>
        </div>
      ))}
      {shown < visible.length && (
        <button type="button" className="text-sm text-link underline" onClick={() => setShown((n) => n + 1)}>
          {t("syllabus.view.showHint", { n: shown + 1, total: visible.length })}
        </button>
      )}
    </div>
  );
}

function Example({ input, output }: { input: string; output: string }) {
  if (!input && !output) return null;
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {input && (
        <div>
          <p className="mb-1 text-xs font-medium text-foreground-secondary">{t("syllabus.tp.exampleInput")}</p>
          <pre className="overflow-x-auto rounded-lg bg-muted p-2 font-mono text-sm">{input}</pre>
        </div>
      )}
      {output && (
        <div>
          <p className="mb-1 text-xs font-medium text-foreground-secondary">{t("syllabus.tp.exampleOutput")}</p>
          <pre className="overflow-x-auto rounded-lg bg-muted p-2 font-mono text-sm">{output}</pre>
        </div>
      )}
    </div>
  );
}

function deadlineText(c: Content): string | null {
  const d = c.deadline as { type?: string; days?: number; at?: string } | undefined;
  if (d?.type === "RELATIVE_DAYS" && d.days) return t("syllabus.view.deadlineDays", { count: d.days });
  if (d?.type === "ABSOLUTE" && d.at) return t("syllabus.view.deadlineAt", { at: fmtDateTime(d.at) });
  return null;
}

/** Read-only student rendering of one lesson item (student-shaped content: teacher-only parts already removed). */
export function StudentItemView({
  kind,
  content,
  materials,
  onVideo,
}: {
  kind: SyllabusItemKind;
  content: Content;
  materials?: Map<string, MaterialRef>;
  onVideo?: (blockIndex: number, s: VideoSignal) => void;
}) {
  switch (kind) {
    case "THEORY":
      return <TheoryView blocks={content.blocks} materials={materials} onVideo={onVideo} />;
    case "TEACHER_PRACTICE":
      return (
        <div className="space-y-3">
          <div className="flex flex-wrap gap-2"><Pill>{difficultyLabel(str(content, "difficulty"))}</Pill></div>
          {str(content, "problem") && <Markdown md={str(content, "problem")} />}
          <Example input={str(content, "exampleInput")} output={str(content, "exampleOutput")} />
          {str(content, "expectedOutcome") && <p className="text-sm"><span className="font-medium">{t("syllabus.tp.expectedOutcome")}: </span>{str(content, "expectedOutcome")}</p>}
          <Hints hints={list(content, "hints").map(String)} />
          <Attachments items={list(content, "attachments")} />
          {str(content, "solution") && (
            <details className="rounded-lg border border-border p-2">
              <summary className="cursor-pointer text-sm font-medium">{t("syllabus.tp.solution")}</summary>
              <pre className="mt-2 overflow-x-auto whitespace-pre-wrap font-mono text-sm">{str(content, "solution")}</pre>
            </details>
          )}
        </div>
      );
    case "STUDENT_PRACTICE": {
      const deadline = deadlineText(content);
      return (
        <div className="space-y-3">
          <div className="flex flex-wrap gap-2">
            <Pill>{difficultyLabel(str(content, "difficulty"))}</Pill>
            <Pill>{t(`syllabus.sp.submission.${str(content, "submissionType") || "TEXT_OR_FILE"}` as MessageKey)}</Pill>
            {deadline && <Pill>{deadline}</Pill>}
          </div>
          {str(content, "instructions") && <Markdown md={str(content, "instructions")} />}
          {str(content, "expectedResult") && <p className="text-sm"><span className="font-medium">{t("syllabus.sp.expectedResult")}: </span>{str(content, "expectedResult")}</p>}
          <Hints hints={list(content, "hints").map(String)} />
          <Attachments items={list(content, "attachments")} />
        </div>
      );
    }
    case "ASSESSMENT": {
      const pass = typeof content.passPct === "number" ? content.passPct : null;
      return <p className="text-sm text-foreground-secondary">{pass !== null ? t("syllabus.view.passPct", { pct: pass }) : t("syllabus.view.assessment")}</p>;
    }
    case "RESOURCE": {
      const m = typeof content.materialId === "string" ? materials?.get(content.materialId) : undefined;
      const href = safeHref(str(content, "url"));
      return (
        <div className="space-y-2 text-sm">
          {m &&
            (m.fileId ? (
              <a href={fileDownloadUrl(m.fileId)} className="inline-flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 hover:bg-muted">
                <FolderOpen className="h-4 w-4" aria-hidden />
                {m.title}
              </a>
            ) : (
              <p className="inline-flex items-center gap-2"><FolderOpen className="h-4 w-4" aria-hidden />{m.title}</p>
            ))}
          {!m && typeof content.materialId === "string" && <p className="text-muted-foreground">{t("syllabus.theory.materialRef")}</p>}
          {href && (
            <a href={href} target="_blank" rel="noopener noreferrer nofollow" className="inline-flex items-center gap-1 break-all text-link underline">
              <ExternalLink className="h-4 w-4 shrink-0" aria-hidden />
              {str(content, "title") || href}
            </a>
          )}
          {str(content, "note") && <p className="whitespace-pre-wrap">{str(content, "note")}</p>}
        </div>
      );
    }
  }
}
