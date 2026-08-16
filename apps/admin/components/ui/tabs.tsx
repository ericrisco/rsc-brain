"use client";

import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export type TabItem = { value: string; label: string; count?: number };

export function Tabs({
  items,
  value,
  onValueChange,
  label,
  children,
}: {
  items: TabItem[];
  value: string;
  onValueChange: (value: string) => void;
  label: string;
  children?: ReactNode;
}) {
  return (
    <div>
      <div role="tablist" aria-label={label} className="flex gap-1 overflow-x-auto border-b border-border">
        {items.map((item) => {
          const selected = item.value === value;
          return (
            <button
              key={item.value}
              type="button"
              role="tab"
              id={`tab-${item.value}`}
              aria-controls={selected && children ? `panel-${item.value}` : undefined}
              aria-selected={selected}
              tabIndex={selected ? 0 : -1}
              onClick={() => onValueChange(item.value)}
              onKeyDown={(event) => {
                const current = items.findIndex((candidate) => candidate.value === item.value);
                let target = current;
                if (event.key === "ArrowRight") target = (current + 1) % items.length;
                else if (event.key === "ArrowLeft") target = (current - 1 + items.length) % items.length;
                else if (event.key === "Home") target = 0;
                else if (event.key === "End") target = items.length - 1;
                else return;
                event.preventDefault();
                const next = items[target];
                if (!next) return;
                onValueChange(next.value);
                document.getElementById(`tab-${next.value}`)?.focus();
              }}
              className={cn(
                "relative min-h-11 whitespace-nowrap px-3 text-sm font-medium text-text-secondary transition-colors duration-[var(--motion-fast)] hover:text-text-primary",
                selected && "text-text-primary after:absolute after:inset-x-3 after:bottom-0 after:h-0.5 after:bg-interactive",
              )}
            >
              {item.label}
              {typeof item.count === "number" ? (
                <span className="ml-2 font-mono text-xs text-text-secondary">{item.count}</span>
              ) : null}
            </button>
          );
        })}
      </div>
      {children ? (
        <div role="tabpanel" id={`panel-${value}`} aria-labelledby={`tab-${value}`} className="pt-5">
          {children}
        </div>
      ) : null}
    </div>
  );
}
