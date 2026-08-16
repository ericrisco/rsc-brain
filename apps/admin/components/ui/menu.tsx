"use client";

import {
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
} from "react";

import { cn } from "@/lib/utils";

export function Menu({
  label,
  children,
  className,
  ...props
}: HTMLAttributes<HTMLDivElement> & { label: ReactNode }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const items = () =>
    Array.from(rootRef.current?.querySelectorAll<HTMLElement>("[role='menuitem']:not([disabled])") ?? []);

  const closeAndRestoreFocus = () => {
    setOpen(false);
    window.requestAnimationFrame(() => triggerRef.current?.focus());
  };

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const menuItems = items();
    const current = menuItems.indexOf(document.activeElement as HTMLElement);
    let target = current;
    if (event.key === "ArrowDown") target = (current + 1) % menuItems.length;
    else if (event.key === "ArrowUp") target = (current - 1 + menuItems.length) % menuItems.length;
    else if (event.key === "Home") target = 0;
    else if (event.key === "End") target = menuItems.length - 1;
    else if (event.key === "Escape") {
      event.preventDefault();
      closeAndRestoreFocus();
      return;
    } else if (event.key === "Tab") {
      setOpen(false);
      return;
    } else return;
    event.preventDefault();
    menuItems[target]?.focus();
  };

  return (
    <div ref={rootRef} className={cn("relative", className)} {...props}>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
          event.preventDefault();
          setOpen(true);
          window.requestAnimationFrame(() => {
            const menuItems = items();
            menuItems[event.key === "ArrowUp" ? menuItems.length - 1 : 0]?.focus();
          });
        }}
        className="flex min-h-11 cursor-pointer items-center rounded-[var(--radius-control)] px-3 text-sm font-medium text-text-primary hover:bg-surface-subtle focus-visible:ring-2 focus-visible:ring-focus"
      >
        {label}
      </button>
      {open ? (
        <div
          role="menu"
          aria-orientation="vertical"
          onKeyDown={onMenuKeyDown}
          onClick={(event) => {
            if ((event.target as HTMLElement).closest("[role='menuitem']")) closeAndRestoreFocus();
          }}
          className="absolute right-0 z-50 mt-1 min-w-48 rounded-[var(--radius-overlay)] border border-border-strong bg-surface p-1 shadow-2xl"
        >
          {children}
        </div>
      ) : null}
    </div>
  );
}

export function MenuItem({ children, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      role="menuitem"
      tabIndex={-1}
      className="flex min-h-10 w-full items-center rounded-[var(--radius-control)] px-3 text-left text-sm text-text-primary hover:bg-surface-subtle focus-visible:bg-selected"
      {...props}
    >
      {children}
    </button>
  );
}
