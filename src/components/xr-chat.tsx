import { Suspense, useMemo, useState, useEffect, useRef } from "react";
import { Canvas, useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import { Text, OrbitControls, RoundedBox, Environment, Lightformer } from "@react-three/drei";
import { XR, createXRStore, useXR } from "@react-three/xr";
import * as THREE from "three";
import { ScanFace, X, Mic, Square, ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getAgents, useVoiceSettings } from "@/lib/settings/voice";
import { useTheme } from "@/lib/settings/theme";
import { roomChoices, roomPages, type RoomMessage } from "@/lib/xr-room";
import type { PlanNode } from "@/components/plan-builder";

export type XrMessage = RoomMessage;
type Props = {
  messages: XrMessage[]; status: string; recording: boolean; busy: boolean;
  activeAgentId: string; activePlan?: { name: string; phases: PlanNode[] } | undefined;
  liveText: string; standby: boolean;
  onSendMessage: (text: string) => void; onSelectAgent: (id: string) => void;
  onToggleStandby: () => void; onStop: () => void;
  onTalkStart: () => void; onTalkEnd: () => void; onClose: () => void;
};
type Palette = { background: string; surface: string; text: string; muted: string; accent: string; glass: number };
const TOKEN_DEFAULTS = { background: "#050807", surface: "#0b1511", text: "#e9fff6", muted: "#8ba69c", accent: "#00ff88", glass: 0.72 };

function Label({ children, position, size = 0.055, color, width = 2.1 }: { children: React.ReactNode; position: [number, number, number]; size?: number; color: string; width?: number }) {
  return <Text position={position} anchorX="left" anchorY="top" fontSize={size} maxWidth={width} lineHeight={1.35} color={color}>{children}</Text>;
}
function Glass({ width, height, p }: { width: number; height: number; p: Palette }) {
  return <>
    <RoundedBox args={[width + 0.025, height + 0.025, 0.025]} radius={0.055} position-z={-0.02}><meshBasicMaterial color={p.accent} transparent opacity={0.22} /></RoundedBox>
    <RoundedBox args={[width, height, 0.035]} radius={0.05}><meshPhysicalMaterial color={p.surface} transparent opacity={p.glass} roughness={0.22} metalness={0.12} clearcoat={1} depthWrite={false} /></RoundedBox>
  </>;
}
function SpatialButton({ text, position, width = 0.75, disabled = false, active = false, p, onClick }: { text: string; position: [number, number, number]; width?: number; disabled?: boolean; active?: boolean; p: Palette; onClick: () => void }) {
  const [hover, setHover] = useState(false);
  return <group position={position}>
    <RoundedBox args={[width, 0.19, 0.045]} radius={0.035} onPointerOver={(e) => { e.stopPropagation(); setHover(true); }} onPointerOut={() => setHover(false)} onClick={(e) => { e.stopPropagation(); if (!disabled) onClick(); }}>
      <meshStandardMaterial color={active || hover ? p.accent : p.surface} transparent opacity={disabled ? 0.3 : 0.92} />
    </RoundedBox>
    <Text position={[0, 0, 0.03]} fontSize={0.043} maxWidth={width - 0.06} color={active || hover ? p.background : p.text}>{text}</Text>
  </group>;
}
/** Apple Vision Pro style: a calm void with soft lighting, no scenery or avatars. */
function SpaceRoom({ p }: { p: Palette }) {
  return <>
    <Environment resolution={64}>
      <Lightformer intensity={1.4} position={[0, 4, 1]} scale={[8, 6, 1]} />
      <Lightformer color={p.accent} intensity={0.35} position={[-4, 2, 1]} rotation-y={Math.PI / 2} scale={[5, 3, 1]} />
    </Environment>
  </>;
}
function AgentRail({ p, activeAgentId, onSelectAgent, busy }: Pick<Props, "activeAgentId" | "onSelectAgent" | "busy"> & { p: Palette }) {
  const [voice] = useVoiceSettings();
  const agents = getAgents(voice);
  return <group position={[-2.06, 1.65, -2.65]} rotation-y={0.25}>
    <Glass width={1.18} height={1.9} p={p} />
    <Label position={[-0.48, 0.82, 0.04]} color={p.accent} width={1}>AGENTS</Label>
    {Object.entries(agents).slice(0, 4).map(([id, agent], i) => <group key={id} position={[0, 0.46 - i * 0.41, 0.035]} onClick={(e) => { e.stopPropagation(); if (!busy) onSelectAgent(id); }}>
      <mesh position-z={-0.002} onClick={(e) => { e.stopPropagation(); if (!busy) onSelectAgent(id); }}><planeGeometry args={[1.08, 0.39]} /><meshBasicMaterial transparent opacity={0} depthWrite={false} /></mesh>
      <mesh position={[-0.44, 0.065, 0.03]}><circleGeometry args={[0.014, 16]} /><meshBasicMaterial color={id === activeAgentId ? p.accent : p.muted} /></mesh>
      <Label position={[-0.36, 0.08, 0.03]} color={id === activeAgentId ? p.accent : p.text} width={0.78} size={0.047}>{agent.label}</Label>
    </group>)}
  </group>;
}
function PlanRail({ p, activePlan, status }: Pick<Props, "activePlan" | "status"> & { p: Palette }) {
  const [page, setPage] = useState(0);
  const phases = activePlan?.phases ?? [];
  const count = Math.max(1, Math.ceil(phases.length / 5));
  const current = Math.min(page, count - 1);
  return <group position={[2.06, 1.65, -2.65]} rotation-y={-0.25}>
    <Glass width={1.18} height={1.9} p={p} />
    <Label position={[-0.48, 0.82, 0.04]} color={p.accent} width={1}>WORKFLOW</Label>
    <Label position={[-0.48, 0.68, 0.04]} color={p.text} width={0.97} size={0.048}>{activePlan?.name ?? "No active project"}</Label>
    {phases.slice(current * 5, current * 5 + 5).map((phase, i) => <Label key={phase.id} position={[-0.48, 0.43 - i * 0.19, 0.04]} color={phase.status === "done" ? p.accent : p.muted} width={0.96} size={0.04}>{`${phase.status === "done" ? "✓" : phase.status === "started" ? "◐" : "○"} ${phase.title.slice(0, 42)}`}</Label>)}
    <SpatialButton text="‹" position={[-0.32, -0.62, 0.06]} width={0.23} p={p} disabled={current === 0} onClick={() => setPage(current - 1)} />
    <SpatialButton text="›" position={[0.32, -0.62, 0.06]} width={0.23} p={p} disabled={current === count - 1} onClick={() => setPage(current + 1)} />
    <Label position={[-0.46, -0.79, 0.04]} color={p.accent} size={0.04} width={0.95}>{status} · {current + 1}/{count}</Label>
  </group>;
}
function TalkControl({ p, recording, busy, onTalkStart, onTalkEnd }: Pick<Props, "recording" | "busy" | "onTalkStart" | "onTalkEnd"> & { p: Palette }) {
  const held = useRef<number | null>(null);
  const ring = useRef<THREE.Mesh>(null);
  const elapsed = useRef(0);
  const endRef = useRef(onTalkEnd); endRef.current = onTalkEnd;
  const release = (event?: ThreeEvent<PointerEvent>) => {
    if (held.current === null || (event && held.current !== event.pointerId)) return;
    held.current = null; endRef.current();
  };
  useEffect(() => {
    const end = () => release();
    window.addEventListener("blur", end);
    return () => { window.removeEventListener("blur", end); end(); };
  }, []);
  useFrame((_, rawDelta) => {
    elapsed.current += Math.min(rawDelta, 0.05);
    if (ring.current) ring.current.scale.setScalar(recording ? 1.1 + Math.sin(elapsed.current * 6) * 0.07 : 1);
  });
  return <group position={[0, 0.36, -1.95]}>
    <mesh ref={ring} position-z={-0.01}><ringGeometry args={[0.16, 0.18, 48]} /><meshBasicMaterial color={p.accent} transparent opacity={0.6} /></mesh>
    <mesh rotation-x={Math.PI / 2} onPointerDown={(e) => {
      e.stopPropagation(); if (busy || held.current !== null) return;
      held.current = e.pointerId;
      const target = e.target as unknown as { setPointerCapture?: (id: number) => void };
      target?.setPointerCapture?.(e.pointerId); onTalkStart();
    }} onPointerUp={(e) => { e.stopPropagation(); release(e); const target = e.target as unknown as { releasePointerCapture?: (id: number) => void }; target?.releasePointerCapture?.(e.pointerId); }} onPointerCancel={(e) => release(e)}>
      <cylinderGeometry args={[0.14, 0.14, 0.06, 48]} /><meshStandardMaterial color={p.accent} emissive={p.accent} emissiveIntensity={recording ? 0.7 : 0.15} />
    </mesh>
    <Text position={[0, -0.27, 0.05]} fontSize={0.052} color={p.text}>{recording ? "Listening…" : busy ? "Working…" : "Hold to talk"}</Text>
  </group>;
}
function RoomScene({ props, p, page, setPage }: { props: Props; p: Palette; page: number; setPage: (page: number) => void }) {
  const [voice] = useVoiceSettings();
  const agents = getAgents(voice);
  const session = useXR((s) => s.session);
  const { camera, size } = useThree();
  const compact = size.width < 600 && !session;
  useEffect(() => {
    if (session) return;
    const aspect = size.width / size.height;
    camera.position.set(0, 1.6, Math.max(2.1, (compact ? 1.55 : 3.25) / (Math.tan(32 * Math.PI / 180) * aspect) - 2.45));
    camera.lookAt(0, 1.6, -2.45);
  }, [camera, size.width, size.height, compact, session]);
  const pages = roomPages(props.messages);
  const current = Math.min(page, Math.max(0, pages.length - 1));
  const shown = pages[current];
  const choices = roomChoices(props.messages);
  return <>
    <SpaceRoom p={p} />
    {!compact && <AgentRail {...props} p={p} />}
    {!compact && <PlanRail {...props} p={p} />}
    <group position={[0, 1.65, -2.45]}>
      <Glass width={2.58} height={1.95} p={p} />
      <Label position={[-1.16, 0.84, 0.04]} color={p.accent} size={0.064}>SPATIAL CHAT</Label>
      <Label position={[-1.16, 0.69, 0.04]} color={p.muted} size={0.044}>{agents[props.activeAgentId]?.label ?? "OpenClaw"} · {props.status}</Label>
      <Label position={[-1.16, 0.49, 0.04]} color={shown?.role === "user" ? p.accent : p.text} size={0.057} width={2.3}>{props.liveText ? props.liveText.slice(-440) : shown?.text ?? "Ready to listen."}</Label>
      <SpatialButton text="‹" position={[-1.02, -0.43, 0.07]} width={0.26} disabled={current === 0} p={p} onClick={() => setPage(current - 1)} />
      <SpatialButton text="›" position={[1.02, -0.43, 0.07]} width={0.26} disabled={current >= pages.length - 1} p={p} onClick={() => setPage(current + 1)} />
      <Text position={[0, -0.43, 0.06]} fontSize={0.038} color={p.muted}>{pages.length ? `${shown?.role === "user" ? "You" : "Agent"} · ${current + 1}/${pages.length}` : "New session"}</Text>
      {choices.map((choice, i) => <SpatialButton key={`${i}-${choice.value}`} text={choice.label} position={[-0.6 + (i % 2) * 1.2, -0.65 - Math.floor(i / 2) * 0.23, 0.07]} width={1.12} p={p} disabled={props.busy || props.recording} onClick={() => props.onSendMessage(choice.value)} />)}
    </group>
    <TalkControl {...props} p={p} />
    <group position={[0, 0.38, -2.15]}>
      <SpatialButton text={props.standby ? "Standby on" : "Standby"} position={[-0.82, 0, 0]} width={0.74} active={props.standby} p={p} onClick={props.onToggleStandby} />
      <SpatialButton text="Stop" position={[0.82, 0, 0]} width={0.74} p={p} onClick={props.onStop} />
      {!compact && <SpatialButton text="Close room" position={[1.68, 0, 0]} width={0.76} p={p} onClick={props.onClose} />}
    </group>
    {!session && <OrbitControls target={[0, 1.6, -2.45]} enablePan={false} enableZoom={false} minAzimuthAngle={-0.7} maxAzimuthAngle={0.7} minPolarAngle={1.2} maxPolarAngle={1.8} />}
  </>;
}
export default function XrChat(props: Props) {
  const store = useMemo(() => createXRStore({ emulate: false, offerSession: false, controller: { rayPointer: true, grabPointer: true }, hand: { rayPointer: true, touchPointer: true, grabPointer: true } }), []);
  const [supported, setSupported] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [p, setPalette] = useState<Palette>(TOKEN_DEFAULTS);
  const [theme] = useTheme();
  const [page, setPage] = useState(0);
  const pages = roomPages(props.messages);
  useEffect(() => { setPage(Math.max(0, pages.length - 1)); }, [props.messages, pages.length]);
  useEffect(() => {
    const css = getComputedStyle(document.documentElement);
    const token = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
    setPalette({ background: token("--dc-black", TOKEN_DEFAULTS.background), surface: token("--dc-surface", TOKEN_DEFAULTS.surface), text: token("--dc-text", TOKEN_DEFAULTS.text), muted: token("--dc-muted", TOKEN_DEFAULTS.muted), accent: token("--dc-green", TOKEN_DEFAULTS.accent), glass: Math.max(0.35, theme.glass / 100) });
  }, [theme]);
  useEffect(() => {
    let live = true;
    const xr = navigator.xr;
    if (xr) void xr.isSessionSupported("immersive-vr").then((ok) => { if (live) setSupported(ok); }).catch(() => { if (live) setSupported(false); });
    return () => { live = false; };
  }, []);
  useEffect(() => store.subscribe((state, previous) => { if (previous.session && !state.session) props.onStop(); }), [store, props.onStop]);
  const close = () => { props.onStop(); void store.getState().session?.end(); props.onClose(); };
  return <div role="dialog" aria-label="Spatial headset room" className="fixed inset-0 z-50 bg-background">
    <Canvas dpr={1} camera={{ position: [0, 1.6, 2.1], fov: 64 }} gl={{ antialias: true }}>
      <XR store={store}>
        <color attach="background" args={[p.background]} /><ambientLight intensity={0.8} /><pointLight position={[0, 4, 2]} intensity={12} />
        <Suspense fallback={null}><RoomScene props={{ ...props, onClose: close }} p={p} page={page} setPage={setPage} /></Suspense>
      </XR>
    </Canvas>
    <div className="glass absolute inset-x-3 top-3 flex flex-wrap items-center justify-between gap-3 rounded-lg p-3">
      <div><p className="font-mono text-xs text-primary">DARK CODERS / SPATIAL</p><p className="mt-1 text-xs text-muted-foreground">{supported ? "Headset ready" : "Desktop preview · headset unavailable"}</p></div>
      <div className="flex gap-2"><Button disabled={!supported} onClick={() => { setError(null); void store.enterVR().catch(() => setError("The headset session could not start. Please try again in your headset browser.")); }}><ScanFace className="size-4" />Enter VR</Button><Button variant="outline" size="icon" aria-label="Close headset room" onClick={close}><X className="size-4" /></Button></div>
      {error && <p role="alert" className="w-full text-xs text-destructive">{error}</p>}
    </div>
    <div className="glass absolute inset-x-3 bottom-3 flex flex-wrap items-center justify-center gap-2 rounded-lg p-3">
      <Button variant="outline" size="icon" aria-label="Previous room message" disabled={page === 0} onClick={() => setPage(Math.max(0, page - 1))}><ChevronLeft className="size-4" /></Button>
      <span className="font-mono text-xs text-muted-foreground">{pages.length ? `${page + 1}/${pages.length}` : "0 messages"}</span>
      <Button variant="outline" size="icon" aria-label="Next room message" disabled={page >= pages.length - 1} onClick={() => setPage(Math.min(pages.length - 1, page + 1))}><ChevronRight className="size-4" /></Button>
      <Button aria-label="Hold to talk in room" disabled={props.busy} className="touch-none" onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); props.onTalkStart(); }} onPointerUp={props.onTalkEnd} onPointerCancel={props.onTalkEnd}><Mic className="size-4" />{props.recording ? "Listening…" : "Hold to talk"}</Button>
      <Button variant="outline" aria-pressed={props.standby} onClick={props.onToggleStandby}>Standby</Button>
      <Button variant="outline" onClick={props.onStop}><Square className="size-4" />Stop</Button>
      <select aria-label="Room agent" className="h-10 max-w-44 rounded-md border border-input bg-surface px-2 text-xs text-foreground" value={props.activeAgentId} disabled={props.busy} onChange={(e) => props.onSelectAgent(e.target.value)}>{Object.entries(getAgents()).map(([id, agent]) => <option key={id} value={id}>{agent.label}</option>)}</select>
    </div>
  </div>;
}
