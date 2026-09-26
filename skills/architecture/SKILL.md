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
| contracts | `src/core/*`, `src/spec/{schema,load}.ts` | node builtins, `zod`, `yaml`, other contracts — no other `src/` module |
| observe | `src/observe/*`, `src/ocr/*` | contracts |
| policy | `src/policy/*` (deterministic risk policy) | contracts, `src/observe/text.ts` |
| jev | `src/jev/*` | contracts; `observe` and `policy` only from calibration code (`src/jev/calibrate.ts`) |
| drivers | `src/appium/*`, `src/drivers/*` | contracts, observe parsers (`src/observe/{android,ios}.ts`) |
| runner | `src/runner/*`, `src/report/*` | contracts, observe, ocr, policy, jev; `src/drivers` only from the runner entry (`src/runner/index.ts`) — execution code consumes the `Driver` interface |
| plan | `src/plan/*` | contracts, observe, policy, jev; the runner entry only for `--run` |
| server | `src/server/*` | contracts; runner/plan/drivers only through injected handlers |
| CLI (composition root) | `bin/qa.ts`, `src/cli/**` | anything; each command loads its module lazily |
| mac app | `mac/**` | the `qa serve` HTTP/SSE API and `.qa/server.json`; it may write its own child-output log `.qa/logs/engine.log` |

No import cycles between modules, and no module imports the CLI. The Jev candidate row format is a contract (`src/core/candidate-row.ts`). A contract change (`src/core/*`, `src/spec/*`, events) updates every consumer in the same change. `test/architecture/` enforces this table.

## Invariants (must)

1. **Fail-closed verdicts.** PASS only from a deterministic check or a calibrated Jev gate. Missing, malformed, uncalibrated, timed-out, or ambiguous answers are ERROR or INCONCLUSIVE, never PASS. A rule that evaluates nothing (e.g. an empty or multi-operator JSONLogic object) is ERROR. Verdict precedence ERROR > FAIL > INCONCLUSIVE > PASS.
2. **Jev contract.** Model pinned (`jev-1.13.0`) and checked on every response; strict answer validation (own-property membership, exact key sets, finite probabilities) before use; thresholds come only from `calibration/<model>/<questionVersion>.json`; no coordinates in state; redaction before any text leaves the machine; ≤ 254 candidates + `none` (overflow is flagged, never truncated).
3. **Actions.** Every mutating action is journaled (fsync) before dispatch. Transport failure, timeout, or an unvalidated driver response → `uncertain` → test ERROR, never retried and never reclassified as `completed`/`rejected`. No-effect after an action → INCONCLUSIVE unless `expectNoChange`.
4. **Risk.** The deterministic policy (`src/policy`: Korean/English keywords, destructive-dialog context, unlabeled targets) runs on the **final fresh target and screen** immediately before dispatch, including `press: enter` and `type.submit`. The Jev commit check can only add refusals and is required for every target-based mutation of a deterministically safe target without `allowRisky`; if it errors or its gate is not `calibrated`, the step is ERROR `commit_check_unavailable` and nothing is dispatched. Risky targets act only with `allowRisky` and only through selector/fast path.
5. **Observation.** Only touchable nodes occlude; taps use the fresh un-occluded tap point after `refind` + hit-test; settle means change → stable on identity/layout fingerprints; a target that is not stable within the post-scroll window is `stale_target`, not tapped.
6. **Devices** are reached only through the `Driver` interface, one device lock per run (reclaiming a dead owner must never delete a live owner's lock), project-local tools (`.tools/`), explicit permissions, validated app ids, quoted device-shell arguments.
7. **Evidence.** Directories 0700, files 0600. Every journal/event/SSE/source/elements/log write passes one sanitizer that masks observed `secure-input` values (regardless of the DSL `secure` flag), `${ENV}`-expanded values, and app-profile `redact` matches; Appium never logs request bodies; events follow `src/core/events.ts` and name the DSL action exactly.
8. **Generated tests** are validated deterministically (zod, coverage, no `allowRisky`, no risky labels, no submit/enter), reviewed per criterion (no aggregate score), and saved as `draft` unless explicitly approved.
9. **Durable records** (calibration, `plan.json`, generated tests, `summary.json`, `.qa/server.json`) are written atomically; regenerating a plan never removes existing tests before the new generation is complete.

## Must avoid

- A model (Jev or LLM) deciding PASS/FAIL or granting permission on its own.
- Treating an absent or invalid model answer, or a skipped required check, as a default value.
- Retrying a mutating step, re-tapping when nothing changed, or replaying an `uncertain` action.
- Unconditional BACK to hide a keyboard; a silent no-op `back`; iOS clipboard text entry.
- Global tool installs, or reading devices/Appium outside `src/drivers`.
- Execution code importing concrete drivers, servers importing runner/plan directly, or any module importing the CLI.
- Truncating candidate lists, sending coordinates or unredacted text to Jev, logging API keys, secrets, or request bodies.
- Aggregate scores that hide a failing criterion.

## Review checklist

Record `must-avoid-check: pass` only after checking every item above against the diff; cite file:line for each failure.
