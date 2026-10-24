import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type Definitions, toParseDefs } from "../src/definitions.ts";
import { classifyInput } from "../src/input.ts";
import { parse, type Row } from "../src/parser.ts";

type Golden = {
  input: string;
  rows: { left: string; right: string; indent: number }[];
  status: string;
  textarea: string;
};

const load = <T>(rel: string): T => JSON.parse(readFileSync(new URL(rel, import.meta.url), "utf8"));

// Each fixture was captured from the legacy index.html DOM with the paired definitions.
const suites: [string, Record<string, Golden>, Definitions][] = [
  ["legacy golden (def.json)", load("./legacy-golden.json"), load("../public/def.json")],
  [
    "legacy golden extra (def.json)",
    load("./legacy-golden-extra.json"),
    load("../public/def.json"),
  ],
  [
    "legacy golden extra 2 (def.json)",
    load("./legacy-golden-extra2.json"),
    load("../public/def.json"),
  ],
  ["legacy golden (xahau types)", load("./legacy-golden-xahau.json"), load("./xahau-defs.json")],
  [
    "legacy golden (xahau transactions)",
    load("./legacy-golden-xahau-txs.json"),
    load("./xahau-definitions.json"),
  ],
];

const strip = (s: string) => s.replace(/[\s\0]+/g, "");
const breakdownText = (row: Row) =>
  (row.breakdown ?? []).map((p) => p.text + (p.note ? `(${p.note})` : "")).join(" ");

describe.each(suites)("%s", (_title, golden, defs) => {
  const parseDefs = toParseDefs(defs);
  // Golden files are legacy captures with hard-coded XRP/XAH; the parser now prints native_currency_code || "XRP".
  const legacy = (s: string) => strip(s.replace(/(XRP|XAH)\b/g, parseDefs.native));
  for (const [name, c] of Object.entries(golden)) {
    it(name, () => {
      const input = classifyInput(c.input);
      if (input.kind === "json" || input.kind === "invalid") {
        expect(input.message).toBe(c.status);
        return;
      }
      if (input.kind !== "hex") throw new Error(`unexpected ${input.kind}`);
      if (input.rewritten) expect(input.hex).toBe(c.textarea);

      const { rows, status } = parse(input.hex, parseDefs);
      expect(strip(status.message)).toBe(legacy(c.status));
      expect(rows.length).toBe(c.rows.length);
      rows.forEach((row, n) => {
        const g = c.rows[n];
        expect(strip(row.label), `row ${n} label`).toBe(legacy(g.left));
        expect(strip(row.hex + breakdownText(row)), `row ${n} right`).toBe(legacy(g.right));
        expect(row.indent, `row ${n} indent`).toBe(g.indent);
      });
    });
  }
});
