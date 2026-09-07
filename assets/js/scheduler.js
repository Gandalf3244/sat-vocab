/**
 * scheduler.js — decides when a word comes back and when it counts as learned.
 *
 * A trimmed SM-2 variant with two gates instead of one:
 *
 *   1. a due DATE   (classic spaced repetition)
 *   2. a session GAP (how many study sessions must pass first)
 *
 * The second gate exists because sessions here are short and frequent. A word
 * you just missed should come back *later in this session*, then skip a session
 * or two, then settle into widening intervals — not reappear in every single
 * session until you finally beat it into memory.
 */

export const DAY = 86400000;

const EASE_START = 2.35;
const EASE_MIN = 1.4;
const EASE_MAX = 3.0;
const FIRST_INTERVAL = 1.0;   // days, after the first correct answer
const LAPSE_INTERVAL = 0.6;   // days, after a miss
const MAX_INTERVAL = 300;     // days

const FAST_MS = 4200;         // answered this quickly = confident
const SLOW_MS = 11000;        // answered this slowly = shaky even if correct

/* Mastery gates — all must hold. In practice this means roughly: four correct
   answers in a row, spread over at least three separate sessions and about two
   weeks of widening gaps, with no recent history of getting it wrong. A single
   miss un-masters the word, and mastered words still get occasional
   maintenance checks, so the bar does not have to be punitive. */
const MASTER_STREAK = 3;      // consecutive correct
const MASTER_SESSIONS = 3;    // seen across at least this many distinct sessions
const MASTER_INTERVAL = 12;   // days of scheduled spacing survived
const MASTER_ACCURACY = 0.75; // lifetime accuracy on the word

export const LEECH_LAPSES = 4;

export function freshRecord(now = Date.now()) {
  return {
    n: 0, k: 0, m: 0, st: 0, lp: 0, ns: 0,
    iv: 0, ea: EASE_START, du: now,
    fs: now, ls: now, ms: 0,
    sq: -1,   // session index when last answered
    sg: 1,    // sessions that must pass before it may return
    ma: 0, up: now,
  };
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** 0 wrong · 1 correct-but-slow · 2 correct · 3 correct-and-fast */
export function gradeOf(correct, ms) {
  if (!correct) return 0;
  if (ms <= FAST_MS) return 3;
  if (ms >= SLOW_MS) return 1;
  return 2;
}

/**
 * Apply one answer to a record. Mutates and returns it.
 * `sessionIndex` is the ordinal of the session this answer happened in.
 */
export function applyAnswer(rec, { correct, ms, sessionIndex, now = Date.now() }) {
  const grade = gradeOf(correct, ms);

  rec.n += 1;
  if (correct) rec.k += 1; else rec.m += 1;
  rec.ms = rec.ms ? Math.round(rec.ms * 0.7 + ms * 0.3) : ms;
  if (rec.sq !== sessionIndex) { rec.ns += 1; rec.sq = sessionIndex; }
  rec.ls = now;
  rec.up = now;

  if (grade === 0) {
    rec.st = 0;
    rec.lp += 1;
    rec.ma = 0;
    rec.ea = clamp(rec.ea - 0.22, EASE_MIN, EASE_MAX);
    rec.iv = LAPSE_INTERVAL;
    // Come back after a session or two, not in the very next one.
    rec.sg = rec.lp >= LEECH_LAPSES ? 1 : 2;
  } else {
    rec.st += 1;
    rec.ea = clamp(rec.ea + (grade === 3 ? 0.08 : grade === 1 ? -0.06 : 0.01), EASE_MIN, EASE_MAX);
    const speed = grade === 3 ? 1.15 : grade === 1 ? 0.8 : 1;
    rec.iv = rec.iv <= 0
      ? FIRST_INTERVAL
      : Math.min(MAX_INTERVAL, rec.iv * rec.ea * speed);
    // One good answer after a lapse is not enough to earn a place in every
    // session again — keep skipping one until the word has a real streak.
    // A word that has never been missed is exempt: its second exposure is the
    // one that actually builds the memory, so it should not be delayed.
    rec.sg = rec.lp > 0 && rec.st < 2 ? 2 : 1;
  }

  // ±15% jitter so a bad session's words do not all resurface together.
  const jitter = 0.85 + Math.random() * 0.3;
  rec.du = now + rec.iv * DAY * jitter;
  rec.ma = isMastered(rec) ? 1 : 0;
  return rec;
}

export function isMastered(rec) {
  if (!rec || rec.n < MASTER_STREAK) return false;
  const acc = rec.n ? rec.k / rec.n : 0;
  return rec.st >= MASTER_STREAK
    && rec.ns >= MASTER_SESSIONS
    && rec.iv >= MASTER_INTERVAL
    && acc >= MASTER_ACCURACY;
}

/** Both gates: the clock and the session counter. */
export function isDue(rec, now, sessionIndex) {
  if (!rec) return false;
  if (now < rec.du) return false;
  if (rec.sq >= 0 && sessionIndex < rec.sq + (rec.sg || 1)) return false;
  return true;
}

/** How overdue, in multiples of its own interval — used to rank the queue. */
export function overdueRatio(rec, now) {
  const iv = Math.max(0.25, rec.iv || 0.25);
  return (now - rec.du) / (iv * DAY);
}

/** 0..1 estimate of how well the word is known, for the difficulty ramp. */
export function strength(rec) {
  if (!rec || !rec.n) return 0;
  const acc = rec.k / rec.n;
  const spacing = Math.min(1, (rec.iv || 0) / MASTER_INTERVAL);
  const streak = Math.min(1, rec.st / MASTER_STREAK);
  return clamp(0.45 * acc + 0.35 * spacing + 0.2 * streak, 0, 1);
}

export const isLeech = (rec) => !!rec && rec.lp >= LEECH_LAPSES && !rec.ma;

export function statusOf(rec) {
  if (!rec || !rec.n) return 'new';
  if (rec.ma) return 'mastered';
  if (isLeech(rec)) return 'trouble';
  if (rec.iv >= 7) return 'strong';
  if (rec.st === 0) return 'relearning';
  return 'learning';
}
