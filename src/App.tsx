import { useEffect, useRef, useState } from "react";
import { buildTypeLookup, loadDefinitions } from "./definitions.ts";
import { BASE64_RE, classifyInput, HEX_RE } from "./input.ts";
import { type ParseResult, parse, type Row, type Status } from "./parser.ts";

type ParseDefs = Parameters<typeof parse>[1];

type View = { kind: "none" } | { kind: "json"; value: unknown } | { kind: "rows"; rows: Row[] };

const NO_DEFS: Status = {
  kind: "ugly",
  message: "No definitions loaded. Try attach ?def.json to the url",
};

function JsonValue({ v, level, pick }: { v: unknown; level: number; pick: (s: string) => void }) {
  if (typeof v === "string") {
    const stripped = v.replace(/\s/gi, "");
    const body = JSON.stringify(v).slice(1, -1);
    const clickable = HEX_RE.test(stripped) || BASE64_RE.test(stripped);
    return (
      <>
        "
        {clickable ? (
          <button type="button" className="clickable" onClick={() => pick(stripped)}>
            {body}
          </button>
        ) : (
          body
        )}
        "
      </>
    );
  }
  if (v === null || typeof v !== "object") return <>{JSON.stringify(v)}</>;

  const isArray = Array.isArray(v);
  const entries: [string, unknown][] = isArray
    ? v.map((x, i) => [String(i), x])
    : Object.entries(v);
  const [open, close] = isArray ? ["[", "]"] : ["{", "}"];
  if (entries.length === 0) return <>{open + close}</>;
  const pad = "  ".repeat(level + 1);
  return (
    <>
      {open}
      {entries.map(([k, x], n) => (
        <span key={k}>
          {"\n"}
          {pad}
          {isArray ? null : `${JSON.stringify(k)}: `}
          <JsonValue v={x} level={level + 1} pick={pick} />
          {n < entries.length - 1 ? "," : null}
        </span>
      ))}
      {`\n${"  ".repeat(level)}${close}`}
    </>
  );
}

function Breakdown({ parts }: { parts: NonNullable<Row["breakdown"]> }) {
  return (
    <div className="breakdown">
      {parts.map((p, i) => {
        const key = i;
        return (
          <span key={key}>
            {i === 0 && !p.note && parts.length > 1 ? (
              <span className="label">{p.text} </span>
            ) : (
              <>{p.text} </>
            )}
            {p.note ? <small>({p.note}) </small> : null}
          </span>
        );
      })}
    </div>
  );
}

const CLASSES: Record<Row["kind"], { row: string; left: string; right: string }> = {
  type: { row: "type", left: "typetext left", right: "typehex right" },
  field: { row: "field", left: "fieldtext left", right: "fieldhex right" },
  explain: { row: "explain", left: "explaintext left", right: "explainhex right" },
  explainPayload: { row: "explain", left: "explaintext left", right: "payloadhex right" },
  special: { row: "explain", left: "explaintext left", right: "payloadhex right" },
  payload: { row: "payload", left: "payloadtext left", right: "payloadhex right" },
  error: { row: "invalid", left: "invalid left", right: "invalid right" },
};

function RowView({ row }: { row: Row }) {
  const c = CLASSES[row.kind];
  const bold = row.kind === "type" || row.kind === "field";
  return (
    <div className={`row ${c.row}`} style={{ marginLeft: `${row.indent}em` }}>
      <div className={c.left}>{bold ? <b>{row.label}</b> : row.label || "\u00a0"}</div>
      <div className={c.right}>
        {row.hex}
        {row.breakdown ? <Breakdown parts={row.breakdown} /> : null}
      </div>
    </div>
  );
}

export function App() {
  const [defs, setDefs] = useState<ParseDefs | null>(null);
  const [text, setText] = useState("");
  const [stack, setStack] = useState<string[]>([]);
  const [status, setStatus] = useState<Status>({ kind: "clear", message: "" });
  const [view, setView] = useState<View>({ kind: "none" });
  const focusedWith = useRef("");

  useEffect(() => {
    let cancelled = false;
    const url = window.location.search.slice(1);
    loadDefinitions(url)
      .then((d) => {
        if (!cancelled) setDefs({ types: d.TYPES, lookup: buildTypeLookup(d) });
      })
      .catch((e) => {
        console.log(e);
        if (!cancelled) setStatus({ kind: "ugly", message: `Could not load: ${url}` });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function show(r: ParseResult | Status, v: View, nextText: string, nextStack: string[]) {
    setText(nextText);
    setStack(nextStack);
    setView(v);
    setStatus("status" in r ? r.status : r);
  }

  function decode(value: string, nextStack: string[]) {
    if (!defs) {
      setStatus(NO_DEFS);
      return;
    }
    const c = classifyInput(value);
    switch (c.kind) {
      case "empty":
        return show({ kind: "clear", message: "" }, { kind: "none" }, value, nextStack);
      case "json":
        return show(
          { kind: "info", message: c.message },
          { kind: "json", value: c.value },
          value,
          nextStack
        );
      case "invalid":
        return show({ kind: "bad", message: c.message }, { kind: "none" }, value, nextStack);
      case "hex": {
        const r = parse(c.hex, defs);
        return show(r, { kind: "rows", rows: r.rows }, c.rewritten ? c.hex : value, nextStack);
      }
    }
  }

  const pick = (leaf: string) => decode(leaf, [...stack, text]);
  const up = () => {
    const v = stack[stack.length - 1];
    if (v !== undefined) decode(v, stack.slice(0, -1));
  };

  const showBanner = status.message !== "" || stack.length > 0;

  return (
    <>
      <textarea
        rows={5}
        className="tainput"
        data-kind={status.kind}
        placeholder="Paste your Xahau/XRPL related HEX/json/base64 here then click outside the box to decode."
        value={text}
        onChange={(e) => setText(e.target.value)}
        onFocus={(e) => {
          focusedWith.current = e.target.value;
        }}
        // legacy used onchange: only decode when the value changed since focus
        onBlur={(e) => {
          if (e.target.value !== focusedWith.current) decode(e.target.value, []);
        }}
      />
      {showBanner ? (
        <div id="errormsg" data-kind={status.kind}>
          {status.message}
          {status.message ? " " : null}
          {stack.length > 0 ? (
            <button type="button" className="clickable" onClick={up}>
              Go up
            </button>
          ) : null}
        </div>
      ) : null}
      <div className="output">
        {view.kind === "json" ? (
          <div className="json">
            <JsonValue v={view.value} level={0} pick={pick} />
          </div>
        ) : null}
        {view.kind === "rows"
          ? view.rows.map((row, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: rows are static and never reordered
              <RowView key={i} row={row} />
            ))
          : null}
      </div>
    </>
  );
}
