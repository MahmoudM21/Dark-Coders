import { useEffect, useState } from "react";
import { Cloud, CloudOff, LogOut } from "lucide-react";
import type { User } from "@supabase/supabase-js";
import { isSupabaseConfigured, supabase } from "@/integrations/supabase/client";
import { lovable } from "@/integrations/lovable/index";
import { onLocalWrite, writeLocal } from "@/lib/settings/store";
import { Button } from "@/components/ui/button";

/** Keys saved to the signed-in account. API keys (providers) stay in this browser only. */
const SYNCED = ["openclaw.plans", "openclaw.voice", "openclaw.run", "openclaw.theme"];

type Status = "off" | "syncing" | "saved" | "error";

/** Google sign-in + two-way sync of plans and settings to the user's account. */
export function CloudSync() {
  const configured = isSupabaseConfigured();
  const [user, setUser] = useState<User | null>(null);
  const [status, setStatus] = useState<Status>("off");

  useEffect(() => {
    if (!configured) return;
    supabase.auth.getSession().then(({ data }) => setUser(data.session?.user ?? null));
    const { data } = supabase.auth.onAuthStateChange((_e, s) => setUser(s?.user ?? null));
    return () => data.subscription.unsubscribe();
  }, [configured]);

  useEffect(() => {
    if (!user) { setStatus("off"); return; }
    let alive = true;
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    setStatus("syncing");

    (async () => {
      const { data, error } = await supabase.from("user_state").select("key,value").eq("user_id", user.id).in("key", SYNCED);
      if (!alive) return;
      if (error) { console.error("Cloud load failed", error); setStatus("error"); return; }
      const remote = new Map((data ?? []).map((r) => [r.key, r.value]));
      for (const key of SYNCED) {
        if (remote.has(key)) writeLocal(key, remote.get(key), { silent: true });
        else {
          const raw = localStorage.getItem(key);
          if (raw) await push(key, JSON.parse(raw));
        }
      }
      if (alive) setStatus("saved");
    })();

    async function push(key: string, value: unknown) {
      const { error } = await supabase.from("user_state").upsert(
        { user_id: user!.id, key, value: value as never, updated_at: new Date().toISOString() },
        { onConflict: "user_id,key" },
      );
      if (!alive) return;
      if (error) { console.error("Cloud save failed", error); setStatus("error"); } else setStatus("saved");
    }

    const off = onLocalWrite((key, value) => {
      if (!SYNCED.includes(key)) return;
      setStatus("syncing");
      clearTimeout(timers.get(key));
      timers.set(key, setTimeout(() => void push(key, value), 800));
    });
    return () => { alive = false; off(); timers.forEach(clearTimeout); };
  }, [user]);

  const signIn = async () => {
    const r = await lovable.auth.signInWithOAuth("google", { redirect_uri: window.location.origin });
    if (r.error) { console.error(r.error); setStatus("error"); }
  };

  if (!configured) return null;

  if (!user) {
    return (
      <Button variant="outline" onClick={signIn} title="Sign in to keep plans on every device"
        className="h-10 gap-2 rounded-xl border-border bg-surface px-3 text-foreground">
        <CloudOff className="size-4" /> <span className="hidden sm:inline">Sign in</span>
      </Button>
    );
  }
  const label = status === "error" ? "Not saved" : status === "syncing" ? "Saving…" : "Saved online";
  return (
    <div className="flex items-center gap-1">
      <span title={user.email ?? ""} className={`hidden items-center gap-1.5 font-mono text-[10px] sm:inline-flex ${status === "error" ? "text-destructive" : "text-primary"}`}>
        <Cloud className="size-3.5" /> {label}
      </span>
      <Button variant="outline" size="icon" aria-label="Sign out" title={`Sign out ${user.email ?? ""}`}
        onClick={() => supabase.auth.signOut()} className="size-10 rounded-xl border-border bg-surface">
        <LogOut className="size-4" />
      </Button>
    </div>
  );
}
