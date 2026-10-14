import { useState } from "react";
import { useLocal } from "@/lib/settings/store";

export type RunStep = { label: string; detail?: string; at: number; tone?: "ok" | "warn" | "error" };
export type RunOptions = { speak: boolean; expandSteps: boolean; typing: boolean };

const RUN_KEY = "openclaw.run";
const DEFAULT_RUN: RunOptions = { speak: true, expandSteps: false, typing: true };
export function useRunOptions() {
  return useLocal(RUN_KEY, DEFAULT_RUN);
}

const time = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** Collapsible log of every step in a run, like a bot's edit history. */
export function StepLog({ steps, defaultOpen = false, live = false }: { steps: RunStep[]; defaultOpen?: boolean; live?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  if (!steps.length) return null;
  const total = ((steps[steps.length - 1]!.at - steps[0]!.at) / 1000).toFixed(1);
  return (
    <div className="mt-2 border-t border-border/70 pt-1.5">
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="flex w-full items-center gap-1 font-mono text-[10px] text-muted-foreground hover:text-foreground">
        <span className={`transition-transform ${open ? "rotate-90" : ""}`}>▸</span>
        {steps.length} steps · {total}s{live ? " · live" : ""}
      </button>
      {open && (
        <ol className="mt-1 space-y-0.5">
          {steps.map((s, i) => (
            <li key={i} className="tg-pop grid grid-cols-[auto_minmax(0,1fr)_auto] gap-2 font-mono text-[10px]">
              <span className={s.tone === "error" ? "text-destructive" : s.tone === "warn" ? "text-severity-medium" : "text-primary"}>{s.tone === "error" ? "▲" : s.tone === "warn" ? "◐" : i === steps.length - 1 && live ? "●" : "✓"}</span>
              <span className="truncate text-foreground">{s.label}{s.detail ? <span className="text-muted-foreground"> — {s.detail}</span> : null}</span>
              <span className="text-muted-foreground">+{((s.at - steps[0]!.at) / 1000).toFixed(1)}s</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/** Incoming bot bubble with a tail, sender line and timestamp, Telegram-style. */
export function BotBubble({ sender, at, edited, children }: { sender: string; at: number; edited?: boolean; children: React.ReactNode }) {
  return (
    <div className="tg-pop flex justify-start">
      <div className="tg-bubble-in w-fit max-w-[92%] px-3.5 pb-1.5 pt-2">
        <p className="text-[11px] font-semibold text-primary">{sender}</p>
        <div className="mt-0.5">{children}</div>
        <p className="mt-1 text-right font-mono text-[9px] text-muted-foreground">{edited ? "edited · " : ""}{time(at)}</p>
      </div>
    </div>
  );
}

export function UserBubble({ text, at }: { text: string; at: number }) {
  return (
    <div className="tg-pop flex justify-end">
      <div className="tg-bubble-out max-w-[85%] px-3.5 pb-1.5 pt-2">
        <p className="whitespace-pre-wrap text-sm text-user-bubble-foreground">{text}</p>
        <p className="mt-0.5 text-right font-mono text-[9px] text-user-bubble-foreground/70">{time(at)} ✓✓</p>
      </div>
    </div>
  );
}

export function TypingDots({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground" aria-live="polite">
      <span className="tg-typing" aria-hidden><i /><i /><i /></span>{label}
    </span>
  );
}

/** Inline keyboard: full-width rows of up to two buttons, like Telegram bot replies. */
export function InlineKeyboard({ buttons }: { buttons: { key: string; label: string; onClick: () => void; disabled?: boolean; tone?: "danger" }[] }) {
  if (!buttons.length) return null;
  return (
    <div className="mt-2 grid grid-cols-2 gap-1">
      {buttons.map((b, i) => (
        <button key={b.key} type="button" onClick={b.onClick} disabled={b.disabled}
          className={`tg-key ${buttons.length % 2 === 1 && i === buttons.length - 1 ? "col-span-2" : ""} ${b.tone === "danger" ? "text-destructive" : ""}`}>
          {b.label}
        </button>
      ))}
    </div>
  );
}

export function RunOptionsControls() {
  const [o, set] = useRunOptions();
  const row = (key: keyof RunOptions, label: string, hint: string) => (
    <label className="flex items-start gap-2 py-1.5 text-sm">
      <input type="checkbox" className="mt-0.5 accent-primary" checked={o[key]} onChange={(e) => set((p) => ({ ...p, [key]: e.target.checked }))} />
      <span><span className="text-foreground">{label}</span><span className="block text-xs text-muted-foreground">{hint}</span></span>
    </label>
  );
  return (
    <div className="space-y-1">
      <p className="dc-label text-[10px]">How answers arrive</p>
      {row("speak", "Speak replies", "Read each answer aloud when it's ready")}
      {row("typing", "Live typing", "Show the reply as it's written in one updating message")}
      {row("expandSteps", "Open step log", "Show every step under each reply")}
    </div>
  );
}
