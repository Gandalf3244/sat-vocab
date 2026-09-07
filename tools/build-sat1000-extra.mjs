#!/usr/bin/env node
/**
 * build-sat1000-extra.mjs — turns tools/sat1000-src/parsed.json (the
 * SparkNotes-style "1000 Most Common SAT Words" list) into rows shaped like
 * build-words.mjs's internal `raw` array, skipping any word already present
 * in data/words.json, and assigning each new word a tier (1/2/3) by real
 * English-usage frequency rather than the list's (alphabetical) order.
 *
 * Frequency source: hermitdave/FrequencyWords en_full (OpenSubtitles-derived,
 * ~1.6M ranked word forms) — deep enough to separate "benign" from
 * "sycophant" the way the top-50k list cannot. Tier cut points are learned
 * from the CURRENT corpus: each existing tier's median frequency rank sets
 * the boundary, so new words interleave at a comparable difficulty rather
 * than all landing in tier 3.
 *
 * Run: node tools/build-sat1000-extra.mjs
 * Then: node tools/build-words.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

const existing = JSON.parse(readFileSync(join(ROOT, 'data', 'words.json'), 'utf8'));
const existingWords = new Map(existing.words.map((w) => [w.w.toLowerCase(), w]));

const parsed = JSON.parse(readFileSync(join(HERE, 'sat1000-src', 'parsed.json'), 'utf8'));

/* --------------------------------------------------------------- frequency */

const freqLines = readFileSync(join(HERE, 'sat1000-src', 'en_full.txt'), 'utf8').split('\n');
const rank = new Map();
for (let i = 0; i < freqLines.length; i++) {
  const line = freqLines[i];
  if (!line) continue;
  const sp = line.indexOf(' ');
  if (sp < 0) continue;
  const w = line.slice(0, sp);
  if (!rank.has(w)) rank.set(w, i);   // first (most frequent) occurrence wins
}
const NOT_FOUND = freqLines.length + 200000;   // rarer than anything ranked

function freqRank(word) {
  const base = word.toLowerCase().replace(/[^a-z]/g, '');
  return rank.has(base) ? rank.get(base) : NOT_FOUND;
}

/* Calibrate tier boundaries from the existing corpus's own frequency ranks. */
const byTier = { 1: [], 2: [], 3: [] };
for (const w of existing.words) byTier[w.t]?.push(freqRank(w.w));
for (const t of [1, 2, 3]) byTier[t].sort((a, b) => a - b);
const median = (arr) => arr[Math.floor(arr.length / 2)];
const m1 = median(byTier[1]), m2 = median(byTier[2]), m3 = median(byTier[3]);
// Boundaries sit halfway (in log-space, since frequency rank is log-distributed)
// between each pair of neighbouring tier medians.
const logMid = (a, b) => Math.exp((Math.log(Math.max(1, a)) + Math.log(Math.max(1, b))) / 2);
const CUT_12 = logMid(m1, m2);
const CUT_23 = logMid(m2, m3);
console.log(`  existing tier median ranks: t1=${m1} t2=${m2} t3=${m3}`);
console.log(`  new-word tier cuts: <${CUT_12.toFixed(0)} => tier1, <${CUT_23.toFixed(0)} => tier2, else tier3`);

function tierFor(r) {
  if (r < CUT_12) return 1;
  if (r < CUT_23) return 2;
  return 3;
}

/* ------------------------------------------------------------------ gloss */
/* Mirrors build-words.mjs's cleanGloss so the new rows read the same way as
 * the sesame-derived ones once merged. */
function cleanGloss(g) {
  return g
    .replace(/^\((?:psychology|chemistry|physics|law|medicine|biology|music|sports?)\)\s*/i, '')
    .replace(/^(?:a|an|the)\s+/i, '')
    .replace(/\s*\(.*?\)\s*/g, ' ')
    .replace(/,.*$/, '')
    .replace(/\s+or\s+.*$/, '')
    .replace(/[;:,]\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/* -------------------------------------------------------------------- run */

let skippedDupe = 0;
const rows = [];
const examples = {};
for (const e of parsed) {
  if (existingWords.has(e.w)) { skippedDupe++; continue; }
  let gloss = cleanGloss(e.d);
  if (e.p === 'v' && gloss.startsWith('to ')) gloss = gloss.slice(3);
  if (!gloss) continue;
  const r = freqRank(e.w);
  const t = tierFor(r);
  rows.push({ w: e.w, g: gloss, d: e.d.replace(/\s+/g, ' ').trim(), t, l: null, rawG: e.d });
  if (e.e) examples[e.w] = e.e;
}

const counts = rows.reduce((m, r) => { m[r.t] = (m[r.t] || 0) + 1; return m; }, {});
console.log(`  parsed list: ${parsed.length}, already in corpus: ${skippedDupe}, new: ${rows.length}`);
console.log(`  new-word tier split: ${JSON.stringify(counts)}`);

writeFileSync(join(HERE, 'sat1000-extra.json'), JSON.stringify(rows, null, 2));

/* Merge example sentences into tools/examples.json (used by build-words.mjs) */
let allExamples = {};
try { allExamples = JSON.parse(readFileSync(join(HERE, 'examples.json'), 'utf8')); } catch { /* none yet */ }
let addedExamples = 0;
for (const [w, ex] of Object.entries(examples)) {
  if (!allExamples[w]) { allExamples[w] = ex; addedExamples++; }
}
writeFileSync(join(HERE, 'examples.json'), JSON.stringify(allExamples, null, 2));
console.log(`  added ${addedExamples} example sentences to tools/examples.json`);
