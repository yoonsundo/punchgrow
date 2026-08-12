import { createHash } from 'node:crypto';

function normalize(value, location = '$') {
  if (Array.isArray(value)) return value.map((item, index) => normalize(item, `${location}[${index}]`));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, normalize(value[key], `${location}.${key}`)]));
  }
  if (typeof value === 'number' && !Number.isFinite(value)) throw new TypeError('canonical JSON rejects non-finite numbers');
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') {
    throw new TypeError(`canonical JSON rejects non-JSON value at ${location}`);
  }
  return value;
}

export function canonicalStringify(value) {
  return `${JSON.stringify(normalize(value), null, 2)}\n`;
}

export function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function sha256Canonical(value) {
  return sha256Bytes(Buffer.from(canonicalStringify(value)));
}
