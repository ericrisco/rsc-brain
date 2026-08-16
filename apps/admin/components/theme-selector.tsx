"use client";

import { useEffect, useState } from "react";

import { Select } from "@/components/ui/select";

export type ThemePreference = "system" | "light" | "dark";

const STORAGE_KEY = "rsc-brain.theme";

function currentTheme(): ThemePreference {
  const value = document.documentElement.dataset.theme;
  return value === "light" || value === "dark" ? value : "system";
}

function applyTheme(theme: ThemePreference) {
  document.documentElement.dataset.theme = theme;
  const effective =
    theme === "system"
      ? window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : theme;
  document.documentElement.style.colorScheme = effective;
}

export function ThemeSelector() {
  const [theme, setTheme] = useState<ThemePreference>("system");

  useEffect(() => {
    setTheme(currentTheme());
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const sync = () => currentTheme() === "system" && applyTheme("system");
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  return (
    <Select
      aria-label="Theme"
      value={theme}
      onChange={(event) => {
        const next = event.target.value as ThemePreference;
        setTheme(next);
        window.localStorage.setItem(STORAGE_KEY, next);
        applyTheme(next);
      }}
      className="min-w-28"
    >
      <option value="system">System</option>
      <option value="light">Light</option>
      <option value="dark">Dark</option>
    </Select>
  );
}
