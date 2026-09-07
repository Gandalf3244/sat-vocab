#!/usr/bin/env node
/**
 * parse-sat1000.mjs — turns tools/sat1000-src/raw.txt (pdftotext -layout output
 * of the SparkNotes-style "1000 Most Common SAT Words" PDF) into structured
 * entries: { w, senses:[{p,g,d}], e }
 *
 * Entry shape in the source text:
 *   word (pos) definition, more definition (example sentence.)
 *   word 1. (pos) def one (ex one.) 2. (pos) def two (ex two.)
 *
 * Multi-line entries wrap with continuation lines indented and not starting a
 * new headword, so we first rejoin the whole file into logical paragraphs by
 * blank-line-separated blocks, then split blocks that contain multiple
 * entries glued together (rare, but the layout mode sometimes merges short
 * one-line entries onto the tail of the previous block).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
// pdftotext emitted a handful of accented letters as raw Latin-1 bytes inside
// an otherwise UTF-8 file (façade, soufflé, Gaudí, lamé, cliché) — normalize
// those specific bytes to their plain-ASCII equivalents before UTF-8 decoding
// so they don't turn into U+FFFD and swallow the entry.
const buf = readFileSync(join(HERE, 'sat1000-src', 'raw.txt'));
for (let i = 0; i < buf.length; i++) {
  if (buf[i] === 0xe7) buf[i] = 0x63;       // ç -> c
  else if (buf[i] === 0xe9) buf[i] = 0x65;  // é -> e
  else if (buf[i] === 0xed) buf[i] = 0x69;  // í -> i
}
const raw = buf.toString('utf8');

// Drop page furniture: header/footer lines, page-break artifacts, bare letter
// section headers (A, B, C, ...), and the title block at the very top.
const lines = raw.split('\n')
  .map((l) => l.trim())
  .filter((l) => l && l !== 'SAT Vocabulary' && !/^[A-Z]$/.test(l) && !/^SAT Vocabulary\s+[A-Z]$/.test(l))
  .filter((l) => !/^The 1000 Most$/.test(l) && !/^Common SAT$/.test(l) && !/^Words$/.test(l));

const text = lines.join(' ').replace(/\s+/g, ' ');

// A headword starts a new entry: lowercase word(s), then either "(pos)" or a
// leading sense number "1.". Word may contain a space (very rare) or hyphen.
const HEAD = /(?<![a-zçé])([a-zçé][a-zçé'’\-]{1,22}?)\s+(?:(\d)\.\s+)?\(((?:v|n|adj|adv)\.)\)/g;

const matches = [...text.matchAll(HEAD)];
const entries = [];
for (let i = 0; i < matches.length; i++) {
  const m = matches[i];
  const word = m[1].trim().toLowerCase();
  if (!/^[a-z][a-z'’\-]*$/.test(word)) continue;

  const senseNum = m[2] ? Number(m[2]) : 1;
  const pos = m[3].replace('.', '');
  const start = m.index + m[0].length;
  const end = i + 1 < matches.length ? matches[i + 1].index : text.length;
  let body = text.slice(start, end).trim();
  // Strip a trailing new headword's own leading fragments if the boundary was
  // imprecise (shouldn't normally happen given the regex, kept defensive).
  entries.push({ word, senseNum, pos, body });
}

// Group consecutive senses of the same word (word repeats with senseNum 2,3..)
const byWord = new Map();
for (const e of entries) {
  if (!byWord.has(e.word)) byWord.set(e.word, []);
  byWord.get(e.word).push(e);
}

function splitDefAndExample(body) {
  // definition text runs up to the first "(" that opens the example, but
  // examples can contain nested parens, so find the matching close for the
  // LAST top-level "(...)" group, i.e. from the first "(" to end, balancing.
  const firstParen = body.indexOf('(');
  if (firstParen === -1) return { def: body.trim(), example: '' };
  const def = body.slice(0, firstParen).trim().replace(/[,;]\s*$/, '');
  let depth = 0, exStart = -1, exEnd = -1;
  for (let i = firstParen; i < body.length; i++) {
    if (body[i] === '(') { if (depth === 0) exStart = i + 1; depth++; }
    else if (body[i] === ')') { depth--; if (depth === 0) { exEnd = i; break; } }
  }
  const example = exStart >= 0 && exEnd > exStart ? body.slice(exStart, exEnd).trim() : '';
  return { def, example };
}

const parsed = [];
for (const [word, list] of byWord) {
  // Use only the first sense — the app's data model is one gloss/def per word.
  const first = list[0];
  const { def, example } = splitDefAndExample(first.body);
  if (!def) continue;
  parsed.push({ w: word, p: first.pos, d: def, e: example });
}

writeFileSync(join(HERE, 'sat1000-src', 'parsed.json'), JSON.stringify(parsed, null, 2));
console.log(`parsed ${parsed.length} unique headwords (${entries.length} raw sense-entries)`);

// Sanity spot-check
for (const w of ['abase', 'aberration', 'abide', 'zealous', 'zephyr', 'quixotic']) {
  const e = parsed.find((p) => p.w === w);
  console.log(w, '=>', e ? JSON.stringify(e) : 'MISSING');
}
