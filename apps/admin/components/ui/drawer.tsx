"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";

import { Button } from "./button";

export function Drawer({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const drawer = ref.current;
    if (!drawer) return;
    if (open && !drawer.open) drawer.showModal();
    if (!open && drawer.open) drawer.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClose={onClose}
      className="ml-0 h-dvh w-[min(24rem,calc(100%-2rem))] max-h-none rounded-r-[var(--radius-overlay)] border-0 border-r border-border-strong bg-surface p-0 text-text-primary shadow-2xl backdrop:bg-overlay"
    >
      <div className="flex h-full flex-col">
        <header className="flex min-h-14 items-center justify-between border-b border-border px-4">
          <p id={titleId} className="font-semibold">
            {title}
          </p>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Close
          </Button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">{children}</div>
      </div>
    </dialog>
  );
}
