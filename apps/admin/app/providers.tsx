"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";

import { LanguageProvider } from "@/lib/i18n/context";
import type { Locale } from "@/lib/i18n/messages";

export function Providers({ children, locale = "en" }: { children: ReactNode; locale?: Locale }) {
  const [client] = useState(
    () => new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false } } }),
  );
  return (
    <QueryClientProvider client={client}>
      <LanguageProvider initialLocale={locale}>{children}</LanguageProvider>
    </QueryClientProvider>
  );
}
