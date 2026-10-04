import { SingleFileUpload } from "@/components/FileUpload";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { t, type MessageKey } from "@/i18n/messages";
import { emptyBlock, resizeTable, THEORY_BLOCK_TYPES, type EditableBlock, type TheoryBlockType } from "@/lib/syllabus";
import { videoProviderOf } from "@shared/syllabus";
import { Bold, Code, Eye, Heading, Italic, Link2, List, ListOrdered, Pencil, Plus, Trash2 } from "lucide-react";
import { useRef, useState } from "react";
import { SortableList } from "./SortableList";
import { Markdown, TheoryBlockView, VideoEmbed, type MaterialRef } from "./TheoryView";

const fieldLabel = "text-foreground-secondary";
const selectCls = "w-full rounded-lg border border-input bg-card px-3 py-2 text-sm text-foreground";
const CODE_LANGUAGES = ["java", "python", "javascript", "typescript", "c", "cpp", "csharp", "go", "kotlin", "php", "ruby", "rust", "sql", "html", "css", "bash", "json"];

export const blockTypeLabel = (type: TheoryBlockType) => t(`syllabus.block.${type}` as MessageKey);

type Wrap = { before: string; after?: string; line?: boolean; placeholder: string };

function MarkdownField({ value, onChange, id }: { value: string; onChange: (v: string) => void; id: string }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [preview, setPreview] = useState(false);
  const apply = ({ before, after = "", line, placeholder }: Wrap) => {
    const el = ref.current;
    if (!el) return;
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const selected = value.slice(start, end) || placeholder;
    const lead = line && start > 0 && value[start - 1] !== "\n" ? "\n" : "";
    const next = `${value.slice(0, start)}${lead}${before}${selected}${after}${value.slice(end)}`;
    onChange(next);
    requestAnimationFrame(() => {
      el.focus();
      const from = start + lead.length + before.length;
      el.setSelectionRange(from, from + selected.length);
    });
  };
  const tools: { icon: typeof Bold; label: MessageKey; wrap: Wrap }[] = [
    { icon: Heading, label: "syllabus.md.heading", wrap: { before: "## ", line: true, placeholder: t("syllabus.md.headingText") } },
    { icon: Bold, label: "syllabus.md.bold", wrap: { before: "**", after: "**", placeholder: t("syllabus.md.text") } },
    { icon: Italic, label: "syllabus.md.italic", wrap: { before: "*", after: "*", placeholder: t("syllabus.md.text") } },
    { icon: Code, label: "syllabus.md.code", wrap: { before: "`", after: "`", placeholder: t("syllabus.md.text") } },
    { icon: Link2, label: "syllabus.md.link", wrap: { before: "[", after: "](https://)", placeholder: t("syllabus.md.text") } },
    { icon: List, label: "syllabus.md.bullets", wrap: { before: "- ", line: true, placeholder: t("syllabus.md.text") } },
    { icon: ListOrdered, label: "syllabus.md.numbers", wrap: { before: "1. ", line: true, placeholder: t("syllabus.md.text") } },
  ];
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1" role="toolbar" aria-label={t("syllabus.md.toolbar")}>
        {tools.map(({ icon: Icon, label, wrap }) => (
          <button
            key={label}
            type="button"
            disabled={preview}
            onClick={() => apply(wrap)}
            className="rounded-md p-1.5 text-foreground-secondary hover:bg-muted disabled:opacity-40"
            aria-label={t(label)}
            title={t(label)}
          >
            <Icon className="h-4 w-4" aria-hidden />
          </button>
        ))}
        <Button type="button" size="sm" variant="ghost" className="ml-auto" onClick={() => setPreview((v) => !v)} aria-pressed={preview}>
          {preview ? <Pencil className="mr-1 h-4 w-4" aria-hidden /> : <Eye className="mr-1 h-4 w-4" aria-hidden />}
          {preview ? t("syllabus.md.edit") : t("syllabus.md.preview")}
        </Button>
      </div>
      {preview ? (
        <div className="min-h-24 rounded-lg border border-border p-3">{value.trim() ? <Markdown md={value} /> : <p className="text-sm text-muted-foreground">{t("syllabus.theory.empty")}</p>}</div>
      ) : (
        <Textarea id={id} ref={ref} rows={8} maxLength={50_000} value={value} onChange={(e) => onChange(e.target.value)} placeholder={t("syllabus.md.placeholder")} className="font-mono text-sm" />
      )}
      <p className="text-xs text-muted-foreground">{t("syllabus.md.help")}</p>
    </div>
  );
}

