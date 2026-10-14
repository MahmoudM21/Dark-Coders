import { useState } from "react";
import { AudioLines, Brain, Cpu, ListTree, Mic, Plug, RefreshCw, Type, Volume2 } from "lucide-react";
import { PlanBuilder } from "@/components/plan-builder";
import { useProviders } from "@/components/provider-settings";
import { BUILTIN, findProvider } from "@/lib/settings/providers";
import { InlineKeyboard } from "@/components/telegram-run";
import { NAV_LABEL, paginate, type ActionProposal, type Screen } from "@/lib/voice/screen";
import { ENGINE_LABEL, getAgents, useVoiceSettings } from "@/lib/settings/voice";

export type PanelStage = "received" | "transcribing" | "planning" | "thinking" | "streaming" | "speaking" | "error";

/** One active screen: long text is paged in place, and controls never exceed four. */
export function PagedScreen({ text, screen, disabled, onSend }: {
  text: string;
  screen?: Screen | undefined;
  disabled: boolean;
  onSend: (value: string) => void;
}) {
  const pages = paginate(text);
  const [page, setPage] = useState(0);
  const index = Math.min(page, pages.length - 1);
  const last = index === pages.length - 1;

  type Control = { key: string; label: string; primary?: boolean; paging?: boolean; onClick: () => void };
  const controls: Control[] = [];
  if (index > 0) controls.push({ key: "prev", label: "‹ Previous", paging: true, onClick: () => setPage(index - 1) });
  if (!last) controls.push({ key: "next", label: "Next ›", primary: true, paging: true, onClick: () => setPage(index + 1) });
  if (last && screen) {
    screen.choices.forEach((c) => controls.push({ key: c.id, label: c.label, primary: true, onClick: () => onSend(c.value) }));
    screen.navigation.forEach((n) => controls.push({ key: n, label: NAV_LABEL[n], onClick: () => onSend(NAV_LABEL[n]) }));
  }
  const shown = controls.slice(0, 4);

  return (
    <>
      <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">{pages[index]}</p>
      {pages.length > 1 && <p className="dc-label mt-1 text-[10px]">Page {index + 1} / {pages.length}</p>}
      <InlineKeyboard buttons={shown.map((c) => ({ key: c.key, label: c.label, onClick: c.onClick, disabled: disabled && !c.paging }))} />
    </>
  );
}

const PIPELINE: { key: string; label: string; detail: string; stages: (PanelStage | "recording")[] }[] = [
  { key: "capture", label: "Audio capture", detail: "Hold-to-talk microphone", stages: ["recording"] },
  { key: "asr", label: "Transcribe", detail: "gemini-3.5-transcribe", stages: ["received", "transcribing"] },
  { key: "plan", label: "Planning", detail: "Request admitted", stages: ["planning"] },
  { key: "think", label: "Thinking", detail: "Reasoning summary", stages: ["thinking"] },
  { key: "stream", label: "Synthesizing", detail: "Edit-in-place screen", stages: ["streaming"] },
  { key: "speak", label: "Speaking", detail: "gemini-3.1-flash-tts · Kore", stages: ["speaking"] },
];

function currentStep(stage: PanelStage | undefined, recording: boolean) {
  if (recording) return 0;
  if (!stage || stage === "error") return -1;
  return PIPELINE.findIndex((step) => step.stages.includes(stage));
}

const STAGE_ICON: Record<string, typeof Mic> = { capture: Mic, asr: AudioLines, plan: ListTree, think: Brain, stream: Type, speak: Volume2 };

/** Compact live model readout merged into the main panel — icons with barely any text. */
export function ModelStatusStrip() {
  const [settings] = useProviders();
  const active = findProvider(settings, settings.activeId) ?? BUILTIN;
  const fallback = findProvider(settings, settings.fallbackId);
  const total = settings.providers.some((p) => p.id === "builtin") ? settings.providers.length : settings.providers.length + 1;
  return (
    <div className="flex min-w-0 items-center justify-between gap-3 font-mono text-[10px] text-muted-foreground" aria-label="Models active now">
      <span className="flex min-w-0 items-center gap-1.5" title={`${active.name} answers now · ${active.model}`}>
        <span aria-hidden className="size-1.5 shrink-0 animate-pulse rounded-full bg-primary" />
        <Cpu aria-hidden className="size-3 shrink-0 text-foreground/70" />
        <span className="truncate text-foreground">{active.model}</span>
      </span>
      <span className="flex shrink-0 items-center gap-3">
        <span className="flex items-center gap-1" title={fallback ? `If it fails → ${fallback.name}` : "No fallback configured"}>
          <RefreshCw aria-hidden className={`size-3 ${fallback ? "text-foreground/70" : "text-muted-foreground/40"}`} />
          {fallback && <span className="hidden truncate sm:inline">{fallback.model}</span>}
        </span>
        <span className="flex items-center gap-1" title={`${total} connection${total === 1 ? "" : "s"} · edit under General settings · Models`}>
          <Plug aria-hidden className="size-3 text-foreground/70" />
          <span>{total}</span>
        </span>
      </span>
    </div>
  );
}

