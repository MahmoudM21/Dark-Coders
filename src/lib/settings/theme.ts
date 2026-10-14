import { useEffect } from "react";
import { useLocal } from "@/lib/settings/store";

export const ACCENTS = {
  green: { label: "Neon green", color: "#00ff88" },
  cyan: { label: "Cyan", color: "#22d3ee" },
  amber: { label: "Amber", color: "#ffb020" },
  violet: { label: "Violet", color: "#a78bfa" },
  rose: { label: "Rose", color: "#ff5c8a" },
} as const;
export type Accent = keyof typeof ACCENTS;

export const BACKGROUNDS = { graphite: "Graphite", midnight: "Midnight", forest: "Forest", room: "Studio" } as const;
export type Background = keyof typeof BACKGROUNDS;
export type ThemeSettings = { accent: Accent; blur: number; glass: number; radius: number; background: Background };
export const THEME_KEY = "openclaw.theme";
export const DEFAULT_THEME: ThemeSettings = { accent: "green", blur: 22, glass: 55, radius: 18, background: "graphite" };
export const THEME_LIMITS = { blur: [0, 40], glass: [20, 95], radius: [6, 32] } as const;

export function useTheme() {
  return useLocal<ThemeSettings>(THEME_KEY, DEFAULT_THEME);
}

export function clampTheme(t: ThemeSettings): ThemeSettings {
  const c = (v: number, [lo, hi]: readonly [number, number]) => Math.min(hi, Math.max(lo, Math.round(v)));
  return {
    accent: t.accent in ACCENTS ? t.accent : "green",
    background: t.background in BACKGROUNDS ? t.background : "graphite",
    blur: c(t.blur, THEME_LIMITS.blur),
    glass: c(t.glass, THEME_LIMITS.glass),
    radius: c(t.radius, THEME_LIMITS.radius),
  };
}

/** Writes the theme into the page's design tokens so every surface updates live. */
export function useApplyTheme() {
  const [theme] = useTheme();
  useEffect(() => {
    const t = clampTheme(theme);
    const root = document.documentElement.style;
    document.documentElement.dataset['background'] = t.background;
    root.setProperty("--dc-green", ACCENTS[t.accent].color);
    root.setProperty("--glass-blur", `${t.blur}px`);
    root.setProperty("--glass-alpha", `${t.glass}%`);
    root.setProperty("--theme-radius", `${t.radius}px`);
  }, [theme]);
}
