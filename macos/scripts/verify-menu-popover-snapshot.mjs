#!/usr/bin/env node

import fs from 'node:fs';
import pngjs from 'pngjs';

const { PNG } = pngjs;
const [snapshotPath] = process.argv.slice(2);

if (!snapshotPath) {
  throw new Error('Usage: verify-menu-popover-snapshot.mjs <snapshot.png>');
}

const image = PNG.sync.read(fs.readFileSync(snapshotPath));
if (image.width !== 398 || image.height !== 670) {
  throw new Error(`Expected 398x670 menu snapshot, received ${image.width}x${image.height}`);
}

function colorAt(x, y) {
  const offset = (image.width * y + x) * 4;
  return Array.from(image.data.subarray(offset, offset + 3));
}

function assertNear(label, actual, expected, tolerance = 18) {
  const distance = Math.max(...actual.map((channel, index) => Math.abs(channel - expected[index])));
  if (distance > tolerance) {
    throw new Error(`${label} missing or clipped: expected ${expected}, received ${actual}`);
  }
}

// The third action row was the original overflow regression. Sample multiple points away
// from text so a one-pixel sliver or a footer overlap cannot satisfy this check.
// PunchGrowColors.actionRetry / actionInherit (Views.swift)와 같은 값이어야 한다.
for (const x of [25, 110, 180]) {
  assertNear('mutation retry action', colorAt(x, 600), [103, 85, 174]);
}
for (const x of [215, 300, 370]) {
  assertNear('inherit action', colorAt(x, 600), [40, 126, 120]);
}

// All five fixed dock destinations must remain visible below the action deck.
const dockAccents = [
  [49, [77, 225, 255]],
  [124, [245, 177, 74]],
  [199, [151, 106, 235]],
  [274, [73, 211, 240]],
  [349, [234, 71, 145]],
];
for (const [x, expected] of dockAccents) {
  assertNear('footer dock item', colorAt(x, 640), expected, 36);
}

console.log(JSON.stringify({ status: 'PASS', width: image.width, height: image.height }));
