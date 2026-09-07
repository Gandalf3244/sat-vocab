/**
 * ability.js — one number for "how hard should this session be".
 *
 * data/words.json gives every word a difficulty `x` in 0..1 (a percentile over
 * the whole corpus — see tools/difficulty.mjs). That is a property of the word.
 * What the planner actually needs is a property of the *user*: the difficulty
 * at which they are currently a coin-flip. Call it their level, θ.
 *
 * With both on the same scale, two questions that used to be guesswork become
 * arithmetic:
 *
 *   · which unseen words should be introduced next?  the ones near θ — not
 *     simply the most common ones left. If a student is beating everything in
 *     the top-frequency band, the next word should be a hard one, wherever in
 *     the list it happens to live.
 *   · how hard will this item feel to them?  their own record on it, expressed
 *     on the same 0..1 scale, so a rare word they know well sorts before a
 *     common word they keep missing.
 *
 * θ is fitted fresh from the progress record each time rather than stored. It
 * is a summary of the data, so there is nothing to migrate, nothing to merge
 * between devices, and no way for it to drift out of step with what the answers
 * actually say.
 *
 * The model is one-parameter logistic (Rasch):  P(correct) = σ((θ − x) / SPREAD)
 */

/** How wide the transition from "gets it" to "does not" is, in x units. */
export const SPREAD = 0.17;

/** Where a user with no history is assumed to sit. */
const PRIOR_LEVEL = 0.18;
/** Strength of that assumption, in answers. Weak — it is gone within a session. */
const PRIOR_WEIGHT = 4;

/** Repeated answers on one word are not independent evidence; cap their say. */
const MAX_TRIALS_PER_WORD = 6;
/** Half-life-ish decay so an estimate follows the user rather than their past. */
const RECENCY_DAYS = 60;
const RECENCY_FLOOR = 0.35;

/**
 * θ may not exceed the hardest word actually answered correctly by more than
 * this. Without it, a run of correct answers on easy words has a likelihood
 * that just keeps rising, and the planner would leap to material the user has
 * shown nothing about. With it, the level climbs by a bounded step each time
 * the ceiling is raised — which is the ramp across sessions.
 */
const REACH = 0.20;

/** Success rate to aim for when choosing brand-new words. */
const NEW_TARGET = 0.60;
/** Meeting a word cold is harder than meeting it again, whatever its x says. */
const NEW_COST = 0.10;

const DAY = 86400000;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const sigmoid = (v) => 1 / (1 + Math.exp(-v));

/** Chance this user answers a word of difficulty `x` correctly. */
export const chance = (theta, x) => sigmoid((theta - x) / SPREAD);

/** The difficulty at which this user would score `p`. Inverse of `chance`. */
export const levelFor = (theta, p) => theta - SPREAD * Math.log(clamp(p, 0.02, 0.98) / (1 - clamp(p, 0.02, 0.98)));

/** Where new material should be introduced for this user. */
export const newWordLevel = (theta) => clamp(levelFor(theta, NEW_TARGET), 0, 1);

/**
 * Fit θ to the whole progress record.
 *
 * The log-likelihood's derivative in θ is Σ w·(k − n·σ), which is monotonically
 * decreasing, so a bisection finds the maximum without any tuning. ~40 passes
 * over the seen words; a few milliseconds on a phone with thousands of them.
 *
 * @returns {{ theta:number, answers:number, words:number, ceiling:number }}
 */
export function fitAbility(words, progress, { now = Date.now() } = {}) {
  const obs = [];
  let answers = 0;
  let ceiling = 0;
  for (const w of words) {
    const rec = progress[w.i];
    if (!rec || !rec.n) continue;
    const n = Math.min(rec.n, MAX_TRIALS_PER_WORD);
    const k = rec.n ? (rec.k / rec.n) * n : 0;
    const ageDays = Math.max(0, (now - (rec.ls || now)) / DAY);
    const weight = RECENCY_FLOOR + (1 - RECENCY_FLOOR) * Math.exp(-ageDays / RECENCY_DAYS);
    obs.push({ x: w.x, n, k, weight });
    answers += rec.n;
    // "Answered correctly and it stuck" — a single lucky guess should not set
    // the ceiling the level is allowed to climb to.
    if (rec.k > 0 && rec.st > 0 && w.x > ceiling) ceiling = w.x;
  }

  const slope = (theta) => {
    let s = PRIOR_WEIGHT * (0.5 - chance(theta, PRIOR_LEVEL));
    for (const o of obs) s += o.weight * (o.k - o.n * chance(theta, o.x));
    return s;
  };

  let lo = -0.4, hi = 1.4;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (slope(mid) > 0) lo = mid; else hi = mid;
  }
  let theta = (lo + hi) / 2;
  if (obs.length) theta = Math.min(theta, ceiling + REACH);

  return { theta: clamp(theta, 0.02, 1), answers, words: obs.length, ceiling };
}

/**
 * How hard this item will feel to this user, on the same 0..1 scale.
 *
 * For a word with a history, the record beats the corpus: invert the model to
 * ask "at what difficulty does this user score what they score on this word?"
 * and blend that with the word's own x, weighted by how much evidence there is.
 * A common word missed four times is a hard item; a rare word answered right at
 * three widening intervals is an easy one.
 */
export function perceivedDifficulty(word, rec, theta) {
  if (!rec || !rec.n) return clamp(word.x + NEW_COST, 0, 1.2);

  const acc = clamp((rec.k + 1) / (rec.n + 2), 0.08, 0.92);   // Laplace-smoothed
  const observed = levelFor(theta, acc);
  const trust = rec.n / (rec.n + 3);
  let d = (1 - trust) * word.x + trust * observed;

  // Surviving a long interval is evidence the memory is solid, which the raw
  // accuracy does not capture — it counts a word answered right yesterday and
  // one answered right a month ago the same.
  d -= 0.12 * Math.min(1, (rec.iv || 0) / 12);
  if (rec.st === 0 && rec.lp > 0) d += 0.06;   // currently relearning

  return clamp(d, 0, 1.2);
}
