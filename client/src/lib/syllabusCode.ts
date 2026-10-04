/**
 * A small, dependency-free code highlighter for theory code blocks: comments, strings, numbers and
 * keywords of common teaching languages. Output is plain tokens rendered as text (never HTML).
 */

export type CodeTokenKind = "plain" | "keyword" | "string" | "comment" | "number";
export interface CodeToken {
  k: CodeTokenKind;
  v: string;
}

const words = (s: string) => new Set(s.split(/\s+/).filter(Boolean));

const C_LIKE = "if else for while do switch case break continue return default goto sizeof struct union enum typedef const static void int char float double long short unsigned signed bool true false null";
const KEYWORDS: Record<string, Set<string>> = {
  python: words("and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return True try while with yield print self"),
  javascript: words(`${C_LIKE} var let function class new this typeof instanceof in of try catch finally throw async await yield import export from extends super undefined delete`),
  typescript: words(`${C_LIKE} var let function class new this typeof instanceof in of try catch finally throw async await yield import export from extends super undefined interface type implements private public protected readonly keyof as number string boolean any unknown never`),
  java: words(`${C_LIKE} class interface extends implements new this super public private protected final abstract try catch finally throw throws import package instanceof synchronized String System var record`),
  c: words(C_LIKE + " include define"),
  cpp: words(`${C_LIKE} class namespace using new delete this public private protected template typename virtual override try catch throw auto nullptr std cout cin endl include`),
  csharp: words(`${C_LIKE} class interface namespace using new this base public private protected internal sealed override virtual abstract try catch finally throw var string async await get set`),
  sql: words("select from where and or not insert into values update set delete create table drop alter join left right inner outer on group by order having limit as distinct null is in like between count sum avg min max primary key foreign references index"),
  bash: words("if then else elif fi for in do done while case esac function return echo export local exit"),
  php: words(`${C_LIKE} function echo class new public private protected array foreach as require include namespace use`),
  go: words("break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var nil true false"),
  rust: words("as break const continue crate else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while"),
};

const ALIASES: Record<string, string> = {
  py: "python",
  js: "javascript",
  jsx: "javascript",
  ts: "typescript",
  tsx: "typescript",
  "c++": "cpp",
  "c#": "csharp",
  cs: "csharp",
  sh: "bash",
  shell: "bash",
  mysql: "sql",
  postgres: "sql",
  golang: "go",
  rs: "rust",
};

export function normalizeLanguage(lang: string): string | null {
  const l = lang.trim().toLowerCase();
  const key = ALIASES[l] ?? l;
  return KEYWORDS[key] ? key : null;
}

const hashComments = new Set(["python", "bash"]);
const caseInsensitive = new Set(["sql"]);

/** Splits code into tokens; unknown languages still get strings, numbers and comments. */
export function highlightCode(code: string, language: string): CodeToken[] {
  const lang = normalizeLanguage(language);
  const keywords = lang ? KEYWORDS[lang] : new Set<string>();
  const out: CodeToken[] = [];
  const push = (k: CodeTokenKind, v: string) => {
    const last = out[out.length - 1];
    if (last && last.k === k) last.v += v;
    else out.push({ k, v });
  };
  const lineComment = hashComments.has(lang ?? "") ? /#[^\n]*/y : lang === "sql" ? /--[^\n]*/y : /\/\/[^\n]*/y;
  const blockComment = lang !== "python" && lang !== "bash" ? /\/\*[\s\S]*?(\*\/|$)/y : null;
  const str = /("""[\s\S]*?("""|$)|'''[\s\S]*?('''|$)|"(\\.|[^"\\\n])*"?|'(\\.|[^'\\\n])*'?|`(\\.|[^`\\])*`?)/y;
  const num = /\d[\d_]*(\.\d+)?([eE][+-]?\d+)?/y;
  const word = /[A-Za-z_$][\w$]*/y;
  const at = (re: RegExp, i: number) => {
    re.lastIndex = i;
    return re.exec(code);
  };
  let i = 0;
  while (i < code.length) {
    let m = at(lineComment, i) ?? (blockComment ? at(blockComment, i) : null);
    if (m) {
      push("comment", m[0]);
      i += m[0].length;
      continue;
    }
    m = at(str, i);
    if (m) {
      push("string", m[0]);
      i += m[0].length;
      continue;
    }
    m = at(num, i);
    if (m && !/[A-Za-z_]/.test(code[i - 1] ?? "")) {
      push("number", m[0]);
      i += m[0].length;
      continue;
    }
    m = at(word, i);
    if (m) {
      const w = caseInsensitive.has(lang ?? "") ? m[0].toLowerCase() : m[0];
      push(keywords.has(w) ? "keyword" : "plain", m[0]);
      i += m[0].length;
      continue;
    }
    push("plain", code[i]);
    i++;
  }
  return out;
}
