import { sha256Bytes, sha256Canonical } from './continuity-assignment/canonical-json.mjs';
import { readContainedFile } from './continuity-assignment/evidence.mjs';
import { G002_V2_IMMUTABLE_PREDECESSOR } from './continuity-public-authority.mjs';
import { verifyG002V2PublicEvidence } from '../verify-g002-v2-public-evidence-manifest.mjs';
import { verifyPersistedG003V4Freeze } from './g003-v4-freeze-inventory.mjs';

const fail = (message) => { throw new Error(`G003 transition snapshot: ${message}`); };
const G002_V2_TOPOLOGY_PATH = 'production/reports/biological-continuity-v3/g002-evidence-v2/topology-after.json';
const parse = (bytes, label) => { try { return JSON.parse(bytes); } catch { fail(`${label} is not JSON`); } };
const VERIFIED_SNAPSHOTS = new WeakSet(); const TEST_SNAPSHOTS = new WeakSet();

export async function loadVerifiedG003TransitionSnapshot(repoRoot) {
  const paths = {
    publicManifest: G002_V2_IMMUTABLE_PREDECESSOR.publicManifestPath,
    predecessorSuccessor: G002_V2_IMMUTABLE_PREDECESSOR.successorPath,
    assignment: G002_V2_IMMUTABLE_PREDECESSOR.assignmentPath,
    topology: G002_V2_TOPOLOGY_PATH,
  };
  const buffers = Object.fromEntries(await Promise.all(Object.entries(paths).map(async ([key, relative]) => [key, await readContainedFile(repoRoot, relative)])));
  for (const [key, expected] of [
    ['publicManifest', G002_V2_IMMUTABLE_PREDECESSOR.publicManifestFileSha256],
    ['predecessorSuccessor', G002_V2_IMMUTABLE_PREDECESSOR.successorFileSha256],
    ['assignment', G002_V2_IMMUTABLE_PREDECESSOR.assignmentFileSha256],
  ]) if (sha256Bytes(buffers[key]) !== expected) fail(`immutable predecessor byte drift: ${paths[key]}`);
  const publicManifest = parse(buffers.publicManifest, 'public manifest');
  const topologyBindings = publicManifest.files?.filter((binding) => binding.path === G002_V2_TOPOLOGY_PATH) ?? [];
  if (topologyBindings.length !== 1 || topologyBindings[0].sha256 !== sha256Bytes(buffers.topology)) fail('once-read topology differs from its pinned public-manifest binding');
  await verifyG002V2PublicEvidence({ repoRoot });
  const freeze = await verifyPersistedG003V4Freeze(repoRoot);
  const snapshot = Object.freeze({
    buffers: Object.freeze(buffers),
    publicManifest,
    predecessorSuccessor: parse(buffers.predecessorSuccessor, 'predecessor successor'),
    assignment: parse(buffers.assignment, 'assignment'), topology: parse(buffers.topology, 'topology'),
    topologyFileSha256: sha256Bytes(buffers.topology), freeze,
    predecessorBindingSha256: sha256Canonical(G002_V2_IMMUTABLE_PREDECESSOR),
  });
  VERIFIED_SNAPSHOTS.add(snapshot); return snapshot;
}

export function createG003TransitionSnapshotForTest({ assignment, topology }) {
  const snapshot = Object.freeze({ assignment: structuredClone(assignment), topology: structuredClone(topology), freeze: Object.freeze({ testOnly: true }) });
  VERIFIED_SNAPSHOTS.add(snapshot); TEST_SNAPSHOTS.add(snapshot); return snapshot;
}

export function assertG003TransitionSnapshot(snapshot, { production = false } = {}) {
  if (!VERIFIED_SNAPSHOTS.has(snapshot) || production && TEST_SNAPSHOTS.has(snapshot)) fail('transition snapshot is not a concrete verified production snapshot');
  return true;
}
