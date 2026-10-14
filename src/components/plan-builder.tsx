import { useEffect, useState } from "react";
import { ArrowDown, ArrowUp, ChevronRight, Cpu, Crosshair, Maximize2, MoreHorizontal, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useLocal, writeLocal } from "@/lib/settings/store";
import { UnifiedRoadmap } from "@/components/unified-roadmap";

type Status = "todo" | "started" | "done";
export type PlanNode = { id: string; title: string; status: Status; children: PlanNode[]; open?: boolean; model?: string | undefined };
type Project = { id: string; name: string; phases: PlanNode[] };
type PlanState = { workflows: Project[]; activeId: string; share: boolean; view: "list" | "flow"; focusId?: string | null };

/** V3 model portfolio — candidates a task or sub-task can be assigned to. Children inherit their parent's model. */
export const PORTFOLIO: { role: string; model: string }[] = [
  { role: "Primary", model: "gpt-5.6-terra" },
  { role: "Utility", model: "gpt-5.6-luna" },
  { role: "Orchestrator", model: "gpt-5.6-sol" },
  { role: "Pro", model: "gpt-5.6-sol-pro" },
  { role: "Vision · PDF", model: "gemini-3.1-pro" },
  { role: "Local coder", model: "qwen3-coder:30b" },
  { role: "Local general", model: "gpt-oss:120b" },
];
export const FAILOVER = ["claude-opus-4-6", "gemini-3.1-pro", "MiniMax-M2.7"];

/** Finds a node and the model it uses (its own, or the nearest parent's). */
export function findWithModel(ns: PlanNode[], id: string, inherited?: string): { node: PlanNode; model?: string | undefined; path: string[] } | null {
  for (const n of ns) {
    const m = n.model || inherited;
    if (n.id === id) return { node: n, model: m, path: [n.title] };
    const hit = findWithModel(n.children, id, m);
    if (hit) return { ...hit, path: [n.title, ...hit.path] };
  }
  return null;
}

/** The task the user is working on now and the model picked for it. */
export function focusModel(state: PlanState): { task: string; model?: string | undefined } | null {
  if (!state.focusId) return null;
  const p = state.workflows.find((w) => w.id === state.activeId);
  const hit = p && findWithModel(normalize(p.phases as Legacy[]), state.focusId);
  return hit ? { task: hit.path.join(" › "), model: hit.model } : null;
}

const uid = () => Math.random().toString(36).slice(2, 10);
const NEXT: Record<Status, Status> = { todo: "started", started: "done", done: "todo" };
const GLYPH: Record<Status, string> = { todo: "○", started: "◐", done: "✓" };
const WORD: Record<Status, string> = { todo: "Not started", started: "Started", done: "Complete" };
const TONE: Record<Status, string> = { todo: "text-muted-foreground", started: "text-severity-medium", done: "text-primary" };
const LEVELS = ["Phase", "Task", "Sub-task", "Sub-sub-task"];
export const levelName = (depth: number) => LEVELS[depth] ?? `Level ${depth + 1} item`;

type Tpl = [string, Tpl[]];
const V3 = ["P0 Preflight & backup", "P1 Resource reclamation", "P2 Runtime repair", "P3 Dev toolchain", "P4 GPU validation", "P5 MCP registry", "P6 LSP fabric", "P7 Model routing", "P8 Qt voice gateway", "P9 Whisper ASR", "P10 Event gateway", "P11 Voice chat UX", "P12 Observability", "P13 Security & approval", "P14 Performance", "P15 Acceptance"];
const TEMPLATES: Record<string, { name: string; phases: Tpl[] }> = {
  v3: { name: "OpenClaw V3 rollout", phases: V3.map((t) => [t, []]) },
  project: { name: "Simple project", phases: [["Discover", [["Define goals", [["Interview owner", []]]], ["List constraints", []]]], ["Plan", [["Break down tasks", []], ["Assign owners", []]]], ["Build", []], ["Test", []], ["Launch", []]] },
  incident: { name: "Incident response", phases: [["Detect", [["Confirm alert", []]]], ["Contain", [["Isolate affected hosts", []]]], ["Eradicate", []], ["Recover", []], ["Review", [["Write summary", []]]]] },
  blank: { name: "Blank project", phases: [] },
};
const build = (t: Tpl, states: Record<string, Status> = {}): PlanNode => ({ id: uid(), title: t[0], status: states[t[0]] ?? "todo", children: t[1].map((c) => build(c)) });
function fromTemplate(key: string, states: Record<string, Status> = {}): Project {
  const t = TEMPLATES[key] ?? TEMPLATES["blank"]!;
  return { id: uid(), name: t.name, phases: t.phases.map((p) => build(p, states)) };
}

