/**
 * difficulty.mjs — how hard is this word, really?
 *
 * The old answer was "where does it sit in the source list", which is a
 * frequency ordering wearing a difficulty label. Frequency is the single best
 * predictor, but it is not the whole of it, and on its own it produces a ramp
 * that feels arbitrary: `obsequious` is not easier than `retract` because a
 * lesson page happened to list it earlier, and `visible` is not hard because it
 * landed in the mid-frequency band.
 *
 * So difficulty here is a small model over seven signals. Each is turned into a
 * percentile across the corpus before it is weighted, so the weights below mean
 * what they look like they mean and no signal can dominate through having a
 * wider natural range.
 *
 *   familiarity   1.00   blended Zipf, spoken + written. The backbone.
 *   family        0.35   `allege` is rare; `alleged` is not. Knowing a relative
 *                        is most of knowing the word.
 *   meaning       0.30   how common the words in the *definition* are. "servile"
 *                        is a harder thing to be told than "talkative".
 *   sense gap     0.15   common word, uncommon meaning — the sense being tested
 *                        is not the one you already know.
 *   look-alike    0.18   shadowed by a commoner near-twin, so you will misread
 *                        it rather than draw a blank.
 *   length        0.12   syllables, a mild independent cost.
 *   traps        0.10   how good this word's own wrong answers are. Difficulty
 *                        of the *item*, not just of the word.
 *   roots        -0.22   decomposes into a high-yield prefix + classical root,
 *                        so it can be reasoned out cold.
 *
 * The weighted sum is then percentile-ranked itself, so `x` is "harder than
 * this fraction of the corpus" — a flat 0..1 scale, which is what makes it
 * usable as a level to aim at rather than just an ordering.
 */

/* High-yield SAT roots and prefixes — the ones actually worth teaching, which
 * is the point: a word built from these is one a prepared student can attack
 * without ever having met it. */
const ROOTS = ('ambi amphi anthrop arch aud auto bell bene bibl bio brev cap capt carn ced ceed cess chron cid cis '
  + 'circum clam claim clud clus cogn corp cred cur curr curs dei dem dic dict duc duct dur ego equ fac fact fer fid '
  + 'fin flect flex flu fort fract frag gen grad gress grat greg hetero homo hydr ject jud junct jur lat leg lev loc '
  + 'locu loqu luc lud lum lus magn mal man mater matr mit miss mon mor mort mut nat nav neg nom nomen nov nunci ocul '
  + 'omni oper pac pand pass path ped pel puls pend pens phil phon plac plic pon pos port pot prehend prim prob punct '
  + 'pug quer quir quis rect reg rog rupt sacr sanct sci scrib script sect sed sequ secu serv sign simil sol solv '
  + 'somn son soph spec spect spir stru struct tac tang tact tempor ten tend tens term terr test therm tort tract '
  + 'trud trus turb urb vac vad val ven vent ver verb vert vers vid vis viv voc vok vol volv vor').split(' ');

const PREFIXES = ('ab ad ambi ana ante anti apo auto bene bi cata circum com con contra counter de demi dia dis dys '
  + 'ecto endo epi equi eu ex extra fore hemi hyper hypo inter intra intro macro mal micro mis mono multi neo non ob '
  + 'omni out over pan para per peri poly post pre pro proto pseudo quadri retro semi sub super supra sur syn sym '
  + 'trans tri ultra under uni').split(' ');

const STOP = new Set(('a an the of to or and in on for with by from as at is are be being been that this which who whom '
  + 'whose it its into out up down over under not no nor so than then very more most some any all each other another '
  + 'such own same one two something someone somebody thing things person people usually especially often sometimes etc').split(' '));

const NEUTRAL_Z = 2.6;   // stand-in for a word the corpora have nothing on

/** Vowel groups. Crude, but it only has to rank words against each other. */
function syllables(word) {
  const s = word.toLowerCase().replace(/[^a-z]/g, '');
  const groups = s.replace(/e$/, '').match(/[aeiouy]+/g);
  return Math.max(1, groups ? groups.length : 1);
}

/** Does the word visibly decompose? 0 = opaque, 1 = prefix *and* root. */
function transparency(word) {
  const s = word.toLowerCase().replace(/[^a-z]/g, '');
  if (s.length < 6) return 0;   // too short to have parts worth finding
  let score = 0;
  for (const p of PREFIXES) {
    if (s.startsWith(p) && s.length - p.length >= 4) { score += 0.4; break; }
  }
  for (const r of ROOTS) {
    if (s.includes(r) && s.length > r.length + 1) { score += 0.6; break; }
  }
  return score;
}

