import { t } from "@/i18n/messages";
import { parseMarkdown, safeHref, type Inline, type MdBlock } from "@/lib/syllabus";
import { fileDownloadUrl } from "@/lib/uploadFile";
import { videoEmbedUrl } from "@shared/syllabus";
import { Download, ExternalLink, FileText, FolderOpen } from "lucide-react";
import type { ReactNode } from "react";

export type MaterialRef = { title: string; fileId: string | null };

function InlineNodes({ nodes }: { nodes: Inline[] }) {
  return (
    <>
      {nodes.map((n, i) => {
        switch (n.t) {
          case "text":
            return <span key={i}>{n.v}</span>;
          case "strong":
            return <strong key={i}><InlineNodes nodes={n.c} /></strong>;
          case "em":
            return <em key={i}><InlineNodes nodes={n.c} /></em>;
          case "code":
            return <code key={i} className="rounded bg-muted px-1 py-0.5 font-mono text-[0.9em]">{n.v}</code>;
          case "link":
            return (
              <a key={i} href={n.href} target="_blank" rel="noopener noreferrer nofollow" className="text-link underline underline-offset-2">
                <InlineNodes nodes={n.c} />
              </a>
            );
        }
      })}
    </>
  );
}

function CodeBlock({ language, code }: { language: string; code: string }) {
  return (
    <figure className="overflow-hidden rounded-xl border border-border bg-muted">
      {language && <figcaption className="border-b border-border px-3 py-1 font-mono text-xs text-muted-foreground">{language}</figcaption>}
      <pre className="overflow-x-auto p-3 text-sm"><code className="font-mono">{code}</code></pre>
    </figure>
  );
}

function MarkdownBlocks({ blocks }: { blocks: MdBlock[] }) {
  return (
    <>
      {blocks.map((b, i) => {
        switch (b.t) {
          case "heading": {
            const cls = b.level === 1 ? "text-xl font-semibold" : b.level === 2 ? "text-lg font-semibold" : "font-semibold";
            const Tag = (["h3", "h4", "h5"] as const)[b.level - 1];
            return <Tag key={i} className={cls}><InlineNodes nodes={b.c} /></Tag>;
          }
          case "paragraph":
            return <p key={i} className="leading-relaxed"><InlineNodes nodes={b.c} /></p>;
          case "list": {
            const Tag = b.ordered ? "ol" : "ul";
            return (
              <Tag key={i} className={`space-y-1 pl-6 ${b.ordered ? "list-decimal" : "list-disc"}`}>
                {b.items.map((item, j) => <li key={j}><InlineNodes nodes={item} /></li>)}
              </Tag>
            );
          }
          case "quote":
            return <blockquote key={i} className="border-l-4 border-border pl-3 text-foreground-secondary"><InlineNodes nodes={b.c} /></blockquote>;
          case "code":
            return <CodeBlock key={i} language={b.lang} code={b.v} />;
          case "rule":
            return <hr key={i} className="border-border" />;
        }
      })}
    </>
  );
}

export function Markdown({ md }: { md: string }) {
  return <div className="space-y-3 text-sm">{<MarkdownBlocks blocks={parseMarkdown(md)} />}</div>;
}

export function VideoEmbed({ url }: { url: string }) {
  const embed = videoEmbedUrl(url);
  const href = safeHref(url);
  if (!embed) {
    return href ? (
      <a href={href} target="_blank" rel="noopener noreferrer nofollow" className="inline-flex items-center gap-1 text-sm text-link underline">
        <ExternalLink className="h-4 w-4" aria-hidden />
        {t("syllabus.theory.openVideo")}
      </a>
    ) : null;
  }
  return (
    <div className="aspect-video w-full overflow-hidden rounded-xl border border-border bg-muted">
      <iframe
        src={embed}
        title={t("syllabus.theory.videoTitle")}
        className="h-full w-full"
        loading="lazy"
        allow="fullscreen; picture-in-picture; encrypted-media"
        allowFullScreen
        referrerPolicy="strict-origin-when-cross-origin"
        sandbox="allow-scripts allow-same-origin allow-presentation allow-popups"
      />
    </div>
  );
}

