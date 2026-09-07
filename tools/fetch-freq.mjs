#!/usr/bin/env node
/**
 * fetch-freq.mjs — builds tools/word-freq.json, the corpus evidence that
 * tools/difficulty.mjs turns into a difficulty score.
 *
 * Two corpora, deliberately:
 *
 *   · OpenSubtitles (hermitdave/FrequencyWords, en_full) — spoken English.
 *     What you hear. Catches "kiss-up", misses "notwithstanding".
 *   · English Wikipedia (IlyaSemenov/wikipedia-word-frequency) — written,
 *     expository English. Roughly the register the SAT reads in.
 *
 * A word is familiar if it is common in *either*, so the two frequencies are
 * averaged per-billion (linear space, so the larger dominates) before the log.
 * Subtitles alone rate "consequently" as obscure; Wikipedia alone rates
 * "sneaky" as obscure. Neither is true of a seventeen-year-old.
 *
 * Three numbers come out per headword:
 *
 *   z    blended Zipf of the word itself
 *   fam  best Zipf anywhere in its derivational family — "allege" is rare but
 *        "alleged" is not, and knowing one gives you the other
 *   nb   how much more frequent its nearest look-alike is. Words shadowed by a
 *        commoner near-twin (ingenuous/ingenious, noisome/noisy) are misread,
 *        not just unknown.
 *
 * Gloss words get `z` too, so the build can ask how familiar a *meaning* is
 * and not only how familiar its label is.
 *
 * Run order when the word list changes:
 *   node tools/parse-sat1000.mjs → build-sat1000-extra.mjs → fetch-freq.mjs
 *   → build-words.mjs
 *
 *   node tools/fetch-freq.mjs
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

const CORPORA = [
  {
    name: 'OpenSubtitles',
    url: 'https://raw.githubusercontent.com/hermitdave/FrequencyWords/master/content/2018/en/en_full.txt',
    cache: join(HERE, '.freq-subtitles.txt'),
    // build-sat1000-extra.mjs already downloads this one under another name.
    alt: join(HERE, 'sat1000-src', 'en_full.txt'),
  },
  {
    name: 'Wikipedia',
    url: 'https://raw.githubusercontent.com/IlyaSemenov/wikipedia-word-frequency/master/results/enwiki-2023-04-13.txt',
    cache: join(HERE, '.freq-enwiki.txt'),
  },
];

async function corpusText(src) {
  if (src.alt && existsSync(src.alt)) return readFileSync(src.alt, 'utf8');
  if (existsSync(src.cache)) return readFileSync(src.cache, 'utf8');
  process.stdout.write(`  downloading ${src.name} frequencies… `);
  const res = await fetch(src.url);
  if (!res.ok) throw new Error(`${src.name}: ${res.status} ${res.statusText}`);
  const text = await res.text();
  writeFileSync(src.cache, text);
  console.log(`${(text.length / 1e6).toFixed(0)} MB`);
  return text;
}

/** "word count" per line, most frequent first. */
function parseCounts(text) {
  const counts = new Map();
  let total = 0;
  for (const line of text.split('\n')) {
    if (!line) continue;
    const sp = line.indexOf(' ');
    if (sp < 1) continue;
    const word = line.slice(0, sp);
    if (!/^[a-z][a-z'-]*$/.test(word)) continue;
    const n = parseInt(line.slice(sp + 1), 10);
    if (!n) continue;
    if (!counts.has(word)) { counts.set(word, n); total += n; }
  }
  return { counts, total };
}

/* ------------------------------------------------------------- the words */

/* Everything the build will want a frequency for: the headwords, and every
 * content word used in a gloss (so "how familiar is this meaning?" is
 * answerable). Read from the previous build plus the not-yet-merged extras,
 * exactly like fetch-pos.mjs does. */
const STOP = new Set(('a an the of to or and in on for with by from as at is are be being been that this which who whom '
  + 'whose it its into out up down over under not no nor so than then very more most some any all each other another '
  + 'such own same one two something someone somebody thing things person people usually especially often sometimes etc').split(' '));

const headwords = new Set();
const glossWords = new Set();

const addEntry = (w, g) => {
  const head = String(w || '').toLowerCase().replace(/[^a-z]/g, '');
  if (head.length > 1) headwords.add(head);
  for (const tok of String(g || '').toLowerCase().split(/[^a-z]+/)) {
    if (tok.length > 2 && !STOP.has(tok)) glossWords.add(tok);
  }
};

try {
  for (const w of JSON.parse(readFileSync(join(ROOT, 'data', 'words.json'), 'utf8')).words) addEntry(w.w, w.g);
} catch {
  console.warn('  ! data/words.json missing — run tools/build-words.mjs once first');
}
try {
  for (const r of JSON.parse(readFileSync(join(HERE, 'sat1000-extra.json'), 'utf8'))) addEntry(r.w, r.g);
} catch { /* optional */ }

if (!headwords.size) { console.error('  nothing to look up — aborting'); process.exit(1); }
console.log(`  looking up ${headwords.size} headwords + ${glossWords.size} gloss words`);

/* ---------------------------------------------------------------- corpora */

const loaded = [];
for (const src of CORPORA) loaded.push({ name: src.name, ...parseCounts(await corpusText(src)) });
for (const c of loaded) console.log(`  ${c.name}: ${c.counts.size.toLocaleString()} forms, ${c.total.toLocaleString()} tokens`);

const perBillion = (n, total) => (n / total) * 1e9;

/* Zipf: log10 of occurrences per billion tokens. ~6 = "the", ~3 = ordinary
 * vocabulary, ~1 = you have probably never met it. Floored rather than left at
 * -Infinity so an absent word is merely the rarest thing on the scale. */
const FLOOR = 0.4;
function zipf(word) {
  let sum = 0;
  for (const c of loaded) sum += perBillion(c.counts.get(word) || 0, c.total);
  const mean = sum / loaded.length;
  return mean > 0 ? Math.max(FLOOR, Math.log10(mean)) : FLOOR;
}

const round2 = (v) => Math.round(v * 100) / 100;

const z = {};
for (const w of headwords) z[w] = round2(zipf(w));
for (const w of glossWords) if (z[w] === undefined) z[w] = round2(zipf(w));

/* ------------------------------------------------------ derivational family */

/* A word's family is every corpus form built on it by suffixing: allege →
 * alleged, allegedly, allegation. Prefix matching (rather than stemming) keeps
 * "candy" out of "candor"'s family, which a stemmer does not. */
const familyBase = (w) => (w.length > 4 && w.endsWith('e') ? w.slice(0, -1) : w);
const byPrefix = new Map();
for (const w of headwords) {
  const b = familyBase(w);
  if (b.length < 4) continue;
  const k = b.slice(0, 4);
  let arr = byPrefix.get(k);
  if (!arr) byPrefix.set(k, (arr = []));
  arr.push([w, b]);
}

const fam = {};
for (const w of headwords) fam[w] = z[w];
for (const c of loaded) {
  for (const [form, n] of c.counts) {
    if (form.length < 4) continue;
    const hits = byPrefix.get(form.slice(0, 4));
    if (!hits) continue;
    const fz = round2(Math.max(FLOOR, Math.log10(perBillion(n, c.total))));
    for (const [w, b] of hits) {
      // Suffixes only, and short ones: "convincingly" yes, "consulate" no.
      if (!form.startsWith(b) || form.length > b.length + 6) continue;
      if (fz > fam[w]) fam[w] = fz;
    }
  }
}

/* --------------------------------------------------- look-alike shadowing */

/* The most frequent ordinary word within two edits of the headword, and how
 * much more frequent it is. This is the "I thought it meant…" factor:
 * ingenuous/ingenious, noisome/noisy, venal/venial. */
function levenshtein(a, b, cap) {
  const m = a.length, n = b.length;
  if (Math.abs(m - n) > cap) return cap + 1;
  let prev = new Array(n + 1), cur = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    let best = i;
    const ai = a.charCodeAt(i - 1);
    for (let j = 1; j <= n; j++) {
      const cost = ai === b.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (cur[j] < best) best = cur[j];
    }
    if (best > cap) return cap + 1;
    const t = prev; prev = cur; cur = t;
  }
  return prev[n];
}

const NEIGHBOUR_MIN_Z = 3.2;   // "ordinary word" — roughly the median of running text
const seen = new Set();
const byLength = new Map();
for (const c of loaded) {
  for (const form of c.counts.keys()) {
    if (form.length < 4 || seen.has(form) || !/^[a-z]+$/.test(form)) continue;
    seen.add(form);
    const fz = zipf(form);
    if (fz < NEIGHBOUR_MIN_Z) continue;
    let arr = byLength.get(form.length);
    if (!arr) byLength.set(form.length, (arr = []));
    arr.push([form, fz]);
  }
}
console.log(`  look-alike pool: ${[...byLength.values()].reduce((a, b) => a + b.length, 0).toLocaleString()} ordinary words`);

const nb = {};
for (const w of headwords) {
  nb[w] = 0;
  if (w.length < 5) continue;
  const base = familyBase(w);
  const zw = z[w];
  let best = 0;
  for (let L = w.length - 2; L <= w.length + 2; L++) {
    for (const [form, fz] of byLength.get(L) || []) {
      if (fz - zw <= best) continue;              // no better than what we have
      if (form === w || form.startsWith(base)) continue;   // itself, or its own family
      if (form[0] !== w[0] && form[1] !== w[1]) continue;  // cheap reject
      if (levenshtein(w, form, 2) > 2) continue;
      best = fz - zw;
    }
  }
  nb[w] = round2(best);
}

/* ------------------------------------------------------------------ write */

const out = {
  built: new Date().toISOString().slice(0, 10),
  sources: CORPORA.map((c) => c.url),
  z, fam, nb,
};
const json = JSON.stringify(out);
writeFileSync(join(HERE, 'word-freq.json'), json);
console.log(`  wrote tools/word-freq.json (${(json.length / 1024).toFixed(0)} KB)`);

const sample = ['convince', 'benign', 'allege', 'obsequious', 'perspicacious', 'ingenuous', 'noisome'];
for (const w of sample) {
  if (z[w] === undefined) continue;
  console.log(`   ${w.padEnd(15)} z=${z[w].toFixed(2)} fam=${fam[w].toFixed(2)} nb=${nb[w].toFixed(2)}`);
}
