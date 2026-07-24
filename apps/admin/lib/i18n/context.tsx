"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";

import { en, es, LOCALES, type Locale } from "./messages";

const CATALOGS = { en, es } as const;
const STORAGE_KEY = "rsc-brain.locale";

type TranslateFn = (key: string, vars?: Record<string, string | number>) => string;

interface I18nValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: TranslateFn;
}

const I18nContext = createContext<I18nValue | null>(null);

function lookup(catalog: typeof en, key: string): string {
  const value = key.split(".").reduce<unknown>((node, part) => {
    if (node && typeof node === "object" && part in node) {
      return (node as Record<string, unknown>)[part];
    }
    return undefined;
  }, catalog);
  return typeof value === "string" ? value : key;
}

function interpolate(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (_match, name: string) =>
    name in vars ? String(vars[name]) : `{${name}}`,
  );
}

function detectInitial(): Locale {
  if (typeof window === "undefined") return "en";
  const stored = window.localStorage.getItem(STORAGE_KEY);
  if (stored && (LOCALES as string[]).includes(stored)) return stored as Locale;
  const browser = window.navigator.language.slice(0, 2);
  return browser === "es" ? "es" : "en";
}

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>("en");

  // Resolve the persisted/browser locale on the client only, to avoid a hydration mismatch.
  useEffect(() => setLocaleState(detectInitial()), []);
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    window.localStorage.setItem(STORAGE_KEY, next);
  }, []);

  const t = useCallback<TranslateFn>(
    (key, vars) => interpolate(lookup(CATALOGS[locale], key), vars),
    [locale],
  );

  const value = useMemo<I18nValue>(() => ({ locale, setLocale, t }), [locale, setLocale, t]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const value = useContext(I18nContext);
  if (!value) throw new Error("useI18n must be used within a LanguageProvider");
  return value;
}

/** Shorthand for the common case: just the translate function. */
export function useT(): TranslateFn {
  return useI18n().t;
}
