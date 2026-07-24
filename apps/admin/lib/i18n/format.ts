// Locale-aware date/number formatting (SPEC-26, FR-13.10). Thin wrappers over Intl so every view
// formats consistently in the active language.

import type { Locale } from "./messages";

const BCP47: Record<Locale, string> = { en: "en-US", es: "es-ES" };

export function formatNumber(value: number, locale: Locale): string {
  return new Intl.NumberFormat(BCP47[locale]).format(value);
}

export function formatDateTime(value: string | null | undefined, locale: Locale): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(BCP47[locale], { dateStyle: "medium", timeStyle: "short" }).format(
    date,
  );
}

export function formatDate(value: string | null | undefined, locale: Locale): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(BCP47[locale], { dateStyle: "medium" }).format(date);
}