const PLAN_KEY = "openclaw.plans";
const DEFAULT_PLAN: PlanState = { workflows: [{ ...fromTemplate("v3"), id: "v3" }], activeId: "v3", share: true, view: "list" };
export const usePlans = () => useLocal(PLAN_KEY, DEFAULT_PLAN);

// Older saves stored phases with a flat `steps` list; turn those into child tasks.
type Legacy = PlanNode & { steps?: { id: string; title: string; done: boolean }[] };
function normalize(nodes: Legacy[]): PlanNode[] {
  return nodes.map((n) => ({
    id: n.id, title: n.title, status: n.status, open: n.open ?? false, ...(n.model ? { model: n.model } : {}),
    children: n.children ? normalize(n.children as Legacy[]) : (n.steps ?? []).map((s) => ({ id: s.id, title: s.title, status: s.done ? "done" : "todo", children: [] })),
  }));
}

export function progress(n: PlanNode): number {
  if (!n.children.length) return n.status === "done" ? 1 : n.status === "started" ? 0.5 : 0;
  return n.children.reduce((a, c) => a + progress(c), 0) / n.children.length;
}
const count = (ns: PlanNode[]): number => ns.reduce((a, n) => a + 1 + count(n.children), 0);

function mapTree(ns: PlanNode[], id: string, fn: (n: PlanNode) => PlanNode | null): PlanNode[] {
  return ns.flatMap((n) => {
    if (n.id === id) { const r = fn(n); return r ? [r] : []; }
    return [{ ...n, children: mapTree(n.children, id, fn) }];
  });
}
function moveInTree(ns: PlanNode[], id: string, dir: -1 | 1): PlanNode[] {
  const i = ns.findIndex((n) => n.id === id);
  if (i >= 0) {
    const j = i + dir;
    if (j < 0 || j >= ns.length) return ns;
    const out = [...ns];
    [out[i], out[j]] = [out[j]!, out[i]!];
    return out;
  }
  return ns.map((n) => ({ ...n, children: moveInTree(n.children, id, dir) }));
}

/** Top-level phases of the active plan with the model each one uses. */
export function planPhases(state: PlanState): { id: string; title: string; status: string; model?: string | undefined }[] {
  const p = state.workflows.find((w) => w.id === state.activeId);
  return p ? normalize(p.phases as Legacy[]).map((n) => ({ id: n.id, title: n.title, status: WORD[n.status], model: n.model })) : [];
}

/** Plain-text outline the voice agent can read as context. */
export function planSummary(state: PlanState): string {
  if (!state.share) return "";
  const p = state.workflows.find((w) => w.id === state.activeId);
  if (!p) return "";
  const lines: string[] = [`Project: ${p.name}`];
  const f = focusModel(state);
  if (f) lines.push(`Current focus: ${f.task}${f.model ? ` (model: ${f.model})` : ""}`);
  const walk = (ns: PlanNode[], d: number) => ns.forEach((n, i) => {
    if (lines.length > 120) return;
    lines.push(`${"  ".repeat(d)}${d === 0 ? `${i + 1}.` : "-"} ${levelName(d)}: ${n.title} [${WORD[n.status]}${n.children.length ? `, ${Math.round(progress(n) * 100)}%` : ""}${n.model ? `, model ${n.model}` : ""}]`);
    walk(n.children, d + 1);
  });
  walk(normalize(p.phases as Legacy[]), 0);
  return lines.join("\n");
}

