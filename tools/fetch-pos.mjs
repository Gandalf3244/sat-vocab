#!/usr/bin/env node
/**
 * fetch-pos.mjs — builds tools/pos-lexicon.json, the part-of-speech data that
 * build-words.mjs needs.
 *
 * Source is the Moby Part-of-Speech list (public domain) as republished in
 * en-wl/wordlist. That file is ~4 MB and most of it is irrelevant here, so we
 * keep only the words this project actually looks up: every headword in the
 * three frequency lists, plus the first word of every gloss.
 *
 * Only needs re-running if the word lists change.
 *
 *   node tools/fetch-pos.mjs
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = 'https://raw.githubusercontent.com/en-wl/wordlist/master/pos/part-of-speech.txt';
const CACHE = join(HERE, '.pos-raw.txt');

/* Moby codes -> the four categories this project cares about.
   N noun · p plural · h noun phrase · V/t/i verb · A adjective · v adverb   */
const CODE_MAP = {
  N: 'n', p: 'n', h: 'n',
  V: 'v', t: 'v', i: 'v',
  A: 'adj',
  v: 'adv',
};

async function raw() {
  if (existsSync(CACHE)) return readFileSync(CACHE, 'utf8');
  process.stdout.write('  downloading Moby POS list… ');
  const res = await fetch(SRC);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const text = await res.text();
  writeFileSync(CACHE, text);
  console.log(`${(text.length / 1e6).toFixed(1)} MB`);
  return text;
}

/** Every word we might ask about: headwords and gloss head words. */
function wantedWords() {
  const want = new Set();
  const words = JSON.parse(readFileSync(join(HERE, '..', 'data', 'words.json'), 'utf8')).words;
  for (const w of words) {
    want.add(w.w.toLowerCase());
    for (const tok of w.g.toLowerCase().split(/[^a-z]+/)) if (tok) want.add(tok);
  }
  return want;
}

const text = await raw();
const want = wantedWords();
const out = {};

for (const line of text.split('\n')) {
  const tab = line.indexOf('\t');
  if (tab < 1) continue;
  const word = line.slice(0, tab).toLowerCase();
  if (!want.has(word)) continue;
  const codes = line.slice(tab + 1).replace(/\|/g, '');
  const set = new Set();
  for (const ch of codes) if (CODE_MAP[ch]) set.add(CODE_MAP[ch]);
  if (!set.size) continue;
  const prev = out[word] || [];
  out[word] = [...new Set([...prev, ...set])].sort();
}

writeFileSync(join(HERE, 'pos-lexicon.json'), JSON.stringify(out));
console.log(`  wanted ${want.size} words, found ${Object.keys(out).length}`);
console.log(`  wrote tools/pos-lexicon.json (${(JSON.stringify(out).length / 1024).toFixed(0)} KB)`);
