import type { Metadata } from "next";
import { cookies, headers } from "next/headers";
import type { CSSProperties, ReactNode } from "react";

import "@fontsource-variable/ibm-plex-sans/index.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "@fontsource/ibm-plex-mono/600.css";

import { ThemeScript } from "@/components/theme-script";
import type { Locale } from "@/lib/i18n/messages";

import { Providers } from "./providers";
import "./globals.css";

export const metadata: Metadata = {
  title: "rsc-brain console",
  description: "Admin console for rsc-brain — consumes only the typed REST admin API.",
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const cookieStore = await cookies();
  const requestHeaders = await headers();
  const nonce = requestHeaders.get("x-nonce") ?? "";
  const localeCookie = cookieStore.get("rsc-brain.locale")?.value;
  const locale: Locale = localeCookie === "es" ? "es" : "en";

  return (
    <html lang={locale} data-theme="system" suppressHydrationWarning>
      <head>
        <ThemeScript nonce={nonce} />
      </head>
      <body
        style={
          {
            "--font-sans": '"IBM Plex Sans Variable"',
            "--font-mono": '"IBM Plex Mono"',
          } as CSSProperties
        }
      >
        <Providers locale={locale}>{children}</Providers>
      </body>
    </html>
  );
}
