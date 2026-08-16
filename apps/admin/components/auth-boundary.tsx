"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, type ReactNode } from "react";

import { Banner } from "@/components/ui/banner";
import { Button } from "@/components/ui/button";
import { useMe } from "@/lib/api/hooks";
import type { UiError } from "@/lib/api/ui-error";
import { safeReturnPath } from "@/lib/auth/safe-return";
import { useT } from "@/lib/i18n/context";

function isUiError(value: unknown): value is UiError {
  return Boolean(value && typeof value === "object" && "kind" in value && "messageKey" in value);
}

export function AuthBoundary({ children }: { children: ReactNode }) {
  const { data, isLoading, isError, error, refetch } = useMe();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const router = useRouter();
  const t = useT();
  const query = searchParams.toString();
  const uiError = isUiError(error) ? error : undefined;
  const expired = isError && uiError?.kind === "session-expired";

  useEffect(() => {
    if (!expired) return;
    const returnTo = safeReturnPath(`${pathname}${query ? `?${query}` : ""}`);
    router.replace(`/login?${new URLSearchParams({ returnTo }).toString()}`);
  }, [expired, pathname, query, router]);

  if (isLoading || (!data && !isError)) {
    return (
      <div
        data-testid="shell-layout"
        className="min-h-screen bg-canvas lg:grid lg:grid-cols-[14.5rem_minmax(0,1fr)]"
      >
        <aside aria-hidden="true" className="hidden border-r border-border bg-surface lg:block" />
        <div className="min-w-0">
          <header className="h-14 border-b border-border bg-canvas">
            <span className="sr-only">rsc-brain</span>
          </header>
          <main
            id="main-content"
            role="status"
            aria-label={t("common.loadingConsole")}
            className="grid min-h-[calc(100vh-3.5rem)] place-items-center text-sm text-text-secondary"
          >
            <span>{t("common.loading")}</span>
          </main>
        </div>
      </div>
    );
  }

  if (expired) return null;

  if (isError || !data) {
    const messageKey = uiError?.messageKey ?? "errors.unexpected";
    return (
      <div
        data-testid="shell-layout"
        className="min-h-screen bg-canvas lg:grid lg:grid-cols-[14.5rem_minmax(0,1fr)]"
      >
        <aside aria-hidden="true" className="hidden border-r border-border bg-surface lg:block" />
        <div className="min-w-0">
          <header className="h-14 border-b border-border bg-canvas">
            <span className="sr-only">rsc-brain</span>
          </header>
          <main id="main-content" className="mx-auto grid min-h-[calc(100vh-3.5rem)] max-w-3xl place-items-center p-6">
            <Banner
              tone="danger"
              title={t(messageKey)}
              actions={
                typeof refetch === "function" ? (
                  <Button variant="outline" onClick={() => void refetch()}>
                    {t("common.retry")}
                  </Button>
                ) : undefined
              }
            >
              {uiError?.traceId
                ? `${t("common.traceId")}: ${uiError.traceId}`
                : t("common.tryAgain")}
            </Banner>
          </main>
        </div>
      </div>
    );
  }

  return children;
}
