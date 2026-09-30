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

function readStored(): Locale | null {
  try {
    const saved = localStorage.getItem(LOCALE_STORAGE_KEY);
    return isLocale(saved) ? saved : null;
  } catch {
    return null;
  }
}

function detectLocale(): Locale {
  const saved = readStored();
  if (saved) return saved;
  const browser = navigator.language.toLowerCase().split("-")[0];
  return isLocale(browser) ? browser : "az";
}

export function LocaleProvider({ children }: { children: React.ReactNode }) {
  const me = trpc.auth.me.useQuery(undefined, { retry: false, refetchOnWindowFocus: false });
  const saveLocale = trpc.auth.setLocale.useMutation();
  const [locale, setLocaleState] = useState<Locale>(detectLocale);
  setActiveLocale(locale);

  useEffect(() => {
    const profileLocale = me.data?.locale;
    if (!readStored() && isLocale(profileLocale) && profileLocale !== locale) setLocaleState(profileLocale);
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
