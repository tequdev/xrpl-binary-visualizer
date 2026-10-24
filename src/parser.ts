/*
XRPL serialized object format visualizer
Author: Richard Holland
Date: 6 October 2020
*/

// Structured decoder. Originally a nibble-by-nibble state machine (2020); it now reads whole
// fields through a HexReader. Running out of input anywhere throws EndOfInput, which is caught
// once in parse(): rows pushed before the throw are kept, nothing partial is pushed.

import type { TypeLookup } from "./definitions.ts";

export type BreakdownPart = { text: string; note?: string };

export type Row = {
  kind: "type" | "field" | "explain" | "payload" | "explainPayload" | "special" | "error";
  label: string;
  hex: string;
  indent: number;
  breakdown?: BreakdownPart[];
};

export type StatusKind = "clear" | "good" | "bad" | "ugly" | "info";
export type Status = { kind: StatusKind; message: string };
export type ParseResult = { rows: Row[]; status: Status };

export type ParseDefs = {
  types: Record<string, number>;
  lookup: TypeLookup;
  /** Native asset code shown in Amount/Currency rows (e.g. XRP, XAH). */
  native: string;
};

/** Serialized type codes. */
const TYPE = {
  UInt16: 1,
  UInt32: 2,
  UInt64: 3,
  Hash128: 4,
  Hash256: 5,
  Amount: 6,
  Blob: 7,
  AccountID: 8,
  /** Type 9 is not a real type; the original visualizer treats it as padding ("nops"). */
  NOP: 9,
  STObject: 14,
  STArray: 15,
  UInt8: 16,
  Hash160: 17,
  PathSet: 18,
  Vector256: 19,
  Issue: 24,
  XChainBridge: 25,
  Currency: 26,
} as const;

/** Field code that closes an STObject / STArray. */
const END_MARKER_FIELD = 1;

/** Indent (in em) added per nesting level: objects, arrays and pathset steps. */
const INDENT_STEP = 2;

const bytes = (n: number) => n * 2; // bytes -> nibbles

/** Payload size of the fixed-width types. */
const FIXED_NIBBLES: Record<number, number> = {
  [TYPE.UInt8]: bytes(1),
  [TYPE.UInt16]: bytes(2),
  [TYPE.UInt32]: bytes(4),
  [TYPE.UInt64]: bytes(8),
  [TYPE.Hash128]: bytes(16),
  [TYPE.Hash160]: bytes(20),
  [TYPE.Hash256]: bytes(32),
};

const NATIVE_AMOUNT_NIBBLES = bytes(8);
// IOU amount = 48 bytes: 3 nibbles flags+exponent, 13 mantissa, 40 currency, 40 issuer
const IOU_FLAGS_EXPONENT_NIBBLES = 3;
const IOU_MANTISSA_NIBBLES = 13;
const NOT_NATIVE_BIT = 8; // bit 3 of the first nibble
const EXPONENT_BIAS = 97;
const CURRENCY_NIBBLES = bytes(20);
const ACCOUNT_NIBBLES = bytes(20);
const ACCOUNT_WITH_VL_NIBBLES = bytes(21); // 1 VL byte + 20 bytes (XChainBridge doors/issuers)
const ZERO_CURRENCY = "0".repeat(CURRENCY_NIBBLES);

/** Variable length prefix limits. */
const VL_ONE_BYTE_MAX = 192;
const VL_TWO_BYTE_MAX = 240;
const VL_TWO_BYTE_OFFSET = 193;
const VL_THREE_BYTE_MIN = 241;
const VL_THREE_BYTE_OFFSET = 12481;

/** Vector256 chunk size in nibbles. */
const HASH256_NIBBLES = bytes(32);

/** PathSet step flags. */
const PATH_ACCOUNT = 0x01;
const PATH_CURRENCY = 0x10;
const PATH_ISSUER = 0x20;
const PATH_END = 0x00;
const PATH_CONTINUE = 0xff;

class EndOfInput extends Error {}

type Chunk = { hex: string; value: number };

/** Sequential reader over a whitespace-free hex string. Preserves the original character case. */
class HexReader {
  private pos = 0;
  constructor(private readonly s: string) {}

  atEnd(): boolean {
    return this.pos >= this.s.length;
  }