function FileLink({ fileId, name, icon }: { fileId: string; name: string; icon?: ReactNode }) {
  return (
    <a
      href={fileDownloadUrl(fileId)}
      className="inline-flex max-w-full items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm hover:bg-muted"
    >
      {icon ?? <Download className="h-4 w-4 shrink-0" aria-hidden />}
      <span className="min-w-0 truncate">{name || t("syllabus.theory.file")}</span>
    </a>
  );
}

export function TheoryBlockView({ block, materials }: { block: Record<string, unknown>; materials?: Map<string, MaterialRef> }) {
  const s = (k: string) => (typeof block[k] === "string" ? (block[k] as string) : "");
  switch (block.type) {
    case "markdown":
      return <Markdown md={s("md")} />;
    case "code":
      return <CodeBlock language={s("language")} code={s("code")} />;
    case "image": {
      const src = s("fileId") ? fileDownloadUrl(s("fileId")) : safeHref(s("url"));
      if (!src) return null;
      return (
        <figure className="space-y-1">
          <img src={src} alt={s("caption")} className="max-h-[480px] max-w-full rounded-xl border border-border object-contain" loading="lazy" referrerPolicy="no-referrer" />
          {s("caption") && <figcaption className="text-xs text-muted-foreground">{s("caption")}</figcaption>}
        </figure>
      );
    }
    case "video":
      return <VideoEmbed url={s("url")} />;
    case "link": {
      const href = safeHref(s("url"));
      if (!href) return null;
      return (
        <a href={href} target="_blank" rel="noopener noreferrer nofollow" className="inline-flex max-w-full items-center gap-1 break-all text-sm text-link underline">
          <ExternalLink className="h-4 w-4 shrink-0" aria-hidden />
          {s("title") || href}
        </a>
      );
    }
    case "file":
      return s("fileId") ? <FileLink fileId={s("fileId")} name={s("name")} icon={<FileText className="h-4 w-4 shrink-0" aria-hidden />} /> : null;
    case "material": {
      const m = materials?.get(s("materialId"));
      if (!m) return <p className="text-sm text-muted-foreground">{t("syllabus.theory.materialRef")}</p>;
      return m.fileId ? (
        <FileLink fileId={m.fileId} name={m.title} icon={<FolderOpen className="h-4 w-4 shrink-0" aria-hidden />} />
      ) : (
        <p className="inline-flex items-center gap-2 text-sm"><FolderOpen className="h-4 w-4" aria-hidden />{m.title}</p>
      );
    }
    case "table": {
      const rows = Array.isArray(block.rows) ? (block.rows as string[][]) : [];
      if (!rows.length) return null;
      const head = block.header === false ? null : rows[0];
      const body = block.header === false ? rows : rows.slice(1);
      return (
        <div className="overflow-x-auto rounded-xl border border-border">
          <table className="w-full text-sm">
            {head && (
              <thead className="bg-muted">
                <tr>{head.map((cell, j) => <th key={j} className="px-3 py-2 text-left font-semibold">{cell}</th>)}</tr>
              </thead>
            )}
            <tbody>
              {body.map((row, i) => (
                <tr key={i} className="border-t border-border">
                  {row.map((cell, j) => <td key={j} className="px-3 py-2 align-top">{cell}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }
    default:
      return null;
  }
}

export function TheoryView({ blocks, materials }: { blocks: unknown; materials?: Map<string, MaterialRef> }) {
  const list = Array.isArray(blocks) ? (blocks as Record<string, unknown>[]) : [];
  if (!list.length) return <p className="text-sm text-muted-foreground">{t("syllabus.theory.empty")}</p>;
  return (
    <div className="space-y-4">
      {list.map((b, i) => <TheoryBlockView key={i} block={b} materials={materials} />)}
    </div>
  );
}