function usePlanActions() {
  const [state, setState] = usePlans();
  const project = state.workflows.find((w) => w.id === state.activeId) ?? state.workflows[0];
  const phases = project ? normalize(project.phases as Legacy[]) : [];
  const setPhases = (fn: (ns: PlanNode[]) => PlanNode[]) =>
    setState((s) => ({ ...s, workflows: s.workflows.map((w) => (w.id === project?.id ? { ...w, phases: fn(normalize(w.phases as Legacy[])) } : w)) }));
  return {
    state, setState, project, phases, setPhases,
    edit: (id: string, patch: Partial<PlanNode>) => setPhases((ns) => mapTree(ns, id, (n) => ({ ...n, ...patch }))),
    remove: (id: string) => setPhases((ns) => mapTree(ns, id, () => null)),
    move: (id: string, dir: -1 | 1) => setPhases((ns) => moveInTree(ns, id, dir)),
    addChild: (id: string, depth: number) => setPhases((ns) => mapTree(ns, id, (n) => ({ ...n, open: true, children: [...n.children, { id: uid(), title: `New ${levelName(depth + 1).toLowerCase()}`, status: "todo", children: [] }] }))),
    addPhase: () => setPhases((ns) => [...ns, { id: uid(), title: `Phase ${ns.length + 1}`, status: "todo", children: [] }]),
  };
}
type Actions = ReturnType<typeof usePlanActions>;

function Bar({ value }: { value: number }) {
  return <span aria-hidden className="h-1 w-10 shrink-0 overflow-hidden rounded-full bg-border"><span className="block h-full bg-primary transition-[width] duration-300" style={{ width: `${Math.round(value * 100)}%` }} /></span>;
}

function ModelPick({ node, inherited, roomy, a }: { node: PlanNode; inherited?: string | undefined; roomy: boolean; a: Actions }) {
  const shown = node.model || inherited;
  return (
    <label title={node.model ? `Model: ${node.model}` : inherited ? `Inherits ${inherited}` : "No model picked"} className={`relative flex shrink-0 items-center gap-0.5 rounded border px-1 font-mono ${node.model ? "border-primary/50 text-primary" : "border-border text-muted-foreground"} ${roomy ? "h-7 text-[10px]" : "h-5 text-[9px]"}`}>
      <Cpu aria-hidden className="size-3" />
      <span className={`truncate ${roomy ? "max-w-28" : "max-w-14"}`}>{shown ? shown.replace(/^gpt-5\.6-/, "") : "auto"}</span>
      <select aria-label={`Model for ${node.title}`} value={node.model ?? ""} onChange={(e) => a.edit(node.id, { model: e.target.value || undefined })} className="absolute inset-0 cursor-pointer opacity-0">
        <option value="">{inherited ? `Inherit (${inherited})` : "Auto (active model)"}</option>
        {PORTFOLIO.map((m) => <option key={m.model} value={m.model}>{m.role} — {m.model}</option>)}
        {FAILOVER.filter((f) => !PORTFOLIO.some((m) => m.model === f)).map((f) => <option key={f} value={f}>Failover — {f}</option>)}
      </select>
    </label>
  );
}

