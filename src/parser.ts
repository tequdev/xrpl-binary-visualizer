/*
XRPL serialized object format visualizer
Author: Richard Holland
Date: 6 October 2020
*/

// Ported from the single-file legacy index.html. The state machine in parse() is deliberately a
// verbatim if-chain: several states (4->5, 61->5, 31->5, 23->5, 182->183, 185->181, 190->191)
// fall through into the next block, so block order matters. Do not reorder or convert to switch.

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

export type ParseDefs = { types: Record<string, number>; lookup: TypeLookup };

export function parse(hex: string, defs: ParseDefs): ParseResult {
  const rows: Row[] = [];
  let indent_level = 0;
  let unknown_detected = false;

  const push = (kind: Row["kind"], label: string, h: string, breakdown?: BreakdownPart[]) => {
    const row: Row = { kind, label, hex: h, indent: indent_level };
    if (breakdown) row.breakdown = breakdown;
    rows.push(row);
  };

  function print_error(c: string, label = "Invalid character") {
    rows.push({ kind: "error", label, hex: c, indent: 0 });
  }

  function print_type(t: number, h: string) {
    let s = "Unknown";
    for (const k in defs.types) {
      if (defs.types[k] === t) {
        s = k;
        break;
      }
    }

    if (s === "Unknown") unknown_detected = true;

    s = s.replaceAll("Hash", "UInt").toUpperCase();

    if (s.substring(0, 2) === "ST") s = s.substring(2);

    push("type", s, h);
  }

  function print_field(t: number, fc: number, h: string) {
    let s = "[[UNKNOWN_FIELD]]";

    if (t in defs.lookup && fc in defs.lookup[t]) s = defs.lookup[t][fc].name;
    else unknown_detected = true;

    push("field", s, h);
  }

  function print_explain(h: string, msg: string) {
    push("explain", msg, h);
  }

  function print_explain_payload(h: string, msg: string) {
    push("explainPayload", msg, h);
  }

  function print_explain_payload_special(h: string, msg: string, breakdown: BreakdownPart[]) {
    push("special", msg, h, breakdown);
  }

  function print_payload(_t: string, _f: string, h: string, msg: string) {
    push("payload", msg === "&nbsp;" ? "" : msg, h);
  }

  const inp = hex;
  const inp_nospace = inp.replace(/\s/gi, "");

  unknown_detected = false;

  let negative_depth = false;

  let state = 0;
  let to_accumulate = 0;

  let hexaccum = "";
  let vec_counter = 0;

  let lastnibble = 0;

  let st_type = 0;
  let st_field = 0;

  let field_hex = "";

  let array_depth = 0;
  let object_depth = 0;

  let amount_type = -1;
  let mantissa_carry = 0;
  let flags = 0;
  let i = 0;
  for (i = 0; i < inp.length; ++i) {
    let nibble = 0;
    const ascii = inp.charCodeAt(i);
    if (ascii >= 48 && ascii <= 57) {
      // 0-9
      nibble = ascii - 48;
    } else if (ascii >= 65 && ascii <= 70) {
      // A-F
      nibble = ascii - 65 + 10;
    } else if (ascii >= 97 && ascii <= 102) {
      // a-f
      nibble = ascii - 97 + 10;
    } else if (ascii === 32 || ascii === 9 || ascii === 10 || ascii === 13) {
      // whitepsace, skip
      continue;
    } else {
      print_error(inp[i]);
      break;
    }

    if (state === 51) {
      hexaccum += inp[i];
      if (st_type === 6 && to_accumulate === -1 && nibble & 8) {
        to_accumulate = 96; // non-xrp currency
        amount_type = 1;
      } else if (st_type === 6 && to_accumulate === -1 && (nibble & 8) === 0) {
        to_accumulate = 16; // xrp currency
        amount_type = 0;
      } else if (st_type === 8 && to_accumulate === 41) {
        // accumulate the 2 VL nibbles at the start of the account field
        print_explain(hexaccum, "account vl prefix");
        if (hexaccum === "00") to_accumulate = 1;
        hexaccum = "";
        amount_type = -1;
      }

      to_accumulate--;
      if (amount_type === 0) {
        if (to_accumulate === 15) {
          let r = parseInt(hexaccum, 16) >>> 0;
          r &= 0x3;
          mantissa_carry = r;
          let rbits = r.toString(2);
          if (rbits.length === 1) rbits = `0${rbits}`;

          print_explain_payload_special(hexaccum, "Flags", [
            { text: "Bit" },
            { text: "0", note: "XAH Bit" },
            { text: "1", note: "Sign Bit + Positve" },
            { text: rbits, note: "First bits of drops integer" },
          ]);
          hexaccum = "";
        } else if (to_accumulate === 0) {
          print_explain_payload_special(hexaccum, "XAH Drops", [
            { text: "Dec" },
            {
              text: String(mantissa_carry + parseInt(hexaccum, 16)),
              note: "XAH Drops including two bits above",
            },
          ]);
          amount_type = -1;
          state = 0;
        }
      } else if (amount_type === 1) {
        if (to_accumulate === 93) {
          const firstthree = parseInt(hexaccum.slice(0, 3), 16);
          const bits = firstthree >> 10;

          const exponent_num = ((firstthree >> 2) & 0xff) >>> 0;
          let exponent = exponent_num.toString(2);
          if (exponent.length !== 8) exponent = "0".repeat(8 - exponent.length) + exponent;

          print_explain_payload_special(hexaccum, "Flags + Exponent", [
            { text: "Bit" },
            { text: "1", note: "Not XRP Bit" },
            {
              text: String(bits & 1),
              note: bits & 1 ? "Sign Bit + Positive" : "Sign Bit - Negative",
            },
            {
              text: exponent,
              note: `Exponent Raw: ${exponent_num}, Adjusted: ${exponent_num - 97}`,
            },
            {
              text: `${firstthree & 0x2}${firstthree & 0x1}`,
              note: "First two bits of mantissa",
            },
          ]);
          mantissa_carry = (firstthree & 0x3) << 52;

          hexaccum = "";
        } else if (to_accumulate === 80) {
          print_explain_payload_special(hexaccum, "Mantissa", [
            { text: "Dec" },
            {
              text: String(mantissa_carry + parseInt(hexaccum, 16)),
              note: "Mantissa including two bits above",
            },
          ]);
          hexaccum = "";
        } else if (to_accumulate === 40) {
          const currency =
            String.fromCharCode(parseInt(hexaccum.slice(24, 26), 16)) +
            String.fromCharCode(parseInt(hexaccum.slice(26, 28), 16)) +
            String.fromCharCode(parseInt(hexaccum.slice(28, 30), 16));
          print_explain_payload_special(hexaccum, "Currency Code", [
            { text: "Asc" },
            { text: currency },
          ]);
          hexaccum = "";
        } else if (to_accumulate === 0) {
          print_explain_payload(hexaccum, "Issuer");
          hexaccum = "";
          state = 0;
          amount_type = -1;
        }
      } else if (amount_type === -1 && to_accumulate === 0) {
        print_payload("", "", hexaccum, "&nbsp;");
        state = 0;
      }
      continue;
    }

    if (state === 70) {
      // parsing a VL field
      hexaccum = inp[i];
      lastnibble = nibble;
      state = 71;
      continue;
    }

    if (state === 71) {
      hexaccum += inp[i];
      const b = (lastnibble << 4) + nibble;
      if (b <= 192) {
        to_accumulate = b * 2;
        print_explain(hexaccum, `1 byte length ${b}`);
        hexaccum = "";
        if (to_accumulate === 0) state = 0;
        else state = st_type === 19 ? 190 : 51;
        continue;
      } else if (b >= 193 && b <= 240) {
        to_accumulate = (b - 193) * 256 + 193;
        state = 72;
        continue;
      } else {
        to_accumulate = 12481 + (b - 241) * 65536;
        state = 74;
        continue;
      }
    }

    if (state === 72) {
      hexaccum += inp[i];
      lastnibble = nibble;
      state = 73;
      continue;
    }
    if (state === 73) {
      hexaccum += inp[i];
      const b = (lastnibble << 4) + nibble;
      to_accumulate += b;
      print_explain(hexaccum, `2 byte length ${to_accumulate}`);
      to_accumulate *= 2;
      hexaccum = "";
      state = st_type === 19 ? 190 : 51;
      continue;
    }

    if (state === 74) {
      hexaccum += inp[i];
      lastnibble = nibble;
      state = 75;
      continue;
    }
    if (state === 75) {
      hexaccum += inp[i];
      const b = (lastnibble << 4) + nibble;
      to_accumulate += b * 256;
      state = 76;
      continue;
    }

    if (state === 76) {
      hexaccum += inp[i];
      lastnibble = nibble;
      state = 77;
      continue;
    }
    if (state === 77) {
      hexaccum += inp[i];
      const b = (lastnibble << 4) + nibble;
      to_accumulate += b;
      print_explain(hexaccum, `3 byte length ${to_accumulate}`);
      to_accumulate *= 2;
      hexaccum = "";
      state = st_type === 19 ? 190 : 51;
      continue;
    }

    if (state === -4) {
      // check if its another nop (type)
      if (nibble === 9) {
        hexaccum += nibble;
        state = -3;
        continue;
      } else {
        if (hexaccum !== "") {
          print_payload("", "", hexaccum, "");
          hexaccum = "";
        }
        state = 0; // fall through
      }
    }

    if (state === -3) {
      hexaccum += nibble;
      if (nibble === 0) {
        // field uncommon
        state = -2;
        continue;
      }
      state = -4;
      continue;
    }

    if (state === -2) {
      hexaccum += nibble;
      state = -4;
      continue;
    }

    if (state === 0) {
      // parsing type
      if (nibble === 0) {
        print_explain(inp[i], "type uncommon");
        state = 1;
        continue;
      }

      st_type = nibble; // this is the case where it's a one nibble type
      print_type(st_type, inp[i]);
      state = 4; // expect 4 bit field code
      continue;
    }

    if (state === 4) {
      if (nibble === 0) {
        print_explain(inp[i], "field uncommon");
        state = 6;
        continue;
      }

      st_field = nibble;
      print_field(st_type, nibble, inp[i]);
      if (st_type === 9) {
        // nop
        hexaccum = "";
        state = -4;
        continue;
      }

      state = 5; // state 5 is a fallthrough state so do not continue
    }

    if (state === 6) {
      lastnibble = nibble; // store the high nibble of fieldcode
      hexaccum = inp[i];
      state = 61;
      continue;
    }

    if (state === 61) {
      hexaccum += inp[i];
      st_field = (lastnibble << 4) + nibble;
      print_field(st_type, st_field, hexaccum);
      state = 5; // both type code (4 bits) and field code (8 bits) parsed
    }

    if (state === 1) {
      // parsing type with first nibble = 0
      if (nibble === 0) {
        print_explain(inp[i], "both type and field uncommon");
        state = 2; // expect 8 bit typecode next followed by 8 bit field code
        continue;
      }

      st_field = nibble; // we cant print until we parse type
      field_hex = inp[i];

      state = 3; // except 8 bit typecode next, we still need to print field
      continue;
    }

    if (state === 3) {
      // expect 8 bit typecode
      lastnibble = nibble; // store the high nibble of typecode
      hexaccum = inp[i];
      state = 31;
      continue;
    }

    if (state === 31) {
      hexaccum += inp[i];
      st_type = (lastnibble << 4) + nibble;
      // we still need to print the field because it came first but we didnt know it until we had type
      print_field(st_type, st_field, field_hex);
      print_type(st_type, hexaccum);
      state = 5; // both field code (4 bits) and type code (8 bits) parsed
    }

    if (state === 2) {
      // expect 8 bit typecode followed by 8 bit field code
      lastnibble = nibble; // store the high nibble of typecode
      hexaccum = inp[i];
      state = 21;
      continue;
    }

    if (state === 21) {
      hexaccum += inp[i];
      st_type = (lastnibble << 4) + nibble;
      print_type(st_type, hexaccum);
      state = 22; // expect 8 bit field code
      continue;
    }

    if (state === 22) {
      lastnibble = nibble;
      hexaccum = inp[i];
      state = 23;
      continue;
    }

    if (state === 23) {
      hexaccum += inp[i];
      st_field = (lastnibble << 4) + nibble;
      print_field(st_type, st_field, hexaccum);
      state = 5; // type and field read
    }

    if (state === 240) {
      hexaccum += inp[i];
      if (--to_accumulate === 0) {
        print_payload("", "", hexaccum, "currency");
        if (hexaccum !== "0".repeat(40)) {
          state = 241;
          hexaccum = "";
          to_accumulate = 40;
          continue;
        }
        state = 0;
      }
      continue;
    }

    if (state === 241) {
      hexaccum += inp[i];
      if (--to_accumulate === 0) {
        print_payload("", "", hexaccum, "issuer");
        hexaccum = "";
        state = 0;
      }
      continue;
    }

    if (state === 250) {
      // account
      hexaccum += inp[i];
      if (--to_accumulate === 0) {
        print_payload("", "", hexaccum, "locking chain door");
        hexaccum = "";
        state = 251;
        to_accumulate = 40;
      }
      continue;
    }

    if (state === 251) {
      // currency
      hexaccum += inp[i];
      if (--to_accumulate === 0) {
        print_payload("", "", hexaccum, "locking chain currency");
        if (hexaccum !== "0".repeat(40)) {
          // we need to read a currency-issuer first
          state = 252;
          hexaccum = "";
          to_accumulate = 42;
          continue;
        } else {
          // skip to issuing chain door
          state = 253;
          hexaccum = "";
          to_accumulate = 42;
          continue;
        }
      }
      continue;
    }

    if (state === 252) {
      // account
      hexaccum += inp[i];
      if (--to_accumulate === 0) {
        print_payload("", "", hexaccum, "locking chain issuer");
        hexaccum = "";
        to_accumulate = 42;
        state = 253;
      }
      continue;
    }

    if (state === 253) {
      // account
      hexaccum += inp[i];
      if (--to_accumulate === 0) {
        print_payload("", "", hexaccum, "issuing chain door");
        hexaccum = "";
        state = 254;
        to_accumulate = 40;
      }
      continue;
    }

    if (state === 254) {
      // currnecy
      hexaccum += inp[i];
      if (--to_accumulate === 0) {
        print_payload("", "", hexaccum, "issuing chain currency");
        if (hexaccum !== "0".repeat(40)) {
          // we need to read a currency-issuer first
          hexaccum = "";
          state = 255;
          to_accumulate = 42;
          continue;
        }
        state = 0;
      }
      continue;
    }

    if (state === 255) {
      // account
      hexaccum += inp[i];
      if (--to_accumulate === 0) {
        print_payload("", "", hexaccum, "issuing chain issuer");
        hexaccum = "";
        state = 0;
      }
      continue;
    }

    if (state === 260) {
      // currency
      hexaccum += inp[i];
      if (--to_accumulate === 0) {
        const isNative = hexaccum === "00".repeat(20);
        const currency = isNative
          ? "XAH"
          : String.fromCharCode(parseInt(hexaccum.slice(24, 26), 16)) +
            String.fromCharCode(parseInt(hexaccum.slice(26, 28), 16)) +
            String.fromCharCode(parseInt(hexaccum.slice(28, 30), 16));
        print_explain_payload_special(hexaccum, "currency", [{ text: currency }]);
        state = 0;
      }
      continue;
    }

    if (state === 5) {
      // now we process VL if any and print the field contents
      hexaccum = "";

      if (st_type === 1) to_accumulate = 4;
      else if (st_type === 2) to_accumulate = 8;
      else if (st_type === 3) to_accumulate = 16;
      else if (st_type === 4) to_accumulate = 32;
      else if (st_type === 5) to_accumulate = 64;
      else if (st_type === 6) {
        to_accumulate =
          -1; /* special value because we need the next byte to know how big 16 or 96 */
        amount_type = -1;
      } else if (st_type === 24) {
        to_accumulate = 40;
        state = 240;
        continue;
      } else if (st_type === 25) {
        to_accumulate = 42;
        state = 250;
        continue;
      } else if (st_type === 26) {
        to_accumulate = 40;
        state = 260;
        continue;
      } else if (st_type === 7) {
        state = 70;
        continue;
      } else if (st_type === 8) to_accumulate = 42;
      else if (st_type === 14) {
        if (st_field === 1) {
          object_depth--; // end of object
          indent_level -= 2;
          if (object_depth < 0) negative_depth = true;
        } else {
          object_depth++;
          indent_level += 2;
        }
        state = 0;
        continue;
      } else if (st_type === 15) {
        if (st_field === 1) {
          array_depth--; // end of array
          indent_level -= 2;
          if (array_depth < 0) negative_depth = true;
        } else {
          array_depth++;
          indent_level += 2;
        }
        state = 0;
        continue;
      } else if (st_type === 16) to_accumulate = 2;
      else if (st_type === 17) to_accumulate = 40;
      else if (st_type === 18) {
        indent_level += 2;
        state = 180;
        continue;
      } else if (st_type === 19) {
        state = 70;
        continue;
      } else {
        // legacy passed a string as the output element here, so this was a silent no-op (no row
        // was ever rendered); the golden fixture depends on that, so we only stop parsing.
        break;
      }

      state = 51;
      continue;
    }

    if (state === 190) {
      // vector256
      if (to_accumulate === 0) {
        state = 0;
        continue;
      }
      hexaccum = "";
      state = 191;
      vec_counter = 0;
    }

    if (state === 191) {
      if (to_accumulate % 64 === 0 && hexaccum !== "") {
        print_payload("", "", hexaccum, `hash ${vec_counter++}`);
        hexaccum = "";
      }
      to_accumulate--;
      hexaccum += inp[i];
      if (to_accumulate <= 0) {
        print_payload("", "", hexaccum, `hash ${vec_counter++}`);
        hexaccum = "";
        vec_counter = 0;
        state = 0;
        continue;
      }
      continue;
    }

    if (state === 182) {
      // pathset accountid or currency or issuer
      to_accumulate--;
      hexaccum += inp[i];
      if (to_accumulate <= 0)
        state = flags === 0 ? 184 : 183; // fallthru
      else continue;
    }

    if (state === 183) {
      // display parsed field
      if (flags & 0x01) {
        print_payload("", "", hexaccum, "account");
        flags -= 0x01;
      } else if (flags & 0x10) {
        print_payload("", "", hexaccum, "currency");
        flags -= 0x10;
      } else if (flags & 0x20) {
        print_payload("", "", hexaccum, "issuer");
        flags -= 0x20;
      }

      if (flags > 0) {
        state = 182;
        to_accumulate = 40;
        hexaccum = "";
        continue;
      }

      state = 184;
      continue;
    }

    if (state === 184) {
      lastnibble = nibble;
      state = 185;
      continue;
    }

    if (state === 185) {
      // check if continue or end byte for path set
      const byte = (lastnibble << 4) + nibble;

      if (byte === 0x00) {
        // end byte
        indent_level -= 4;
        print_explain(`${inp[i - 1]}${inp[i]}`, "pathset end");
        state = 0;
        continue;
      } else if (byte === 0xff) {
        // continue byte
        indent_level -= 2;
        print_explain(`${inp[i - 1]}${inp[i]}`, "pathset continue");
        state = 180;
        continue;
      } else {
        // another path step
        indent_level -= 2;
        flags = byte;
        state = 181; // fall through
      }
    }

    if (state === 180) {
      // pathset lead byte
      lastnibble = nibble;
      state = 181;
      continue;
    }

    if (state === 181) {
      // pathset second byte
      flags = (lastnibble << 4) + nibble;

      print_explain(
        `${inp[i - 1]}${inp[i]}`,
        "step w/ " +
          (flags & 0x1 ? "account " : "") +
          (flags & 0x10 ? "currency " : "") +
          (flags & 0x20 ? "issuer" : "") +
          ""
      );

      let tmp = flags;
      if (tmp === 0) break;

      if (tmp & 0x01) tmp -= 0x01;

      if (tmp & 0x10) tmp -= 0x10;

      if (tmp & 0x20) tmp -= 0x20;

      if (tmp !== 0) break;

      indent_level += 2;

      hexaccum = "";
      to_accumulate = 40;
      state = 182;
      continue;
    }

    print_error("?", "Unknown parsing state maybe something wasn't implemented yet? Report this!");
    break;
  }

  if (
    !unknown_detected &&
    i === inp.length &&
    object_depth === 0 &&
    array_depth === 0 &&
    state === 0 &&
    !negative_depth
  )
    return { rows, status: { kind: "good", message: "Looks like a valid STObject." } };

  const ugly = (message: string): ParseResult => ({ rows, status: { kind: "ugly", message } });

  const indent_info =
    (object_depth !== 0 ? " and one or more internal objects lacked a terminator" : "") +
    (array_depth !== 0 ? " and one or more internal arrays lacked a terminator" : "") +
    (negative_depth ? " and one or more internal objects or arrays lacked a header" : "");

  const up = inp_nospace.toUpperCase();
  const len = up.length;
  if (len === 66 || len === 64 || len === 40)
    return ugly(
      "Parser did not complete cleanly" +
        indent_info +
        (unknown_detected ? " and unknown fields were detected" : "") +
        " ...\nby the way this " +
        (up[0] === "E" && up[1] === "D" && len === 66
          ? "is definitely a public key not an STObject"
          : len === 66
            ? "might be a public key."
            : len === 40
              ? "might be an AccountID."
              : "might be a hash.")
    );
  if (unknown_detected)
    return ugly(
      "Unknown fields detected " +
        (i === up.length ? "" : "and parser did not end cleanly, ") +
        "either not an STObject or wrong definitions.json. Try adding: ?url-to-your-definitions.json to the current URL"
    );

  return ugly(
    `Parser did not complete cleanly${indent_info}, if this is an STObject it is incomplete.`
  );
}
