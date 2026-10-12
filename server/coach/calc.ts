/**
 * A small arithmetic evaluator for checking the model's calculation answers (pure, no eval):
 * numbers, named variables, + - * / ^ (or **), unary minus, parentheses, the constants pi and e,
 * and sqrt, abs, ln, log (base 10), log2, exp, sin, cos, tan (radians), min, max, round.
 */

const FUNCTIONS: Record<string, (...a: number[]) => number> = {
  sqrt: Math.sqrt,
  abs: Math.abs,
  ln: Math.log,
  log: Math.log10,
  lg: Math.log10,
  log2: Math.log2,
  exp: Math.exp,
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  min: Math.min,
  max: Math.max,
  round: Math.round,
};
const CONSTANTS: Record<string, number> = { pi: Math.PI, e: Math.E };
const MAX_LENGTH = 300;
const MAX_DEPTH = 40;

type Token = { kind: "num"; value: number } | { kind: "id"; name: string } | { kind: "op"; op: string };

export class CalcError extends Error {}

function tokenize(src: string): Token[] {
  const s = src.replace(/×|·/g, "*").replace(/÷/g, "/").replace(/−/g, "-").replace(/\*\*/g, "^");
  const out: Token[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    const num = /^(\d+\.?\d*|\.\d+)(e[-+]?\d+)?/i.exec(s.slice(i));
    if (num) {
      out.push({ kind: "num", value: Number(num[0]) });
      i += num[0].length;
      continue;
    }
    const id = /^[\p{L}_][\p{L}\p{N}_]*/u.exec(s.slice(i));
    if (id) {
      out.push({ kind: "id", name: id[0] });
      i += id[0].length;
      continue;
    }
    if ("+-*/^(),".includes(c)) {
      out.push({ kind: "op", op: c });
      i++;
      continue;
    }
    throw new CalcError(`unexpected "${c}"`);
  }
  return out;
}

/** Evaluates `formula` with `variables`; throws CalcError on anything it does not understand. */
export function evaluate(formula: string, variables: Record<string, number> = {}): number {
  if (formula.length > MAX_LENGTH) throw new CalcError("too long");
  const tokens = tokenize(formula);
  let pos = 0;
  let depth = 0;
  const peek = () => tokens[pos];
  const isOp = (op: string) => {
    const t = tokens[pos];
    return t?.kind === "op" && t.op === op;
  };
  const expect = (op: string) => {
    if (!isOp(op)) throw new CalcError(`expected "${op}"`);
    pos++;
  };

  const expr = (): number => {
    if (++depth > MAX_DEPTH) throw new CalcError("too deep");
    let v = term();
    while (isOp("+") || isOp("-")) {
      const op = (tokens[pos++] as { op: string }).op;
      const r = term();
      v = op === "+" ? v + r : v - r;
    }
    depth--;
    return v;
  };
  const term = (): number => {
    let v = unary();
    for (;;) {
      if (isOp("*") || isOp("/")) {
        const op = (tokens[pos++] as { op: string }).op;
        const r = unary();
        v = op === "*" ? v * r : v / r;
        continue;
      }
      // Implicit multiplication: 2pi, 3(x+1), 2 m.
      const t = peek();
      if (t && (t.kind === "id" || t.kind === "num" || (t.kind === "op" && t.op === "("))) {
        v *= unary();
        continue;
      }
      return v;
    }
  };
  const unary = (): number => {
    if (isOp("-")) {
      pos++;
      return -unary();
    }
    if (isOp("+")) {
      pos++;
      return unary();
    }
    return power();
  };
  const power = (): number => {
    const base = atom();
    if (isOp("^")) {
      pos++;
      return base ** unary();
    }
    return base;
  };
  const atom = (): number => {
    const t = tokens[pos++];
    if (!t) throw new CalcError("unexpected end");
    if (t.kind === "num") return t.value;
    if (t.kind === "op") {
      if (t.op !== "(") throw new CalcError(`unexpected "${t.op}"`);
      const v = expr();
      expect(")");
      return v;
    }
    const name = t.name;
    if (isOp("(") && Object.prototype.hasOwnProperty.call(FUNCTIONS, name.toLowerCase())) {
      pos++;
      const args = [expr()];
      while (isOp(",")) {
        pos++;
        args.push(expr());
      }
      expect(")");
      return FUNCTIONS[name.toLowerCase()](...args);
    }
    if (Object.prototype.hasOwnProperty.call(variables, name)) return variables[name];
    if (Object.prototype.hasOwnProperty.call(CONSTANTS, name.toLowerCase())) return CONSTANTS[name.toLowerCase()];
    throw new CalcError(`unknown name "${name}"`);
  };

  const value = expr();
  if (pos !== tokens.length) throw new CalcError("trailing input");
  if (!Number.isFinite(value)) throw new CalcError("not a finite number");
  return value;
}

export function tryEvaluate(formula: string, variables: Record<string, number>): number | null {
  try {
    return evaluate(formula, variables);
  } catch {
    return null;
  }
}

/**
 * Checks a calculation key: "verified" when the formula reproduces the value within tolerance,
 * "mismatch" when it computes something else (the key is unreliable), "unchecked" when the formula
 * is missing or not understood.
 */
export function checkCalc(spec: { formula: string; variables: Record<string, number> } | null, value: number, tolerance: number): { verdict: "verified" | "mismatch" | "unchecked"; computed: number | null } {
  if (!spec?.formula) return { verdict: "unchecked", computed: null };
  const computed = tryEvaluate(spec.formula, spec.variables);
  if (computed === null) return { verdict: "unchecked", computed: null };
  const slack = Math.max(Math.abs(tolerance), Math.abs(value) * 0.01, 1e-9);
  return { verdict: Math.abs(computed - value) <= slack ? "verified" : "mismatch", computed };
}