function TreeRow({ node, depth, a, first, last, roomy, inherited }: { node: PlanNode; depth: number; a: Actions; first: boolean; last: boolean; roomy: boolean; inherited?: string | undefined }) {
  const pct = progress(node);
  const focused = a.state.focusId === node.id;
  return (
    <li>
      <div className={`group flex items-center gap-1 rounded-md pr-1 hover:bg-surface-raised ${focused ? "bg-surface-raised ring-1 ring-primary/50" : ""} ${roomy ? "min-h-10 text-sm" : "min-h-8 text-[11px]"}`} style={{ paddingLeft: `${depth * (roomy ? 18 : 10)}px` }}>
        <button type="button" aria-label={node.open ? "Collapse" : "Expand"} aria-expanded={node.open} disabled={!node.children.length} onClick={() => a.edit(node.id, { open: !node.open })}
          className="flex size-6 shrink-0 items-center justify-center text-muted-foreground disabled:opacity-0">
          <ChevronRight className={`size-3.5 transition-transform duration-200 ${node.open ? "rotate-90" : ""}`} />
        </button>
        <button type="button" onClick={() => a.edit(node.id, { status: NEXT[node.status] })} aria-label={`${node.title}: ${WORD[node.status]}. Tap to change.`}
          className={`flex size-6 shrink-0 items-center justify-center font-mono ${TONE[node.status]}`}>{GLYPH[node.status]}</button>
        <input aria-label={`${levelName(depth)} name`} value={node.title} onChange={(e) => a.edit(node.id, { title: e.target.value })}
          className={`min-w-0 flex-1 rounded bg-transparent px-1 py-0.5 outline-none focus:bg-background focus:ring-1 focus:ring-primary ${node.status === "done" ? "text-muted-foreground line-through" : "text-foreground"} ${depth === 0 ? "font-semibold" : ""}`} />
        {node.children.length > 0 && (roomy ? <><Bar value={pct} /><span className="w-9 text-right font-mono text-[10px] text-muted-foreground">{Math.round(pct * 100)}%</span></> : <span className="font-mono text-[9px] text-muted-foreground">{Math.round(pct * 100)}%</span>)}
        <ModelPick node={node} inherited={inherited} roomy={roomy} a={a} />
        <button type="button" aria-label={focused ? "Stop working on this" : "Work on this now"} aria-pressed={focused} title={focused ? "Current focus — voice runs use its model" : "Set as current focus"}
          onClick={() => a.setState((s) => ({ ...s, focusId: focused ? null : node.id }))}
          className={`flex size-6 shrink-0 items-center justify-center ${focused ? "text-primary" : "text-muted-foreground opacity-50 hover:opacity-100"}`}><Crosshair className="size-3.5" /></button>
        <button type="button" aria-label={`Add ${levelName(depth + 1).toLowerCase()}`} onClick={() => a.addChild(node.id, depth)} className="flex size-6 shrink-0 items-center justify-center text-primary opacity-70 hover:opacity-100"><Plus className="size-3.5" /></button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild><button type="button" aria-label="More actions" className="flex size-6 shrink-0 items-center justify-center text-muted-foreground"><MoreHorizontal className="size-3.5" /></button></DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => a.addChild(node.id, depth)}><Plus className="size-3.5" /> Add {levelName(depth + 1).toLowerCase()}</DropdownMenuItem>
            <DropdownMenuItem disabled={first} onSelect={() => a.move(node.id, -1)}><ArrowUp className="size-3.5" /> Move up</DropdownMenuItem>
            <DropdownMenuItem disabled={last} onSelect={() => a.move(node.id, 1)}><ArrowDown className="size-3.5" /> Move down</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem className="text-destructive" onSelect={() => a.remove(node.id)}><Trash2 className="size-3.5" /> Delete{node.children.length ? ` with ${count(node.children)} inside` : ""}</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {node.open && node.children.length > 0 && (
        <ul className="tg-pop">
          {node.children.map((c, i) => <TreeRow key={c.id} node={c} depth={depth + 1} a={a} first={i === 0} last={i === node.children.length - 1} roomy={roomy} inherited={node.model || inherited} />)}
        </ul>
      )}
    </li>
  );
}

