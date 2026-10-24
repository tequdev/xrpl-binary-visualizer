import { useEffect, useRef, useState } from "react";
import { loadDefinitions, toParseDefs } from "./definitions.ts";
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
              <span className="part">{p.text} </span>
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

const KICKERS: Partial<Record<Row["kind"], string>> = {
  type: "Type-code",
  field: "Field-code",
  payload: "Field-contents",
};

function RowView({ row }: { row: Row }) {
  return (
    <div className={`row ${row.kind}`} style={{ marginLeft: `${row.indent}em` }}>
      <div className="kicker">{KICKERS[row.kind]}</div>
      <div className="lbl">{row.label}</div>
      <div className="hex">
        {row.hex}
        {row.breakdown ? <Breakdown parts={row.breakdown} /> : null}
      </div>
    </div>
  );
}

const STATUS_CLASS: Partial<Record<Status["kind"], string>> = {
  good: "callout-good",
  bad: "x-callout-error",
  ugly: "x-callout-error",
  info: "x-callout-warn",
};

export function App() {
  const [defs, setDefs] = useState<ParseDefs | null>(null);
  const [text, setText] = useState("");
  const [stack, setStack] = useState<string[]>([]);
  const [status, setStatus] = useState<Status>({ kind: "clear", message: "" });
  const [view, setView] = useState<View>({ kind: "none" });
  const [defsState, setDefsState] = useState<"loading" | "ready" | "error">("loading");
  const focusedWith = useRef("");
  const defsUrl = window.location.search.slice(1);

  useEffect(() => {
    let cancelled = false;
    const url = window.location.search.slice(1);
    loadDefinitions(url)
      .then((d) => {
        if (cancelled) return;
        setDefs(toParseDefs(d));
        setDefsState("ready");
      })
      .catch((e) => {
        console.log(e);
        if (cancelled) return;
        setDefsState("error");
        setStatus({ kind: "ugly", message: `Could not load: ${url}` });
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

  const rows = view.kind === "rows" ? view.rows : null;
  const statusClass = STATUS_CLASS[status.kind];
  const dot = { loading: "x-dot-wait", ready: "x-dot-live", error: "" }[defsState];
  const defsLabel = {
    loading: "Loading definitions…",
    ready: `Definitions: ${defsUrl.trim() === "" ? "xahau.network" : defsUrl}`,
    error: "Definitions failed to load",
  }[defsState];

  return (
    <>
      <header className="x-topbar">
        <div className="x-container x-topbar-row">
          <h1 className="x-brand">Xahau Binary Visualizer</h1>
          <a
            className="x-btn x-btn-secondary"
            href="https://github.com/tequdev/xrpl-binary-visualizer"
          >
            GitHub
          </a>
        </div>
      </header>
      <main className="x-container">
        <p className="intro">
          Paste a Xahau / XRPL hex blob, base64 or JSON and see how the STObject is decoded, field
          by field.
        </p>
        <div className="x-stack">
          <section className="x-card">
            <div className="x-card-head">
              <h2>Input</h2>
              <span className="x-state">
                <span className={`x-dot ${dot}`} />
                {defsLabel}
              </span>
            </div>
            <div className="x-card-body input-body">
              <label>
                <span className="x-label">Hex / base64 / JSON</span>
                <textarea
                  className="x-input tainput"
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
              </label>
              <div className="actions">
                <button type="button" className="x-btn" onClick={() => decode(text, stack)}>
                  Decode
                </button>
                {stack.length > 0 ? (
                  <button type="button" className="x-btn x-btn-secondary" onClick={up}>
                    Go up
                  </button>
                ) : null}
              </div>
              {statusClass && status.message ? (
                <div className={`status ${statusClass}`} role="status">
                  {status.message}
                </div>
              ) : null}
            </div>
          </section>
          <section className="x-card">
            <div className="x-card-head">
              <h2>Decoded</h2>
              {rows?.length ? (
                <span className="x-badge x-badge-glass">{rows.length} rows</span>
              ) : null}
            </div>
            <div className="x-card-body">
              {view.kind === "none" ? (
                <div className="x-box muted">The decoded fields appear here.</div>
              ) : null}
              {view.kind === "json" ? (
                <div className="x-box json">
                  <JsonValue v={view.value} level={0} pick={pick} />
                </div>
              ) : null}
              {rows ? (
                <div className="rows">
                  {rows.map((row, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: rows are static and never reordered
                    <RowView key={i} row={row} />
                  ))}
                </div>
              ) : null}
            </div>
          </section>
        </div>
        <footer className="x-footer">
          Xahau Binary Visualizer · <a href="https://xahau.network">xahau.network</a> · Original by{" "}
          <a href="https://github.com/RichardAH/xrpl-binary-visualizer">Richard Holland</a>
        </footer>
      </main>
    </>
  );
}
