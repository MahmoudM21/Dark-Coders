import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useLocal } from "@/lib/settings/store";
import { BUILTIN, DEFAULT_PROVIDERS, KIND_INFO, PROVIDERS_KEY, findProvider, withPortfolio, type KeySource, type Provider, type ProviderKind } from "@/lib/settings/providers";

const field = "w-full rounded-md border border-border bg-background px-2 py-1.5 font-mono text-[11px] text-foreground outline-none focus:border-primary";

export function useProviders() {
  const [s, set] = useLocal(PROVIDERS_KEY, DEFAULT_PROVIDERS);
  // Portfolio models are always set up, so per-task chips have a real provider to run on.
  return [withPortfolio(s), set] as const;
}

/** Read-only readout of which model answers right now. Editing lives in General settings · Models. */
export function ModelStatus() {
  const [settings] = useProviders();
  const active = findProvider(settings, settings.activeId) ?? BUILTIN;
  const fallback = findProvider(settings, settings.fallbackId);
  const total = settings.providers.some((p) => p.id === "builtin") ? settings.providers.length : settings.providers.length + 1;
  return (
    <section className="panel border-primary/40 p-4">
      <div className="flex items-center justify-between">
        <p className="dc-label text-[10px]">Models · active now</p>
        <span className="font-mono text-[10px] text-primary">● Live</span>
      </div>
      <dl className="mt-3 space-y-1.5 text-[11px]">
        <div className="flex items-baseline justify-between gap-2"><dt className="shrink-0 text-muted-foreground">Answers with</dt><dd className="truncate font-mono text-foreground">{active.name} · {active.model}</dd></div>
        <div className="flex items-baseline justify-between gap-2"><dt className="shrink-0 text-muted-foreground">If it fails</dt><dd className="truncate font-mono text-foreground">{fallback ? fallback.name : "No fallback"}</dd></div>
        <div className="flex items-baseline justify-between gap-2"><dt className="shrink-0 text-muted-foreground">Connections</dt><dd className="font-mono text-foreground">{total}</dd></div>
      </dl>
      <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">Safety refusals never switch models. Choose another one under General settings · Models.</p>
    </section>
  );
}

/** Lets people add local or cloud model providers and choose which one answers, plus a fallback. */
export function ProviderSettings() {
  const [settings, setSettings] = useProviders();
  const [editing, setEditing] = useState<Provider | null>(null);
  const active = findProvider(settings, settings.activeId) ?? BUILTIN;
  const fallback = findProvider(settings, settings.fallbackId);
  const all = settings.providers.some((p) => p.id === "builtin") ? settings.providers : [BUILTIN, ...settings.providers];

  const save = (p: Provider) => {
    setSettings((s) => ({ ...s, providers: s.providers.some((x) => x.id === p.id) ? s.providers.map((x) => (x.id === p.id ? p : x)) : [...s.providers, p] }));
    setEditing(null);
  };
  const remove = (id: string) => setSettings((s) => ({
    providers: s.providers.filter((p) => p.id !== id),
    activeId: s.activeId === id ? "builtin" : s.activeId,
    fallbackId: s.fallbackId === id ? null : s.fallbackId,
  }));
  const startNew = (kind: ProviderKind) => {
    const info = KIND_INFO[kind];
    setEditing({ id: Math.random().toString(36).slice(2), name: info.label, kind, baseUrl: info.baseUrl, model: info.model, keySource: info.where === "cloud" ? "browser" : "none", vaultField: "api_key" });
  };

  return (
    <section className="panel border-primary/40 p-4">
      <div className="flex items-center justify-between">
        <p className="dc-label text-[10px]">Models · active now</p>
        <span className="font-mono text-[10px] text-primary">● Live</span>
      </div>
      <label className="mt-3 block text-[11px] text-muted-foreground">Answers with
        <select className={`${field} mt-1`} value={active.id} onChange={(e) => setSettings((s) => ({ ...s, activeId: e.target.value, fallbackId: s.fallbackId === e.target.value ? null : s.fallbackId }))}>
          {all.map((p) => <option key={p.id} value={p.id}>{p.name} · {p.model}</option>)}
        </select>
      </label>
      <label className="mt-2 block text-[11px] text-muted-foreground">If it fails, try
        <select className={`${field} mt-1`} value={settings.fallbackId ?? ""} onChange={(e) => setSettings((s) => ({ ...s, fallbackId: e.target.value || null }))}>
          <option value="">No fallback</option>
          {all.filter((p) => p.id !== active.id).map((p) => <option key={p.id} value={p.id}>{p.name} · {p.model}</option>)}
        </select>
      </label>
      <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
        {fallback ? `Switches to ${fallback.name} only when ${active.name} errors.` : "A failed answer shows an error."} Safety refusals never switch models.
      </p>

      <p className="dc-label mt-4 text-[10px]">Connections</p>
      <ul className="mt-2 space-y-1">
        {all.map((p) => (
          <li key={p.id} className="flex items-center gap-2 rounded-md border border-border px-2 py-1.5">
            <span className="min-w-0 flex-1">
              <span className="block truncate text-xs text-foreground">{p.name}</span>
              <span className="block truncate font-mono text-[10px] text-muted-foreground">{KIND_INFO[p.kind].where} · {p.model}{p.keySource === "vault" ? " · Vault key" : ""}</span>
            </span>
            {p.id !== "builtin" && (
              <>
                <Button variant="ghost" size="sm" className="h-7 px-2 text-[11px]" onClick={() => setEditing(p)}>Edit</Button>
                <Button variant="ghost" size="sm" className="h-7 px-2" aria-label={`Remove ${p.name}`} onClick={() => remove(p.id)}><Trash2 className="size-3.5" /></Button>
              </>
            )}
          </li>
        ))}
      </ul>

      {editing ? <ProviderForm value={editing} onCancel={() => setEditing(null)} onSave={save} /> : (
        <label className="mt-3 block text-[11px] text-muted-foreground"><span className="inline-flex items-center gap-1"><Plus className="size-3" /> Add a connection</span>
          <select className={`${field} mt-1`} value="" onChange={(e) => e.target.value && startNew(e.target.value as ProviderKind)}>
            <option value="">Choose a provider…</option>
            <optgroup label="OpenClaw &amp; Local">{(["openclaw", "ollama", "lmstudio", "custom"] as const).map((k) => <option key={k} value={k}>{KIND_INFO[k].label}</option>)}</optgroup>
            <optgroup label="Cloud">{(["openai", "anthropic", "gemini", "openrouter"] as const).map((k) => <option key={k} value={k}>{KIND_INFO[k].label}</option>)}</optgroup>
          </select>
        </label>
      )}
    </section>
  );
}

