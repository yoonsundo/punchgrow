#!/usr/bin/env node

import { createHash } from "node:crypto";
import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const outputRoot = path.resolve(process.argv[2] ?? "website/dist");
const errors = [];
const contentSecurityPolicy = "default-src 'self'; base-uri 'none'; object-src 'none'; frame-src 'none'; form-action 'none'; connect-src 'self'; img-src 'self' data:; font-src 'self'; style-src 'self'; script-src 'self' 'sha256-Du+OJKJSbdUgz5nrHeWWINvez6XKDDU/tyj/5c2uvwo=' 'sha256-Bt/npEZSmp8M4HgBPGuGTb+g1a+11NKBnnid7mj1uec=' 'sha256-eejKdM244Fddqhz5BS95zSCdDV76bhyUPqu5tshRxaA='; upgrade-insecure-requests";

try {
  await access(outputRoot);
} catch {
  console.error(`Site output does not exist: ${outputRoot}`);
  process.exit(1);
}

const files = await listFiles(outputRoot);
const htmlFiles = files.filter((file) => file.endsWith(".html"));
const relativeFiles = new Set(files.map((file) => toPosix(path.relative(outputRoot, file))));
const htmlByRelativePath = new Map();

if (htmlFiles.length === 0) {
  errors.push("No generated HTML files were found.");
}

for (const file of htmlFiles) {
  const relativePath = toPosix(path.relative(outputRoot, file));
  const html = await readFile(file, "utf8");
  htmlByRelativePath.set(relativePath, html);
  validateHtml(relativePath, html);
}

for (const [relativePath, html] of htmlByRelativePath) {
  validateReferences(relativePath, html);
}

validateLocaleParity();

if (errors.length > 0) {
  console.error(`Website validation failed with ${errors.length} error(s):`);
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(
  `Website validation passed: ${htmlFiles.length} HTML file(s), ${relativeFiles.size} total file(s).`,
);

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        errors.push(
          `${toPosix(path.relative(outputRoot, entryPath))}: symbolic links are not allowed in the deployment artifact`,
        );
        return [];
      }
      return entry.isDirectory() ? listFiles(entryPath) : [entryPath];
    }),
  );
  return nested.flat().sort();
}

