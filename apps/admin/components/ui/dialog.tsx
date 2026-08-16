"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";

import { Button } from "./button";

export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  actions,
  destructive = false,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children?: ReactNode;
  actions?: ReactNode;
  destructive?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClose={onClose}
      className="m-auto w-[min(36rem,calc(100%-2rem))] rounded-[var(--radius-overlay)] border border-border-strong bg-surface p-0 text-text-primary shadow-2xl backdrop:bg-overlay"
    >
      <div className="border-b border-border px-5 py-4">
        <p id={titleId} className="text-base font-semibold">
          {title}
        </p>
        {description ? (
          <p id={descriptionId} className="mt-1 text-sm text-text-secondary">
            {description}
          </p>
        ) : null}
      </div>
      {children ? <div className="px-5 py-5">{children}</div> : null}
      <div className="flex flex-wrap justify-end gap-2 border-t border-border bg-surface-subtle/55 px-5 py-4">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        {actions ?? (destructive ? <Button variant="destructive">Confirm</Button> : null)}
      </div>
    </dialog>
  );
}

export function AlertDialog(props: Parameters<typeof Dialog>[0]) {
  return <Dialog {...props} destructive />;
}
