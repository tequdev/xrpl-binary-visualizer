export type FieldInfo = {
  nth: number;
  type: string;
};

export type Definitions = {
  TYPES: Record<string, number>;
  FIELDS: [string, FieldInfo][];
  /** Native asset code shown in Amount/Currency rows; falls back to XRP. */
  native_currency_code?: string;
};

export const DEFAULT_DEFINITIONS_URL = "https://xahau.network/server_definitions.json";

export async function loadDefinitions(url?: string): Promise<Definitions> {
  const res = await fetch(url === undefined || url.trim() === "" ? DEFAULT_DEFINITIONS_URL : url);
  const json = await res.json();
  return Object.keys(json).length === 1 && json.result ? json.result : json;
}
