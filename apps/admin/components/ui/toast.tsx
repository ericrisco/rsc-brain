"use client";

import { useEffect } from "react";

import { Button } from "./button";

export function Toast({
  title,
  description,
  tone = "info",
  onDismiss,
  duration = 5000,
}: {
  title: string;
  description?: string;
  tone?: "info" | "success" | "danger";
  onDismiss: () => void;
  duration?: number;
}) {
  useEffect(() => {
    if (duration <= 0) return;
    const timeout = window.setTimeout(onDismiss, duration);
    return () => window.clearTimeout(timeout);
  }, [duration, onDismiss]);

  const border =
    tone === "danger" ? "border-danger" : tone === "success" ? "border-success" : "border-info";
  return (
    <div
      role={tone === "danger" ? "alert" : "status"}
      aria-live={tone === "danger" ? "assertive" : "polite"}
      className={`fixed bottom-4 right-4 z-50 w-[min(24rem,calc(100%-2rem))] rounded-[var(--radius-overlay)] border ${border} bg-surface p-4 text-text-primary shadow-2xl`}
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm font-semibold">{title}</p>
          {description ? <p className="mt-1 text-sm text-text-secondary">{description}</p> : null}
        </div>
        <Button variant="ghost" size="sm" onClick={onDismiss}>
          Dismiss
        </Button>
      </div>
    </div>
  );
}
