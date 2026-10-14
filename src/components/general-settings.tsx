import { useEffect, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Slider } from "@/components/ui/slider";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AGENTS, ENGINE_LABEL, getAgents, speakWith, useVoiceSettings, type AsrEngine, type VoiceEngine } from "@/lib/settings/voice";
import { ProviderSettings } from "@/components/provider-settings";
import { ThemeControls } from "@/components/theme-panel";
import { RunOptionsControls } from "@/components/telegram-run";
import { CloudSync } from "@/components/cloud-sync";

const select = "w-full rounded-lg border border-border bg-surface px-3 py-2.5 text-sm text-foreground outline-none focus:border-primary";

/** One place for every preference: voice, appearance, models, run behaviour and saved data. */
export function GeneralSettings({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [v, set] = useVoiceSettings();
  const agents = getAgents(v);
  const [voices, setVoices] = useState<string[]>([]);
  const [preview, setPreview] = useState(false);
  const [error, setError] = useState("");
  const [newAgentId, setNewAgentId] = useState("");
  const [newAgentLabel, setNewAgentLabel] = useState("");
  const [newAgentPersona, setNewAgentPersona] = useState("");
  useEffect(() => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
    const load = () => setVoices(speechSynthesis.getVoices().map((x) => x.name));
    load();
    speechSynthesis.addEventListener("voiceschanged", load);
    return () => speechSynthesis.removeEventListener("voiceschanged", load);
  }, []);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="text-xl">General</DialogTitle>
          <DialogDescription>Everything about how this console listens, answers, looks and saves. Changes apply immediately.</DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="voice">
          <TabsList className="h-auto w-full flex-wrap justify-start gap-1 bg-transparent p-0">
            <TabsTrigger value="voice" className="rounded-full px-3 py-1.5 text-xs">Voice &amp; Agents</TabsTrigger>
            <TabsTrigger value="appearance" className="rounded-full px-3 py-1.5 text-xs">Appearance</TabsTrigger>
            <TabsTrigger value="models" className="rounded-full px-3 py-1.5 text-xs">Models</TabsTrigger>
            <TabsTrigger value="run" className="rounded-full px-3 py-1.5 text-xs">Run options</TabsTrigger>
            <TabsTrigger value="account" className="rounded-full px-3 py-1.5 text-xs">Account &amp; data</TabsTrigger>
          </TabsList>

          <TabsContent value="voice" className="mt-4 space-y-5">
            <label className="block space-y-1.5"><span className="text-sm font-semibold">Active OpenClaw Agent</span>
              <select className={select} value={v.agent} onChange={(e) => set((p) => ({ ...p, agent: e.target.value }))}>
                {Object.entries(agents).map(([k, a]) => <option key={k} value={k}>{a.label} ({k})</option>)}
              </select>
            </label>
            <details className="rounded-lg border border-border bg-surface/60 p-3">
              <summary className="cursor-pointer text-xs font-semibold text-foreground">Register custom OpenClaw agent</summary>
              <div className="mt-3 space-y-2">
                <input className={select} placeholder="Agent ID (e.g. researcher, devops, finance)" value={newAgentId} onChange={(e) => setNewAgentId(e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, ""))} />
                <input className={select} placeholder="Display label (e.g. Research Specialist)" value={newAgentLabel} onChange={(e) => setNewAgentLabel(e.target.value)} />
                <textarea className={select} rows={2} placeholder="Agent role / OpenClaw skill instructions…" value={newAgentPersona} onChange={(e) => setNewAgentPersona(e.target.value)} />
                <Button size="sm" variant="outline" disabled={!newAgentId.trim() || !newAgentLabel.trim()} onClick={() => {
                  const id = newAgentId.trim();
                  set((p) => ({
                    ...p,
                    agent: id,
                    customAgents: { ...(p.customAgents ?? {}), [id]: { label: newAgentLabel.trim(), persona: newAgentPersona.trim() } },
                  }));
                  setNewAgentId(""); setNewAgentLabel(""); setNewAgentPersona("");
                }}><Plus className="size-3.5" /> Add agent</Button>
                {Object.keys(v.customAgents ?? {}).length > 0 && (
                  <ul className="mt-2 space-y-1 border-t border-border pt-2">
                    {Object.entries(v.customAgents ?? {}).map(([id, a]) => (
                      <li key={id} className="flex items-center justify-between text-xs">
                        <span className="font-mono">{a.label} ({id})</span>
                        {!(id in AGENTS) && (
                          <Button size="sm" variant="ghost" className="h-6 px-2" onClick={() => set((p) => {
                            const next = { ...(p.customAgents ?? {}) };
                            delete next[id];
                            return { ...p, agent: p.agent === id ? "general" : p.agent, customAgents: next };
                          })}><Trash2 className="size-3" /></Button>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </details>
            <label className="block space-y-1.5"><span className="text-sm font-semibold">Voice engine</span>
              <select className={select} value={v.engine} onChange={(e) => set((p) => ({ ...p, engine: e.target.value as VoiceEngine }))}>
                {(Object.keys(ENGINE_LABEL) as VoiceEngine[]).map((k) => <option key={k} value={k}>{ENGINE_LABEL[k]}</option>)}
                <optgroup label="Commercial · connection required"><option disabled>ElevenLabs · setup required</option><option disabled>Azure Speech · setup required</option><option disabled>Amazon Polly · setup required</option></optgroup>
              </select>
              <span className="block text-xs text-muted-foreground">No silent fallback: a failed engine shows an error, it never swaps voices behind your back.</span>
            </label>
            <Button variant="outline" disabled={preview} onClick={async () => { setPreview(true); setError(""); try { await speakWith(v, "Your voice is ready."); } catch (e) { setError(e instanceof Error ? e.message : "Voice preview failed"); } finally { setPreview(false); } }}>{preview ? "Playing…" : "Preview voice"}</Button>
            {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
            <label className="block space-y-1.5"><span className="text-sm font-semibold">Speech recognition (ASR)</span>
              <select className={select} value={v.asrEngine} onChange={(e) => set((p) => ({ ...p, asrEngine: e.target.value as AsrEngine }))}><option value="cloud">Built-in cloud transcription</option><option value="local">Local · Whisper-compatible server</option></select>
            </label>
            {v.asrEngine === "local" && <div className="space-y-3">
              <label className="block space-y-1.5"><span className="text-sm font-semibold">ASR server base URL</span><input className={select} value={v.asrUrl} onChange={(e) => set((p) => ({ ...p, asrUrl: e.target.value }))} placeholder="http://localhost:8000/v1" /></label>
              <label className="block space-y-1.5"><span className="text-sm font-semibold">ASR model</span><input className={select} value={v.asrModel} onChange={(e) => set((p) => ({ ...p, asrModel: e.target.value }))} /></label>
              <p className="text-xs text-severity-medium">Requires a running server with POST /audio/transcriptions and JSON text output. This site must be allowed by the server; headset localhost means the headset itself.</p>
            </div>}
            <details className="border-y border-border py-3"><summary className="cursor-pointer text-sm font-semibold">Open-source ASR · installation</summary><div className="mt-3 space-y-3 text-xs text-muted-foreground">
              <p>Not installed on this device. Installation needs your machine, available memory and explicit permission.</p>
              <a className="block text-primary underline" href="https://github.com/SYSTRAN/faster-whisper" target="_blank" rel="noreferrer">Faster-Whisper · Python / GPU setup</a>
              <a className="block text-primary underline" href="https://github.com/ggml-org/whisper.cpp" target="_blank" rel="noreferrer">whisper.cpp · native CPU / GPU setup</a>
              <p>Use an OpenAI-compatible adapter. Native server formats are not assumed compatible. Keep the service private and allow only trusted origins.</p>
            </div></details>
            <div className="space-y-2"><p className="text-sm font-semibold">Speaking rate · {v.rate.toFixed(2)}×</p>
              <Slider min={0.5} max={1.5} step={0.05} value={[v.rate]} onValueChange={([r]) => set((p) => ({ ...p, rate: r ?? 1 }))} aria-label="Speaking rate" />
            </div>
            <div className="space-y-2"><p className="text-sm font-semibold">Standby pause · {v.standbyPause} ms</p>
              <Slider min={300} max={1500} step={50} value={[v.standbyPause]} onValueChange={([r]) => set((p) => ({ ...p, standbyPause: r ?? 900 }))} aria-label="Standby pause" />
              <span className="block text-xs text-muted-foreground">How long you stay quiet in Standby before your words are sent.</span>
            </div>
            {v.engine === "browser" && (
              <label className="block space-y-1.5"><span className="text-sm font-semibold">Browser voice character</span>
                <select className={select} value={v.browserVoice} onChange={(e) => set((p) => ({ ...p, browserVoice: e.target.value }))}>
                  <option value="">Device default</option>
                  {voices.map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
              </label>
            )}
            {v.engine === "kokoro" && (
              <div className="grid grid-cols-[minmax(0,1fr)_8rem] gap-2">
                <label className="space-y-1.5"><span className="text-sm font-semibold">Kokoro server</span>
                  <input className={select} value={v.kokoroUrl} onChange={(e) => set((p) => ({ ...p, kokoroUrl: e.target.value }))} placeholder="http://localhost:8880" /></label>
                <label className="space-y-1.5"><span className="text-sm font-semibold">Voice</span>
                  <input className={select} value={v.kokoroVoice} onChange={(e) => set((p) => ({ ...p, kokoroVoice: e.target.value }))} /></label>
              </div>
            )}
          </TabsContent>

          <TabsContent value="appearance" className="mt-4">
            <ThemeControls />
          </TabsContent>

          <TabsContent value="models" className="mt-4 space-y-4">
            <ProviderSettings />
            <p className="text-xs leading-relaxed text-muted-foreground">Settings and keys stay in this browser. Cloud keys are sent only to their own provider for each answer; Vault keys are fetched on the server and never shown here.</p>
          </TabsContent>

          <TabsContent value="run" className="mt-4">
            <RunOptionsControls />
          </TabsContent>

          <TabsContent value="account" className="mt-4 space-y-4">
            <CloudSync />
            <p className="text-xs leading-relaxed text-muted-foreground">Signed in, your plans, voice settings, run options and theme are kept on your account and follow you to any device. Model API keys never leave this browser.</p>
          </TabsContent>
        </Tabs>

        <DialogFooter><Button variant="outline" className="border-primary/50" onClick={() => onOpenChange(false)}>Close</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
