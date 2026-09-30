import { catalog } from "./catalog";
import type { Locale } from "./types";

export type { Entry, Locale } from "./types";
export type MessageKey = keyof typeof catalog;
export type MessageValues = Record<string, string | number>;

export const supportedLocales: readonly Locale[] = ["az", "ru", "en"];

/** Each language named in itself, so a reader can always find their own language. */
export const LOCALE_NAMES: Record<Locale, string> = { az: "Azərbaycanca", en: "English", ru: "Русский" };

const COLUMN: Record<Locale, 0 | 1 | 2> = { az: 0, en: 1, ru: 2 };

/** CLDR plural categories in the order their word forms are written in `{n|form|form…}`. */
const PLURAL_ORDER: Record<Locale, Intl.LDMLPluralRule[]> = {
  az: ["other"],
  en: ["one", "other"],
  ru: ["one", "few", "many"],
};

const pluralRules = new Map<Locale, Intl.PluralRules>();

function pluralForm(locale: Locale, n: number, forms: string[]): string {
  let rules = pluralRules.get(locale);
  if (!rules) {
    rules = new Intl.PluralRules(locale);
    pluralRules.set(locale, rules);
  }
  const index = PLURAL_ORDER[locale].indexOf(rules.select(n));
  return forms[index >= 0 ? index : forms.length - 1] ?? forms[0] ?? "";
}

export function isLocale(value: unknown): value is Locale {
  return supportedLocales.includes(value as Locale);
}

export function isMessageKey(key: string): key is MessageKey {
  return Object.prototype.hasOwnProperty.call(catalog, key);
}

/**
 * `{name}` inserts a value; `{count|one|other}` picks the plural word form for `count`
 * (Russian takes three forms: one|few|many).
 */
export function interpolate(template: string, values?: MessageValues, locale: Locale = "az"): string {
  if (!values) return template;
  return template.replace(/\{(\w+)(?:\|([^}]*))?\}/g, (match, name: string, forms: string | undefined) => {
    const value = values[name];
    if (value === undefined) return match;
    return forms === undefined ? String(value) : pluralForm(locale, Number(value), forms.split("|"));
  });
}

export function translate(locale: Locale, key: MessageKey, values?: MessageValues): string {
  const entry = catalog[key] as readonly string[] | undefined;
  return interpolate(entry ? entry[COLUMN[locale]] : key, values, locale);
}

let activeLocale: Locale = "az";

/** Set by LocaleProvider while rendering, before any child reads it. */
export function setActiveLocale(locale: Locale) {
  activeLocale = locale;
}

export function getLocale(): Locale {
  return activeLocale;
}

/** Translate in the active UI locale. Safe outside React; the whole tree re-renders on locale change. */
export function t(key: MessageKey, values?: MessageValues): string {
  return translate(activeLocale, key, values);
}