function validateHtml(relativePath, html) {
  requireMatch(relativePath, html, /^\s*<!doctype html>/i, "missing HTML5 doctype");
  requireMatch(relativePath, html, /<html\b[^>]*\blang=["'][^"']+["']/i, "missing html lang");
  requireMatch(relativePath, html, /<meta\b[^>]*\bcharset=["']?utf-8\b/i, "missing UTF-8 charset");
  requireMatch(
    relativePath,
    html,
    /<meta\b(?=[^>]*\bname=["']viewport["'])(?=[^>]*\bcontent=["'][^"']+["'])[^>]*>/i,
    "missing viewport metadata",
  );
  requireMatch(relativePath, html, /<title\b[^>]*>\s*[^<\s][^<]*<\/title>/i, "missing page title");
  if (!html.includes(`<meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy}">`)) {
    errors.push(`${relativePath}: missing the locked static-site Content Security Policy`);
  }
  if (!html.includes('<meta name="referrer" content="no-referrer">')) {
    errors.push(`${relativePath}: missing no-referrer metadata`);
  }
  if (/\sstyle=["']/i.test(html)) {
    errors.push(`${relativePath}: inline style attributes are blocked by the static-site policy`);
  }
  for (const match of html.matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)) {
    const hash = createHash("sha256").update(match[1]).digest("base64");
    if (!contentSecurityPolicy.includes(`'sha256-${hash}'`)) {
      errors.push(`${relativePath}: inline script is missing its exact CSP hash`);
    }
  }

  const ids = new Set();
  for (const match of html.matchAll(/\bid=["']([^"']+)["']/gi)) {
    if (ids.has(match[1])) errors.push(`${relativePath}: duplicate id #${match[1]}`);
    ids.add(match[1]);
  }

  for (const match of html.matchAll(/<img\b[^>]*>/gi)) {
    if (!/\balt=["'][^"']*["']/i.test(match[0])) {
      errors.push(`${relativePath}: image is missing an alt attribute`);
    }
  }
}

function validateReferences(relativePath, html) {
  const attributes = [];
  for (const match of html.matchAll(/\b(?:href|src)=["']([^"']+)["']/gi)) {
    attributes.push(match[1]);
  }
  for (const match of html.matchAll(/\bsrcset=["']([^"']+)["']/gi)) {
    for (const candidate of match[1].split(",")) {
      attributes.push(candidate.trim().split(/\s+/)[0]);
    }
  }

  for (const reference of attributes) {
    const decoded = safeDecode(reference.trim());
    if (!decoded || isExternal(decoded)) continue;

    const [pathname, fragment] = decoded.split("#", 2);
    const target = resolveReference(relativePath, pathname);

    if (pathname && !target) {
      errors.push(`${relativePath}: broken internal reference ${reference}`);
      continue;
    }

    if (fragment) {
      const targetHtmlPath = target ?? relativePath;
      const targetHtml = htmlByRelativePath.get(targetHtmlPath);
      const escapedFragment = escapeRegExp(fragment);
      if (targetHtml && !new RegExp(`\\bid=["']${escapedFragment}["']`, "i").test(targetHtml)) {
        errors.push(`${relativePath}: missing fragment #${fragment} in ${targetHtmlPath}`);
      }
    }
  }
}

function resolveReference(fromHtml, reference) {
  const cleanReference = reference.split("?", 1)[0];
  if (!cleanReference) return fromHtml;

  const baseDirectory = cleanReference.startsWith("/")
    ? ""
    : path.posix.dirname(fromHtml);
  const candidate = path.posix.normalize(
    path.posix.join(baseDirectory, cleanReference.replace(/^\/+/, "")),
  );

  if (candidate.startsWith("../")) return null;
  if (relativeFiles.has(candidate)) return candidate;
  if (relativeFiles.has(`${candidate}.html`)) return `${candidate}.html`;

  const indexCandidate = path.posix.join(candidate, "index.html");
  return relativeFiles.has(indexCandidate) ? indexCandidate : null;
}

function validateLocaleParity() {
  const localePattern = /^[a-z]{2}(?:-[A-Z]{2})?$/;
  const localeRoots = new Map();

  for (const relativePath of htmlByRelativePath.keys()) {
    const [locale, ...rest] = relativePath.split("/");
    if (localePattern.test(locale) && rest.length > 0 && relativeFiles.has(`${locale}/index.html`)) {
      const routes = localeRoots.get(locale) ?? new Set();
      routes.add(rest.join("/"));
      localeRoots.set(locale, routes);
    }
  }

  if (localeRoots.size < 2) return;

  const [baselineLocale, baselineRoutes] = [...localeRoots.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  )[0];
  for (const [locale, routes] of localeRoots) {
    if (locale === baselineLocale) continue;
    for (const route of baselineRoutes) {
      if (!routes.has(route)) errors.push(`${locale}: missing locale route matching ${baselineLocale}/${route}`);
    }
    for (const route of routes) {
      if (!baselineRoutes.has(route)) errors.push(`${baselineLocale}: missing locale route matching ${locale}/${route}`);
    }
  }
}

function requireMatch(relativePath, html, pattern, message) {
  if (!pattern.test(html)) errors.push(`${relativePath}: ${message}`);
}

function isExternal(reference) {
  return (
    reference.startsWith("//") ||
    reference.startsWith("data:") ||
    reference.startsWith("mailto:") ||
    reference.startsWith("tel:") ||
    reference.startsWith("javascript:") ||
    /^[a-z][a-z\d+.-]*:/i.test(reference)
  );
}

function safeDecode(value) {
  try {
    return decodeURI(value);
  } catch {
    return value;
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function toPosix(value) {
  return value.split(path.sep).join("/");
}
