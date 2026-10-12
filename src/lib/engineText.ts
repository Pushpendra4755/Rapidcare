// Small text helpers shared by the engine (kept separate so the engine has no UI dependencies).
export { RESOURCE_LABEL, RESOURCE_SHORT, RESOURCE_PLURAL, CAPABILITY_LABEL } from './labels';

export function formatAgeShort(minutes: number | null): string {
  if (minutes == null) return 'never';
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${Math.round(minutes)} min ago`;
  const h = Math.floor(minutes / 60);
  return `${h} h ${Math.round(minutes - h * 60)} min ago`;
}
