// Result container + compact number formatting (port of api/flpc/fmt.py).
//
// Every tool returns a `Result`: a title, a few context lines (filters,
// units), one or more small tables and optional notes. It renders as compact
// CSV-style text (MCP: cheapest for an LLM to read) or as JSON (REST).
// Rounding follows Python's round() exactly, so hosted and local answers match.

export type Cell = string | number | null;

/** Bad input from the caller; the message is meant to be shown to the LLM. */
export class UserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserError";
  }
}

export interface Table {
  columns: string[];
  rows: Cell[][];
  title: string | null;
}

function csvField(v: Cell): string {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export class Result {
  title: string;
  context: string[] = [];
  tables: Table[] = [];
  notes: string[] = [];

  constructor(title: string) {
    this.title = title;
  }

  add(columns: string[], rows: Cell[][], title: string | null = null): Table {
    const t: Table = { columns: [...columns], rows: rows.map((r) => [...r]), title };
    this.tables.push(t);
    return t;
  }

  toText(): string {
    let out = `## ${this.title}\n`;
    for (const c of this.context) out += c + "\n";
    for (const t of this.tables) {
      if (t.title) out += `\n# ${t.title}\n`;
      else if (this.tables.length > 1 || this.context.length) out += "\n";
      out += t.columns.map(csvField).join(",") + "\n";
      for (const r of t.rows) out += r.map(csvField).join(",") + "\n";
    }
    if (this.notes.length) {
      out += "\nNotes:\n";
      for (const n of this.notes) out += `- ${n}\n`;
    }
    return out.trimEnd() + "\n";
  }

  toJSON() {
    return {
      title: this.title,
      context: this.context,
      tables: this.tables.map((t) => ({ title: t.title, columns: t.columns, rows: t.rows })),
      notes: this.notes,
    };
  }
}

// --------------------------------------------------------------------------
// Python-compatible rounding
// --------------------------------------------------------------------------

/** Python's round(x, n) for n >= 0: exact decimal value, ties to even. */
export function pyRound(x: number, n = 0): number {
  if (!Number.isFinite(x) || Math.abs(x) >= 1e21) return x;
  const neg = x < 0;
  const s = Math.abs(x).toFixed(100); // exact decimal expansion of the double
  const dot = s.indexOf(".");
  const digits = s.slice(0, dot) + s.slice(dot + 1);
  const cut = dot + n;
  let kept = digits.slice(0, cut);
  const rest = digits.slice(cut);
  let up = false;
  if (rest[0] > "5") up = true;
  else if (rest[0] === "5") {
    up = /[1-9]/.test(rest.slice(1)) || Number(kept[kept.length - 1] ?? "0") % 2 === 1;
  }
  if (up) {
    const arr = kept.split("");
    let i = arr.length - 1;
    while (i >= 0) {
      if (arr[i] === "9") {
        arr[i] = "0";
        i--;
      } else {
        arr[i] = String(Number(arr[i]) + 1);
        break;
      }
    }
    kept = (i < 0 ? "1" : "") + arr.join("");
  }
  const intLen = kept.length - n;
  const str = n > 0 ? `${kept.slice(0, intLen) || "0"}.${kept.slice(intLen)}` : kept;
  const r = Number(str);
  return neg ? -r : r;
}

/** Round for display: >= 1000 -> integer, else `sig` significant figures. */
export function num(v: number | null | undefined, sig = 4): number | null {
  if (v === null || v === undefined || !Number.isFinite(v)) return null;
  const a = Math.abs(v);
  if (a >= 1000 || v === Math.trunc(v)) return pyRound(v, 0) || 0;
  const digits = sig - 1 - Math.floor(Math.log10(a));
  const r = pyRound(v, Math.max(digits, 0));
  return r === 0 ? 0 : r;
}

/** Fraction -> percent number (0.1234 -> 12.3). */
export function pct(v: number | null | undefined, decimals = 1): number | null {
  if (v === null || v === undefined) return null;
  const r = pyRound(v * 100, decimals);
  return r === 0 ? 0 : r;
}

const USD_SCALES: [number, string][] = [[1e9, "$B"], [1e6, "$M"], [1e3, "$K"]];
const UNIT_LABEL: Record<string, string> = { usd: "$", usd_each: "$", pct: "%", count: "count", rate: "per 1k" };

/** Display scaling for one metric/unit across a whole table. */
export class Scale {
  unit: string;
  div = 1;
  label: string;

  constructor(unit: string, values: (number | null | undefined)[] = [], raw = false) {
    this.unit = unit;
    this.label = UNIT_LABEL[unit] ?? unit;
    if (unit === "usd" && !raw) {
      let m = 0;
      for (const v of values) if (v !== null && v !== undefined && Math.abs(v) > m) m = Math.abs(v);
      for (const [d, lab] of USD_SCALES) {
        if (m >= d) {
          this.div = d;
          this.label = lab;
          break;
        }
      }
    }
  }

  fmt(v: number | null | undefined): number | null {
    if (v === null || v === undefined) return null;
    if (this.unit === "pct") return pct(v, 2);
    if (this.unit === "count") return Math.abs(v) >= 1 || v === 0 ? pyRound(v, 0) || 0 : num(v);
    return num(v / this.div);
  }
}
