// Screen inventory for the planner (`.qa/inventory/<app>/<platform>/<screen>.json`) and tab-bar detection for smoke crawl.
import { join } from 'node:path';
import type { Candidate, Platform, ScreenModel } from '../core/types.ts';
import { writeJson } from '../core/fsx.ts';
import type { EvidenceSanitizer } from './sanitize.ts';

export const INVENTORY_SCHEMA = 'app-qa/inventory/v1';

export interface InventoryFile {
  $schema: typeof INVENTORY_SCHEMA;
  app: string;
  platform: Platform;
  name: string;
  capturedAt: string;
  source: 'capture' | 'smoke';
  texts: string[];
  candidates: { role: Candidate['role']; name: string; state: string[]; actionable: boolean; region: Candidate['region'] }[];
}

/** File-name-safe screen name: keeps Korean/letters/digits, other runs → '-'. */
export function screenSlug(name: string): string {
  return name.normalize('NFC').replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'screen';
}

/** Secure fields are left out; every name and text passes the evidence sanitizer. */
export function writeInventory(dir: string, app: string, platform: Platform, name: string, model: ScreenModel, source: InventoryFile['source'], clean: EvidenceSanitizer): string {
  const label = clean.text(name);
  const file = join(dir, app, platform, `${screenSlug(label)}.json`);
  const inv: InventoryFile = {
    $schema: INVENTORY_SCHEMA,
    app,
    platform,
    name: label,
    capturedAt: model.snapshot.takenAt,
    source,
    texts: model.texts.map(clean.text),
    candidates: model.candidates
      .filter((c) => c.role !== 'secure-input')
      .map((c) => ({ role: c.role, name: clean.text(c.name), state: c.state, actionable: c.actionable, region: c.region })),
  };
  writeJson(file, inv);
  return file;
}

/** Same size within a couple of units (device px rounding). */
const SIZE_TOLERANCE = 4;

/**
 * Tab bar items identified by role: `tab` candidates, else ≥3 actionable, same-size, same-row siblings in the bottom
 * region (RN/Compose bottom bars exposed as plain clickable views). Left-to-right; empty when nothing qualifies.
 */
export function findTabs(model: ScreenModel): Candidate[] {
  const byX = (a: Candidate, b: Candidate) => a.rect.x - b.rect.x;
  const tabs = model.candidates.filter((c) => c.role === 'tab' && c.actionable && c.source === 'tree');
  if (tabs.length >= 2) return tabs.sort(byX);
  const bottom = model.candidates.filter((c) => c.region === 'bottom' && c.actionable && c.source === 'tree' && c.name);
  let best: Candidate[] = [];
  for (const seed of bottom) {
    const row = bottom.filter(
      (c) =>
        Math.abs(c.rect.y - seed.rect.y) <= SIZE_TOLERANCE &&
        Math.abs(c.rect.width - seed.rect.width) <= SIZE_TOLERANCE &&
        Math.abs(c.rect.height - seed.rect.height) <= SIZE_TOLERANCE,
    );
    if (row.length > best.length) best = row;
  }
  return best.length >= 3 ? best.sort(byX) : [];
}