function ProviderForm({ value, onSave, onCancel }: { value: Provider; onSave: (p: Provider) => void; onCancel: () => void }) {
  const [p, setP] = useState(value);
  const where = KIND_INFO[p.kind].where;
  const set = (patch: Partial<Provider>) => setP((cur) => ({ ...cur, ...patch }));
  return (
    <div className="mt-3 space-y-2 rounded-md border border-primary/40 bg-surface p-3">
      <p className="dc-label text-[10px]">{KIND_INFO[p.kind].label}</p>
      <input className={field} aria-label="Name" value={p.name} onChange={(e) => set({ name: e.target.value })} placeholder="Name" />
      {where === "local" && <input className={field} aria-label="Address" value={p.baseUrl} onChange={(e) => set({ baseUrl: e.target.value })} placeholder="http://localhost:11434/v1" />}
      <input className={field} aria-label="Model" value={p.model} onChange={(e) => set({ model: e.target.value })} placeholder="Model name" />
      {where === "cloud" ? (
        <>
          <select className={field} aria-label="Key source" value={p.keySource} onChange={(e) => set({ keySource: e.target.value as KeySource })}>
            <option value="browser">API key saved in this browser</option>
            <option value="vault">Fetch key from HashiCorp Vault</option>
          </select>
          {p.keySource === "vault" ? (
            <>
              <input className={field} aria-label="Vault path" value={p.vaultPath ?? ""} onChange={(e) => set({ vaultPath: e.target.value })} placeholder="secret/data/openai" />
              <input className={field} aria-label="Vault field" value={p.vaultField ?? ""} onChange={(e) => set({ vaultField: e.target.value })} placeholder="api_key" />
            </>
          ) : (
            <input className={field} type="password" aria-label="API key" value={p.apiKey ?? ""} onChange={(e) => set({ apiKey: e.target.value })} placeholder="API key" />
          )}
        </>
      ) : (
        <>
          <input className={field} type="password" aria-label="Optional API key" value={p.apiKey ?? ""} onChange={(e) => set({ apiKey: e.target.value })} placeholder="API key (optional)" />
          <p className="text-[10px] leading-relaxed text-muted-foreground">Runs on your own computer while this page is open there. For Ollama, allow this site with OLLAMA_ORIGINS.</p>
        </>
      )}
      <div className="flex gap-2">
        <Button size="sm" className="h-8" disabled={!p.name.trim() || !p.model.trim()} onClick={() => onSave({ ...p, name: p.name.trim(), model: p.model.trim() })}>Save</Button>
        <Button size="sm" variant="ghost" className="h-8" onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}
