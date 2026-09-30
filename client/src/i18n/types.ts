export type Locale = "az" | "ru" | "en";

/** One message in every supported locale: [az, en, ru]. Az is the source language. */
export type Entry = readonly [az: string, en: string, ru: string];