function Flow({ a, roomy }: { a: Actions; roomy: boolean }) {
  const [drag, setDrag] = useState<string | null>(null);
  return (
    <ol className={roomy ? "flex gap-3 overflow-x-auto pb-2" : "flex flex-col"}>
      {a.phases.map((p, i) => (
        <li key={p.id} className={roomy ? "w-60 shrink-0" : "flex flex-col items-center"}>
          <div draggable onDragStart={() => setDrag(p.id)} onDragOver={(e) => e.preventDefault()}
            onDrop={() => { if (drag && drag !== p.id) { const from = a.phases.findIndex((x) => x.id === drag); a.setPhases((ns) => { const out = ns.filter((x) => x.id !== drag); out.splice(i, 0, ns[from]!); return out; }); } setDrag(null); }}
            className={`w-full cursor-grab rounded-lg border bg-surface p-2.5 transition-colors ${drag === p.id ? "border-primary opacity-60" : p.status === "done" ? "border-primary/50" : p.status === "started" ? "border-severity-medium/60" : "border-border"}`}>
            <div className="flex items-center gap-2 text-xs">
              <button type="button" onClick={() => a.edit(p.id, { status: NEXT[p.status] })} aria-label={`${p.title}: ${WORD[p.status]}`} className={`font-mono ${TONE[p.status]}`}>{GLYPH[p.status]}</button>
              <span className="min-w-0 flex-1 truncate font-semibold text-foreground">{p.title}</span>
              <Bar value={progress(p)} />
            </div>
            {roomy && p.children.length > 0 && (
              <ul className="mt-2 space-y-1">
                {p.children.map((t) => (
                  <li key={t.id} className="flex items-center gap-1.5 rounded border border-border/60 px-2 py-1 text-[11px]">
                    <button type="button" onClick={() => a.edit(t.id, { status: NEXT[t.status] })} aria-label={`${t.title}: ${WORD[t.status]}`} className={`font-mono ${TONE[t.status]}`}>{GLYPH[t.status]}</button>
                    <span className="min-w-0 flex-1 truncate">{t.title}</span>
                    {t.children.length > 0 && <span className="font-mono text-[9px] text-muted-foreground">{count(t.children)} sub</span>}
                  </li>
                ))}
              </ul>
            )}
            {roomy && <button type="button" onClick={() => a.addChild(p.id, 0)} className="mt-2 text-[11px] text-primary">+ Add task</button>}
          </div>
          {!roomy && i < a.phases.length - 1 && <span aria-hidden className="py-0.5 text-xs text-primary/60">↓</span>}
        </li>
      ))}
    </ol>
  );
}

function FocusLine({ state }: { state: PlanState }) {
  const f = focusModel(state);
  return (
    <p className="mt-1 flex items-center gap-1.5 rounded-md border border-border px-2 py-1 font-mono text-[10px] text-muted-foreground">
      <Crosshair aria-hidden className={`size-3 ${f ? "text-primary" : ""}`} />
      {f ? <><span className="min-w-0 flex-1 truncate text-foreground">{f.task}</span><Cpu aria-hidden className="size-3 text-primary" /><span className="text-primary">{f.model ?? "active model"}</span></>
        : <span>Tap ⌖ on a task to work on it — its model is used for voice runs.</span>}
    </p>
  );
}

