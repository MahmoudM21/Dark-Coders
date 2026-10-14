import { unlockSpeaker } from "@/lib/voice/speak";
import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { Mic, Square, Radio, SlidersHorizontal, Paperclip, SendHorizontal, X as XIcon, RotateCcw, ThumbsUp, ListTree, Volume2, AlertTriangle, PanelsTopLeft, ScanFace } from "lucide-react";
import { recordWav, type Recording } from "@/lib/voice/record-wav";
import { transcribeRecording, type Turn } from "@/lib/voice/agent";
import { transcribeLocal } from "@/lib/voice/local-asr";
import { cleanRaw, runProvider } from "@/lib/voice/providers-client";
import { BUILTIN, KIND_INFO, findProvider, type Provider } from "@/lib/settings/providers";
import { useProviders } from "@/components/provider-settings";
import { focusModel, planPhases, planSummary, usePlans } from "@/components/plan-builder";
import { BotBubble, InlineKeyboard, StepLog, TypingDots, UserBubble, useRunOptions, type RunStep } from "@/components/telegram-run";
import { getAgents, speakWith, useVoiceSettings } from "@/lib/settings/voice";
import { GeneralSettings } from "@/components/general-settings";
import { CloudSync } from "@/components/cloud-sync";
import { parseScreen, partialText, spokenScreen, type ActionProposal, type Command, type Screen } from "@/lib/voice/screen";
import { Button } from "@/components/ui/button";
import { LifecyclePanel, PagedScreen, ProfilePanel, Waveform } from "@/components/console-panels";
import darkCodersLogo from "@/assets/darkcoders-logo.png";
import spatialRoom from "@/assets/spatial-room.jpg";
import { ACCENTS, clampTheme, useApplyTheme, useTheme, type Accent } from "@/lib/settings/theme";
const XrChat = lazy(() => import("@/components/xr-chat"));

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "OpenClaw Voice Console — talk to your agent" },
      {
        name: "description",
        content:
          "Hold to talk, watch the agent move through received, thinking, planning and synthesizing, then hear the answer spoken back.",
      },
      { property: "og:title", content: "OpenClaw Voice Console — talk to your agent" },
      {
        property: "og:description",
        content: "A voice console that shows every stage of an agent run and speaks the final answer.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: VoiceConsole,
});

type Stage = "received" | "transcribing" | "planning" | "thinking" | "streaming" | "speaking" | "error";

const STAGE_LABEL: Record<Stage, string> = {
  received: "Received",
  transcribing: "Transcribing",
  planning: "Planning",
  thinking: "Thinking",
  streaming: "Synthesizing",
  speaking: "Speaking",
  error: "Failed",
};


type Message = {
  id: string;
  role: "user" | "assistant";
  text: string;
  screen?: Screen;
  reasoning?: string;
  liked?: boolean;
  at: number;
  steps?: RunStep[];
  sender?: string;
  phase?: PhaseCard;
};

/** A plan phase shown in the chat; it waits for explicit approval before the agent works on it. */
type PhaseCard = { index: number; total: number; title: string; status: string; model: string; state: "waiting" | "approved" | "skipped" | "stopped" };

type Run = {
  stage: Stage;
  heard: string;
  answer: string;
  reasoning: string;
  error?: string;
  steps: RunStep[];
  sender?: string;
};

const newId = () => Math.random().toString(36).slice(2);

