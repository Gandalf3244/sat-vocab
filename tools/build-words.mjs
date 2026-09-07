#!/usr/bin/env node
/**
 * build-words.mjs - turns the saved sesamewords HTML pages into data/words.json
 *
 * Output shape (keys kept short; the file ships to the browser):
 *   { version, built, tiers:[...], words:[ {i,w,g,d,t,l,r,x,c:[ids]} ] }
 *     i  id (index)          w  word              g  short gloss (used as answer text)
 *     d  full definition     t  tier 1|2|3        l  lesson label
 *     r  global freq rank    x  difficulty 0..1   c  confusable distractor ids
 *
 * Run:  node tools/build-words.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

const SOURCES = [
  { file: 'sesame_top-frequency-sat-450-words-lessons-1-1-1-15.html', tier: 1, name: 'Top Frequency' },
  { file: 'sesame_mid-frequency-sat-1350-words-lessons-2-1-2-45.html', tier: 2, name: 'Mid Frequency' },
  { file: 'sesame_low-frequency-sat-2700-words.html', tier: 3, name: 'Low Frequency' },
];

/* ---------------------------------------------------------------- parsing */

function visibleLines(html) {
  let s = html.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  s = s.replace(/<[^>]+>/g, '\n');
  s = s
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&rsquo;|&#8217;/g, '’');
  return s.split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

// "allege...syn: claim or accuse; report or maintain"
const ENTRY = /^([A-Za-z][A-Za-z'’\- ]{1,30}?)\s*\.\.\.\s*(?:syn|synonym)\s*:\s*(.+)$/i;
const LESSON = /^Lesson\s+([\d.]+)\s*$/i;

function parsePage(html, tier) {
  const out = [];
  let lesson = null;
  for (const line of visibleLines(html)) {
    const lm = line.match(LESSON);
    if (lm) { lesson = lm[1]; continue; }
    const m = line.match(ENTRY);
    if (!m) continue;
    const word = m[1].trim().toLowerCase();
    const rest = m[2].trim();
    // gloss ; definition   (first semicolon splits them)
    let gloss, def;
    const semi = rest.indexOf(';');
    if (semi > 0) { gloss = rest.slice(0, semi).trim(); def = rest.slice(semi + 1).trim(); }
    else { gloss = rest; def = rest; }
    gloss = cleanGloss(gloss);
    def = def.replace(/\s+/g, ' ').trim();
    if (!word || !gloss) continue;
    if (word.split(' ').length > 3) continue;
    out.push({ w: word, g: gloss, d: def || gloss, t: tier, l: lesson });
  }
  return out;
}

function cleanGloss(g) {
  return g
    .replace(/^\((?:psychology|chemistry|physics|law|medicine|biology|music|sports?)\)\s*/i, '')
    .replace(/^(?:a|an|the)\s+/i, '')
    .replace(/\s*\(.*?\)\s*/g, ' ')
    .replace(/[;:,]\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/* ------------------------------------------------------------- phonetics */

/** Compact, Metaphone-flavoured key. Good enough to cluster look/sound-alikes. */
function phoneticKey(word) {
  let s = word.toLowerCase().replace(/[^a-z]/g, '');
  if (!s) return '';
  s = s
    .replace(/^(kn|gn|pn|ae|wr)/, (m) => m[1])
    .replace(/^x/, 's')
    .replace(/^wh/, 'w');
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i], n = s[i + 1], p = s[i - 1];
    if (c === p && c !== 'c') continue;              // collapse doubles
    switch (c) {
      case 'a': case 'e': case 'i': case 'o': case 'u':
        if (i === 0) out += 'A';                     // only leading vowels survive
        break;
      case 'b': out += (i === s.length - 1 && p === 'm') ? '' : 'B'; break;
      case 'c':
        if (n === 'i' && s[i + 2] === 'a') out += 'X';
        else if (n === 'h') { out += 'X'; i++; }
        else if (n === 'i' || n === 'e' || n === 'y') out += 'S';
        else out += 'K';
        break;
      case 'd': if (n === 'g') { out += 'J'; i++; } else out += 'T'; break;
      case 'g':
        if (n === 'h') { i++; break; }
        if (n === 'n') break;
        out += (n === 'i' || n === 'e' || n === 'y') ? 'J' : 'K';
        break;
      case 'h': if ('aeiou'.includes(p || '') && !'aeiou'.includes(n || '')) break; out += 'H'; break;
      case 'k': if (p === 'c') break; out += 'K'; break;
      case 'p': if (n === 'h') { out += 'F'; i++; } else out += 'P'; break;
      case 'q': out += 'K'; break;
      case 's':
        if (n === 'h') { out += 'X'; i++; }
        else if (n === 'i' && (s[i + 2] === 'o' || s[i + 2] === 'a')) out += 'X';
        else out += 'S';
        break;
      case 't':
        if (n === 'i' && (s[i + 2] === 'o' || s[i + 2] === 'a')) out += 'X';
        else if (n === 'h') { out += '0'; i++; }
        else out += 'T';
        break;
      case 'v': out += 'F'; break;
      case 'w': case 'y': if (!'aeiou'.includes(n || '')) break; out += c.toUpperCase(); break;
      case 'x': out += 'KS'; break;
      case 'z': out += 'S'; break;
      default: out += c.toUpperCase();
    }
  }
  return out;
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = new Array(n + 1), cur = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    const ai = a.charCodeAt(i - 1);
    for (let j = 1; j <= n; j++) {
      const cost = ai === b.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    const t = prev; prev = cur; cur = t;
  }
  return prev[n];
}

const commonPrefix = (a, b) => { let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++; return i; };
const commonSuffix = (a, b) => { let i = 0; while (i < a.length && i < b.length && a[a.length - 1 - i] === b[b.length - 1 - i]) i++; return i; };

/* --------------------------------------------------- morphology + meaning */

const SUFFIXES = ['iveness', 'ization', 'ability', 'ically', 'ousness', 'fulness', 'ations', 'ement', 'ances', 'ences', 'ities', 'ingly', 'ional', 'ative', 'itive', 'ation', 'ition', 'ously', 'ivity', 'ility', 'ments', 'ising', 'izing', 'ance', 'ence', 'ment', 'ness', 'less', 'ible', 'able', 'tion', 'sion', 'ious', 'eous', 'ical', 'ally', 'ised', 'ized', 'ises', 'izes', 'ing', 'ers', 'ors', 'ive', 'ify', 'ity', 'ism', 'ist', 'ous', 'ary', 'ory', 'ate', 'ent', 'ant', 'age', 'ful', 'ial', 'ian', 'ic', 'al', 'ly', 'ed', 'es', 'er', 'or', 'ee', 'y', 's'];

function stem(word) {
  let s = word.toLowerCase().replace(/[^a-z]/g, '');
  for (const suf of SUFFIXES) {
    if (s.length - suf.length >= 4 && s.endsWith(suf)) { s = s.slice(0, -suf.length); break; }
  }
  return s.replace(/(.)\1$/, '$1');
}

const STOP = new Set(('a an the of to or and in on for with by from as at is are be being been that this which who whom whose it its into out up down over under not no nor so than then very more most some any all each other another such own same one two something someone somebody thing things person people usually especially often sometimes etc used use using make makes made cause causes caused having have has had do does did way ways state condition quality act action manner degree').split(' '));

function contentWords(text) {
  const set = new Set();
  for (const raw of text.toLowerCase().split(/[^a-z]+/)) {
    if (raw.length < 3 || STOP.has(raw)) continue;
    set.add(stem(raw));
  }
  return set;
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/* ------------------------------------------------------------------ main */

const raw = [];
for (const src of SOURCES) {
  const html = readFileSync(join(HERE, src.file), 'utf8');
  const rows = parsePage(html, src.tier);
  console.log(`  ${src.name}: parsed ${rows.length}`);
  raw.push(...rows);
}

// Dedupe: a word appearing in several tiers keeps its highest-frequency (lowest tier) entry.
const order = new Map();
raw.forEach((r, i) => { if (!order.has(r)) order.set(r, i); });
const byWord = new Map();
for (const r of raw) {
  const prev = byWord.get(r.w);
  if (!prev || r.t < prev.t) byWord.set(r.w, r);
}

const words = [...byWord.values()].sort((a, b) => a.t - b.t || order.get(a) - order.get(b));

words.forEach((w, i) => { w.i = i; w.r = i; });
console.log(`  deduped: ${words.length} unique words`);

/* difficulty 0..1 - tier dominates, position inside tier refines it,
   with a small nudge for long words.                                      */
const tierBand = { 1: [0.00, 0.30], 2: [0.28, 0.66], 3: [0.60, 1.00] };
const tierCounts = words.reduce((m, w) => { m[w.t] = (m[w.t] || 0) + 1; return m; }, {});
const tierSeen = {};
for (const w of words) {
  const n = (tierSeen[w.t] = (tierSeen[w.t] || 0) + 1) - 1;
  const [lo, hi] = tierBand[w.t];
  const pos = n / Math.max(1, tierCounts[w.t] - 1);
  const lenPenalty = Math.min(0.06, Math.max(0, (w.w.replace(/[^a-z]/g, '').length - 7) * 0.012));
  w.x = Math.round(Math.min(1, lo + (hi - lo) * pos + lenPenalty) * 1000) / 1000;
}

/* ------------------------------------------------ confusable distractors */

const keys = words.map((w) => phoneticKey(w.w));
const meanings = words.map((w) => contentWords(`${w.g} ${w.d}`));
const glossSets = words.map((w) => contentWords(w.g));
const stems = words.map((w) => stem(w.w));
const glossNorm = words.map((w) => w.g.replace(/[^a-z ]/g, '').trim());

// blocking buckets so we don't do 10M edit distances
const bucket = new Map();
const push = (k, i) => { if (!k) return; let a = bucket.get(k); if (!a) bucket.set(k, (a = [])); a.push(i); };
words.forEach((w, i) => {
  const s = w.w.replace(/[^a-z]/g, '');
  push('p3:' + s.slice(0, 3), i);
  push('p2:' + s.slice(0, 2), i);
  push('s4:' + s.slice(-4), i);
  push('k3:' + keys[i].slice(0, 3), i);
  push('k4:' + keys[i].slice(0, 4), i);
  push('L:' + s[0] + s.length, i);
});

/** Would swapping in `j` as a wrong answer for `i` be unfair (i.e. also correct-ish)? */
function tooSimilarMeaning(i, j) {
  if (glossNorm[i] === glossNorm[j]) return true;
  if (stems[i] === stems[j] && stems[i].length >= 4) return true;        // innovation / innovative
  const g1 = words[i].g, g2 = words[j].g;
  if (g1.includes(g2) || g2.includes(g1)) return true;
  if (jaccard(glossSets[i], glossSets[j]) >= 0.34) return true;          // gloss-level synonyms
  const overlap = jaccard(meanings[i], meanings[j]);
  if (overlap >= 0.30) return true;                                      // full-definition overlap
  // Same-root relatives (buoyant / buoyancy) are unfair once their senses touch at all,
  // but keep genuine root-mates whose senses diverged (precipitate / precipitous).
  const a = words[i].w.replace(/[^a-z]/g, ''), b = words[j].w.replace(/[^a-z]/g, '');
  if (commonPrefix(a, b) >= 6 && overlap >= 0.10) return true;
  return false;
}

function similarity(i, j) {
  const a = words[i].w.replace(/[^a-z]/g, '');
  const b = words[j].w.replace(/[^a-z]/g, '');
  const maxLen = Math.max(a.length, b.length);
  if (!maxLen) return 0;
  const lev = levenshtein(a, b);
  const edit = 1 - lev / maxLen;
  const pre = commonPrefix(a, b);
  const suf = commonSuffix(a, b);
  const ka = keys[i], kb = keys[j];
  const kpre = commonPrefix(ka, kb);
  const kEdit = ka && kb ? 1 - levenshtein(ka, kb) / Math.max(ka.length, kb.length) : 0;

  let s = 0;
  s += 3.4 * edit;                                           // overall look-alike
  s += 2.2 * kEdit;                                          // overall sound-alike
  if (pre >= 3) s += 2.6 * (pre / maxLen);                   // adverse / averse, elicit / illicit
  else if (pre === 2) s += 0.5;
  if (kpre >= 3) s += 1.4 * (kpre / Math.max(ka.length, kb.length));
  if (suf >= 4) s += 0.9 * (suf / maxLen);                   // shared rhyme / word-ending
  if (a[0] === b[0]) s += 0.45;
  s -= 0.16 * Math.abs(a.length - b.length);                 // keep lengths comparable
  if (lev <= 2 && maxLen >= 5) s += 1.5;                     // near-twins are the best traps
  return s;
}

const CANDIDATES = 14;
let noneCount = 0;
for (let i = 0; i < words.length; i++) {
  const seen = new Set([i]);
  const pool = [];
  const s = words[i].w.replace(/[^a-z]/g, '');
  const bkeys = ['p3:' + s.slice(0, 3), 'p2:' + s.slice(0, 2), 's4:' + s.slice(-4),
    'k3:' + keys[i].slice(0, 3), 'k4:' + keys[i].slice(0, 4), 'L:' + s[0] + s.length];
  for (const k of bkeys) {
    for (const j of bucket.get(k) || []) {
      if (seen.has(j)) continue;
      seen.add(j);
      pool.push(j);
    }
  }
  const scored = [];
  for (const j of pool) {
    if (tooSimilarMeaning(i, j)) continue;
    scored.push([j, similarity(i, j)]);
  }
  scored.sort((a, b) => b[1] - a[1]);
  words[i].c = scored.slice(0, CANDIDATES).map((x) => x[0]);
  if (words[i].c.length < 3) noneCount++;
  if (i % 500 === 0) process.stdout.write(`\r  distractors ${i}/${words.length}`);
}
process.stdout.write(`\r  distractors ${words.length}/${words.length}\n`);
console.log(`  words with <3 confusables (runtime falls back to tier-mates): ${noneCount}`);

const out = {
  version: 1,
  built: new Date().toISOString().slice(0, 10),
  source: 'https://sites.google.com/site/sesamewords/home',
  tiers: SOURCES.map((s) => ({ t: s.tier, name: s.name })),
  words: words.map((w) => ({ i: w.i, w: w.w, g: w.g, d: w.d, t: w.t, l: w.l || null, r: w.r, x: w.x, c: w.c })),
};

writeFileSync(join(ROOT, 'data', 'words.json'), JSON.stringify(out));
console.log(`  wrote data/words.json (${(JSON.stringify(out).length / 1024).toFixed(0)} KB)`);

// sanity sample
console.log('\n  sample questions:');
for (const idx of [3, 40, 200, 700, 1200, 3000]) {
  const w = words[idx];
  if (!w) continue;
  const ds = w.c.slice(0, 3).map((j) => `${words[j].w} (${words[j].g})`);
  console.log(`   ${w.w} = "${w.g}"  |  traps: ${ds.join(' / ')}`);
}