function PlanEditor({ roomy, onExpand }: { roomy: boolean; onExpand?: () => void }) {
  const a = usePlanActions();
  const [tpl, setTpl] = useState("project");
  const { state, setState, project, phases } = a;
  if (!project) return null;
  const done = phases.filter((p) => progress(p) === 1).length;
  const total = phases.length ? phases.reduce((s, p) => s + progress(p), 0) / phases.length : 0;
  const ctl = `rounded-md border border-border bg-background px-2 text-foreground ${roomy ? "py-2 text-sm" : "py-1.5 text-xs"}`;

  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <p className="dc-label text-[10px]">Planning workflow</p>
        <span className="flex items-center gap-2 font-mono text-[10px] text-muted-foreground">{done}/{phases.length} phases · {Math.round(total * 100)}%
          {onExpand && <button type="button" aria-label="Open full planner" onClick={onExpand} className="text-primary"><Maximize2 className="size-3.5" /></button>}
        </span>
      </div>
      <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-border"><div className="h-full bg-primary transition-[width] duration-500" style={{ width: `${total * 100}%` }} /></div>

      <div className={`mt-3 grid gap-2 ${roomy ? "sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]" : ""}`}>
        <div className="flex gap-1">
          <select aria-label="Project" className={`${ctl} w-0 min-w-0 flex-1`} value={project.id} onChange={(e) => setState((s) => ({ ...s, activeId: e.target.value }))}>
            {state.workflows.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
          <Button variant="ghost" size="sm" className="h-auto px-2" aria-label="Delete project" onClick={() => setState((s) => {
            const rest = s.workflows.filter((w) => w.id !== project.id);
            const workflows = rest.length ? rest : [fromTemplate("blank")];
            return { ...s, workflows, activeId: workflows[0]!.id };
          })}><Trash2 className="size-3.5" /></Button>
        </div>
        <div className="flex gap-1">
          <select aria-label="Template" className={`${ctl} w-0 min-w-0 flex-1 text-muted-foreground`} value={tpl} onChange={(e) => setTpl(e.target.value)}>
            {Object.entries(TEMPLATES).map(([k, t]) => <option key={k} value={k}>New from: {t.name}</option>)}
          </select>
          <Button variant="outline" size="sm" className="h-auto border-primary/40 px-2 text-[11px]" onClick={() => { const n = fromTemplate(tpl); setState((s) => ({ ...s, workflows: [...s.workflows, n], activeId: n.id })); }}><Plus className="size-3" /> New</Button>
        </div>
      </div>
      <input aria-label="Project name" className={`mt-2 w-full rounded bg-transparent px-1 font-semibold text-foreground outline-none focus:ring-1 focus:ring-primary ${roomy ? "text-lg" : "text-sm"}`} value={project.name}
        onChange={(e) => setState((s) => ({ ...s, workflows: s.workflows.map((w) => (w.id === project.id ? { ...w, name: e.target.value } : w)) }))} />
      <FocusLine state={state} />
      <p className="px-1 font-mono text-[10px] text-muted-foreground">Project → Phases → Tasks → Sub-tasks → … ({count(phases)} items)</p>

      <div role="tablist" className="mt-3 grid grid-cols-2 rounded-md border border-border p-0.5 text-[11px]">
        {(["list", "flow"] as const).map((v) => (
          <button key={v} role="tab" aria-selected={state.view === v} onClick={() => setState((s) => ({ ...s, view: v }))}
            className={`rounded px-2 py-1.5 transition-colors ${state.view === v ? "bg-surface-raised text-primary" : "text-muted-foreground"}`}>{v === "list" ? "Outline" : roomy ? "Board" : "Flow"}</button>
        ))}
      </div>

      <div className="mt-2">
        {state.view === "list" ? (
          phases.length ? <ul>{phases.map((p, i) => <TreeRow key={p.id} node={p} depth={0} a={a} first={i === 0} last={i === phases.length - 1} roomy={roomy} />)}</ul>
            : <p className="py-4 text-center text-xs text-muted-foreground">No phases yet. Add the first one below.</p>
        ) : <Flow a={a} roomy={roomy} />}
      </div>
      <button type="button" onClick={a.addPhase} className="mt-2 text-xs font-medium text-primary">+ Add phase</button>
      {state.view === "flow" && <p className="mt-1 text-[10px] text-muted-foreground">Drag a phase onto another to reorder.</p>}

      <label className="mt-3 flex items-start gap-2 text-[11px] text-muted-foreground">
        <input type="checkbox" className="mt-0.5 accent-primary" checked={state.share} onChange={(e) => setState((s) => ({ ...s, share: e.target.checked }))} />
        Let the voice agent read this plan when answering
      </label>
      <UnifiedRoadmap />
    </div>
  );
}

export function PlanBuilder() {
  const [full, setFull] = useState(false);
  useEffect(() => {
    if (localStorage.getItem(PLAN_KEY)) return;
    let old: Record<string, Status> = {};
    try { old = JSON.parse(localStorage.getItem("openclaw.v3.phases") ?? "{}"); } catch { /* ignore */ }
    writeLocal(PLAN_KEY, { ...DEFAULT_PLAN, workflows: [{ ...fromTemplate("v3", old), id: "v3" }] });
  }, []);
  return (
    <section className="panel p-4">
      <PlanEditor roomy={false} onExpand={() => setFull(true)} />
      <Dialog open={full} onOpenChange={setFull}>
        <DialogContent className="max-h-[92dvh] overflow-y-auto border-border bg-background sm:max-w-5xl">
          <DialogHeader>
            <DialogTitle>Planner</DialogTitle>
            <DialogDescription>Shape the project as phases, tasks and as many levels of sub-tasks as you need. Saved in this browser.</DialogDescription>
          </DialogHeader>
          <PlanEditor roomy />
        </DialogContent>
      </Dialog>
    </section>
  );
}
