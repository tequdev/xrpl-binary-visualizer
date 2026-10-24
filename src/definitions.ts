export type FieldInfo = {
  nth: number;
  type: string;
  isVLEncoded: boolean;
  isSigningField: boolean;
};

export type Definitions = {
  TYPES: Record<string, number>;
  FIELDS: [string, FieldInfo][];
};

export type TypeLookup = Record<
  number,
  Record<number, { name: string; vl: boolean; signing: boolean }>
>;

export const DEFAULT_DEFINITIONS_URL = "https://xahau.network/server_definitions.json";

export function buildTypeLookup(defs: Definitions): TypeLookup {
  const lookup: TypeLookup = {};
  for (const [name, info] of defs.FIELDS) {
    const code = defs.TYPES[info.type] ?? -1;
    lookup[code] ??= {};
    lookup[code][info.nth] = { name, vl: info.isVLEncoded, signing: info.isSigningField };
  }
  return lookup;
}

export async function loadDefinitions(url?: string): Promise<Definitions> {
  const res = await fetch(url === undefined || url.trim() === "" ? DEFAULT_DEFINITIONS_URL : url);
  const json = await res.json();
  return Object.keys(json).length === 1 && json.result ? json.result : json;
}