/**
 * Turn any array of numbers into percentiles in [0,1].
 *
 * Equal values must come out equal, which a plain positional rank does not
 * give: half the corpus has no look-alike at all, and spreading those zeroes
 * across 0..0.5 by array position would inject the exact kind of noise this
 * file exists to remove. Ties share the mean of the positions they span.
 */
function percentile(values) {
  const order = values.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const out = new Array(values.length);
  const last = Math.max(1, order.length - 1);
  for (let k = 0; k < order.length;) {
    let j = k;
    while (j + 1 < order.length && order[j + 1][0] === order[k][0]) j++;
    const shared = ((k + j) / 2) / last;
    for (let m = k; m <= j; m++) out[order[m][1]] = shared;
    k = j + 1;
  }
  return out;
}

const WEIGHTS = {
  familiar: 1.00,
  family: 0.35,
  meaning: 0.30,
  sense: 0.15,
  lookalike: 0.18,
  length: 0.12,
  traps: 0.10,
  roots: -0.22,
};

/**
 * @param {Array}  words  entries with .w and .g, in corpus order
 * @param {object} freq   tools/word-freq.json ({ z, fam, nb }), or {} to fall
 *                        back to word-shape signals alone
 * @param {object} opts   { traps: number[] } 0..1 per word, strength of its own
 *                        distractors — omit before distractors are computed
 * @returns {{ x:number[], z:number[], rank:number[], parts:object }}
 */
export function scoreDifficulty(words, freq = {}, { traps = null } = {}) {
  const z = freq.z || {};
  const famTable = freq.fam || {};
  const nbTable = freq.nb || {};
  const key = (w) => String(w).toLowerCase().replace(/[^a-z]/g, '');
  const zipfOf = (w) => {
    const v = z[key(w)];
    return v === undefined ? NEUTRAL_Z : v;
  };

  /* How familiar the *meaning* is: the average of its content words, pulled
   * toward the least familiar one. A definition is only as clear as its
   * murkiest word. */
  const glossZipf = (gloss) => {
    const toks = String(gloss).toLowerCase().split(/[^a-z]+/).filter((t) => t.length > 2 && !STOP.has(t));
    if (!toks.length) return NEUTRAL_Z;
    const zs = toks.map(zipfOf);
    const mean = zs.reduce((a, b) => a + b, 0) / zs.length;
    return 0.5 * mean + 0.5 * Math.min(...zs);
  };

  const wordZ = words.map((w) => zipfOf(w.w));
  const famZ = words.map((w, i) => Math.max(wordZ[i], famTable[key(w.w)] ?? wordZ[i]));
  const glossZ = words.map((w) => glossZipf(w.g));
  const nbGap = words.map((w) => nbTable[key(w.w)] || 0);
  const syl = words.map((w) => syllables(w.w));
  const roots = words.map((w) => transparency(w.w));
  // A common word with an uncommon meaning is being tested on a sense you do
  // not already have — "table a motion", not "a table".
  const senseGap = words.map((w, i) => Math.max(0, wordZ[i] - glossZ[i]));

  const p = {
    familiar: percentile(wordZ.map((v) => -v)),
    family: percentile(famZ.map((v) => -v)),
    meaning: percentile(glossZ.map((v) => -v)),
    sense: percentile(senseGap),
    lookalike: percentile(nbGap),
    length: percentile(syl),
    traps: traps ? percentile(traps) : null,
  };

  const raw = words.map((_, i) => {
    let s = 0;
    for (const [name, weight] of Object.entries(WEIGHTS)) {
      if (name === 'roots') { s += weight * roots[i]; continue; }
      const col = p[name];
      if (col) s += weight * col[i];
    }
    return s;
  });

  const x = percentile(raw).map((v) => Math.round(v * 1000) / 1000);

  // A true frequency ordering, 0 = the most ordinary word in the list. The old
  // `r` was the corpus index, which is tier order — not a frequency rank at all
  // despite being documented as one.
  const rank = new Array(words.length);
  wordZ.map((v, i) => [v, i]).sort((a, b) => b[0] - a[0]).forEach(([, i], k) => { rank[i] = k; });

  return { x, rank, parts: { wordZ, famZ, glossZ, nbGap, syl, roots, senseGap } };
}
