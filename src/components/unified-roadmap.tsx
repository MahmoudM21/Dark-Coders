import { useMemo, useRef, useState } from 'react';
import { Download, Upload, FileCode2, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useLocal } from '@/lib/settings/store';
import source from '@/config/unified-plan.yaml?raw';
import { ROADMAP_KEY, exportRoadmap, parsePlan, type ReviewStatus, type RoadmapState } from '@/lib/config/unified-plan';

const DEFAULT_ROADMAP: RoadmapState = { source, statuses: {} };

function download(text: string, name: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/yaml' }));
  const a = document.createElement('a'); a.href = url; a.download = name; a.click(); URL.revokeObjectURL(url);
}
const labels: Record<ReviewStatus, string> = { planned: 'Planned', started: 'In progress', reviewed: 'Reviewed', blocked: 'Blocked' };
export function UnifiedRoadmap() {
  const [state, setState] = useLocal(ROADMAP_KEY, DEFAULT_ROADMAP);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [group, setGroup] = useState('all');
  const [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const plan = useMemo(() => { try { return parsePlan(state.source); } catch { return parsePlan(DEFAULT_ROADMAP.source); } }, [state.source]);
  const groups = [...new Set(plan.features.map((f) => f.group))];
  const shown = plan.features.filter((f) => (group === 'all' || f.group === group) && `${f.path} ${f.value}`.toLowerCase().includes(search.toLowerCase()));
  const reviewed = plan.features.filter((f) => state.statuses[f.path] === 'reviewed').length;
  return <>
    <div className="mt-3 flex items-center justify-between gap-2 border-t border-border pt-3">
      <span className="min-w-0 text-[10px] text-muted-foreground">{plan.features.length} requirements · {reviewed} reviewed</span>
      <Button variant="ghost" size="icon" className="size-7 shrink-0 text-primary" aria-label="Review architecture" title="Unified plan · review architecture" onClick={() => setOpen(true)}><FileCode2 className="size-4" /></Button>
    </div>
    <Dialog open={open} onOpenChange={setOpen}><DialogContent className="flex max-h-[90dvh] flex-col sm:max-w-4xl">
      <DialogHeader><DialogTitle>Unified architecture</DialogTitle><DialogDescription>Design specification · review progress is not deployment status.</DialogDescription></DialogHeader>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" onClick={() => input.current?.click()}><Upload className="size-4" />Import YAML</Button>
        <Button variant="outline" size="sm" onClick={() => download(state.source, 'unified-plan.yaml')}><Download className="size-4" />Plan</Button>
        <Button variant="outline" size="sm" onClick={() => download(exportRoadmap(state), 'architecture-review.yaml')}><Download className="size-4" />Progress</Button>
        <input ref={input} type="file" accept=".yaml,.yml" className="hidden" onChange={async (e) => { const file = e.target.files?.[0]; e.target.value = ''; if (!file) return; try { if (file.size > 200_000) throw new Error('YAML must be under 200 KB.'); const source = await file.text(); parsePlan(source); setState((p) => ({ ...p, source })); setError(''); setGroup('all'); } catch (e) { setError(e instanceof Error ? e.message : 'Could not import YAML'); } }} />
      </div>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <div className="flex flex-wrap gap-2">
        <label className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-border px-3"><Search className="size-4 text-muted-foreground" /><input aria-label="Search requirements" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search requirements" className="min-w-0 w-full bg-transparent py-2 text-sm outline-none" /></label>
        <select aria-label="Architecture section" value={group} onChange={(e) => setGroup(e.target.value)} className="max-w-full rounded-lg border border-border bg-surface px-3 text-sm"><option value="all">All sections</option>{groups.map((g) => <option key={g} value={g}>{g.replaceAll('_', ' ')}</option>)}</select>
      </div>
      <div className="min-h-0 overflow-y-auto divide-y divide-border">
        {shown.map((f) => <div key={f.path} className="grid grid-cols-[minmax(0,1fr)_8rem] items-center gap-3 py-3">
          <div className="min-w-0"><p className="break-words font-mono text-xs text-foreground">{f.path}</p><p className="mt-1 break-words text-xs text-muted-foreground">{f.value}</p></div>
          <select aria-label={`Review ${f.path}`} value={state.statuses[f.path] ?? 'planned'} onChange={(e) => setState((p) => ({ ...p, statuses: { ...p.statuses, [f.path]: e.target.value as ReviewStatus } }))} className="w-full rounded-md border border-border bg-surface px-2 py-2 text-xs">{Object.entries(labels).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
        </div>)}
        {!shown.length && <p className="py-8 text-center text-sm text-muted-foreground">No matching requirements</p>}
      </div>
    </DialogContent></Dialog>
  </>;
}
