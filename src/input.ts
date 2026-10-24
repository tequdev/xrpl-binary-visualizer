export type ClassifiedInput =
  | { kind: "empty" }
  | { kind: "json"; value: unknown; message: string }
  | { kind: "hex"; hex: string; rewritten: boolean }
  | { kind: "invalid"; message: string };

export const HEX_RE = /^[A-Fa-f0-9]+$/;
export const BASE64_RE = /^[-A-Za-z0-9+/]*={0,3}$/;

export function classifyInput(raw: string): ClassifiedInput {
  if (raw === "") return { kind: "empty" };

  const nospace = raw.replace(/\s/gi, "");

  if (nospace[0] === "{") {
    // probably json
    try {
      return {
        kind: "json",
        value: JSON.parse(raw),
        message: "You entered json... Click a field!",
      };
    } catch {
      // not json, fall through
    }
  }

  if (!HEX_RE.test(nospace) /* not hex */ && BASE64_RE.test(nospace) /* and is base64 */) {
    let binstr: string;
    try {
      binstr = atob(nospace);
    } catch {
      // legacy threw here; report it as unusable input instead
      return invalid();
    }
    try {
      return {
        kind: "json",
        value: JSON.parse(binstr),
        message: "When decoding base64 I found it contained json... Click a field!",
      };
    } catch {
      // not json, convert to hex
    }
    let hex = "";
    for (let i = 0; i < binstr.length; ++i) {
      let h = binstr.charCodeAt(i).toString(16);
      if (h.length < 2) h = `0${h}`;
      hex += h;
    }
    // legacy re-ran the decoder on the empty string, which just clears
    if (hex === "") return { kind: "empty" };
    return { kind: "hex", hex, rewritten: true };
  }

  if (!HEX_RE.test(nospace)) return invalid();

  return { kind: "hex", hex: raw, rewritten: false };
}

function invalid(): ClassifiedInput {
  return {
    kind: "invalid",
    message: "Input was not base64 or hex, I don't know what to do with it...",
  };
}
