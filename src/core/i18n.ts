import { TR } from './locales/tr.ts';

/**
 * English strings are the keys; a translation that's missing falls back to
 * them. `{0}`, `{1}`... are filled with the arguments in order.
 */
const TABLES: Record<string, Record<string, string>> = { tr: TR };

let table: Record<string, string> = {};

/** Follows Obsidian's own language (`getLanguage()`), set once at load. */
export function setLanguage(code: string): void {
  table = TABLES[code.toLowerCase().split('-')[0]] ?? {};
}

export function t(key: string, ...args: (string | number)[]): string {
  const text = table[key] ?? key;
  return args.length === 0 ? text : text.replace(/\{(\d+)\}/g, (match, index: string) => {
    const value = args[Number(index)];
    return value === undefined ? match : String(value);
  });
}

/** "1 file" / "3 files", with the count filled in. */
export function plural(count: number, one: string, many: string): string {
  return t(count === 1 ? one : many, count);
}
