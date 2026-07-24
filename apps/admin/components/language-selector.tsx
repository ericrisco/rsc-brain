"use client";

import { useI18n } from "@/lib/i18n/context";
import { LOCALES, type Locale } from "@/lib/i18n/messages";

const LABELS: Record<Locale, string> = { en: "English", es: "Español" };

/** Per-user language toggle (SPEC-26, FR-13.10); the choice persists in localStorage. */
export function LanguageSelector() {
  const { locale, setLocale, t } = useI18n();
  return (
    <select
      aria-label={t("common.language")}
      className="h-9 rounded-md border border-neutral-300 bg-transparent px-2 text-sm dark:border-neutral-700"
      value={locale}
      onChange={(event) => setLocale(event.target.value as Locale)}
    >
      {LOCALES.map((code) => (
        <option key={code} value={code}>
          {LABELS[code]}
        </option>
      ))}
    </select>
  );
}
