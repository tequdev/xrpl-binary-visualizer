import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildTypeLookup, type Definitions } from "../src/definitions.ts";
import { classifyInput } from "../src/input.ts";
import { parse, type Row } from "../src/parser.ts";

type Golden = {
  input: string;
  rows: { left: string; right: string; indent: number }[];
  status: string;
  textarea: string;
};

const golden: Record<string, Golden> = JSON.parse(
  readFileSync(new URL("./legacy-golden.json", import.meta.url), "utf8")
);
const defs: Definitions = JSON.parse(
  readFileSync(new URL("../public/def.json", import.meta.url), "utf8")
);
const parseDefs = { types: defs.TYPES, lookup: buildTypeLookup(defs) };

const strip = (s: string) => s.replace(/[\s\0]+/g, "");
const breakdownText = (row: Row) =>
  (row.breakdown ?? []).map((p) => p.text + (p.note ? `(${p.note})` : "")).join(" ");

describe("legacy golden", () => {
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
      expect(status.message).toBe(c.status);
      expect(rows.length).toBe(c.rows.length);
      rows.forEach((row, n) => {
        const g = c.rows[n];
        expect(strip(row.label), `row ${n} label`).toBe(strip(g.left));
        expect(strip(row.hex + breakdownText(row)), `row ${n} right`).toBe(strip(g.right));
        expect(row.indent, `row ${n} indent`).toBe(g.indent);
      });
    });
  }
});
