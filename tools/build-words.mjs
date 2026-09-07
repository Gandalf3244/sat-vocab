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

/* Real part-of-speech data (Moby, public domain) trimmed by tools/fetch-pos.mjs.
   Heuristics on suffixes only got ~77% of these right, and a grammatically odd
   answer choice is exactly what lets someone guess without knowing the word. */
let POS_LEXICON = {};
try {
  POS_LEXICON = JSON.parse(readFileSync(join(HERE, 'pos-lexicon.json'), 'utf8'));
} catch {
  console.warn('  ! tools/pos-lexicon.json missing — run: node tools/fetch-pos.mjs');
}

/* Mutual synonym links (Moby Thesaurus, public domain) from
   tools/fetch-thesaurus.mjs. Catches pairs whose definitions look unrelated but
   whose glosses mean the same thing — broadcast / distribute. */
let SYNONYMS = {};
try {
  SYNONYMS = JSON.parse(readFileSync(join(HERE, 'synonyms.json'), 'utf8'));
} catch {
  console.warn('  ! tools/synonyms.json missing — run: node tools/fetch-thesaurus.mjs');
}

const synLink = (a, b) => {
  if (!a || !b || a === b) return false;
  return (SYNONYMS[a] || []).includes(b) || (SYNONYMS[b] || []).includes(a);
};

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
    const rawG = gloss;
    gloss = cleanGloss(gloss);
    def = def.replace(/\s+/g, ' ').trim();
    if (!word || !gloss) continue;
    if (word.split(' ').length > 3) continue;
    out.push({ w: word, g: gloss, d: def || gloss, t: tier, l: lesson, rawG });
  }
  return out;
}

