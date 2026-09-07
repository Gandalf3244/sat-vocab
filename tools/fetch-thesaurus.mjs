#!/usr/bin/env node
/**
 * fetch-thesaurus.mjs — builds tools/synonyms.json.
 *
 * Some unfair distractors are invisible to a definition-based check: the
 * definitions of "disseminate" (cause to become widely known) and "dispense"
 * (administer or bestow) share nothing, yet their glosses — broadcast and
 * distribute — mean much the same thing, so offering one against the other is
 * a question with two defensible answers.
 *
 * Catching that needs a thesaurus. Source is Moby Thesaurus II (public domain).
 * The full file is ~25 MB; we keep only links between words this project can
 * actually display, which is a very small slice of it.
 *
 * Moby is a loose associative thesaurus, so a single one-way link means little.
 * We keep only MUTUAL links (a lists b AND b lists a), which is a much stronger
 * claim that two words really are interchangeable.
 *
 *   node tools/fetch-thesaurus.mjs
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = 'https://raw.githubusercontent.com/words/moby/master/words.txt';
const CACHE = join(HERE, '.thesaurus-raw.txt');

async function raw() {
  if (existsSync(CACHE)) return readFileSync(CACHE, 'utf8');
  process.stdout.write('  downloading Moby Thesaurus… ');
  const res = await fetch(SRC);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const text = await res.text();
  writeFileSync(CACHE, text);
  console.log(`${(text.length / 1e6).toFixed(1)} MB`);
  return text;
}

/** Headwords plus every gloss head word — the only things ever displayed. */
function relevant() {
  const want = new Set();
  const words = JSON.parse(readFileSync(join(HERE, '..', 'data', 'words.json'), 'utf8')).words;
  for (const w of words) {
    want.add(w.w.toLowerCase());
    const g = w.g.toLowerCase().trim();
    want.add(g);
    // Only the head word matters: it is what a comparison keys on.
    const head = g.split(/[^a-z]+/).filter(Boolean)[0];
    if (head && head.length > 2) want.add(head);
  }
  return want;
}

const text = await raw();
const want = relevant();

// Pass 1: for each relevant root, its synonyms that are also relevant.
const forward = new Map();
for (const line of text.split('\n')) {
  if (!line) continue;
  const comma = line.indexOf(',');
  if (comma < 1) continue;
  const root = line.slice(0, comma).toLowerCase();
  if (!want.has(root)) continue;
  const syns = new Set();
  for (const s of line.slice(comma + 1).toLowerCase().split(',')) {
    const t = s.trim();
    if (t && t !== root && want.has(t)) syns.add(t);
  }
  if (syns.size) forward.set(root, syns);
}

// Pass 2: keep only mutual links.
const out = {};
let kept = 0, dropped = 0;
for (const [root, syns] of forward) {
  const mutual = [];
  for (const s of syns) {
    if (forward.get(s)?.has(root)) { mutual.push(s); kept++; } else dropped++;
  }
  if (mutual.length) out[root] = mutual.sort();
}

writeFileSync(join(HERE, 'synonyms.json'), JSON.stringify(out));
console.log(`  relevant vocabulary: ${want.size}`);
console.log(`  roots with mutual synonyms: ${Object.keys(out).length}`);
console.log(`  mutual links kept ${kept}, one-way links dropped ${dropped}`);
console.log(`  wrote tools/synonyms.json (${(JSON.stringify(out).length / 1024).toFixed(0)} KB)`);

for (const [a, b] of [['broadcast', 'distribute'], ['prevent', 'preclude'], ['mild', 'harmless']]) {
  const hit = out[a]?.includes(b) || out[b]?.includes(a);
  console.log(`  check: ${a} ~ ${b} -> ${hit ? 'SYNONYMS (would be rejected)' : 'distinct'}`);
}