function TableField({ block, onChange }: { block: EditableBlock; onChange: (b: EditableBlock) => void }) {
  const rows = Array.isArray(block.rows) ? (block.rows as string[][]) : [[""]];
  const cols = rows[0]?.length ?? 1;
  const setCell = (i: number, j: number, v: string) => onChange({ ...block, rows: rows.map((r, ri) => (ri === i ? r.map((c, ci) => (ci === j ? v : c)) : r)) });
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-end gap-3 text-sm">
        <label><span className={fieldLabel}>{t("syllabus.table.rows")}</span><Input type="number" min={1} max={60} className="w-24" value={rows.length} onChange={(e) => onChange({ ...block, rows: resizeTable(rows, Number(e.target.value) || 1, cols) })} /></label>
        <label><span className={fieldLabel}>{t("syllabus.table.cols")}</span><Input type="number" min={1} max={12} className="w-24" value={cols} onChange={(e) => onChange({ ...block, rows: resizeTable(rows, rows.length, Number(e.target.value) || 1) })} /></label>
        <label className="flex items-center gap-2 pb-2"><input type="checkbox" className="accent-link" checked={block.header !== false} onChange={(e) => onChange({ ...block, header: e.target.checked })} />{t("syllabus.table.header")}</label>
      </div>
      <div className="overflow-x-auto">
        <table className="text-sm">
          <tbody>
            {rows.map((row, i) => (
              <tr key={i}>
                {row.map((cell, j) => (
                  <td key={j} className="p-0.5">
                    <Input
                      value={cell}
                      maxLength={500}
                      onChange={(e) => setCell(i, j, e.target.value)}
                      aria-label={t("syllabus.table.cell", { row: i + 1, col: j + 1 })}
                      className={`min-w-28 ${i === 0 && block.header !== false ? "font-semibold" : ""}`}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function BlockFields({ block, onChange, materials }: { block: EditableBlock; onChange: (b: EditableBlock) => void; materials: { id: string; title: string; fileId: string | null }[] }) {
  const s = (k: string) => (typeof block[k] === "string" ? (block[k] as string) : "");
  const id = `blk-${block.key}`;
  switch (block.type) {
    case "markdown":
      return <MarkdownField id={id} value={s("md")} onChange={(md) => onChange({ ...block, md })} />;
    case "code":
      return (
        <div className="grid gap-2">
          <label className="text-sm sm:w-56">
            <span className={fieldLabel}>{t("syllabus.code.language")}</span>
            <Input list={`${id}-langs`} maxLength={32} value={s("language")} onChange={(e) => onChange({ ...block, language: e.target.value })} />
            <datalist id={`${id}-langs`}>{CODE_LANGUAGES.map((l) => <option key={l} value={l} />)}</datalist>
          </label>
          <label className="text-sm"><span className={fieldLabel}>{t("syllabus.code.code")}</span><Textarea rows={8} spellCheck={false} maxLength={50_000} value={s("code")} onChange={(e) => onChange({ ...block, code: e.target.value })} className="font-mono text-sm" /></label>
        </div>
      );
    case "image":
      return (
        <div className="grid gap-2 text-sm">
          <div>
            <p className={`mb-1 ${fieldLabel}`}>{t("syllabus.image.upload")}</p>
            <SingleFileUpload
              context="syllabus"
              value={s("fileId") ? { fileId: s("fileId"), name: s("caption") || t("syllabus.block.image"), size: 0, mimeType: "" } : null}
              onChange={(f) => onChange({ ...block, fileId: f?.fileId ?? undefined, url: f ? undefined : block.url })}
            />
          </div>
          {!s("fileId") && <label><span className={fieldLabel}>{t("syllabus.image.url")}</span><Input type="url" maxLength={2000} value={s("url")} onChange={(e) => onChange({ ...block, url: e.target.value })} placeholder={t("syllabus.urlPlaceholder")} /></label>}
          <label><span className={fieldLabel}>{t("syllabus.image.caption")}</span><Input maxLength={255} value={s("caption")} onChange={(e) => onChange({ ...block, caption: e.target.value })} /></label>
          {(s("fileId") || s("url")) && <TheoryBlockView block={block} />}
        </div>
      );
    case "video": {
      const url = s("url");
      const provider = url.trim() ? videoProviderOf(url) : null;
      return (
        <div className="grid gap-2 text-sm">
          <label>
            <span className={fieldLabel}>{t("syllabus.video.url")}</span>
            <Input type="url" maxLength={2000} value={url} onChange={(e) => onChange({ ...block, url: e.target.value, provider: videoProviderOf(e.target.value) ?? "youtube" })} placeholder={t("syllabus.urlPlaceholder")} />
          </label>
          <p className="text-xs text-muted-foreground">{t("syllabus.video.allowed")}</p>
          {url.trim() && !provider && <p role="alert" className="text-xs text-destructive">{t("syllabus.video.notAllowed")}</p>}
          {provider && <VideoEmbed url={url} />}
        </div>
      );
    }
    case "link":
      return (
        <div className="grid gap-2 text-sm sm:grid-cols-2">
          <label><span className={fieldLabel}>{t("syllabus.link.url")}</span><Input type="url" maxLength={2000} value={s("url")} onChange={(e) => onChange({ ...block, url: e.target.value })} placeholder={t("syllabus.urlPlaceholder")} /></label>
          <label><span className={fieldLabel}>{t("syllabus.link.title")}</span><Input maxLength={255} value={s("title")} onChange={(e) => onChange({ ...block, title: e.target.value })} /></label>
        </div>
      );
    case "file":
      return (
        <SingleFileUpload
          context="syllabus"
          value={s("fileId") ? { fileId: s("fileId"), name: s("name"), size: 0, mimeType: "" } : null}
          onChange={(f) => onChange({ ...block, fileId: f?.fileId ?? "", name: f?.name ?? "" })}
        />
      );
    case "material":
      return (
        <label className="text-sm">
          <span className={fieldLabel}>{t("syllabus.material.pick")}</span>
          <select className={selectCls} value={s("materialId")} onChange={(e) => onChange({ ...block, materialId: e.target.value })}>
            <option value="">{t("syllabus.material.none")}</option>
            {materials.map((m) => <option key={m.id} value={m.id}>{m.title}</option>)}
          </select>
          {!materials.length && <span className="mt-1 block text-xs text-muted-foreground">{t("syllabus.material.empty")}</span>}
        </label>
      );
    case "table":
      return <TableField block={block} onChange={onChange} />;
  }
}

/** Block-based theory editor: text (Markdown subset), code, image, video link, link, file, material, table. */
export function TheoryEditor({
  value,
  onChange,
  materials,
}: {
  value: EditableBlock[];
  onChange: (blocks: EditableBlock[]) => void;
  materials: { id: string; title: string; fileId: string | null }[];
}) {
  const update = (key: string, next: EditableBlock) => onChange(value.map((b) => (b.key === key ? next : b)));
  return (
    <div className="space-y-3">
      {value.length === 0 && <p className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">{t("syllabus.theory.noBlocks")}</p>}
      <SortableList items={value} getKey={(b) => b.key} getLabel={(b) => blockTypeLabel(b.type)} onReorder={onChange}>
        {(block, { handle }) => (
          <div className="rounded-xl border border-border bg-card p-3">
            <div className="mb-2 flex items-center gap-2">
              {handle}
              <span className="text-sm font-medium">{blockTypeLabel(block.type)}</span>
              <button
                type="button"
                onClick={() => onChange(value.filter((b) => b.key !== block.key))}
                className="ml-auto rounded p-1 text-destructive hover:bg-danger-surface"
                aria-label={t("syllabus.theory.removeBlock", { type: blockTypeLabel(block.type) })}
              >
                <Trash2 className="h-4 w-4" aria-hidden />
              </button>
            </div>
            <BlockFields block={block} onChange={(b) => update(block.key, b)} materials={materials} />
          </div>
        )}
      </SortableList>
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-dashed border-border p-3">
        <span className="text-sm text-foreground-secondary">{t("syllabus.theory.addBlock")}</span>
        {THEORY_BLOCK_TYPES.map((type) => (
          <Button key={type} type="button" size="sm" variant="outline" onClick={() => onChange([...value, emptyBlock(type)])}>
            <Plus className="mr-1 h-3.5 w-3.5" aria-hidden />
            {blockTypeLabel(type)}
          </Button>
        ))}
      </div>
    </div>
  );
}

export type { MaterialRef };
