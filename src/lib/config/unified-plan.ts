import { parseDocument, stringify } from 'yaml';

export type PlanFeature = { path: string; value: string; group: string };
export function parsePlan(text: string): { title: string; features: PlanFeature[] } {
  if (text.length > 200_000) throw new Error('YAML must be under 200 KB.');
  const doc = parseDocument(text, { uniqueKeys: true });
  if (doc.errors.length) throw new Error(doc.errors[0]?.message ?? 'Invalid YAML');
  const value: unknown = doc.toJS({ maxAliasCount: 30 });
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('The plan must be a YAML object.');
  const features: PlanFeature[] = [];
  function walk(node: unknown, path: string[], depth: number) {
    if (depth > 20 || features.length > 2500) throw new Error('Plan is too deeply nested or too large.');
    if (node && typeof node === 'object') {
      Object.entries(node).forEach(([key, child]) => walk(child, [...path, key], depth + 1));
    } else if (path.length && !['metadata', 'apiVersion', 'kind'].includes(path[0] ?? '')) {
      features.push({ path: path.join('.'), group: path[0] ?? 'plan', value: String(node) });
    }
  }
  walk(value, [], 0);
  const metadata = (value as { metadata?: { name?: unknown } }).metadata;
  return { title: typeof metadata?.name === 'string' ? metadata.name : 'Unified architecture', features };
}
export const ROADMAP_KEY = 'openclaw.unified-roadmap';
export type ReviewStatus = 'planned' | 'started' | 'reviewed' | 'blocked';
export type RoadmapState = { source: string; statuses: Record<string, ReviewStatus> };
export function exportRoadmap(state: RoadmapState) {
  return stringify({ kind: 'ArchitectureReviewProgress', deployment_authority: false, statuses: state.statuses });
}
