#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalStringify } from './lib/continuity-assignment/canonical-json.mjs';
import { buildG003V4FreezeInventory } from './lib/g003-v4-freeze-inventory.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = await buildG003V4FreezeInventory({ repoRoot: ROOT });
process.stdout.write(canonicalStringify(manifest));
