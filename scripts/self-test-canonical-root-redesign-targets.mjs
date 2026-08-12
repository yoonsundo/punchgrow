#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256Canonical } from './lib/continuity-assignment/canonical-json.mjs';
import {
  APPROVED_CANONICAL_CORE_SHA256, CANONICAL_ROOT_IDS, selectCanonicalRootTarget,
  validateCanonicalRootRedesignCore, validateSignedCanonicalRootRedesignTargets,
} from './lib/continuity-assignment/canonical-root-redesign-targets.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const draft = JSON.parse(await readFile(path.join(ROOT, 'production/reports/biological-continuity-v3/g002-evidence-v1/canonical-root-redesign-targets-v1.unsigned.json')));
const byRoot = validateCanonicalRootRedesignCore(draft);
assert.equal(sha256Canonical(draft), APPROVED_CANONICAL_CORE_SHA256);
assert.deepEqual([...byRoot.keys()].sort(), CANONICAL_ROOT_IDS);

const missingSignature = { ...structuredClone(draft), outputSha256: sha256Canonical(draft) };
assert.throws(() => validateSignedCanonicalRootRedesignTargets(missingSignature), /fields mismatch|signature/i);

const borrowedSignature = JSON.parse(await readFile(path.join(ROOT, 'production/reports/biological-continuity-v3/g002-evidence-v1/taxonomy-reviews/consensus.json'))).publicSignature;
assert.throws(() => validateSignedCanonicalRootRedesignTargets({ ...missingSignature, publicSignature: borrowedSignature }), /signature/i);

const swapped = structuredClone(draft);
[swapped.targets[0].canonicalTarget, swapped.targets[1].canonicalTarget] = [swapped.targets[1].canonicalTarget, swapped.targets[0].canonicalTarget];
assert.throws(() => validateCanonicalRootRedesignCore(swapped), /architect-approved atomic targets/i);

const anatomySplice = structuredClone(draft);
anatomySplice.targets.find((target) => target.rootId === 'PG-028').canonicalTarget.coreAnatomy = draft.targets.find((target) => target.rootId === 'PG-016').canonicalTarget.coreAnatomy;
assert.throws(() => validateCanonicalRootRedesignCore(anatomySplice), /architect-approved atomic targets/i);

const missingAnchor = structuredClone(draft); missingAnchor.targets[0].anchors.pop();
assert.throws(() => validateCanonicalRootRedesignCore(missingAnchor), /exactly three immutable anchors/i);
const missingVisibility = structuredClone(draft); delete missingVisibility.visibilityPolicy.ambiguityRule;
assert.throws(() => validateCanonicalRootRedesignCore(missingVisibility), /visibility policy.*fields mismatch/i);
const missingClarification = structuredClone(draft); missingClarification.targets[0].clarificationRequirements = [];
assert.throws(() => validateCanonicalRootRedesignCore(missingClarification), /clarification requirements omitted/i);

const missingId = structuredClone(draft); missingId.targets.pop();
assert.throws(() => validateCanonicalRootRedesignCore(missingId), /target coverage mismatch/i);
const extraId = structuredClone(draft); extraId.targets.push({ ...structuredClone(extraId.targets[0]), rootId: 'PG-999' });
assert.throws(() => validateCanonicalRootRedesignCore(extraId), /target coverage mismatch|target IDs/i);
const manual = structuredClone(draft); manual.targets[0].canonicalTarget.speciesFamily = 'manual-review-required';
assert.throws(() => validateCanonicalRootRedesignCore(manual), /unknown\/manual\/non-concrete/i);

const oldPixelA = { biologicalClass: 'mammal', speciesFamily: 'rabbit', coreAnatomy: 'quadruped', locomotionPlan: 'quadrupedal' };
assert.deepEqual(selectCanonicalRootTarget('PG-016', oldPixelA, byRoot), byRoot.get('PG-016').canonicalTarget, 'disputed current-pixel A must never override signed canonical B');
assert.deepEqual(selectCanonicalRootTarget('PG-016', { ...oldPixelA, speciesFamily: 'mustelid' }, byRoot), byRoot.get('PG-016').canonicalTarget, 'descendants must inherit canonical B atomically');
assert.deepEqual(selectCanonicalRootTarget('PG-001', oldPixelA, byRoot), oldPixelA, 'non-contract roots must remain pixel-frozen');

console.log(JSON.stringify({ status: 'PASS', checks: 14, approvedCoreSha256: APPROVED_CANONICAL_CORE_SHA256 }));
