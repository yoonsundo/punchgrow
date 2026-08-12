#!/usr/bin/env node

import { constants as fsConstants } from "node:fs";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const REGISTRY_REL = "config/creature-assets.json";
const CATALOG_REL = "production/catalog/creatures.json";
const CONTRACT_REL = "production/contracts/visual-review-v1.schema.json";
const PUBLIC_PARENT_REL = "production/reports/biological-continuity-v3/blinded-inputs";
const PRIVATE_PARENT_REL = ".omx/evidence/visual-census";
const ID_PATTERN = /^PG-\d{3}$/;
const SHA_PATTERN = /^[a-f0-9]{64}$/;

function parseArgs(argv) {
  const result = { rebuild: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--run-id") result.runId = argv[++index];
    else if (arg === "--rebuild") result.rebuild = true;
    else if (arg === "--help") result.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return result;
}

function usage() {
  return "Usage: node scripts/prepare-blinded-visual-review.mjs --run-id <opaque-run-id> [--rebuild]";
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function pretty(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function assertRunId(runId) {
  if (!runId || !/^[A-Za-z0-9][A-Za-z0-9._-]{7,79}$/.test(runId)) {
    throw new Error("--run-id must be an opaque 8-80 character identifier");
  }
}

function approvedAbsolute(relativePath) {
  if (path.isAbsolute(relativePath)) throw new Error(`Absolute path rejected: ${relativePath}`);
  const absolute = path.resolve(REPO_ROOT, relativePath);
  const relation = path.relative(REPO_ROOT, absolute);
  if (!relation || relation.startsWith("..") || path.isAbsolute(relation)) throw new Error(`Path escapes repository: ${relativePath}`);
  return absolute;
}

async function rejectSymlinkedPath(absolutePath, allowMissingLeaf = false) {
  const relation = path.relative(REPO_ROOT, absolutePath);
  if (relation.startsWith("..") || path.isAbsolute(relation)) throw new Error(`Path escapes repository: ${absolutePath}`);
  let current = REPO_ROOT;
  for (const component of relation.split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw new Error(`Symlinked path rejected: ${current}`);
    } catch (error) {
      if (error.code === "ENOENT" && allowMissingLeaf) return;
      throw error;
    }
  }
}

async function readRegular(relativePath) {
  const absolutePath = approvedAbsolute(relativePath);
  await rejectSymlinkedPath(absolutePath);
  const info = await lstat(absolutePath);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Non-regular source rejected: ${relativePath}`);
  return { absolutePath, bytes: await readFile(absolutePath) };
}

function pngDimensions(bytes, label) {
  if (bytes.length < 24 || bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") throw new Error(`Not a PNG: ${label}`);
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

async function inspectPng(relativePath) {
  const { absolutePath, bytes } = await readRegular(relativePath);
  return { relativePath, absolutePath, sha256: sha256(bytes), bytes: bytes.length, ...pngDimensions(bytes, relativePath) };
}

async function cloneOrCopyVerified(source, destination, expected) {
  await mkdir(path.dirname(destination), { recursive: true });
  let strategy = "copy";
  try {
    await copyFile(source, destination, fsConstants.COPYFILE_FICLONE_FORCE);
    strategy = "apfs-clone";
  } catch (forceError) {
    try {
      await copyFile(source, destination, fsConstants.COPYFILE_FICLONE);
      strategy = "clone-or-copy";
    } catch {
      await copyFile(source, destination);
    }
  }
  const info = await lstat(destination);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error(`Published pixel is not an independent regular file: ${destination}`);
  const bytes = await readFile(destination);
  const dimensions = pngDimensions(bytes, destination);
  if (sha256(bytes) !== expected.sha256 || bytes.length !== expected.bytes || dimensions.width !== expected.width || dimensions.height !== expected.height) {
    throw new Error(`Cloned pixel verification failed: ${destination}`);
  }
  return strategy;
}

function alias(seed, runId, namespace, stableKey) {
  return `${namespace}-${createHmac("sha256", seed).update(`${runId}\0${namespace}\0${stableKey}`).digest("hex").slice(0, 20)}`;
}

function opaqueSort(values, seed, runId, namespace, key) {
  return [...values].sort((left, right) => {
    const a = createHmac("sha256", seed).update(`${runId}\0${namespace}\0${key(left)}`).digest("hex");
    const b = createHmac("sha256", seed).update(`${runId}\0${namespace}\0${key(right)}`).digest("hex");
    return a.localeCompare(b);
  });
}

async function loadSeed(privateFinal) {
  const existing = path.join(privateFinal, "alias-seed");
  try {
    await rejectSymlinkedPath(existing);
    const value = (await readFile(existing, "utf8")).trim();
    if (!SHA_PATTERN.test(value)) throw new Error("Invalid private alias seed");
    return value;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return randomBytes(32).toString("hex");
  }
}

function publicSurface(surface, relativePath) {
  return { path: relativePath, sha256: surface.sha256, bytes: surface.bytes, width: surface.width, height: surface.height };
}

function voteSurface(surface) {
  return { sha256: surface.sha256, width: surface.width, height: surface.height };
}

function promptText() {
  return Buffer.from(`# PunchGrow blinded visual review v1\n\nReview only this assignment's supplied pixels. Do not seek or infer hidden product identifiers, names, catalog labels, lineage mappings, categories, other assignments, or earlier verdicts.\n\nUse the controlled visual vocabulary so independent reviewers can encode the same pixels consistently. Asset anchors are exactly face-geometry, body-silhouette, and signature-organ. A single-parent edge uses exactly ancestry-face, ancestry-body, and ancestry-signature. A mixed-parent edge uses exactly parent-a-face, parent-a-body, parent-b-face, and parent-b-body with the matching source slot. Do not invent anchor IDs. Free-form observation text explains the fixed axis and is not compared for agreement. developmentalDeltas may contain only size-increase, limb-development, appendage-development, armor-development, silhouette-change, or locomotion-change, in that priority order; use [] when none is clearly visible. biologicalClass/coreAnatomy/locomotionPlan use schema enums.\n\nspeciesFamily must use the most specific visibly supported neutral family, and unknown-family only when genuinely ambiguous: bear, canid, feline, mustelid, rodent, rabbit, deer, bovine, equine, bat, bird-owl, bird-raptor, bird-songbird, bird-waterfowl, bird-penguin, bird-other, serpent, lizard, turtle, frog, salamander, fish-bony, fish-shark, cetacean, pinniped, arachnid, insect-larva, insect-beetle, insect-lepidopteran, crustacean, cephalopod, gastropod, plant-flower, fungus, spirit, construct, unknown-family. Taxonomy disagreement is handled separately and never overrides continuity dissent.\n\nFor an asset target, assess master/runtime continuity. For an edge target, assess the focused parent-to-child relationship; a second parent may appear only for mixed-parent context. Palette, naming, lore, and broad class are not continuity evidence.\n\nFill vote-template.json and replace reviewer-supplied placeholders. The trusted recorder derives outputSha256 and conductorHmacSha256; reviewers must not create or alter those authority fields. voterReviewRunId is independent from bundleGenerationRunId. Confidence below 0.85 is an honest raw vote but cannot pass activation.\n`);
}

function baseVote(input, hashes) {
  return {
    schemaVersion: "visual-review-v1",
    reviewId: "{{REVIEW_ID}}",
    voterReviewRunId: "{{VOTER_REVIEW_RUN_ID}}",
    reviewTarget: { kind: input.targetKind, opaqueInputId: input.opaqueInputId },
    reviewer: { reviewerInstanceId: "{{REVIEWER_INSTANCE_ID}}", agentTaskId: "{{AGENT_TASK_ID}}", role: "{{primary|adjudicator}}" },
    provenance: {
      bundleGenerationRunId: hashes.runId,
      promptSha256: hashes.promptSha256,
      allowlistSha256: hashes.allowlistSha256,
      templateSha256: "{{TEMPLATE_SHA256}}",
      bundleManifestSha256: "{{BUNDLE_MANIFEST_SHA256}}",
      privateSidecarSha256: hashes.privateSidecarSha256,
      authorizationId: "{{CONDUCTOR_AUTHORIZATION_ID}}",
      batchPackageManifestSha256: "{{REVIEWER_BATCH_PACKAGE_MANIFEST_SHA256}}",
      fileSetSha256: "{{REVIEWER_BATCH_FILE_SET_SHA256}}"
    }
  };
}

function voteTemplate(input, hashes) {
  const vote = baseVote(input, hashes);
  if (input.targetKind === "asset") {
    vote.assets = [{ slot: "asset", master: voteSurface(input.surfaces.master), runtime: voteSurface(input.surfaces.runtime) }];
    vote.assetObservation = {
      biologicalClass: "unknown", speciesFamily: "unknown-family", coreAnatomy: "unknown", locomotionPlan: "unknown",
      faceAnchors: [{ anchorId: "face-geometry", visible: false, observation: "{{OBSERVATION}}" }],
      bodyAnchors: [{ anchorId: "body-silhouette", visible: false, observation: "{{OBSERVATION}}" }, { anchorId: "signature-organ", visible: false, observation: "{{OBSERVATION}}" }],
      developmentalDeltas: [], masterRuntimeContinuity: "undetermined"
    };
  } else {
    vote.assets = input.parents.map((parent) => ({ slot: parent.slot, master: voteSurface(parent.surfaces.master), runtime: voteSurface(parent.surfaces.runtime) }));
    vote.assets.push({ slot: "child", master: voteSurface(input.child.surfaces.master), runtime: voteSurface(input.child.surfaces.runtime) });
    const inheritedAnchors = input.parents.length === 2
      ? ["parent-a-face", "parent-a-body", "parent-b-face", "parent-b-body"].map((anchorId) => ({ anchorId, sourceSlots: [anchorId.startsWith("parent-a") ? "parent-a" : "parent-b"], visibleInChild: false, observation: "{{OBSERVATION}}" }))
      : ["ancestry-face", "ancestry-body", "ancestry-signature"].map((anchorId) => ({ anchorId, sourceSlots: [input.focusParentSlot], visibleInChild: false, observation: "{{OBSERVATION}}" }));
    vote.edgeObservation = { sameCreatureContinuity: "undetermined", coreAnatomyAgreement: "undetermined", locomotionAgreement: "undetermined", inheritedAnchors, developmentalDeltas: [] };
  }
  vote.confidence = 0;
  vote.submittedAt = "{{ISO_8601_TIMESTAMP}}";
  vote.outputSha256 = "{{CANONICAL_OUTPUT_SHA256}}";
  vote.conductorHmacSha256 = "{{CONDUCTOR_HMAC_SHA256}}";
  return vote;
}

async function publishDirectory(staging, finalPath, rebuild) {
  await rejectSymlinkedPath(path.dirname(finalPath));
  let exists = false;
  try { await rejectSymlinkedPath(finalPath); exists = true; } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (exists && !rebuild) throw new Error(`Run already exists; use --rebuild: ${finalPath}`);
  if (!exists) { await rename(staging, finalPath); return; }
  const backup = `${finalPath}.replace-${process.pid}`;
  await rm(backup, { recursive: true, force: true });
  await rename(finalPath, backup);
  try { await rename(staging, finalPath); } catch (error) { await rename(backup, finalPath); throw error; }
  await rm(backup, { recursive: true, force: true });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return console.log(usage());
  assertRunId(args.runId);
  const publicParent = approvedAbsolute(PUBLIC_PARENT_REL);
  const privateParent = approvedAbsolute(PRIVATE_PARENT_REL);
  await mkdir(publicParent, { recursive: true });
  await mkdir(privateParent, { recursive: true });
  await rejectSymlinkedPath(publicParent);
  await rejectSymlinkedPath(privateParent);
  const publicFinal = path.join(publicParent, args.runId);
  const privateFinal = path.join(privateParent, args.runId);
  if (path.dirname(publicFinal) !== publicParent || path.dirname(privateFinal) !== privateParent) throw new Error("Unsafe run path");
  const publicStage = await mkdtemp(path.join(publicParent, `.stage-${args.runId}-`));
  const privateStage = await mkdtemp(path.join(privateParent, `.stage-${args.runId}-`));

  try {
    const registrySource = await readRegular(REGISTRY_REL);
    const registry = JSON.parse(registrySource.bytes);
    const packRel = registry.packs?.[registry.activePack];
    if (typeof packRel !== "string") throw new Error("Active pack is absent from registry");
    const allowedPackParent = approvedAbsolute("production/manifests/creature-asset-packs");
    const packAbsolute = approvedAbsolute(packRel);
    const packRelation = path.relative(allowedPackParent, packAbsolute);
    if (!packRelation || packRelation.startsWith("..") || path.isAbsolute(packRelation) || path.extname(packAbsolute) !== ".json") throw new Error("Active pack manifest path is outside approved registry root");
    const [packSource, catalogSource, contractSource] = await Promise.all([readRegular(packRel), readRegular(CATALOG_REL), readRegular(CONTRACT_REL)]);
    const pack = JSON.parse(packSource.bytes), catalog = JSON.parse(catalogSource.bytes);
    if (pack.packId !== registry.activePack || pack.status !== "active") throw new Error("Registry active pack and manifest disagree");
    if (!Array.isArray(pack.entries) || pack.entries.length !== 240 || !Array.isArray(catalog) || catalog.length !== 240) throw new Error("Expected exactly 240 active pack and catalog entries");
    const registrySha256 = sha256(registrySource.bytes), catalogSha256 = sha256(catalogSource.bytes), packSha256 = sha256(packSource.bytes);
    const seed = await loadSeed(privateFinal);
    await writeFile(path.join(privateStage, "alias-seed"), `${seed}\n`, { mode: 0o600 });

    const entryById = new Map(pack.entries.map((entry) => [entry.id, entry]));
    const catalogById = new Map(catalog.map((entry) => [entry.id, entry]));
    if (entryById.size !== 240 || catalogById.size !== 240) throw new Error("Active IDs must be unique");
    const byLineageStage = new Map();
    for (const creature of catalog) {
      const key = `${creature.lineageId}:S${creature.stage}`, values = byLineageStage.get(key) ?? [];
      values.push(creature); byLineageStage.set(key, values);
    }
    const resolveParent = (owner, reference) => {
      if (ID_PATTERN.test(reference)) { const hit = catalogById.get(reference); if (!hit) throw new Error(`Missing parent for ${owner.id}`); return hit.id; }
      if (!/^PG-L\d{3}:S[1-4]$/.test(reference)) throw new Error(`Invalid parent for ${owner.id}`);
      const hits = byLineageStage.get(reference) ?? []; if (hits.length !== 1) throw new Error(`Ambiguous parent for ${owner.id}`); return hits[0].id;
    };

    const surfacesById = new Map();
    for (const entry of pack.entries) {
      if (!ID_PATTERN.test(entry.id) || entry.path !== `${pack.masterRoot}/${entry.id}.png`) throw new Error(`Non-canonical active entry ${entry.id}`);
      const runtimeRel = entry.deploymentPaths?.macos;
      if (runtimeRel !== `macos/Sources/PunchGrowMenuBar/Resources/Creatures/${entry.id}.png`) throw new Error(`Non-canonical runtime path ${entry.id}`);
      const [master, runtime] = await Promise.all([inspectPng(entry.path), inspectPng(runtimeRel)]);
      if (master.sha256 !== entry.sha256 || runtime.sha256 !== entry.mobileSha256) throw new Error(`Selected pack hash mismatch ${entry.id}`);
      if (master.width !== 1254 || master.height !== 1254 || runtime.width !== 360 || runtime.height !== 360) throw new Error(`Unexpected dimensions ${entry.id}`);
      surfacesById.set(entry.id, { master, runtime });
    }

    const assets = pack.entries.map((entry) => ({ kind: "asset", stableKey: entry.id, assetId: entry.id, opaqueInputId: alias(seed, args.runId, "asset", entry.id) }));
    const edges = [];
    for (const child of catalog) {
      if (!child.evolutionFrom) continue;
      const references = Array.isArray(child.evolutionFrom) ? child.evolutionFrom : [child.evolutionFrom];
      const parentIds = references.map((reference) => resolveParent(child, reference));
      for (const focusParentId of parentIds) {
        const stableKey = `${focusParentId}>${child.id}`;
        edges.push({ kind: "edge", stableKey, childId: child.id, parentIds, focusParentId, opaqueInputId: alias(seed, args.runId, "edge", stableKey) });
      }
    }
    if (edges.length !== 190) throw new Error(`Expected 190 focused edges, got ${edges.length}`);
    const targets = opaqueSort([...assets, ...edges], seed, args.runId, "target-order", (target) => `${target.kind}:${target.stableKey}`);

    const privateAssets = assets.map((target) => ({ opaqueInputId: target.opaqueInputId, assetId: target.assetId }));
    const privateEdges = [];
    const publicInputs = new Map();
    for (const target of targets) {
      if (target.kind === "asset") {
        const s = surfacesById.get(target.assetId);
        publicInputs.set(target.opaqueInputId, { opaqueInputId: target.opaqueInputId, targetKind: "asset", surfaces: { master: publicSurface(s.master, "inputs/asset/master.png"), runtime: publicSurface(s.runtime, "inputs/asset/runtime.png") } });
      } else {
        const parentIds = opaqueSort(target.parentIds, seed, args.runId, `parents:${target.opaqueInputId}`, (id) => id);
        const parentSlots = {}, parents = parentIds.map((id, index) => {
          const slot = index === 0 ? "parent-a" : "parent-b", s = surfacesById.get(id); parentSlots[slot] = id;
          return { slot, surfaces: { master: publicSurface(s.master, `inputs/${slot}/master.png`), runtime: publicSurface(s.runtime, `inputs/${slot}/runtime.png`) } };
        });
        const child = surfacesById.get(target.childId), focusParentSlot = Object.entries(parentSlots).find(([, id]) => id === target.focusParentId)[0];
        publicInputs.set(target.opaqueInputId, { opaqueInputId: target.opaqueInputId, targetKind: "edge", focusParentSlot, parents, child: { slot: "child", surfaces: { master: publicSurface(child.master, "inputs/child/master.png"), runtime: publicSurface(child.runtime, "inputs/child/runtime.png") } }, stageOrder: [...parents.map((p) => p.slot), "child"] });
        privateEdges.push({ opaqueInputId: target.opaqueInputId, focusParentId: target.focusParentId, parentSlots, childId: target.childId });
      }
    }
    const assignments = targets.map((target) => ({ assignmentId: alias(seed, args.runId, "assignment", `${target.kind}:${target.stableKey}`), opaqueInputId: target.opaqueInputId, targetKind: target.kind }));
    const sidecar = { schemaVersion: "private-visual-alias-map-v2", bundleGenerationRunId: args.runId, registryPath: REGISTRY_REL, registrySha256, activePackId: registry.activePack, packManifestPath: packRel, packSha256, catalogPath: CATALOG_REL, catalogSha256, counts: { assets: 240, edges: 190, assignments: 430 }, assets: privateAssets, edges: privateEdges, assignments };
    const sidecarBytes = pretty(sidecar), privateSidecarSha256 = sha256(sidecarBytes);
    await writeFile(path.join(privateStage, "alias-map.json"), sidecarBytes, { mode: 0o600 });

    const prompt = promptText(), promptSha256 = sha256(prompt), contractSha256 = sha256(contractSource.bytes), attestations = [];
    const strategyCounts = {};
    for (const assignment of assignments) {
      const assignmentRoot = path.join(publicStage, "assignments", assignment.assignmentId);
      const input = publicInputs.get(assignment.opaqueInputId);
      const fileSurfaces = input.targetKind === "asset" ? [input.surfaces.master, input.surfaces.runtime] : [...input.parents.flatMap((p) => [p.surfaces.master, p.surfaces.runtime]), input.child.surfaces.master, input.child.surfaces.runtime];
      const sourceSurfaces = input.targetKind === "asset" ? [surfacesById.get(assets.find((x) => x.opaqueInputId === input.opaqueInputId).assetId).master, surfacesById.get(assets.find((x) => x.opaqueInputId === input.opaqueInputId).assetId).runtime] : (() => {
        const privateEdge = privateEdges.find((edge) => edge.opaqueInputId === input.opaqueInputId);
        return [...input.parents.flatMap((parent) => { const s = surfacesById.get(privateEdge.parentSlots[parent.slot]); return [s.master, s.runtime]; }), surfacesById.get(privateEdge.childId).master, surfacesById.get(privateEdge.childId).runtime];
      })();
      for (let i = 0; i < fileSurfaces.length; i += 1) {
        const strategy = await cloneOrCopyVerified(sourceSurfaces[i].absolutePath, path.join(assignmentRoot, fileSurfaces[i].path), sourceSurfaces[i]);
        strategyCounts[strategy] = (strategyCounts[strategy] ?? 0) + 1;
      }
      const allowlist = { schemaVersion: "blinded-input-allowlist-v1", bundleGenerationRunId: args.runId, assignmentId: assignment.assignmentId, inputs: [{ opaqueInputId: input.opaqueInputId, targetKind: input.targetKind, files: fileSurfaces }] };
      const allowlistBytes = pretty(allowlist), allowlistSha256 = sha256(allowlistBytes);
      const template = voteTemplate(input, { runId: args.runId, promptSha256, allowlistSha256, privateSidecarSha256 });
      const templateBytes = pretty(template), templateSha256 = sha256(templateBytes);
      const manifest = { schemaVersion: "blinded-visual-assignment-v1", bundleGenerationRunId: args.runId, assignmentId: assignment.assignmentId, reviewTarget: { kind: input.targetKind, opaqueInputId: input.opaqueInputId }, pixelMaterialization: "independent-apfs-clone-or-copy", registrySha256, catalogSha256, packSha256, privateSidecarSha256, contractSha256, promptSha256, allowlistSha256, templateSha256, counts: { targets: 1, pixelFiles: fileSurfaces.length }, input };
      const manifestBytes = pretty(manifest), bundleManifestSha256 = sha256(manifestBytes);
      await Promise.all([
        writeFile(path.join(assignmentRoot, "REVIEW_PROMPT.md"), prompt),
        writeFile(path.join(assignmentRoot, "review-contract.schema.json"), contractSource.bytes),
        writeFile(path.join(assignmentRoot, "input-allowlist.json"), allowlistBytes),
        writeFile(path.join(assignmentRoot, "vote-template.json"), templateBytes),
        writeFile(path.join(assignmentRoot, "bundle-manifest.json"), manifestBytes)
      ]);
      attestations.push({ assignmentId: assignment.assignmentId, opaqueInputId: input.opaqueInputId, targetKind: input.targetKind, relativePackagePath: `assignments/${assignment.assignmentId}`, bundleManifestSha256, templateSha256, allowlistSha256 });
    }
    const orchestration = { schemaVersion: "blinded-review-orchestration-v1", bundleGenerationRunId: args.runId, counts: { assets: 240, edges: 190, assignments: 430 }, assignments: attestations.map(({ assignmentId, relativePackagePath, bundleManifestSha256 }) => ({ assignmentId, relativePackagePath, bundleManifestSha256 })) };
    await writeFile(path.join(publicStage, "orchestration-index.json"), pretty(orchestration));
    const attestation = { schemaVersion: "private-visual-assignment-attestation-v1", bundleGenerationRunId: args.runId, privateSidecarSha256, registrySha256, catalogSha256, packSha256, assignments: attestations };
    await writeFile(path.join(privateStage, "assignment-attestation.json"), pretty(attestation), { mode: 0o600 });
    await chmod(path.join(privateStage, "alias-seed"), 0o600); await chmod(path.join(privateStage, "alias-map.json"), 0o600); await chmod(path.join(privateStage, "assignment-attestation.json"), 0o600);
    await publishDirectory(publicStage, publicFinal, args.rebuild);
    await publishDirectory(privateStage, privateFinal, args.rebuild);
    console.log(JSON.stringify({ runId: args.runId, activePackId: registry.activePack, counts: orchestration.counts, registrySha256, catalogSha256, packSha256, privateSidecarSha256, pixelMaterialization: "independent-apfs-clone-or-copy", materializationCounts: strategyCounts, publicRoot: path.relative(REPO_ROOT, publicFinal), privateRoot: path.relative(REPO_ROOT, privateFinal) }, null, 2));
  } catch (error) {
    await rm(publicStage, { recursive: true, force: true }); await rm(privateStage, { recursive: true, force: true }); throw error;
  }
}

main().catch((error) => { console.error(error.stack ?? error.message); process.exitCode = 1; });
