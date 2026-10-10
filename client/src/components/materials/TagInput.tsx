import { t } from "@/i18n/messages";
import { trpc } from "@/lib/trpc";
import { cleanTags, MAX_TAG_LENGTH, MAX_TAGS_PER_FIELD, tagKey, type TagType } from "@shared/materialTemplates";
import { X } from "lucide-react";
import { useEffect, useId, useState } from "react";

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
}

/**
 * Chips plus a text box. Enter or comma adds the typed tag; suggestions come from the
 * workspace's tags and, for topics, its question-bank sections.
 */
export function TagInput({ id, type, value, onChange, label }: { id?: string; type: TagType; value: string[]; onChange: (v: string[]) => void; label: string }) {
  const listId = useId();
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const query = useDebounced(text.trim(), 200);
  const suggest = trpc.teacher.tasks.suggestTags.useQuery({ type, query }, { enabled: open, staleTime: 30_000 });
  const taken = new Set(value.map(tagKey));
  const options = (suggest.data ?? []).filter((s) => !taken.has(tagKey(s.name))).slice(0, 8);
  const full = value.length >= MAX_TAGS_PER_FIELD;

  const add = (name: string) => {
    const next = cleanTags([...value, name]);
    if (next.length !== value.length) onChange(next);
    setText("");
    setActive(-1);
  };

  return (
    <div className="relative">
      <div className="flex min-h-10 flex-wrap items-center gap-1.5 rounded-lg border border-input bg-card px-2 py-1.5 focus-within:ring-2 focus-within:ring-ring/40">
        {value.map((tag) => (
          <span key={tagKey(tag)} className="inline-flex max-w-full items-center gap-1 rounded-full border border-border bg-muted px-2 py-0.5 text-xs">
            <span className="min-w-0 break-words">{tag}</span>
            <button
              type="button"
              className="shrink-0 rounded-full p-0.5 text-muted-foreground hover:text-foreground"
              aria-label={t("material.form.tagRemove", { tag })}
              onClick={() => onChange(value.filter((v) => v !== tag))}
            >
              <X className="size-3" aria-hidden />
            </button>
          </span>
        ))}
        <input
          id={id}
          role="combobox"
          aria-expanded={open && options.length > 0}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-label={label}
          aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
          className="min-w-[8rem] flex-1 bg-transparent py-0.5 text-sm outline-none placeholder:text-muted-foreground"
          value={text}
          maxLength={MAX_TAG_LENGTH}
          disabled={full}
          placeholder={full ? t("material.form.tagLimit", { count: MAX_TAGS_PER_FIELD }) : t("material.form.tagPlaceholder")}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 120)}
          onChange={(e) => {
            const v = e.target.value;
            if (v.includes(",")) v.split(",").slice(0, -1).forEach((part) => part.trim() && add(part));
            setText(v.includes(",") ? (v.split(",").pop() ?? "") : v);
            setOpen(true);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" && options.length) {
              e.preventDefault();
              setActive((i) => (i + 1) % options.length);
            } else if (e.key === "ArrowUp" && options.length) {
              e.preventDefault();
              setActive((i) => (i <= 0 ? options.length - 1 : i - 1));
            } else if (e.key === "Enter") {
              if (active >= 0 && options[active]) {
                e.preventDefault();
                add(options[active].name);
              } else if (text.trim()) {
                e.preventDefault();
                add(text);
              }
            } else if (e.key === "Backspace" && !text && value.length) {
              onChange(value.slice(0, -1));
            } else if (e.key === "Escape") {
              setOpen(false);
            }
          }}
        />
      </div>
      {open && options.length > 0 && (
        <ul id={listId} role="listbox" className="absolute z-50 mt-1 max-h-56 w-full overflow-auto rounded-lg border border-border bg-popover p-1 text-sm shadow-md">
          {options.map((o, i) => (
            <li
              key={`${o.source}-${o.name}`}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              className={`flex cursor-pointer items-center justify-between gap-2 rounded-md px-2 py-1.5 ${i === active ? "bg-muted" : "hover:bg-muted"}`}
              onMouseDown={(e) => {
                e.preventDefault();
                add(o.name);
              }}
            >
              <span className="min-w-0 break-words">{o.name}</span>
              {o.source === "QUESTION_BANK" && <span className="shrink-0 text-xs text-muted-foreground">{t("material.form.tagFromBank")}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
