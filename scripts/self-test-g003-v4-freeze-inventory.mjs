#!/usr/bin/env node

import assert from 'node:assert/strict';
import { link, mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { canonicalStringify, sha256Canonical } from './lib/continuity-assignment/canonical-json.mjs';
import {
  G003_V4_FREEZE_PATH, assertG003V4FreezeShape, assertG003V4NotFrozen, buildG003V4FreezeInventory,
} from './lib/g003-v4-freeze-inventory.mjs';

const root = await mkdtemp(path.join(os.tmpdir(), 'punchgrow-g003-v4-freeze-'));
await mkdir(path.join(root, 'evidence/nested'), { recursive: true }); await mkdir(path.join(root, 'rejected'), { recursive: true });
await writeFile(path.join(root, 'evidence/z.bin'), Buffer.from([0, 255, 1]));
await writeFile(path.join(root, 'evidence/nested/a.json'), '{}\n'); await writeFile(path.join(root, 'rejected/tombstone.json'), '{"rejected":true}\n');
const roots = [{ kind: 'public-evidence', path: 'evidence' }, { kind: 'rejection-archive', path: 'rejected' }];
const first = await buildG003V4FreezeInventory({ repoRoot: root, roots }); const second = await buildG003V4FreezeInventory({ repoRoot: root, roots });
assert.equal(canonicalStringify(first), canonicalStringify(second), 'inventory must be deterministic');
assert.equal(first.totals.fileCount, 3); assert.equal(first.totals.byteCount, 24);
assertG003V4FreezeShape(first, { allowUnsigned: true });
const changed = structuredClone(first); changed.roots[0].files[0].sha256 = '0'.repeat(64);
assert.throws(() => assertG003V4FreezeShape(changed, { allowUnsigned: true }), /root digest mismatch/);
await assertG003V4NotFrozen({ repoRoot: root });
await mkdir(path.join(root, path.dirname(G003_V4_FREEZE_PATH)), { recursive: true });
await writeFile(path.join(root, G003_V4_FREEZE_PATH), '{}\n');
await assert.rejects(assertG003V4NotFrozen({ repoRoot: root }), /mutation denied/);

const unsafe = await mkdtemp(path.join(os.tmpdir(), 'punchgrow-g003-v4-unsafe-'));
await mkdir(path.join(unsafe, 'evidence'), { recursive: true }); await mkdir(path.join(unsafe, 'rejected'), { recursive: true });
await writeFile(path.join(unsafe, 'outside'), 'x'); await symlink(path.join(unsafe, 'outside'), path.join(unsafe, 'evidence/link'));
await assert.rejects(buildG003V4FreezeInventory({ repoRoot: unsafe, roots }), /symlink is forbidden/);
const hard = await mkdtemp(path.join(os.tmpdir(), 'punchgrow-g003-v4-hardlink-'));
await mkdir(path.join(hard, 'evidence'), { recursive: true }); await mkdir(path.join(hard, 'rejected'), { recursive: true });
await writeFile(path.join(hard, 'source'), 'x'); await link(path.join(hard, 'source'), path.join(hard, 'evidence/hard'));
await assert.rejects(buildG003V4FreezeInventory({ repoRoot: hard, roots }), /hard-linked/);

console.log(JSON.stringify({ status: 'PASS', files: first.totals.fileCount, treeSha256: first.treeSha256, manifestSha256: sha256Canonical(first) }));
