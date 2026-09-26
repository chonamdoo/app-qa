// Guards and traversal for untyped JSON (LLM output, json/yaml documents) inside the planner.

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Depth-first visit of every (key, value) pair below `value`, with the object that owns the key. */
export function visitJson(value: unknown, visit: (key: string, value: unknown, parent: Record<string, unknown>) => void): void {
  if (Array.isArray(value)) {
    for (const v of value) visitJson(v, visit);
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [key, v] of Object.entries(value)) {
    visit(key, v, value);
    visitJson(v, visit);
  }
}
