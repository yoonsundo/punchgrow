# Evolution Continuity Runtime Audit — 2026-08-10

## Scope

This audit inspected the assets that the built macOS app actually loads, not only the repository source files.

- Runtime catalog: `macos/.build/PunchGrow.app/Contents/Resources/PunchGrowMenuBar_PunchGrowMenuBar.bundle/creatures.json`
- Runtime PNGs: 240 / 240
- Visual review units: 119 / 119
- Parent→child edges: 190 / 190, including both parents of every mixed evolution
- Contact sheets: 12 / 12

Each manifest entry records the runtime catalog hash and every PNG's SHA-256, byte size, width, and height. Each review unit also records its contact-sheet path, row, decoded RGBA pixel SHA-256, width, and height. The final ledger therefore applies only to the exact resources inspected in this audit while remaining stable across equivalent PNG compression implementations.

## Acceptance rules

1. A single-parent evolution keeps the parent's basic body plan and remains recognizable as the same species.
2. Every single-parent evolution visibly inherits at least two traits from its parent: face or marking, silhouette, appendage, motif, palette, or body proportion.
3. A mixed evolution inherits at least one unmistakable trait from each parent.
4. A mutant remains recognizable as the parent species while changing at least two of silhouette, organ, and material. Palette or glow changes alone do not pass.
5. Artwork stays readable as a full-body square card with safe outer spacing and no text, logo, or watermark.
6. Every unit and every edge must receive `PASS`, score at least 90, and match its catalog category. `WARN`, `FAIL`, missing evidence, duplicate evidence, or resource hash drift fails verification.

These rules implement the continuity contract in `문서/CREATURE_DESIGN_BIBLE.md`. Structural body-form checks remain in the Swift catalog loader and the Node catalog validator; the runtime visual ledger adds evidence for the rendered artwork itself.

## Review process

Three independent lanes split all 119 visual units and 190 edges without overlap.

| Initial verdict | Units |
| --- | ---: |
| PASS | 108 |
| WARN | 9 |
| FAIL | 2 |
| Total | 119 |

All 11 non-PASS units received an independent second review against their individual runtime PNGs and exact parent images.

- Nine were corrected to PASS because the first review had missed inherited anatomy, misread the creature type, or evaluated a mixed child without considering both parents.
- `PG-216` was a real failure: the violet circuit fox had become visually similar to a rock rabbit.
- `PG-237` was a real failure: the upright baby elephant had become visually similar to a leaf-eared quadruped.

Only those two failed images were regenerated. Their final 360×360 runtime assets passed independent gates at 97 (`PG-216`) and 96 (`PG-237`). The final overall runtime gate scored 96 and passed.

The three initial PASS units that contained an exact-threshold 90-point unit or edge were also reviewed independently. `PG-060→PG-144`, both parent edges of `PG-093 + PG-123→PG-199`, and `PG-012→PG-227` passed again at 97–99. This supplemental gate prevents borderline results from being accepted only because they touched the threshold.

## Final result

| Review target | Final result |
| --- | ---: |
| Runtime PNGs | 240 / 240 bound to the manifest |
| Visual review units | 119 / 119 PASS |
| Parent→child edges | 190 / 190 PASS |
| Contact sheets | 12 / 12 bound by decoded RGBA pixel SHA-256 and dimensions |
| Regenerated images | 2 (`PG-216`, `PG-237`) |
| Overall runtime gate | 96 / 100 PASS |

The machine-readable final ledger is `production/reports/evolution-runtime-visual-audit.json`. Independent lane results and second-review overrides are preserved in `production/reports/evolution-runtime-audit-lanes/` and `production/reports/evolution-runtime-adjudications.json`.

## Why the runtime binding is required

The previous review could mark source contact sheets as PASS while the already-built `.app` still contained stale resources. That meant a valid source image did not prove that the user saw the same image in the running app.

The new verifier is fail-closed. It rejects the ledger when any runtime catalog or PNG hash, size, or dimensions drift; when a contact-sheet pixel hash, dimensions, or row changes; when a unit or edge is missing or duplicated; when a score is below 90; or when a mixed evolution omits either parent. A handwritten PASS without matching current runtime evidence cannot satisfy the gate.

The macOS GitHub Actions job regenerates the manifest and contact sheets from the assembled `PunchGrow.app`, then runs the hostile self-test and runtime verifier. Generated sheets stay out of Git while stale or manipulated audit evidence still blocks CI.

## Reproduction

Run from the repository root:

```bash
npm run creatures:contact-sheets -- docs/qa/evolution-continuity \
  --runtime-bundle macos/.build/PunchGrow.app/Contents/Resources/PunchGrowMenuBar_PunchGrowMenuBar.bundle
node scripts/build-runtime-evolution-audit.mjs
node scripts/verify-runtime-evolution-audit.mjs
node scripts/verify-runtime-evolution-audit.mjs --self-test
```

Expected verifier summaries:

```text
{"status":"PASS","creatures":240,"units":119,"edges":190,"sheets":12}
{"selfTest":"PASS","negativeCases":22,...}
```

The self-test proves that the verifier rejects 22 corrupt cases. In addition to missing, duplicate, out-of-range score, missing-reasoning, mixed-parent, contact-sheet pixel drift, and separately tested lane/adjudication hash drift, it rejects stale visual decisions after assets change, a manually altered final ledger, a catalog/manifest edge substitution, a fake `.app` traversal path, invalid parents on normal roots, unresolved or incorrect normal and exceptional parent references, incorrect lane identity or sheet assignment, and a unit placed in the wrong lane.

## UI verification boundary

This asset audit does not replace the separate layout check. The current operating maximum remains four stages, six cards total, and three cards in one stage within the 372×620 evolution popover. Only lineages beyond that maximum may introduce internal scrolling.