/** Compact lifecycle strip shown under the microphone: icons instead of words. */
export function LifecycleStrip({ stage, recording }: { stage?: PanelStage | undefined; recording: boolean }) {
  const step = currentStep(stage, recording);
  const [voice] = useVoiceSettings();
  const detail = (key: string) =>
    key === "asr" ? (voice.asrEngine === "local" ? voice.asrModel : PIPELINE[1]!.detail)
    : key === "speak" ? ENGINE_LABEL[voice.engine]
    : PIPELINE.find((p) => p.key === key)?.detail ?? "";
  return (
    <div className="flex items-end gap-2" aria-label="Lifecycle progress">
      {PIPELINE.map((item, i) => {
        const state = step < 0 ? "idle" : i < step ? "done" : i === step ? "active" : "idle";
        const Icon = STAGE_ICON[item.key]!;
        return (
          <span key={item.key} title={`${item.label} — ${detail(item.key)}`} className="flex flex-col items-center gap-1">
            <Icon aria-hidden className={`size-4 ${state === "active" ? "animate-pulse text-primary" : state === "done" ? "text-foreground/70" : "text-muted-foreground/50"}`} />
            <span aria-hidden className="h-0.5 w-5 overflow-hidden rounded-full bg-border">
              <span className={`block h-full rounded-full transition-all duration-500 ${state === "done" ? "w-full bg-primary/60" : state === "active" ? "w-full animate-pulse bg-primary" : "w-0"}`} />
            </span>
          </span>
        );
      })}
      <span className="ml-0.5 pb-0.5 font-mono text-[10px] text-muted-foreground">{step < 0 ? "—" : `${step + 1}/6`}</span>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2 py-1 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className="truncate font-mono text-foreground">{value}</span>
    </div>
  );
}

export function ProfilePanel({ show = false }: { show?: boolean }) {
  return (
    <aside className={`${show ? "block" : "hidden"} space-y-4 pb-24 lg:block lg:pb-0 2xl:space-y-5`}>
      <PlanBuilder />
    </aside>
  );

}

export function LifecyclePanel({
  statusLabel,
  turns,
  show = false,
  proposal,
  disabled = false,
  onDecideProposal,
}: {
  show?: boolean;
  statusLabel: string;
  turns: number;
  proposal?: ActionProposal | null | undefined;
  disabled?: boolean;
  onDecideProposal?: (proposal: ActionProposal, approved: boolean) => void;
}) {
  const [voice] = useVoiceSettings();
  const [providers] = useProviders();
  const agents = getAgents(voice);
  const activeAgent = agents[voice.agent]?.label ?? voice.agent;
  const activeProvider = findProvider(providers, providers.activeId) ?? BUILTIN;

  return (
    <aside className={`${show ? "block" : "hidden"} space-y-4 pb-24 lg:block lg:pb-0 2xl:space-y-5`}>
      <section className="panel p-4">
        <p className="dc-label text-[10px]">Current run</p>
        <div className="mt-2">
          <Row label="Status" value={statusLabel} />
          <Row label="Messages" value={String(turns)} />
        </div>
      </section>
      <section className="panel p-4">
        <div className="flex items-center justify-between gap-2">
          <p className="dc-label text-[10px]">Approval</p>
          {proposal && (
            <span className={`font-mono text-[10px] ${proposal.risk === "high" ? "text-destructive" : "text-severity-medium"}`}>
              ● {proposal.risk ? `${proposal.risk.toUpperCase()} RISK` : "PENDING"}
            </span>
          )}
        </div>
        {proposal ? (
          <div className="mt-2 space-y-2">
            <p className="text-xs font-semibold text-foreground">{proposal.title}</p>
            <p className="font-mono text-[10px] text-primary">Tool · {proposal.tool}</p>
            <p className="text-xs leading-relaxed text-muted-foreground">{proposal.summary}</p>
            {onDecideProposal && (
              <InlineKeyboard
                buttons={[
                  { key: "approve", label: "✓ Approve", onClick: () => onDecideProposal(proposal, true), disabled },
                  { key: "deny", label: "✕ Deny", tone: "danger", onClick: () => onDecideProposal(proposal, false), disabled },
                ]}
              />
            )}
          </div>
        ) : (
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
            No pending tool proposals. When an OpenClaw agent proposes a state-changing or external action (`action_proposal`), it appears here for human approval.
          </p>
        )}
      </section>
      <section className="panel p-4">
        <div className="flex items-center justify-between">
          <p className="dc-label text-[10px]">OpenClaw gateway</p>
          <span className="font-mono text-[10px] text-primary">● Active</span>
        </div>
        <div className="mt-2">
          <Row label="Agent" value={activeAgent} />
          <Row label="Roster" value={`${Object.keys(agents).length} agents`} />
          <Row label="Route" value={activeProvider.baseUrl || "/api/agent"} />
        </div>
      </section>
    </aside>
  );
}

export function Waveform({ level, active, stage }: { level: number; active: boolean; stage?: PanelStage | undefined }) {
  return (
    <div className="mb-4 flex flex-col gap-2 border-b border-border pb-3">
      <ModelStatusStrip />
      <div aria-hidden className="flex h-12 min-w-0 items-center justify-center gap-1">
        {Array.from({ length: 36 }, (_, i) => {
          const wave = active ? 0.25 + Math.min(level * 4, 1) * Math.abs(Math.sin(i * 0.7 + level * 20)) : 0.12;
          return (
            <span key={i} className="w-1 rounded-full bg-primary transition-[height] duration-100"
              style={{ height: `${Math.max(8, wave * 100)}%`, opacity: active ? 0.9 : 0.3 }} />
          );
        })}
      </div>
      <div className="flex justify-center">
        <LifecycleStrip stage={stage} recording={active} />
      </div>
    </div>
  );
}
