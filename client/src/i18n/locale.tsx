import { trpc } from "@/lib/trpc";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { isLocale, setActiveLocale, t, type Locale } from "./messages";

type LocaleContextValue = {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: typeof t;
};

const LocaleContext = createContext<LocaleContextValue | null>(null);
export const LOCALE_STORAGE_KEY = "resulio-locale";
/** Set when the person picked the language; a locale only detected from the browser never outranks their profile. */
export const LOCALE_CHOSEN_KEY = "resulio-locale-chosen";

function readStored(): Locale | null {
  try {
    const saved = localStorage.getItem(LOCALE_STORAGE_KEY);
    return isLocale(saved) ? saved : null;
  } catch {
    return null;
  }
}

function wasChosen(): boolean {
  try {
    return localStorage.getItem(LOCALE_CHOSEN_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * Default is always "az" on a first visit, on any device -- a visitor's own stored choice (this
 * browser) or signed-in profile preference (handled separately, below) still wins, but the
 * device/browser language is never used to guess it. Previously fell back to `navigator.language`,
 * which opened the site in English for anyone whose phone's system language was English even
 * though they'd never chosen that for Resulio -- inconsistent with desktop, where the browser
 * language more often happened to be az/ru already.
 */
function detectLocale(): Locale {
  return readStored() ?? "az";
}

export function LocaleProvider({ children }: { children: React.ReactNode }) {
  const me = trpc.auth.me.useQuery(undefined, { retry: false, refetchOnWindowFocus: false });
  const saveLocale = trpc.auth.setLocale.useMutation();
  const [locale, setLocaleState] = useState<Locale>(detectLocale);
  setActiveLocale(locale);

  useEffect(() => {
    const profileLocale = me.data?.locale;
    if (!wasChosen() && isLocale(profileLocale) && profileLocale !== locale) setLocaleState(profileLocale);
  }, [me.data?.locale, locale]);

  useEffect(() => {
    try {
      localStorage.setItem(LOCALE_STORAGE_KEY, locale);
    } catch {
      // storage unavailable: the choice still applies for this page view
    }
    document.documentElement.lang = locale;
    document.documentElement.dir = "ltr";
    document.title = `Resulio — ${t("brand.tagline")}`;
  }, [locale]);

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === LOCALE_STORAGE_KEY && isLocale(e.newValue)) setLocaleState(e.newValue);
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const signedIn = Boolean(me.data);
  const saveMutate = saveLocale.mutate;
  const setLocale = useCallback(
    (next: Locale) => {
      try {
        localStorage.setItem(LOCALE_CHOSEN_KEY, "1");
      } catch {
        // storage unavailable: the choice still applies for this page view
      }
      setLocaleState(next);
      if (signedIn) saveMutate({ locale: next });
    },
    [signedIn, saveMutate],
  );

  // `t` gets a new identity per locale so memoised consumers see the change.
  const value = useMemo<LocaleContextValue>(() => ({ locale, setLocale, t: (key, values) => t(key, values) }), [locale, setLocale]);

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useI18n() {
  const ctx = useContext(LocaleContext);
  if (!ctx) throw new Error("LocaleProvider missing");
  return ctx;
}
