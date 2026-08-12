import { execFile } from 'node:child_process';
import { cp, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const root = fileURLToPath(new URL('..', import.meta.url));
const run = promisify(execFile);
const packId = process.argv[2];
const registryPath = path.join(root, 'config/creature-assets.json');
const registry = JSON.parse(await readFile(registryPath, 'utf8'));

if (!packId || !registry.packs[packId]) {
  throw new Error(`unknown creature pack: ${packId ?? '(missing)'}`);
}

const manifest = JSON.parse(await readFile(path.join(root, registry.packs[packId]), 'utf8'));
if (!manifest.activationAllowed || !['qa-passed', 'active'].includes(manifest.status)) {
  throw new Error(`${packId} is not allowed to activate`);
}

await run(process.execPath, [path.join(root, 'scripts/verify-creature-asset-pack.mjs'), packId, '--source-only'], {
  cwd: root,
});

const targets = [
  { source: manifest.masterRoot, destination: 'assets/creatures/generated' },
  { source: manifest.mobileRoot, destination: 'assets/creatures/mobile' },
  { source: manifest.mobileRoot, destination: 'macos/Sources/PunchGrowMenuBar/Resources/Creatures' },
];
const supplementalIds = Array.from(
  { length: 16 },
  (_, index) => `PG-${String(241 + index).padStart(3, '0')}.png`,
);
const transactionRoot = await mkdtemp(path.join(root, '.creature-pack-transaction-'));
const registryStage = path.join(path.dirname(registryPath), `.creature-assets-${process.pid}.json`);
const swapped = [];

try {
  for (const [index, target] of targets.entries()) {
    const stage = path.join(transactionRoot, `stage-${index}`);
    const backup = path.join(transactionRoot, `backup-${index}`);
    await cp(path.join(root, target.source), stage, { recursive: true });
    // The registered visual packs are the frozen PG-001..240 base. Preserve
    // the independently reviewed elemental-origin supplement on every switch.
    for (const filename of supplementalIds) {
      await cp(
        path.join(root, target.destination, filename),
        path.join(stage, filename),
      );
    }
    await rename(path.join(root, target.destination), backup);
    swapped.push({ target, backup });
    await rename(stage, path.join(root, target.destination));
  }

  registry.activePack = packId;
  await writeFile(registryStage, `${JSON.stringify(registry, null, 2)}\n`);
  await rename(registryStage, registryPath);
} catch (error) {
  for (const { target, backup } of swapped.reverse()) {
    await rm(path.join(root, target.destination), { recursive: true, force: true });
    await rename(backup, path.join(root, target.destination));
  }
  throw error;
} finally {
  await rm(registryStage, { force: true });
  await rm(transactionRoot, { recursive: true, force: true });
}

console.log(JSON.stringify({ activePack: packId, deployedTargets: targets.length }));
