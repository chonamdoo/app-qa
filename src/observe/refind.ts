// Re-locating a previously resolved target in a fresh observation.
import type { Candidate, ScreenModel } from '../core/types.ts';
import { normLabel } from './text.ts';

/**
 * The candidate in `model` with the same source, resource id (null matches only null), role, normalized name and value
 * as `prev`, nearest to where `prev` was (rect centres). Null when none matches — the target is gone or changed meaning.
 */
export function refind(prev: Candidate, model: ScreenModel): Candidate | null {
  const name = normLabel(prev.name);
  const px = prev.rect.x + prev.rect.width / 2;
  const py = prev.rect.y + prev.rect.height / 2;
  let best: Candidate | null = null;
  let bestDistance = Infinity;
  for (const c of model.candidates) {
    if (c.source !== prev.source || c.resourceId !== prev.resourceId || c.role !== prev.role || c.value !== prev.value || normLabel(c.name) !== name) continue;
    const d = Math.hypot(c.rect.x + c.rect.width / 2 - px, c.rect.y + c.rect.height / 2 - py);
    if (d < bestDistance) {
      best = c;
      bestDistance = d;
    }
  }
  return best;
}