function VoiceConsole() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [run, setRun] = useState<Run | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [level, setLevel] = useState(0);
  const [openDetails, setOpenDetails] = useState<string | null>(null);

  const recordingRef = useRef<Recording | null>(null);
  const startingRef = useRef(false);
  const releaseRef = useRef(false);
  const stopRecordingRef = useRef<() => Promise<void>>(async () => {});
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const messagesRef = useRef<Message[]>([]);
  const reasoningRef = useRef("");
  const stepsRef = useRef<RunStep[]>([]);
  const [providers] = useProviders();
  const [plans] = usePlans();
  const [runOptions] = useRunOptions();
  const [voice, setVoice] = useVoiceSettings();
  const settingsRef = useRef({ providers, plans, runOptions, voice });
  settingsRef.current = { providers, plans, runOptions, voice };
  const [speaking, setSpeaking] = useState(false);
  const [standby, setStandby] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [attachment, setAttachment] = useState<{ name: string; text: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const commandRef = useRef<(command: Command) => string | null>(() => null);

  const addStep = useCallback((label: string, detail?: string, tone?: RunStep["tone"]) => {
    stepsRef.current = [...stepsRef.current, { label, at: Date.now(), ...(detail ? { detail } : {}), ...(tone ? { tone } : {}) }];
    const steps = stepsRef.current;
    setRun((current) => (current ? { ...current, steps } : current));
  }, []);
  const resetSteps = () => { stepsRef.current = []; };

  const appendMessage = useCallback((message: Message) => {
    messagesRef.current = [...messagesRef.current, message];
    setMessages(messagesRef.current);
    return messagesRef.current;
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, run]);

  useEffect(() => {
    if (!isRecording) return;
    const timer = window.setInterval(() => setLevel(recordingRef.current?.level() ?? 0), 100);
    return () => window.clearInterval(timer);
  }, [isRecording]);

  const runAgent = useCallback(
    async (history: Message[], signal: AbortSignal, override?: { model: string; task: string }) => {
      const { providers: settings, plans: planState, runOptions: opts, voice: voiceSettings } = settingsRef.current;
      setRun((current) => (current ? { ...current, stage: "planning" } : current));
      reasoningRef.current = "";
      const turns: Turn[] = history.filter((m) => !m.phase).map(({ role, text }) => ({ role, text }));
      const roster = getAgents(voiceSettings);
      const persona = roster[voiceSettings.agent]?.persona ?? "";
      const context = [persona && `Agent role (${voiceSettings.agent}): ${persona}`, planSummary(planState)].filter(Boolean).join("\n\n");
      if (persona) addStep("Agent", roster[voiceSettings.agent]?.label);
      if (context) addStep("Plan attached", planState.workflows.find((w) => w.id === planState.activeId)?.name);
      const focus = override ?? focusModel(planState);
      const picked = focus?.model ? settings.providers.find((p) => p.model === focus.model) : undefined;
      if (focus?.model) addStep("Task model", picked ? `${focus.model} for ${focus.task}` : `${focus.model} isn't set up in Models yet — using the active model`, picked ? undefined : "warn");
      const chain: Provider[] = [picked ?? findProvider(settings, settings.activeId) ?? BUILTIN];
      const fb = findProvider(settings, settings.fallbackId);
      if (fb && fb.id !== chain[0]!.id) chain.push(fb);

      let raw = "";
      let used: Provider = chain[0]!;
      for (let i = 0; i < chain.length; i++) {
        used = chain[i]!;
        addStep(i === 0 ? "Planning" : "Fallback", `${used.name} · ${used.model} (${KIND_INFO[used.kind].where})`, i === 0 ? undefined : "warn");
        setRun((current) => (current ? { ...current, sender: used.name, answer: "" } : current));
        let thinking = false;
        let writing = false;
        try {
          raw = await runProvider(used, turns, context, {
            onThinking: (reasoning) => {
              if (!thinking) { thinking = true; addStep("Thinking"); }
              reasoningRef.current = reasoning;
              setRun((current) => current ? { ...current, reasoning, stage: current.stage === "streaming" ? current.stage : "thinking" } : current);
            },
            onAnswer: (text) => {
              if (!writing) { writing = true; addStep("Writing reply"); }
              if (opts.typing) setRun((current) => (current ? { ...current, answer: partialText(cleanRaw(text)), stage: "streaming" } : current));
            },
          }, signal);
          break;
        } catch (error) {
          if (signal.aborted) throw error;
          const message = error instanceof Error ? error.message : "Model failed";
          addStep("Failed", message, "error");
          if (i === chain.length - 1) throw error;
        }
      }

      // Blueprint: invalid planner output renders a safe error screen. Plain-text local replies are shown as-is.
      const cleaned = cleanRaw(raw);
      const screen: Screen = parseScreen(cleaned) ?? (used.kind !== "builtin" && !cleaned.startsWith("{")
        ? { text: cleaned, choices: [], navigation: [] }
        : { text: "That step could not be completed. Your last confirmed state is unchanged.", choices: [], navigation: ["home"] });
      for (const command of screen.commands ?? []) {
        const result = commandRef.current(command);
        addStep(result ? "Applied" : "Not available", result ?? `${command.name} ${command.value}`.trim(), result ? undefined : "error");
      }
      if (screen.actionProposal) {
        addStep("Approval required", `${screen.actionProposal.title} · ${screen.actionProposal.tool}`, "warn");
      }
      addStep("Reply ready", `${screen.choices.length} button${screen.choices.length === 1 ? "" : "s"}`);
      if (opts.speak) addStep("Speaking");
      appendMessage({ id: newId(), role: "assistant", text: screen.text, screen, reasoning: reasoningRef.current, at: Date.now(), steps: stepsRef.current, sender: used.name });
      setRun(null);
      if (!opts.speak) return;
      try {
        setSpeaking(true);
        await speakWith(voiceSettings, spokenScreen(screen), signal);
      } catch (error) {
        if (!signal.aborted) setNotice(error instanceof Error ? error.message : "The voice engine failed");
      } finally {
        setSpeaking(false);
      }
    },
    [addStep, appendMessage],
  );

  const postPhase = useCallback((index: number) => {
    const phases = planPhases(settingsRef.current.plans);
    const ph = phases[index];
    if (!ph) {
      appendMessage({ id: newId(), role: "assistant", text: "All plan phases are done.", at: Date.now(), sender: "Plan" });
      return;
    }
    appendMessage({
      id: newId(), role: "assistant", at: Date.now(), sender: "Plan",
      text: `Phase ${index + 1} of ${phases.length}: ${ph.title}`,
      phase: { index, total: phases.length, title: ph.title, status: ph.status, model: ph.model ?? "gpt-6-astra", state: "waiting" },
    });
  }, [appendMessage]);

  const decidePhase = useCallback((id: string, decision: "approved" | "skipped" | "stopped") => {
    const msg = messagesRef.current.find((m) => m.id === id);
    if (!msg?.phase || msg.phase.state !== "waiting" || run) return;
    const card = { ...msg.phase, state: decision };
    messagesRef.current = messagesRef.current.map((m) => (m.id === id ? { ...m, phase: card } : m));
    setMessages(messagesRef.current);
    if (decision === "stopped") return;
    if (decision === "skipped") return postPhase(card.index + 1);
    resetSteps();
    addStep("Approved", `Phase ${card.index + 1}: ${card.title}`);
    const history = appendMessage({ id: newId(), role: "user", text: `Approved. Work on phase ${card.index + 1}: ${card.title}. Give the concrete next steps.`, at: Date.now() });
    const controller = new AbortController();
    abortRef.current = controller;
    setRun({ stage: "planning", heard: "", answer: "", reasoning: "", steps: stepsRef.current });
    void runAgent(history.filter((m) => !m.phase), controller.signal, { model: card.model, task: card.title })
      .then(() => postPhase(card.index + 1))
      .catch((error) => {
        if (controller.signal.aborted) return setRun(null);
        setRun({ stage: "error", heard: "", answer: "", reasoning: "", error: error instanceof Error ? error.message : "That phase failed", steps: stepsRef.current });
      })
      .finally(() => { abortRef.current = null; });
  }, [addStep, appendMessage, postPhase, run, runAgent]);

  const sendText = useCallback(
    (text: string) => {
      if (run || isRecording) return;
      resetSteps();
      addStep("Received", "text message");
      const history = appendMessage({ id: newId(), role: "user", text, at: Date.now() });
      const controller = new AbortController();
      abortRef.current = controller;
      setRun({ stage: "planning", heard: text, answer: "", reasoning: "", steps: stepsRef.current });
      void runAgent(history, controller.signal)
        .catch((error) => {
          if (controller.signal.aborted) return setRun(null);
          setRun({ stage: "error", heard: "", answer: "", reasoning: "", error: error instanceof Error ? error.message : "That step failed", steps: stepsRef.current });
        })
        .finally(() => {
          abortRef.current = null;
        });
    },
    [appendMessage, isRecording, run, runAgent],
  );

  const finishTurn = useCallback(
    async (file: File) => {
      const controller = new AbortController();
      abortRef.current = controller;
      resetSteps();
      stepsRef.current = [{ label: "Received", detail: "voice note", at: Date.now() }];
      setRun({ stage: "received", heard: "", answer: "", reasoning: "", steps: stepsRef.current });
      try {
        setRun((current) => (current ? { ...current, stage: "transcribing" } : current));
        addStep("Transcribing");
        const selectedVoice = settingsRef.current.voice;
        const onPartial = (partial: string) => setRun((current) => (current ? { ...current, heard: partial } : current));
        const heard = selectedVoice.asrEngine === "local"
          ? await transcribeLocal(file, selectedVoice.asrUrl, selectedVoice.asrModel, onPartial, controller.signal)
          : await transcribeRecording(file, onPartial, controller.signal);
        const userMessage: Message = { id: newId(), role: "user", text: heard, at: Date.now() };
        addStep("Heard", heard.length > 60 ? `${heard.slice(0, 60)}…` : heard);
        const history = appendMessage(userMessage);
        setRun((current) => (current ? { ...current, heard, stage: "planning" } : current));
        await runAgent(history, controller.signal);
      } catch (error) {
        if (controller.signal.aborted) {
          setRun(null);
          return;
        }
        const message = error instanceof Error ? error.message : "Something went wrong";
        setRun({ stage: "error", heard: "", answer: "", reasoning: "", error: message, steps: stepsRef.current });
      } finally {
        abortRef.current = null;
      }
    },
    [addStep, appendMessage, runAgent],
  );

  const startRecording = useCallback(async () => {
    if (isRecording || run || startingRef.current) return;
    unlockSpeaker();
    startingRef.current = true;
    releaseRef.current = false;
    try {
      recordingRef.current = await recordWav();
      setIsRecording(true);
      startingRef.current = false;
      // Released before the microphone finished opening: finish the turn now.
      if (releaseRef.current) { releaseRef.current = false; void stopRecordingRef.current(); }
    } catch {
      startingRef.current = false;
      setRun({
        stage: "error",
        heard: "",
        answer: "",
        reasoning: "",
        steps: stepsRef.current,
        error: "I need microphone access to hear you. Allow it and try again.",
      });
    }
  }, [isRecording, run]);

  const stopRecording = useCallback(async () => {
    const recording = recordingRef.current;
    if (!recording) { if (startingRef.current) releaseRef.current = true; return; }
    recordingRef.current = null;
    setIsRecording(false);
    setLevel(0);
    try {
      const file = await recording.stop();
      void finishTurn(file);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Recording failed";
      setRun({ stage: "error", heard: "", answer: "", reasoning: "", error: message, steps: stepsRef.current });
    }
  }, [finishTurn]);
  stopRecordingRef.current = stopRecording;

  const stopRun = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setRun(null);
  }, []);

  const retry = useCallback(() => {
    const lastUser = [...messages].reverse().find((message) => message.role === "user");
    if (!lastUser) return;
    const history = messages.slice(0, messages.lastIndexOf(lastUser) + 1);
    messagesRef.current = history;
    setMessages(history);
    const controller = new AbortController();
    abortRef.current = controller;
    stepsRef.current = [{ label: "Retry", detail: "same question", at: Date.now() }];
    setRun({ stage: "planning", heard: lastUser.text, answer: "", reasoning: "", steps: stepsRef.current });
    void runAgent(history, controller.signal)
      .catch((error) => {
        if (controller.signal.aborted) return setRun(null);
        setRun({
          stage: "error",
          heard: "",
          answer: "",
          reasoning: "",
          steps: stepsRef.current,
          error: error instanceof Error ? error.message : "Retry failed",
        });
      })
      .finally(() => {
        abortRef.current = null;
      });
  }, [messages, runAgent]);

  const [view, setView] = useState<"talk" | "plan" | "run">("talk");
  const [spatial, setSpatial] = useState(false);
  const [headset, setHeadset] = useState(false);
  const [, setTheme] = useTheme();
  useApplyTheme();
  const busy = Boolean(run) && run?.stage !== "error";

  // Standby: listen hands-free, send after the chosen pause of silence, and wait while the agent talks.
  const standbyRef = useRef({ heard: false, lastLoud: 0 });
  useEffect(() => {
    if (!standby || busy || speaking || isRecording || settingsOpen) return;
    const t = window.setTimeout(() => { standbyRef.current = { heard: false, lastLoud: Date.now() }; void startRecording(); }, 250);
    return () => window.clearTimeout(t);
  }, [standby, busy, speaking, isRecording, settingsOpen, startRecording]);
  useEffect(() => {
    if (!standby || !isRecording) return;
    const t = window.setInterval(() => {
      const lv = recordingRef.current?.level() ?? 0;
      const st = standbyRef.current;
      if (lv > 0.06) { st.heard = true; st.lastLoud = Date.now(); }
      else if (st.heard && Date.now() - st.lastLoud > voice.standbyPause) { st.heard = false; void stopRecording(); }
    }, 80);
    return () => window.clearInterval(t);
  }, [standby, isRecording, voice.standbyPause, stopRecording]);

  const toggleStandby = useCallback(() => {
    setStandby((on) => {
      if (on && recordingRef.current) { recordingRef.current.cancel(); recordingRef.current = null; setIsRecording(false); setLevel(0); }
      return !on;
    });
  }, []);

  // Voice commands: only these reversible controls; returns a confirmation or null if it can't be applied.
  commandRef.current = (command) => {
    const v = command.value.trim().toLowerCase();
    switch (command.name) {
      case "set_view":
        if (v !== "spatial" && v !== "console") return null;
        setSpatial(v === "spatial"); setView("talk");
        return `${v === "spatial" ? "Spatial" : "Console"} view on`;
      case "show_tab":
        if (v !== "talk" && v !== "plan" && v !== "run") return null;
        setSpatial(false); setView(v);
        return `Showing ${v === "plan" ? "Models & plan" : v === "run" ? "Run" : "Talk"}`;
      case "set_agent": {
        const roster = getAgents(settingsRef.current.voice);
        const agent = roster[v];
        if (!agent) return null;
        setVoice((previous) => ({ ...previous, agent: v }));
        return `Agent set to ${agent.label}`;
      }
      case "set_speaking_rate": {
        const rate = Number(v);
        if (!Number.isFinite(rate) || rate < 0.5 || rate > 2) return null;
        setVoice((previous) => ({ ...previous, rate: Math.round(rate * 100) / 100 }));
        return `Speaking rate ${rate.toFixed(2)}×`;
      }
      case "set_accent": {
        if (!(v in ACCENTS)) return null;
        setTheme((p) => ({ ...p, accent: v as Accent }));
        return `Accent ${ACCENTS[v as Accent].label}`;
      }
      case "set_style": {
        const m = v.match(/^(blur|glass|radius)\s*[:=]?\s*(-?\d+)$/);
        if (!m) return null;
        const key = m[1] as "blur" | "glass" | "radius";
        let applied = 0;
        setTheme((p) => { const next = clampTheme({ ...p, [key]: Number(m[2]) }); applied = next[key]; return next; });
        return `${key === "glass" ? "Glass opacity" : key === "blur" ? "Glass blur" : "Corner roundness"} ${applied || m[2]}`;
      }
      case "open_headset": setSpatial(true); setView("talk"); setHeadset(true); return "Headset view opened";
      case "open_settings": setSettingsOpen(true); return "General settings opened";
      case "close_settings": setSettingsOpen(false); return "General settings closed";
      case "standby":
        if (v !== "on" && v !== "off") return null;
        if ((v === "on") !== standby) toggleStandby();
        return `Standby ${v}`;
    }
    return null;
  };

  const stopAll = useCallback(() => {
    stopRun();
    if (typeof window !== "undefined" && "speechSynthesis" in window) speechSynthesis.cancel();
    setSpeaking(false);
  }, [stopRun]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "F9") { e.preventDefault(); toggleStandby(); }
      if (e.key === "Escape" && !settingsOpen) stopAll();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleStandby, stopAll, settingsOpen]);

  const submitDraft = () => {
    const text = draft.trim();
    if ((!text && !attachment) || busy || isRecording) return;
    const full = attachment ? `${text || "Please review the attached file."}\n\nAttached file "${attachment.name}":\n${attachment.text}` : text;
    setDraft("");
    setAttachment(null);
    sendText(full);
    inputRef.current?.focus();
  };
  const attach = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > 200_000) return setNotice("That file is too large. Attach a text file under 200 KB.");
    const text = await file.text();
    if (text.includes("\u0000")) return setNotice("Only text files can be attached (txt, md, json, csv, yaml, log).");
    setAttachment({ name: file.name, text: text.slice(0, 20_000) });
  };

  return (
    <main className="relative flex min-h-dvh w-full flex-col overflow-hidden bg-transparent text-foreground">
      {!spatial && <div aria-hidden className="voice-grid pointer-events-none absolute inset-0 opacity-35" />}
      <header className="relative z-10 border-b border-white/10 bg-background/55 backdrop-blur-xl backdrop-saturate-150">
        <div className="mx-auto flex w-full max-w-7xl flex-wrap items-center 2xl:max-w-[1800px] justify-between gap-3 px-3 py-3 sm:px-8">
          <img src={darkCodersLogo} alt="Dark Coders" className="h-6 w-auto max-w-[145px] object-contain sm:h-7 sm:max-w-none" />
          <div className="flex shrink-0 items-center gap-2">
            <CloudSync />
            <Button variant="outline" size="icon" aria-label={spatial ? "Switch to console view" : "Switch to spatial view"} title={spatial ? "Console view" : "Spatial view"} aria-pressed={spatial} onClick={() => { setSpatial((current) => !current); setView("talk"); }} className={`glass size-10 shrink-0 rounded-full ${spatial ? "border-primary/60 text-primary" : ""}`}>
              {spatial ? <PanelsTopLeft className="size-4" /> : <ScanFace className="size-4" />}
            </Button>
            <Button variant="outline" onClick={toggleStandby} aria-pressed={standby} title="Standby (F9)"
              className={`glass h-10 gap-2 rounded-full px-3 ${standby ? "border-primary/60 text-primary" : "text-foreground"}`}>
              <Radio className={`size-4 ${standby ? "animate-pulse" : ""}`} /> {standby ? "Standing by" : "Standby"}
            </Button>
            <Button variant="outline" size="icon" onClick={() => setSettingsOpen(true)} aria-label="General settings" title="General settings" className="glass size-10 rounded-full">
              <SlidersHorizontal className="size-4" />
            </Button>
          </div>
        </div>
      </header>

      <div className="relative z-10 mx-auto grid w-full max-w-7xl flex-1 gap-4 px-3 py-3 pb-24 sm:px-4 sm:py-4 lg:grid-cols-[260px_minmax(0,1fr)_280px] lg:pb-4 2xl:max-w-[1800px] 2xl:grid-cols-[340px_minmax(0,1fr)_360px] 2xl:gap-6 2xl:text-lg">
      {spatial && <><img src={spatialRoom} width={1536} height={1024} alt="Contemporary room backdrop for spatial chat" className="pointer-events-none fixed inset-0 -z-20 size-full object-cover" /><div aria-hidden className="spatial-veil pointer-events-none fixed inset-0 -z-10" /></>}
      <ProfilePanel show={view === "plan"} />
      <div className={`${spatial ? "spatial-glass" : "panel"} ${view === "talk" ? "flex" : "hidden"} lg:flex min-h-[calc(100dvh-10rem)] lg:sticky lg:top-4 lg:h-[calc(100dvh-6.5rem)] lg:min-h-0 min-w-0 flex-col rounded-lg px-4 pb-6 pt-5 sm:px-8 2xl:px-12`}>
      <div className="contents">
      {spatial && <div className="mb-3 flex items-center justify-between gap-2 border-b border-border pb-3">
        <div className="min-w-0"><p className="dc-label text-[10px]">Spatial chat</p><p className="truncate text-sm font-semibold text-foreground">{getAgents(voice)[voice.agent]?.label ?? "OpenClaw"}</p></div>
        <select aria-label="Choose agent" value={voice.agent} onChange={(event) => setVoice((previous) => ({ ...previous, agent: event.target.value }))} className="max-w-32 rounded-md border border-border bg-surface px-2 py-1.5 text-xs text-foreground lg:hidden">{Object.entries(getAgents(voice)).map(([id, agent]) => <option value={id} key={id}>{agent.label}</option>)}</select>
        <Button size="sm" variant="outline" onClick={() => setHeadset(true)} className="glass h-8 gap-1.5 rounded-full text-xs"><ScanFace className="size-3.5" />Headset</Button>
      </div>}
      <Waveform level={level} active={isRecording} stage={run?.stage} />

      <div ref={scrollRef} className="mt-6 min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
        {!run && (
          <div className="flex justify-center">
            <Button variant="outline" size="sm" className="h-7 rounded-full text-xs" onClick={() => postPhase(0)} disabled={busy || isRecording}>
              <ListTree className="size-3.5" /> Walk through plan
            </Button>
          </div>
        )}
        {messages.length === 0 && !run && (
           <div className={spatial ? "px-3 py-6 sm:px-5" : "glass rounded-2xl px-5 py-8 sm:px-7"}>
            <p className="dc-label">● Ready to listen</p>
            <p className="mt-4 text-base leading-relaxed text-muted-foreground">Hold the microphone, turn on Standby, or type below to start.</p>
          </div>
        )}

        {messages.map((message) =>
          message.role === "user" ? (
            <UserBubble key={message.id} text={message.text} at={message.at} />
          ) : (
            <div key={message.id} className="space-y-1.5">
              <BotBubble sender={`OpenClaw${message.sender ? ` · ${message.sender}` : ""}`} at={message.at}>
                {message.phase ? (
                  <div className="space-y-1.5">
                    <p className="text-sm font-semibold">{message.text}</p>
                    <p className="font-mono text-[11px] text-muted-foreground">Model · {message.phase.model} · Stage · {message.phase.status}</p>
                    <p className={`font-mono text-[11px] ${message.phase.state === "waiting" ? "text-severity-medium" : message.phase.state === "approved" ? "text-primary" : "text-muted-foreground"}`}>
                      {message.phase.state === "waiting" ? "⏸ Waiting for your approval" : message.phase.state === "approved" ? "✓ Approved" : message.phase.state === "skipped" ? "↷ Skipped" : "■ Stopped"}
                    </p>
                    {message.phase.state === "waiting" && (
                      <InlineKeyboard buttons={[
                        { key: "a", label: "Approve", onClick: () => decidePhase(message.id, "approved"), disabled: busy || isRecording },
                        { key: "s", label: "Skip", onClick: () => decidePhase(message.id, "skipped"), disabled: busy || isRecording },
                        { key: "x", label: "Stop", tone: "danger", onClick: () => decidePhase(message.id, "stopped"), disabled: busy || isRecording },
                      ]} />
                    )}
                  </div>
                ) : <PagedScreen
                  text={message.text}
                  screen={message.id === messages[messages.length - 1]?.id ? message.screen : undefined}
                  disabled={busy || isRecording}
                  onSend={sendText}
                />}
                {message.steps && <StepLog steps={message.steps} defaultOpen={runOptions.expandSteps} />}
              </BotBubble>
              <div className="flex flex-wrap items-center gap-1.5 pl-1">
                <Button variant="ghost" size="sm"
                  onClick={() => {
                    messagesRef.current = messagesRef.current.map((item) =>
                      item.id === message.id ? { ...item, liked: !item.liked } : item,
                    );
                    setMessages(messagesRef.current);
                  }}
                  className={`stage-chip h-auto transition-colors hover:bg-surface-raised ${message.liked ? "text-primary" : ""}`}
                >
                  <ThumbsUp className="size-3.5" /> Useful
                </Button>
                <Button variant="ghost" size="sm" onClick={retry} disabled={busy} className="stage-chip h-auto transition-colors hover:bg-surface-raised disabled:opacity-50">
                  <RotateCcw className="size-3.5" /> Retry
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setOpenDetails((current) => (current === message.id ? null : message.id))} className="stage-chip h-auto transition-colors hover:bg-surface-raised">
                  <ListTree className="size-3.5" /> Thinking
                </Button>
                <Button variant="ghost" size="sm" onClick={() => { setSpeaking(true); void speakWith(voice, message.text).catch((e: unknown) => setNotice(e instanceof Error ? e.message : "The voice engine failed")).finally(() => setSpeaking(false)); }} className="stage-chip h-auto transition-colors hover:bg-surface-raised">
                  <Volume2 className="size-3.5" /> Replay
                </Button>
              </div>
              {openDetails === message.id && (
                <div className="panel p-4">
                  <p className="dc-label text-dc-muted-2">Agent thinking</p>
                  <p className="mt-2 whitespace-pre-wrap font-mono text-xs leading-relaxed text-foreground">
                    {message.reasoning?.trim() || "No thinking summary was returned for this answer."}
                  </p>
                </div>
              )}
            </div>
          ),
        )}

        {run && <StatusCard run={run} onDismiss={() => setRun(null)} onCancel={stopRun} />}
      </div>

      {notice && (
        <div role="alert" className="tg-pop mt-3 flex items-start gap-2 rounded-lg border border-destructive/50 bg-surface px-3 py-2 text-xs text-foreground">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-destructive" /><span className="min-w-0 flex-1">{notice}</span>
          <button type="button" aria-label="Dismiss" onClick={() => setNotice(null)} className="text-muted-foreground"><XIcon className="size-3.5" /></button>
        </div>
      )}
      <footer className="mt-4 flex flex-col items-center gap-3">
        <form className="flex w-full max-w-2xl items-end gap-2" onSubmit={(e) => { e.preventDefault(); submitDraft(); }}>
          <div className="glass min-w-0 flex-1 rounded-2xl focus-within:border-primary/60">
            {attachment && (
              <div className="flex items-center gap-2 border-b border-border px-3 py-1.5 font-mono text-[11px] text-muted-foreground">
                <Paperclip className="size-3" /><span className="min-w-0 flex-1 truncate">{attachment.name}</span>
                <button type="button" aria-label="Remove attachment" onClick={() => setAttachment(null)}><XIcon className="size-3" /></button>
              </div>
            )}
            <textarea ref={inputRef} rows={1} value={draft} onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submitDraft(); } }}
              placeholder="Type a message… (Enter to send)" aria-label="Message"
              className="block max-h-32 min-h-12 w-full resize-none bg-transparent px-4 py-3 text-sm text-foreground outline-none placeholder:text-muted-foreground" />
          </div>
          <label className="glass flex size-12 shrink-0 cursor-pointer items-center justify-center rounded-2xl text-foreground hover:bg-white/10" aria-label="Attach a text file">
            <Paperclip className="size-5" />
            <input type="file" className="sr-only" accept=".txt,.md,.json,.csv,.yaml,.yml,.log,text/*" onChange={(e) => { void attach(e.target.files?.[0]); e.target.value = ""; }} />
          </label>
          <Button type="submit" disabled={busy || isRecording || (!draft.trim() && !attachment)} aria-label="Send" className="size-12 shrink-0 rounded-2xl">
            <SendHorizontal className="size-5" />
          </Button>
        </form>
        <div className="relative">
          {isRecording && <span className="pulse-ring absolute inset-0 rounded-full bg-primary" />}
          <Button
            variant="default"
            onPointerDown={() => void startRecording()}
            onPointerUp={() => void stopRecording()}
            onPointerLeave={() => isRecording && void stopRecording()}
            disabled={busy}
            aria-label={isRecording ? "Release to send" : "Hold to talk"}
            className="mic-button relative flex size-20 items-center justify-center rounded-full active:scale-95 disabled:opacity-40 [&_svg]:size-8"
            style={isRecording ? { filter: `brightness(${1 + Math.min(level, 0.5)})` } : undefined}
          >
            <Mic className="size-8" />
          </Button>
        </div>
        <p className="font-mono text-xs text-muted-foreground">
          {isRecording ? (standby ? "standing by… pause to send" : "listening… release to send") : busy ? "agent is running · Esc stop" : speaking ? "speaking · Esc stop" : "hold to talk · F9 standby · Esc stop"}
        </p>
        {(busy || speaking) && (
          <Button variant="outline"
            onClick={stopAll}
            className="glass inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-white/10"
          >
            <Square className="size-3.5" /> Stop
          </Button>
        )}
      </footer>
      </div>
      </div>
      <LifecyclePanel
        statusLabel={isRecording ? "Listening" : run ? STAGE_LABEL[run.stage] : "Idle"}
        turns={messages.length}
        show={view === "run"}
        proposal={messages[messages.length - 1]?.role === "assistant" ? messages[messages.length - 1]?.screen?.actionProposal : null}
        disabled={busy || isRecording}
        onDecideProposal={(proposal: ActionProposal, approved: boolean) => {
          sendText(
            approved
              ? `Approved action [${proposal.id}] (${proposal.title} via ${proposal.tool}). Proceed and report the result.`
              : `Denied action [${proposal.id}] (${proposal.title}). Do not execute.`,
          );
        }}
      />
      </div>
      <nav aria-label="Console sections" className="fixed inset-x-0 bottom-0 z-20 grid grid-cols-3 border-t border-border bg-background/55 pb-[env(safe-area-inset-bottom)] backdrop-blur-xl backdrop-saturate-150 lg:hidden">
        {([["talk", "◉", "Talk"], ["plan", "▤", "Models & plan"], ["run", "◷", "Run"]] as const).map(([key, glyph, label]) => (
          <button key={key} type="button" onClick={() => setView(key)} aria-current={view === key ? "page" : undefined}
            className={`flex min-h-16 flex-col items-center justify-center gap-0.5 text-xs ${view === key ? "text-primary" : "text-muted-foreground"}`}>
            <span aria-hidden className="text-lg leading-none">{glyph}</span>{label}
          </button>
        ))}
      </nav>
      {headset && <Suspense fallback={null}><XrChat messages={messages} recording={isRecording} busy={busy} activeAgentId={voice.agent} activePlan={plans.workflows.find((project) => project.id === plans.activeId)} liveText={run ? partialText(run.answer) || run.heard || STAGE_LABEL[run.stage] : ""} standby={standby} onSelectAgent={(agent) => setVoice((previous) => ({ ...previous, agent }))} onSendMessage={sendText} onToggleStandby={toggleStandby} onStop={stopAll} status={isRecording ? "Listening" : run ? STAGE_LABEL[run.stage] : "Ready"} onTalkStart={() => void startRecording()} onTalkEnd={() => void stopRecording()} onClose={() => setHeadset(false)} /></Suspense>}
      <GeneralSettings open={settingsOpen} onOpenChange={setSettingsOpen} />
    </main>
  );
}

