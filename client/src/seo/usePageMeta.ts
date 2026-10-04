import { t } from "@/i18n/messages";
import { useEffect } from "react";
import { absoluteUrl } from "./config";
import type { SitePage } from "./pages";

function setTag(selector: string, create: () => HTMLElement, attr: string, value: string) {
  const existing = document.head.querySelector<HTMLElement>(selector);
  const previous = existing?.getAttribute(attr) ?? "";
  const el = existing ?? document.head.appendChild(create());
  el.setAttribute(attr, value);
  return () => {
    if (existing) existing.setAttribute(attr, previous);
    else el.remove();
  };
}

const meta = (key: "name" | "property", name: string) => () => {
  const el = document.createElement("meta");
  el.setAttribute(key, name);
  return el;
};

/** Title, description, canonical and social tags of a public page in the active language; restored on leave. */
export function usePageMeta(page: SitePage) {
  const title = t(page.title);
  const description = t(page.description);
  useEffect(() => {
    const previousTitle = document.title;
    document.title = title;
    const url = absoluteUrl(page.path);
    const restore = [
      setTag('meta[name="description"]', meta("name", "description"), "content", description),
      setTag('link[rel="canonical"]', () => Object.assign(document.createElement("link"), { rel: "canonical" }), "href", url),
      setTag('meta[property="og:title"]', meta("property", "og:title"), "content", title),
      setTag('meta[property="og:description"]', meta("property", "og:description"), "content", description),
      setTag('meta[property="og:url"]', meta("property", "og:url"), "content", url),
    ];
    return () => {
      document.title = previousTitle;
      restore.forEach((undo) => undo());
    };
  }, [page.path, title, description]);
}