function cleanGloss(g) {
  return g
    .replace(/^\((?:psychology|chemistry|physics|law|medicine|biology|music|sports?)\)\s*/i, '')
    .replace(/^(?:a|an|the)\s+/i, '')
    .replace(/\s*\(.*?\)\s*/g, ' ')
    .replace(/,.*$/, '')      // "excessive, sickening" -> "excessive"
    .replace(/\s+or\s+.*$/, '')
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

const SUFFIXES = ['iveness', 'ization', 'ability', 'ically', 'ousness', 'fulness', 'ations', 'ement', 'ances', 'ences', 'ities', 'ingly', 'ional', 'ative', 'itive', 'ation', 'ition', 'ously', 'ivity', 'ility', 'ments', 'ising', 'izing', 'ance', 'ence', 'ment', 'ness', 'less', 'ible', 'able', 'tion', 'sion', 'ious', 'eous', 'ical', 'ally', 'ised', 'ized', 'ises', 'izes', 'ing', 'ers', 'ors', 'ive', 'ify', 'ity', 'ism', 'ist', 'ous', 'ish', 'ary', 'ory', 'ate', 'ent', 'ant', 'age', 'ful', 'ial', 'ian', 'ic', 'al', 'ly', 'ed', 'es', 'er', 'or', 'ee', 'y', 's'];

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

/** True when one set's stem is contained in the other's — "selfish" vs "self". */
function stemsNest(a, b) {
  for (const x of a) {
    if (x.length < 4) continue;
    for (const y of b) {
      if (y.length < 4) continue;
      if (x === y || x.startsWith(y) || y.startsWith(x)) return true;
    }
  }
  return false;
}

/* ------------------------------------------------------ part of speech --- */

/**
 * Coarse part of speech. The definitions are WordNet-shaped, so their opening
 * words are a strong signal ("marked by…" is an adjective, "a person who…" is
 * a noun, "cause to…" is a verb); the word's own suffix breaks ties.
 *
 * This matters more than anything else for question quality: four choices that
 * are all the same part of speech cannot be narrowed down by grammar alone.
 */
const VERB_STARTS = new Set(('make making cause causing be become becoming give giving take taking put putting move moving '
  + 'bring bringing come go change changing provide keep hold holding express show showing cut form have remove removing '
  + 'place set get let send carry draw turn use work deal act look pass run strike break fill feel find leave lose win '
  + 'say speak tell think treat urge stop start begin end reduce increase raise lower affect force allow enable prevent '
  + 'supply throw touch travel transfer transform grant gather join separate spread strip support surround '
  + 'reject refuse deny accept admit declare assert claim argue insist demand request ask answer reply respond '
  + 'destroy damage harm hurt injure kill ruin spoil weaken strengthen improve worsen restore repair rebuild '
  + 'praise blame criticize condemn accuse charge punish forgive pardon release free capture seize grab hold '
  + 'hide conceal reveal disclose expose uncover discover detect notice observe perceive sense recognize '
  + 'gain earn obtain acquire receive collect gather assemble build construct create produce generate '
  + 'reduce shrink expand enlarge extend stretch shorten cut divide split merge combine unite attach '
  + 'follow lead guide direct control manage govern rule command order instruct teach learn study '
  + 'walk march climb jump fall rise sink float drift wander roam chase pursue flee escape avoid '
  + 'eat drink swallow chew bite consume devour digest breathe sleep wake rest relax worry fear dread '
  + 'love hate like dislike enjoy prefer choose select pick decide determine settle resolve solve '
  + 'begin cease quit abandon desert leave depart arrive enter exit approach retreat withdraw '
  + 'behave treat handle deal cope manage struggle strive attempt try seek search hunt explore '
  + 'disavow renounce revoke repeal cancel annul nullify negate contradict oppose resist defy '
  + 'soothe calm comfort console encourage inspire motivate persuade convince influence sway '
  + 'mock ridicule tease taunt insult offend annoy irritate provoke anger enrage soothe '
  + 'wander squander waste spend save hoard store keep preserve maintain sustain').split(/\s+/).filter(Boolean));
const NOUN_STARTS = new Set('a an the any someone something one anything people person group amount number part piece unit member instance period process property trait feeling quality state condition act action activity ability lack absence.'.split(' '));
const ADJ_STARTS = new Set('not marked having characterized lacking showing capable relating being without incapable so tending used made done free full able unable possessing exhibiting affected filled covered devoid worthy deserving likely inclined disposed given suggestive resembling pertaining belonging conforming consisting composed unwilling willing easily difficult hard impossible possible extremely very somewhat slightly.'.split(' '));

const NOUN_SUF = /(tion|sion|ment|ness|ity|ance|ence|ism|ist|ship|hood|dom|ery|cy|tude|acy)$/;
// -ish is absent (embellish, furnish, diminish are verbs); so are -ine/-ile/-id
// (discipline, medicine, missile are nouns).
const ADJ_SUF = /(ous|ful|ive|able|ible|ical|ic|less)$/;
const ADJ_SUF_WEAK = /(ant|ent|ory|ary|y)$/;
const VERB_SUF = /(ify|ize|ise|ate|en)$/;

function inferPos(word, gloss, def, rawGloss) {
  const score = { v: 0, n: 0, adj: 0, adv: 0 };
  const w = word.toLowerCase().replace(/[^a-z]/g, '');
  const d = (def || '').toLowerCase();
  const toks = d.split(/[^a-z(]+/).filter(Boolean);

  /* ---- 1. the definition's opening, which is the strongest signal ------- */
  if (d.startsWith('(of ') || d.startsWith('of or ') || /^of or (relating|pertaining)/.test(d)) score.adj += 4;

  const lead = toks[0] || '';
  const leadIsAdverb = /ly$/.test(lead) && lead.length > 4;
  // "unpleasantly harsh", "humorously vulgar", "extremely wicked" — an adverb
  // opening a definition modifies an adjective far more often than a verb.
  let k = 0;
  if (leadIsAdverb && !VERB_STARTS.has(toks[1] || '')) { score.adj += 3; k = 1; }
  else if (leadIsAdverb) k = 1;

  const first = toks[k] || '';
  if (VERB_STARTS.has(first)) score.v += 3.2;
  if (NOUN_STARTS.has(first)) score.n += 3.2;
  if (ADJ_STARTS.has(first)) score.adj += 3.2;
  if (/^(impossible|difficult|easy|hard|possible|unable|able|likely|unlikely|quick|slow)$/.test(first)) score.adj += 2.6;
  if (/^in an? \w+ (manner|way)/.test(d)) score.adv += 4;

  // Two bare verbs joined by or/and — but only when the first is a known verb,
  // otherwise "harsh or grating" reads as a verb pair when it is adjectival.
  if (VERB_STARTS.has(first) && (toks[k + 1] === 'or' || toks[k + 1] === 'and')) score.v += 1.0;

  /* ---- 2. the gloss ----------------------------------------------------- */
  const rg = (rawGloss || '').toLowerCase().trim();
  if (/^to\s/.test(rg)) score.v += 2.5;
  if (/^(a|an|the)\s/.test(rg)) score.n += 2.0;

  const g = (gloss || '').trim();
  // "take back", "pull out", "cover up" — a verb plus a particle.
  if (/^\w+ (up|down|out|off|back|over|away|through|apart|aside|along|forward)$/.test(g)) score.v += 2.6;

  // The gloss's own head word is usually a common word whose suffix is honest.
  const head = g.split(/\s+/)[0] || '';
  if (ADJ_SUF.test(head)) score.adj += 1.2;
  if (NOUN_SUF.test(head)) score.n += 1.2;
  if (/(ify|ize|ise)$/.test(head)) score.v += 1.2;

  /* ---- 3. the target word's own shape ----------------------------------- */
  if (/ly$/.test(w) && w.length > 4) score.adv += 2.0;
  if (NOUN_SUF.test(w)) score.n += 1.8;
  if (ADJ_SUF.test(w)) score.adj += 1.6;
  if (ADJ_SUF_WEAK.test(w)) score.adj += 0.5;
  if (/(ify|ize|ise)$/.test(w)) score.v += 1.8;
  if (/(ate|en)$/.test(w) && !NOUN_SUF.test(w)) score.v += 0.7;

  return score;
}

/**
 * The lexicon says which parts of speech a word *can* be; the definition's
 * wording decides which one this entry actually is. Falls back to the
 * definition alone for the ~1.4% of words the lexicon does not carry.
 */
function resolvePos(word, gloss, def, rawGloss) {
  const evidence = inferPos(word, gloss, def, rawGloss);
  const allowed = POS_LEXICON[word.toLowerCase()];
  let options = allowed && allowed.length ? allowed : ['v', 'n', 'adj', 'adv'];

  // The displayed answer is the gloss, so its part of speech has to agree.
  // "dovetail" is both noun and verb, but its gloss "interconnect" is a verb;
  // labelling the entry a noun would surround the answer with nouns and leave
  // it as the one odd item on the list.
  // Only for one-word glosses: in "selfish person" the first word is not the
  // head of the phrase, and trusting it would call egotist an adjective.
  const parts = (gloss || '').toLowerCase().split(/[^a-z]+/).filter(Boolean);
  if (parts.length === 1) {
    const headPos = POS_LEXICON[parts[0]];
    if (headPos && headPos.length) {
      const both = options.filter((o) => headPos.includes(o));
      options = both.length ? both : headPos;   // trust the visible text
    }
  }
  let best = options[0], bestVal = -Infinity;
  for (const key of options) {
    const v = evidence[key] ?? 0;
    if (v > bestVal) { best = key; bestVal = v; }
  }
  return best;
}

/** Surface shape of the answer text, so four choices read as one set. */
function glossClass(g) {
  const parts = g.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 1) {
    if (/ly$/.test(parts[0]) && parts[0].length > 4) return '1ly';
    if (/ing$/.test(parts[0])) return '1ing';
    return '1';
  }
  return 'n';
}

/* ------------------------------------------------- shape of the meaning --- */

/**
 * How specific / concrete an answer text reads. "harmless" is abstract and
 * blends into a list of adjectives; "residence of a recluse" announces itself
 * as a thing and can be discarded on sight. Wrong answers must not announce
 * themselves.
 */
const CONCRETE_NOUNS = /\b(person|man|woman|priest|prelate|king|queen|poem|song|verse|composition|music|bird|plant|tree|flower|animal|insect|fish|building|room|house|residence|instrument|device|machine|tool|weapon|city|state|country|capital|book|god|soldier|ship|boat|vehicle|cloth|garment|food|drink|metal|stone|paper|body|blood|skin|bone|disease)\b/;

function concreteness(gloss) {
  const words = gloss.trim().split(/\s+/).filter(Boolean);
  let c = 0;
  if (words.length >= 4) c += 1.0;
  else if (words.length === 3) c += 0.35;
  if (/\b(of|who|that|which|for)\b/.test(gloss)) c += 0.8;
  if (CONCRETE_NOUNS.test(gloss)) c += 1.6;
  return c;
}

const glossWordCount = (g) => g.trim().split(/\s+/).filter(Boolean).length;

/* --------------------------------------------------- semantic distance --- */

/**
 * TF-IDF over each entry's own gloss + definition, compared with cosine.
 * Used as a band, not a maximum: a wrong answer should sit near enough to the
 * target to be believable, but never so near that it is arguably also correct.
 */
function buildVectors(docs) {
  const df = new Map();
  const tokenised = docs.map((text) => {
    const tf = new Map();
    for (const raw of text.toLowerCase().split(/[^a-z]+/)) {
      if (raw.length < 3 || STOP.has(raw)) continue;
      const t = stem(raw);
      tf.set(t, (tf.get(t) || 0) + 1);
    }
    for (const t of tf.keys()) df.set(t, (df.get(t) || 0) + 1);
    return tf;
  });

  const N = docs.length;
  const vectors = tokenised.map((tf) => {
    const v = new Map();
    let norm = 0;
    for (const [t, n] of tf) {
      const idf = Math.log(N / (1 + (df.get(t) || 0)));
      if (idf <= 0) continue;
      const w = (1 + Math.log(n)) * idf;
      v.set(t, w);
      norm += w * w;
    }
    norm = Math.sqrt(norm) || 1;
    for (const [t, w] of v) v.set(t, w / norm);
    return v;
  });

  // Inverted index so we only compare documents that share a term.
  const inverted = new Map();
  vectors.forEach((v, i) => {
    for (const t of v.keys()) {
      let arr = inverted.get(t);
      if (!arr) inverted.set(t, (arr = []));
      arr.push(i);
    }
  });
  return { vectors, inverted };
}

function cosine(a, b) {
  const [small, big] = a.size < b.size ? [a, b] : [b, a];
  let dot = 0;
  for (const [t, w] of small) {
    const o = big.get(t);
    if (o) dot += w * o;
  }
  return dot;
}

/* ------------------------------------------------------------------ main */

const raw = [];
for (const src of SOURCES) {
  const html = readFileSync(join(HERE, src.file), 'utf8');
  const rows = parsePage(html, src.tier);
  console.log(`  ${src.name}: parsed ${rows.length}`);
  raw.push(...rows);
}

/* Extra words merged in later (e.g. tools/build-sat1000-extra.mjs), already
 * shaped like a parsePage() row and pre-tiered by real usage frequency. Any
 * word already covered by SOURCES above wins on dedup below regardless of
 * this file's tier, since it is ordered first in `raw`. */
try {
  const extra = JSON.parse(readFileSync(join(HERE, 'sat1000-extra.json'), 'utf8'));
  console.log(`  Extra (SAT 1000 list): ${extra.length}`);
  raw.push(...extra);
} catch {
  console.log('  Extra (SAT 1000 list): none found (tools/sat1000-extra.json)');
}

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

/* part of speech */
for (const w of words) w.p = resolvePos(w.w, w.g, w.d, w.rawG);
const posCount = words.reduce((m, w) => { m[w.p] = (m[w.p] || 0) + 1; return m; }, {});
console.log(`  parts of speech: ${Object.entries(posCount).map(([k, v]) => `${k} ${v}`).join(', ')}`);

/* ------------------------------------------------ confusable distractors */

const keys = words.map((w) => phoneticKey(w.w));
const meanings = words.map((w) => contentWords(`${w.g} ${w.d}`));
const glossSets = words.map((w) => contentWords(w.g));
const stems = words.map((w) => stem(w.w));
const glossNorm = words.map((w) => w.g.replace(/[^a-z ]/g, '').trim());
const conc = words.map((w) => concreteness(w.g));
const gclass = words.map((w) => glossClass(w.g));
const defStems = words.map((w) => contentWords(`${w.g} ${w.d}`));
const glossHead = words.map((w) => (w.g.toLowerCase().split(/[^a-z]+/).filter(Boolean)[0] || ''));

/* For multi-word glosses, the opening word sets the register: "having …",
   "tending to …", "impossible to …". Matching it keeps the four choices
   parallel instead of one of them announcing itself. */
const LEAD_FAMILY = (g) => {
  const first = (g.trim().split(/\s+/)[0] || '').toLowerCase();
  if (/^(having|lacking|showing|tending|related|marked|characterized|containing|causing|resembling|involving)$/.test(first)) return 'participle';
  if (/^(impossible|possible|able|unable|easy|hard|difficult|likely|unlikely|acceptable|willing|ready)$/.test(first)) return 'adjTo';
  if (/^(one|someone|person|state|act|quality|feeling)$/.test(first)) return 'nounish';
  return 'plain';
};
const lead = words.map((w) => LEAD_FAMILY(w.g));

/* The choice a student reads is the gloss, not the headword. "reciprocal" is an
   adjective, but its gloss "exchange" reads as a noun — offered among
   adjectives it stands out and can be crossed off without knowing anything. So
   the gloss's own part of speech has to fit too. */
const glossPos = words.map((w, i) => {
  const parts = w.g.toLowerCase().split(/[^a-z]+/).filter(Boolean);
  if (!parts.length) return null;
  if (parts.length === 1) return POS_LEXICON[parts[0]] || null;
  // In a plain phrase the last word is the syntactic head: "selfish person" is
  // a noun, "walk pompously" is a verb. Phrases opening with "having…" or
  // "impossible to…" are adjectival regardless of how they end, so those are
  // judged by their opening instead (see the lead-family filter).
  return LEAD_FAMILY(w.g) === 'plain' ? (POS_LEXICON[parts[parts.length - 1]] || null) : null;
});

const gwc = words.map((w) => glossWordCount(w.g));

const { vectors, inverted } = buildVectors(words.map((w) => `${w.g} ${w.d}`));

// Blocking buckets for the look-alike half of the candidate pool.
const bucket = new Map();
const pushBucket = (k, i) => {
  if (!k) return;
  let a = bucket.get(k);
  if (!a) bucket.set(k, (a = []));
  a.push(i);
};
words.forEach((w, i) => {
  const s = w.w.replace(/[^a-z]/g, '');
  pushBucket('p3:' + s.slice(0, 3), i);
  pushBucket('p2:' + s.slice(0, 2), i);
  pushBucket('s4:' + s.slice(-4), i);
  pushBucket('k3:' + keys[i].slice(0, 3), i);
  pushBucket('k4:' + keys[i].slice(0, 4), i);
});

const byPos = new Map();
words.forEach((w, i) => {
  let arr = byPos.get(w.p);
  if (!arr) byPos.set(w.p, (arr = []));
  arr.push(i);
});

const SYN_COSINE_MAX = 0.30;

/* An "oddness" score per gloss: the mean rarity of its content words. Glosses
 * like "having muted rainbow colors" score high and are conspicuous in a list
 * of four; "harmless" scores low and blends in. */
const oddness = words.map((w, i) => {
  const v = vectors[i];
  const g = contentWords(w.g);
  let sum = 0, n = 0;
  for (const t of g) { const x = v.get(t); if (x !== undefined) { sum += x; n += 1; } }
  return n ? sum / n : 0;
});

/** Would offering `j` as a wrong answer for `i` be unfair — i.e. also right? */
function tooSimilarMeaning(i, j) {
  if (glossNorm[i] === glossNorm[j]) return true;
  if (stems[i] === stems[j] && stems[i].length >= 4) return true;
  const g1 = words[i].g, g2 = words[j].g;
  if (g1.includes(g2) || g2.includes(g1)) return true;
  if (jaccard(glossSets[i], glossSets[j]) >= 0.30) return true;
  if (stemsNest(glossSets[i], glossSets[j])) return true;
  const overlap = jaccard(meanings[i], meanings[j]);
  if (overlap >= 0.26) return true;
  const a = words[i].w.replace(/[^a-z]/g, ''), b = words[j].w.replace(/[^a-z]/g, '');
  if (commonPrefix(a, b) >= 6 && overlap >= 0.10) return true;
  // If one entry's own definition uses the other's gloss word, they are being
  // defined in terms of each other.
  if (definesEachOther(i, j) || definesEachOther(j, i)) return true;
  // Thesaurus check on what is actually displayed, plus on the headwords.
  const gi = words[i].g.toLowerCase().trim(), gj = words[j].g.toLowerCase().trim();
  if (synLink(gi, gj)) return true;
  if (synLink(glossHead[i], glossHead[j])) return true;
  if (synLink(words[i].w, gj) || synLink(words[j].w, gi)) return true;
  if (synLink(words[i].w, words[j].w)) return true;
  return false;
}

/** Does i's gloss+definition contain the head word of j's gloss? */
function definesEachOther(i, j) {
  const head = stem(words[j].g.split(/\s+/)[0] || '');
  if (head.length < 4) return false;
  return defStems[i].has(head);
}

/** Sound/look-alike bonus, kept because retract/detract really is a good trap. */
function rootConfusion(i, j) {
  const a = words[i].w.replace(/[^a-z]/g, '');
  const b = words[j].w.replace(/[^a-z]/g, '');
  const maxLen = Math.max(a.length, b.length);
  if (!maxLen) return 0;
  const lev = levenshtein(a, b);
  const edit = 1 - lev / maxLen;
  const ka = keys[i], kb = keys[j];
  const kEdit = ka && kb ? 1 - levenshtein(ka, kb) / Math.max(ka.length, kb.length) : 0;
  const pre = commonPrefix(a, b);
  const suf = commonSuffix(a, b);
  let s = 0.55 * edit + 0.35 * kEdit;
  if (pre >= 3) s += 0.35;
  if (suf >= 4) s += 0.2;
  return Math.min(1, s);
}

/**
 * How good a wrong answer `j` makes for `i`.
 * Shape and register dominate: the four choices must look like they were
 * written by the same hand, so that only knowing the word separates them.
 */
function distractorScore(i, j, sim) {
  const shape = 1 - Math.min(1, Math.abs(gwc[i] - gwc[j]) / 2);
  const register = 1 - Math.min(1, Math.abs(conc[i] - conc[j]) / 1.5);
  const root = rootConfusion(i, j);
  // A trap should feel plausible, not just parallel in shape. tooSimilarMeaning
  // (a hard filter, unaffected by this score) still throws out anything close
  // enough to be arguably also correct — so within the surviving candidates,
  // sitting nearer the target's sense makes an option harder to rule out on
  // "clearly unrelated" grounds alone, and is rewarded rather than punished.
  const odd = Math.max(0, oddness[j] - oddness[i]);
  const familyMatch = gclass[i] === '1' ? 1 : (lead[i] === lead[j] ? 1 : 0);
  return 1.6 * familyMatch
    + 2.6 * shape
    + 1.2 * register
    + 1.3 * root                       // look/sound-alikes are the classic hard trap
    + 1.1 * Math.min(sim, 0.22)        // reward closeness up to the fairness ceiling
    - 1.0 * Math.max(0, sim - 0.16)    // only rein in the very closest survivors
    - 1.3 * conc[j]                    // never offer a conspicuously specific answer
    - 3.4 * odd                        // nor one built from conspicuously rare words
    - (gwc[j] > 4 ? 1.5 : 0);
}

const CANDIDATES = 16;
let thin = 0;

for (let i = 0; i < words.length; i++) {
  const pool = new Set();

  // 1. semantically nearby entries, via the inverted index
  const sims = new Map();
  const vi = vectors[i];
  const terms = [...vi.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  for (const [t] of terms) {
    for (const j of inverted.get(t) || []) {
      if (j === i || sims.has(j)) continue;
      sims.set(j, cosine(vi, vectors[j]));
    }
  }
  [...sims.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 90)
    .forEach(([j]) => pool.add(j));

  // 2. look-alikes and sound-alikes
  const s = words[i].w.replace(/[^a-z]/g, '');
  for (const k of ['p3:' + s.slice(0, 3), 'p2:' + s.slice(0, 2), 's4:' + s.slice(-4),
    'k3:' + keys[i].slice(0, 3), 'k4:' + keys[i].slice(0, 4)]) {
    for (const j of bucket.get(k) || []) if (j !== i) pool.add(j);
  }

  // 3. same part of speech and same gloss length, for shape-matched filler
  const samePos = byPos.get(words[i].p) || [];
  for (let n = 0, guard = 0; n < 70 && guard < 400; guard++) {
    const j = samePos[Math.floor(Math.random() * samePos.length)];
    if (j === undefined || j === i) continue;
    if (gwc[j] !== gwc[i] || gclass[j] !== gclass[i]) continue;
    if (!pool.has(j)) { pool.add(j); n++; }
  }

  const scored = [];
  for (const j of pool) {
    if (words[j].p !== words[i].p) continue;            // hard: same part of speech
    if (gclass[j] !== gclass[i]) continue;              // hard: same surface shape
    if (glossPos[j] && !glossPos[j].includes(words[i].p)) continue;  // hard: the text must read that way
    // Multi-word answers must share their opening register too, or a noun
    // phrase ("false and malicious statement") lands among adjective phrases.
    if (gclass[i] !== '1' && lead[i] !== lead[j]) continue;
    if (tooSimilarMeaning(i, j)) continue;
    const sim = sims.has(j) ? sims.get(j) : cosine(vi, vectors[j]);
    if (sim > SYN_COSINE_MAX) continue;
    scored.push([j, distractorScore(i, j, sim)]);
  }
  scored.sort((a, b) => b[1] - a[1]);

  // Greedy pick, rejecting anything that clashes with a candidate already
  // taken. Every stored candidate is therefore pairwise distinct in meaning,
  // so whichever three the app draws at runtime cannot include two options
  // that say the same thing.
  const chosen = [];
  const takenText = new Set([glossNorm[i]]);
  for (const [j] of scored) {
    if (takenText.has(glossNorm[j])) continue;
    let clashes = false;
    for (const k of chosen) {
      if (tooSimilarMeaning(k, j) || cosine(vectors[k], vectors[j]) > SYN_COSINE_MAX) { clashes = true; break; }
    }
    if (clashes) continue;
    takenText.add(glossNorm[j]);
    chosen.push(j);
    if (chosen.length >= CANDIDATES) break;
  }
  words[i].c = chosen;
  if (words[i].c.length < 3) thin++;
  if (i % 250 === 0) process.stdout.write(`\r  distractors ${i}/${words.length}`);
}
process.stdout.write(`\r  distractors ${words.length}/${words.length}\n`);
console.log(`  words with <3 usable distractors (runtime falls back): ${thin}`);

/* ------------------------------------------------------ example sentences */

let examples = {};
try {
  examples = JSON.parse(readFileSync(join(HERE, 'examples.json'), 'utf8'));
  console.log(`  example sentences: ${Object.keys(examples).length}`);
} catch {
  console.log('  example sentences: none found (tools/examples.json)');
}

const out = {
  version: 2,
  built: new Date().toISOString().slice(0, 10),
  source: 'https://sites.google.com/site/sesamewords/home',
  tiers: SOURCES.map((s) => ({ t: s.tier, name: s.name })),
  words: words.map((w) => {
    const row = { i: w.i, w: w.w, g: w.g, d: w.d, t: w.t, l: w.l || null, r: w.r, x: w.x, p: w.p, c: w.c };
    if (examples[w.w]) row.e = examples[w.w];
    return row;
  }),
};

writeFileSync(join(ROOT, 'data', 'words.json'), JSON.stringify(out));
console.log(`  wrote data/words.json (${(JSON.stringify(out).length / 1024).toFixed(0)} KB)`);

const withExamples = out.words.filter((w) => w.e).length;
console.log(`  words carrying an example sentence: ${withExamples}`);

console.log('\n  sample questions:');
const show = ['benign', 'retract', 'embellish', 'apprehension', 'preclude', 'palatable', 'disseminate'];
const index = Object.fromEntries(words.map((w) => [w.w, w]));
for (const name of show) {
  const w = index[name];
  if (!w) continue;
  const opts = w.c.slice(0, 3).map((j) => words[j].g);
  console.log(`   ${w.w} [${w.p}]`);
  console.log(`      ${[w.g, ...opts].join('  /  ')}`);
}