const LIVE_LABEL: Record<Stage, string> = {
  received: "received your message",
  transcribing: "listening back",
  planning: "planning",
  thinking: "thinking",
  streaming: "typing",
  speaking: "recording voice",
  error: "failed",
};

/** One live bot message that is edited in place as the run moves through each stage. */
function StatusCard({ run, onDismiss, onCancel }: { run: Run; onDismiss: () => void; onCancel: () => void }) {
  if (run.stage === "error") {
    return (
      <BotBubble sender="OpenClaw" at={Date.now()}>
        <p className="stage-chip text-destructive"><AlertTriangle className="size-3.5" /> Failed</p>
        <p className="mt-2 text-sm text-foreground">{run.error}</p>
        <StepLog steps={run.steps} defaultOpen />
        <InlineKeyboard buttons={[{ key: "ok", label: "Dismiss", onClick: onDismiss }]} />
      </BotBubble>
    );
  }
  return (
    <BotBubble sender={`OpenClaw${run.sender ? ` · ${run.sender}` : ""}`} at={Date.now()} edited={run.steps.length > 1}>
      {run.heard && run.stage === "transcribing" && <p className="font-mono text-xs text-muted-foreground">heard: <span className="text-foreground">{run.heard}</span></p>}
      {run.answer ? (
        <p className="caret whitespace-pre-wrap text-sm leading-relaxed text-foreground">{run.answer}</p>
      ) : run.reasoning ? (
        <p className="line-clamp-3 font-mono text-xs leading-relaxed text-muted-foreground">{run.reasoning}</p>
      ) : null}
      <p className="mt-1"><TypingDots label={LIVE_LABEL[run.stage]} /></p>
      <StepLog steps={run.steps} defaultOpen live />
      <InlineKeyboard buttons={[{ key: "cancel", label: "✕ Cancel", onClick: onCancel, tone: "danger" }]} />
    </BotBubble>
  );
}
