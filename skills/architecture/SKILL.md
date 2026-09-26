---
name: architecture
description: app-qa architecture contract — module boundaries, dependency direction, and fail-closed invariants for the mobile QA platform. Apply when designing, changing, or reviewing any code under src/, bin/, test/, mac/, calibration/, or apps/.
requires_docs:
  - references/design.md
---

# app-qa architecture contract

`references/design.md` is the full design (numbers, rules, measured evidence). This file is the normative summary reviewers check. When the two disagree, fix the disagreement; do not pick one silently.

## Roles

- **Code** owns rules, permissions, execution, and verdicts.
- **Jev** answers narrow typed questions (grounding Choice, screen claim Noul, which-screen Choice, commit Noul, generated-test review Nouls). It never grants permission and never produces a verdict by itself.
- **LLM** (Claude/Codex CLI) only generates tests from documents in `qa plan`, read-only, no tools.
- **Humans** approve risky actions (`allowRisky`) and promote draft tests.

## Modules and allowed dependencies

| Module | Path | May import |
|---|---|---|
| contracts | `src/core/*`, `src/spec/schema.ts` | node builtins, `zod` only — no other `src/` module |
| observe | `src/observe/*`, `src/ocr/*` | contracts |
| jev | `src/jev/*` | contracts; `observe` only from calibration code |
| drivers | `src/appium/*`, `src/drivers/*` | contracts, observe parsers |
| runner | `src/runner/*`, `src/spec/load.ts`, `src/report/*` | contracts, observe, ocr, jev; `src/drivers` only from the runner entry (`src/runner/index.ts`) — execution code consumes the `Driver` interface |
| plan | `src/plan/*` | contracts, observe, jev, `src/runner/risk.ts`; the runner entry only for `--run` |
| server | `src/server/*` | contracts, `src/spec/*`; runner/plan/drivers only through injected handlers |
| CLI (composition root) | `bin/qa.ts`, `src/cli/**` | anything; each command loads its module lazily |
| mac app | `mac/**` | the `qa serve` HTTP/SSE API and `.qa/server.json` only |

No import cycles between modules. A contract change (`src/core/*`, `src/spec/schema.ts`, events) updates every consumer in the same change.

## Invariants (must)

1. **Fail-closed verdicts.** PASS only from a deterministic check or a calibrated Jev gate. Missing, malformed, uncalibrated, timed-out, or ambiguous answers are ERROR or INCONCLUSIVE, never PASS. Verdict precedence ERROR > FAIL > INCONCLUSIVE > PASS.
2. **Jev contract.** Model pinned (`jev-1.13.0`) and checked on every response; strict answer validation before use; thresholds come only from `calibration/<model>/<questionVersion>.json`; no coordinates in state; redaction before any text leaves the machine; ≤ 254 candidates + `none` (overflow is flagged, never truncated).
3. **Actions.** Every mutating action is journaled (fsync) before dispatch. Transport failure or timeout → `uncertain` → test ERROR, never retried. No-effect after an action → INCONCLUSIVE unless `expectNoChange`.
4. **Risk.** Deterministic policy (Korean/English keywords, destructive-dialog context, unlabeled targets) decides first; Jev commit can only add refusals; risky targets act only with `allowRisky` and only through selector/fast path.
5. **Observation.** Only touchable nodes occlude; taps use the fresh un-occluded tap point after `refind` + hit-test; settle means change → stable on identity/layout fingerprints.
6. **Devices** are reached only through the `Driver` interface, one device lock per run, project-local tools (`.tools/`), explicit permissions.
7. **Evidence.** Directories 0700, files 0600, secrets and secure-field values never written or logged, events follow `src/core/events.ts`.
8. **Generated tests** are validated deterministically (zod, coverage, no `allowRisky`, no risky labels), reviewed per criterion (no aggregate score), and saved as `draft` unless explicitly approved.

## Must avoid

- A model (Jev or LLM) deciding PASS/FAIL or granting permission on its own.
- Treating an absent or invalid model answer as a default value.
- Retrying a mutating step, re-tapping when nothing changed, or replaying an `uncertain` action.
- Unconditional BACK to hide a keyboard; a silent no-op `back`; iOS clipboard text entry.
- Global tool installs, or reading devices/Appium outside `src/drivers`.
- Execution code importing concrete drivers, servers importing runner/plan directly, or any module importing the CLI.
- Truncating candidate lists, sending coordinates or unredacted text to Jev, logging API keys or request bodies.
- Aggregate scores that hide a failing criterion.

## Review checklist

Record `must-avoid-check: pass` only after checking every item above against the diff; cite file:line for each failure.