  /** Reads n nibbles and returns the original characters. */
  take(n: number): string {
    if (this.pos + n > this.s.length) throw new EndOfInput();
    const out = this.s.slice(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  private chunk(n: number): Chunk {
    const hex = this.take(n);
    return { hex, value: Number.parseInt(hex, 16) };
  }

  nibble(): Chunk {
    return this.chunk(1);
  }

  byte(): Chunk {
    return this.chunk(2);
  }

  /** Value of the next nibble without consuming it. */
  peek(): number {
    if (this.atEnd()) throw new EndOfInput();
    return Number.parseInt(this.s[this.pos], 16);
  }
}

type FieldHeader = { type: number; field: number; compact: boolean };

export function parse(hex: string, defs: ParseDefs): ParseResult {
  const input = hex.replace(/\s/g, "");
  const r = new HexReader(input);
  const rows: Row[] = [];
  let indent = 0;
  let unknownDetected = false;
  let negativeDepth = false;
  const depth = { object: 0, array: 0 };

  const push = (kind: Row["kind"], label: string, h: string, breakdown?: BreakdownPart[]) => {
    const row: Row = { kind, label, hex: h, indent };
    if (breakdown) row.breakdown = breakdown;
    rows.push(row);
  };

  const pushType = (t: number, h: string) => {
    let name = "Unknown";
    for (const k in defs.types) {
      if (defs.types[k] === t) {
        name = k;
        break;
      }
    }
    if (name === "Unknown") unknownDetected = true;
    name = name.replaceAll("Hash", "UInt").toUpperCase();
    if (name.startsWith("ST")) name = name.substring(2);
    push("type", name, h);
  };

  const pushField = (t: number, fc: number, h: string) => {
    let name = "[[UNKNOWN_FIELD]]";
    if (t in defs.lookup && fc in defs.lookup[t]) name = defs.lookup[t][fc].name;
    else unknownDetected = true;
    push("field", name, h);
  };

  /** Reads n nibbles into a payload row; returns the hex. */
  const payload = (label: string, nibbles: number): string => {
    const h = r.take(nibbles);
    push("payload", label, h);
    return h;
  };

  const asciiCode = (h: string) =>
    String.fromCharCode(parseInt(h.slice(24, 26), 16)) +
    String.fromCharCode(parseInt(h.slice(26, 28), 16)) +
    String.fromCharCode(parseInt(h.slice(28, 30), 16));

  /** Type + field code, in every encoding. Emits the explain/type/field rows. */
  function readFieldHeader(): FieldHeader {
    const first = r.nibble();
    if (first.value !== 0) {
      const type = first.value;
      pushType(type, first.hex);
      const f = r.nibble();
      if (f.value !== 0) {
        pushField(type, f.value, f.hex);
        return { type, field: f.value, compact: true };
      }
      push("explain", "field uncommon", f.hex);
      const fc = r.byte();
      pushField(type, fc.value, fc.hex);
      return { type, field: fc.value, compact: false };
    }

    push("explain", "type uncommon", first.hex);
    const second = r.nibble();
    if (second.value !== 0) {
      const t = r.byte();
      // legacy quirk: the field row comes before the type row because the field nibble came first
      pushField(t.value, second.value, second.hex);
      pushType(t.value, t.hex);
      return { type: t.value, field: second.value, compact: false };
    }

    push("explain", "both type and field uncommon", second.hex);
    const t = r.byte();
    pushType(t.value, t.hex);
    const f = r.byte();
    pushField(t.value, f.value, f.hex);
    return { type: t.value, field: f.value, compact: false };
  }

  /** Reads a variable length prefix, emits its explain row and returns the byte length. */
  function readVL(): number {
    const b1 = r.byte();
    if (b1.value <= VL_ONE_BYTE_MAX) {
      push("explain", `1 byte length ${b1.value}`, b1.hex);
      return b1.value;
    }
    if (b1.value <= VL_TWO_BYTE_MAX) {
      const b2 = r.byte();
      const len = VL_TWO_BYTE_OFFSET + (b1.value - VL_TWO_BYTE_OFFSET) * 256 + b2.value;
      push("explain", `2 byte length ${len}`, b1.hex + b2.hex);
      return len;
    }
    const b2 = r.byte();
    const b3 = r.byte();
    const len =
      VL_THREE_BYTE_OFFSET + (b1.value - VL_THREE_BYTE_MIN) * 65536 + b2.value * 256 + b3.value;
    push("explain", `3 byte length ${len}`, b1.hex + b2.hex + b3.hex);
    return len;
  }

  function readBlob() {
    const len = readVL();
    if (len > 0) payload("", bytes(len));
  }

  function readVector256() {
    let remaining = bytes(readVL());
    let acc = "";
    let n = 0;
    while (remaining > 0) {
      const c = r.take(1);
      // chunks are cut on the remaining count, so an inconsistent length yields a short first chunk
      if (remaining % HASH256_NIBBLES === 0 && acc !== "") {
        push("payload", `hash ${n++}`, acc);
        acc = "";
      }
      remaining--;
      acc += c;
    }
    if (acc !== "") push("payload", `hash ${n}`, acc);
  }

  function readAccount() {
    const prefix = r.byte();
    push("explain", "account vl prefix", prefix.hex);
    // legacy quirk: a "00" prefix yields an empty payload row instead of reading an account
    push("payload", "", prefix.hex === "00" ? "" : r.take(ACCOUNT_NIBBLES));
  }

  function readAmount() {
    const first = r.nibble();
    if ((first.value & NOT_NATIVE_BIT) === 0) {
      const carry = first.value & 0x3;
      push("special", "Flags", first.hex, [
        { text: "Bit" },
        { text: "0", note: `${defs.native} Bit` },
        { text: "1", note: "Sign Bit + Positve" },
        { text: carry.toString(2).padStart(2, "0"), note: "First bits of drops integer" },
      ]);
      const drops = r.take(NATIVE_AMOUNT_NIBBLES - 1);
      push("special", `${defs.native} Drops`, drops, [
        { text: "Dec" },
        {
          text: String(carry + parseInt(drops, 16)),
          note: `${defs.native} Drops including two bits above`,
        },
      ]);
      return;
    }

    const head = first.hex + r.take(IOU_FLAGS_EXPONENT_NIBBLES - 1);
    const firstthree = parseInt(head, 16);
    const bits = firstthree >> 10;
    const exponentNum = ((firstthree >> 2) & 0xff) >>> 0;
    const exponent = exponentNum.toString(2).padStart(8, "0");
    push("special", "Flags + Exponent", head, [
      { text: "Bit" },
      { text: "1", note: `Not ${defs.native} Bit` },
      { text: String(bits & 1), note: bits & 1 ? "Sign Bit + Positive" : "Sign Bit - Negative" },
      {
        text: exponent,
        note: `Exponent Raw: ${exponentNum}, Adjusted: ${exponentNum - EXPONENT_BIAS}`,
      },
      { text: `${firstthree & 0x2}${firstthree & 0x1}`, note: "First two bits of mantissa" },
    ]);
    // legacy quirk: JS shifts by (52 & 31) = 20 bits here, not 52
    const carry = (firstthree & 0x3) << 52;

    const mantissa = r.take(IOU_MANTISSA_NIBBLES);
    push("special", "Mantissa", mantissa, [
      { text: "Dec" },
      { text: String(carry + parseInt(mantissa, 16)), note: "Mantissa including two bits above" },
    ]);

    const currency = r.take(CURRENCY_NIBBLES);
    push("special", "Currency Code", currency, [{ text: "Asc" }, { text: asciiCode(currency) }]);

    push("explainPayload", "Issuer", r.take(ACCOUNT_NIBBLES));
  }

  /** Reads a 20 byte currency payload row; true if it is not the all-zero (native) currency. */
  function readCurrencyPayload(label: string): boolean {
    return payload(label, CURRENCY_NIBBLES) !== ZERO_CURRENCY;
  }

  function readIssue() {
    if (readCurrencyPayload("currency")) payload("issuer", ACCOUNT_NIBBLES);
  }

  function readXChainBridge() {
    payload("locking chain door", ACCOUNT_WITH_VL_NIBBLES);
    if (readCurrencyPayload("locking chain currency"))
      payload("locking chain issuer", ACCOUNT_WITH_VL_NIBBLES);
    payload("issuing chain door", ACCOUNT_WITH_VL_NIBBLES);
    if (readCurrencyPayload("issuing chain currency"))
      payload("issuing chain issuer", ACCOUNT_WITH_VL_NIBBLES);
  }

  function readCurrency() {
    const h = r.take(CURRENCY_NIBBLES);
    const text = h === ZERO_CURRENCY ? defs.native : asciiCode(h);
    push("special", "currency", h, [{ text }]);
  }

  /** Returns false when the step flags are unusable and parsing must stop. */
  function readPathSet(): boolean {
    indent += INDENT_STEP;
    let step = r.byte();
    for (;;) {
      const flags = step.value;
      push(
        "explain",
        "step w/ " +
          (flags & PATH_ACCOUNT ? "account " : "") +
          (flags & PATH_CURRENCY ? "currency " : "") +
          (flags & PATH_ISSUER ? "issuer" : ""),
        step.hex
      );
      if (flags === 0 || flags & ~(PATH_ACCOUNT | PATH_CURRENCY | PATH_ISSUER)) return false;

      indent += INDENT_STEP;
      if (flags & PATH_ACCOUNT) payload("account", ACCOUNT_NIBBLES);
      if (flags & PATH_CURRENCY) payload("currency", CURRENCY_NIBBLES);
      if (flags & PATH_ISSUER) payload("issuer", ACCOUNT_NIBBLES);

      const next = r.byte();
      if (next.value === PATH_END) {
        indent -= 2 * INDENT_STEP; // closes the step and the pathset
        push("explain", "pathset end", next.hex);
        return true;
      }
      indent -= INDENT_STEP;
      if (next.value === PATH_CONTINUE) {
        push("explain", "pathset continue", next.hex);
        step = r.byte();
      } else {
        step = next;
      }
    }
  }

  /** Padding: nibble 9 followed by another nibble (and one more if that is 0), accumulated in decimal. */
  function readNops() {
    let acc = "";
    for (;;) {
      if (r.peek() !== TYPE.NOP) {
        if (acc !== "") push("payload", "", acc);
        return;
      }
      r.nibble();
      acc += TYPE.NOP;
      const m = r.nibble();
      acc += m.value;
      if (m.value === 0) acc += r.nibble().value;
    }
  }

  function nest(kind: "object" | "array", field: number) {
    if (field === END_MARKER_FIELD) {
      depth[kind]--;
      indent -= INDENT_STEP;
      if (depth[kind] < 0) negativeDepth = true;
    } else {
      depth[kind]++;
      indent += INDENT_STEP;
    }
  }

  /** Reads the value of a field. Returns false when parsing must stop (unknown type, bad pathset). */
  function readBody({ type, field, compact }: FieldHeader): boolean {
    if (type in FIXED_NIBBLES) {
      payload("", FIXED_NIBBLES[type]);
      return true;
    }
    switch (type) {
      case TYPE.Amount:
        readAmount();
        return true;
      case TYPE.Blob:
        readBlob();
        return true;
      case TYPE.AccountID:
        readAccount();
        return true;
      case TYPE.STObject:
        nest("object", field);
        return true;
      case TYPE.STArray:
        nest("array", field);
        return true;
      case TYPE.PathSet:
        return readPathSet();
      case TYPE.Vector256:
        readVector256();
        return true;
      case TYPE.Issue:
        readIssue();
        return true;
      case TYPE.XChainBridge:
        readXChainBridge();
        return true;
      case TYPE.Currency:
        readCurrency();
        return true;
      case TYPE.NOP:
        // legacy: nops only exist with a one-nibble type and one-nibble field
        if (!compact) return false;
        readNops();
        return true;
      default:
        // legacy rendered nothing for unknown types, the golden fixtures depend on that
        return false;
    }
  }

  // "clean": ended on a field boundary, "truncated": ran out of input, "stopped": gave up early
  let outcome: "clean" | "truncated" | "stopped" = "clean";
  try {
    while (!r.atEnd()) {
      if (!readBody(readFieldHeader())) {
        outcome = "stopped";
        break;
      }
    }
  } catch (e) {
    if (!(e instanceof EndOfInput)) throw e;
    outcome = "truncated";
  }

  if (
    !unknownDetected &&
    outcome === "clean" &&
    depth.object === 0 &&
    depth.array === 0 &&
    !negativeDepth
  )
    return { rows, status: { kind: "good", message: "Looks like a valid STObject." } };

  const ugly = (message: string): ParseResult => ({ rows, status: { kind: "ugly", message } });

  const indentInfo =
    (depth.object !== 0 ? " and one or more internal objects lacked a terminator" : "") +
    (depth.array !== 0 ? " and one or more internal arrays lacked a terminator" : "") +
    (negativeDepth ? " and one or more internal objects or arrays lacked a header" : "");

  const up = input.toUpperCase();
  const len = up.length;
  if (len === 66 || len === 64 || len === 40)
    return ugly(
      "Parser did not complete cleanly" +
        indentInfo +
        (unknownDetected ? " and unknown fields were detected" : "") +
        " ...\nby the way this " +
        (up[0] === "E" && up[1] === "D" && len === 66
          ? "is definitely a public key not an STObject"
          : len === 66
            ? "might be a public key."
            : len === 40
              ? "might be an AccountID."
              : "might be a hash.")
    );
  if (unknownDetected)
    return ugly(
      "Unknown fields detected " +
        (outcome === "stopped" ? "and parser did not end cleanly, " : "") +
        "either not an STObject or wrong definitions.json. Try adding: ?url-to-your-definitions.json to the current URL"
    );

  return ugly(
    `Parser did not complete cleanly${indentInfo}, if this is an STObject it is incomplete.`
  );
}
