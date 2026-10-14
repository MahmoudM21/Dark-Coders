import { RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { ACCENTS, BACKGROUNDS, DEFAULT_THEME, THEME_LIMITS, useTheme, type Accent } from "@/lib/settings/theme";

/** Live theme controls: every change applies instantly and is saved (and synced when signed in). */
export function ThemeControls() {
  const [theme, setTheme] = useTheme();
  const row = (label: string, key: "blur" | "glass" | "radius", unit: string) => (
    <label className="block space-y-2">
      <span className="flex justify-between text-xs text-muted-foreground"><span>{label}</span><span className="font-mono text-foreground">{theme[key]}{unit}</span></span>
      <Slider min={THEME_LIMITS[key][0]} max={THEME_LIMITS[key][1]} step={1} value={[theme[key]]}
        onValueChange={([v]) => setTheme((p) => ({ ...p, [key]: v ?? p[key] }))} aria-label={label} />
    </label>
  );
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="dc-label">Live theme</p>
        <Button variant="ghost" size="sm" onClick={() => setTheme(DEFAULT_THEME)} className="h-7 gap-1 text-xs"><RotateCcw className="size-3" />Reset</Button>
      </div>
      <div className="flex gap-2" role="radiogroup" aria-label="Accent color">
        {(Object.keys(ACCENTS) as Accent[]).map((id) => (
          <Button key={id} variant="ghost" size="icon" type="button" role="radio" aria-checked={theme.accent === id} aria-label={ACCENTS[id].label} title={ACCENTS[id].label}
            onClick={() => setTheme((p) => ({ ...p, accent: id }))}
            style={{ background: ACCENTS[id].color }}
            className={`size-8 rounded-full border-2 transition-transform hover:scale-110 ${theme.accent === id ? "border-foreground" : "border-transparent"}`} />
        ))}
      </div>
      <fieldset className="space-y-2">
        <legend className="text-xs text-muted-foreground">Background</legend>
        <div className="grid grid-cols-2 gap-2">
          {Object.entries(BACKGROUNDS).map(([id, label]) => <Button key={id} variant="outline" aria-pressed={theme.background === id} onClick={() => setTheme((p) => ({ ...p, background: id as keyof typeof BACKGROUNDS }))} className={`h-auto justify-start gap-2 px-2 py-2 text-xs ${theme.background === id ? "border-primary text-primary" : ""}`}><span aria-hidden className={`background-swatch background-${id} size-6 shrink-0 rounded-md`} />{label}</Button>)}
        </div>
      </fieldset>
      {row("Glass blur", "blur", "px")}
      {row("Glass opacity", "glass", "%")}
      {row("Corner roundness", "radius", "px")}
    </div>
  );
}
