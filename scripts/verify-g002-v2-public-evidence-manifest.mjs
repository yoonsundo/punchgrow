#!/usr/bin/env node
import path from 'node:path'; import { fileURLToPath } from 'node:url'; import { readJson } from './lib/continuity-assignment/evidence.mjs'; import { V2_PUBLIC_SIGNED, assertV2Inventory, assertV2PublicManifestShape, verifyV2PublicMaterial } from './lib/g002-v2-public-evidence.mjs';
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export async function verifyG002V2PublicEvidence({repoRoot=ROOT}={}){const manifest=await readJson(repoRoot,V2_PUBLIC_SIGNED);assertV2PublicManifestShape(manifest);const unsigned=structuredClone(manifest);delete unsigned.publicSignature;await verifyV2PublicMaterial(unsigned,{repoRoot});await assertV2Inventory(repoRoot,{requireUnsigned:true,requireSigned:true});return{status:'PASS',files:manifest.files.length,runtimeAssets:manifest.runtimeAssets.length,outputSha256:manifest.outputSha256};}
if(process.argv[1]===fileURLToPath(import.meta.url))console.log(JSON.stringify(await verifyG002V2PublicEvidence()));
