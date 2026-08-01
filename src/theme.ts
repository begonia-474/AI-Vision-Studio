import { useCallback, useEffect, useState } from "react";

export type ThemeMode = "dark" | "light" | "system";

export const THEME_KEY = "theme";

function prefersLight(): boolean {
  return window.matchMedia?.("(prefers-color-scheme: light)").matches ?? false;
}

export function applyTheme(mode: ThemeMode): void {
  const light = mode === "light" || (mode === "system" && prefersLight());
  document.documentElement.dataset.theme = light ? "light" : "dark";
}

export function loadTheme(): ThemeMode {
  try {
    const s = localStorage.getItem(THEME_KEY);
    if (s === "dark" || s === "light" || s === "system") return s;
  } catch {
    /* ignore */
  }
  return "system";
}

export function useTheme(): { theme: ThemeMode; setTheme: (t: ThemeMode) => void } {
  const [theme, setThemeState] = useState<ThemeMode>(loadTheme);

  useEffect(() => {
    applyTheme(theme);
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      /* ignore */
    }
    if (theme !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    const onChange = () => applyTheme("system");
    mq.addEventListener?.("change", onChange);
    return () => mq.removeEventListener?.("change", onChange);
  }, [theme]);

  const setTheme = useCallback((t: ThemeMode) => setThemeState(t), []);
  return { theme, setTheme };
}
