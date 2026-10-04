import fs from "node:fs";
import path from "node:path";
import type { Plugin } from "vite";
import { SITE_PAGES } from "./pages";
import { jsonLdScript, llmsFullTxt, prerender, siteJsonLd, sitemapXml } from "./render";

/** Folder (inside the build output) for prerendered pages; `server/_core/spa.ts` serves them by path. */
export const PRERENDER_DIR = "_pages";

export const prerenderFileName = (pagePath: string) => (pagePath === "/" ? "index.html" : `${pagePath.slice(1)}.html`);

/**
 * Site-wide JSON-LD goes into index.html (dev and build). After a build, every public page is also
 * written as static HTML with its own title, meta, canonical, JSON-LD and text, plus sitemap.xml and
 * llms-full.txt, so crawlers that do not run JavaScript still see the content.
 */
export function seoPlugin(): Plugin {
  let outDir = "";
  let isBuild = false;
  return {
    name: "resulio-seo",
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir);
      isBuild = config.command === "build";
    },
    transformIndexHtml(html) {
      return html.replace("</head>", `  ${jsonLdScript(siteJsonLd())}\n  </head>`);
    },
    closeBundle() {
      const shellPath = path.join(outDir, "index.html");
      if (!isBuild || !fs.existsSync(shellPath)) return;
      const shell = fs.readFileSync(shellPath, "utf8");
      fs.mkdirSync(path.join(outDir, PRERENDER_DIR), { recursive: true });
      for (const page of SITE_PAGES) {
        fs.writeFileSync(path.join(outDir, PRERENDER_DIR, prerenderFileName(page.path)), prerender(shell, page));
      }
      fs.writeFileSync(path.join(outDir, "sitemap.xml"), sitemapXml(new Date().toISOString().slice(0, 10)));
      fs.writeFileSync(path.join(outDir, "llms-full.txt"), llmsFullTxt());
    },
  };
}
