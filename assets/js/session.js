/**
 * session.js — plans and runs one study session.
 *
 * Two ideas do most of the work here, and both run on the same 0..1 difficulty
 * scale: the word's own `x` from data/words.json, and the user's level θ from
 * ability.js.
 *
 *  · WITHIN a session the difficulty ramps. Items are ordered by how hard they
 *    should feel *to this user* — their record on a word outweighs the corpus,
 *    so a rare word they know cold opens the session and a common word they
 *    keep missing lands near the end.
 *
 *  · ACROSS sessions difficulty tracks the user. New words are drawn from a
 *    band around θ, so beating today's material raises tomorrow's. Frequency
 *    still breaks ties — of two words at the right level, the one you are
 *    likelier to meet is worth more — but it no longer sets the order on its
 *    own. Grinding the whole top-frequency band before touching anything rare
 *    is what made the ramp feel flat and arbitrary.
 */

import { applyAnswer, freshRecord, isDue, overdueRatio, DAY } from './scheduler.js';
import { buildQuestion } from './quiz.js';
import { fitAbility, newWordLevel, perceivedDifficulty } from './ability.js';

const MS_PER_ITEM_DEFAULT = 7200;
const MS_PER_ITEM_MIN = 4200;
const MS_PER_ITEM_MAX = 13000;
const FEEDBACK_OVERHEAD = 900;   // reading the answer explanation

const SHARE_REVIEW = 0.55;
const SHARE_NEW = 0.30;
const SHARE_MAINTENANCE = 0.08;

const RETRY_OFFSETS = [4, 9, 15];   // how far ahead a missed word is re-inserted
const MIN_RETRY_GAP = 3;            // never re-ask sooner than this many questions
const OVERRUN = 1.7;                // hard ceiling on queue growth from retries
const TOPUP_ITEM_MS = 7000;         // time one extra question is assumed to need

// A not-yet-due word may only be pulled in as filler once it is this far
// through its own interval. Without this the queue quietly drags every known
// word back into every session and the spacing stops meaning anything.
const EARLY_REVIEW_READY = 0.7;

// Where new words sit in the finished queue, as a fraction of its length.
const NEW_BAND = [0.25, 0.88];

// How far either side of the target level a new word may be drawn from. Wide
// enough that a session is not four synonyms of the same difficulty, narrow
// enough that the level means something.
const NEW_SPAN = 0.16;
// How much a word's usefulness (how often it turns up in English) counts
// against being at exactly the right level. Below 1, so level wins and
// frequency only breaks near-ties.
const USEFULNESS_PULL = 0.4;

/** 0 = just reviewed, 1 = due now. */
function readiness(rec, now) {
  const span = Math.max(1, (rec.iv || 0) * DAY);
  return 1 - (rec.du - now) / span;
}

/* ---------------------------------------------------------------- plan --- */

/** Median ms/item from recent sessions, so the time estimate fits the user. */
function estimateItemMs(sessions) {
  const recent = sessions.slice(-8).filter((s) => s.items > 2 && s.ms > 0);
  if (!recent.length) return MS_PER_ITEM_DEFAULT;
  const rates = recent.map((s) => s.ms / s.items).sort((a, b) => a - b);
  const mid = rates[Math.floor(rates.length / 2)];
  return Math.max(MS_PER_ITEM_MIN, Math.min(MS_PER_ITEM_MAX, mid));
}

export function estimateItems({ minutes, sessions }) {
  const per = estimateItemMs(sessions) + FEEDBACK_OVERHEAD;
  return Math.max(4, Math.round((minutes * 60000) / per));
}

/** Share of a session historically spent re-asking words missed in it. */
function retryAllowance(sessions) {
  const recent = sessions.slice(-8).filter((s) => s.items > 4);
  if (!recent.length) return 0.25;
  const asked = recent.reduce((a, s) => a + s.items, 0);
  const right = recent.reduce((a, s) => a + s.correct, 0);
  const missRate = 1 - right / Math.max(1, asked);
  return Math.max(0.1, Math.min(0.45, missRate * 1.15));
}

/**
 * @returns {{ queue: Array<{id:number,kind:string}>, target:number, counts:object }}
 */
export function planSession({ words, progress, settings, sessions, minutes, now = Date.now() }) {
  const sessionIndex = sessions.length;
  const ability = fitAbility(words, progress, { now });
  const budget = estimateItems({ minutes, sessions });
  // Missed words get re-asked inside the same session, so the planned queue has
  // to be shorter than the time budget or the tail never gets reached.
  const target = Math.max(4, Math.round(budget * (1 - retryAllowance(sessions))));
  const maxTier = settings.tierMode === 'auto' ? 3 : Number(settings.tierMode) || 3;

  const due = [];
  const maintenance = [];
  const upcoming = [];
  const fresh = [];

  for (const w of words) {
    const rec = progress[w.i];
    if (!rec) {
      if (w.t <= maxTier) fresh.push(w);
      continue;
    }
    if (rec.ma) {
      if (isDue(rec, now, sessionIndex)) maintenance.push(w);
      continue;
    }
    if (isDue(rec, now, sessionIndex)) due.push(w);
    else if (readiness(rec, now) >= EARLY_REVIEW_READY) upcoming.push(w);
  }

  due.sort((a, b) => overdueRatio(progress[b.i], now) - overdueRatio(progress[a.i], now));
  maintenance.sort((a, b) => overdueRatio(progress[b.i], now) - overdueRatio(progress[a.i], now));
  upcoming.sort((a, b) => readiness(progress[b.i], now) - readiness(progress[a.i], now));

  // New words: nearest to the level this user is working at, with how often the
  // word actually turns up breaking ties. As they get better the target moves
  // up and rarer, harder words come into range on their own — so the list is
  // never "all of tier 1, then all of tier 2".
  const newLevel = newWordLevel(ability.theta);
  const corpus = Math.max(1, words.length);
  const fit = (w) => Math.abs(w.x - newLevel) / NEW_SPAN + USEFULNESS_PULL * (w.r / corpus);
  fresh.sort((a, b) => fit(a) - fit(b));

  const picked = [];
  const takenIds = new Set();
  // Hard ceiling on new material. Without it a thin review backlog lets the
  // filler pour in unseen words, and nothing ever gets consolidated.
  const newCap = Math.max(2, Math.round(budget * SHARE_NEW));
  let newTaken = 0;
  const take = (list, n, kind) => {
    for (const w of list) {
      if (picked.length >= target || n <= 0) break;
      if (kind === 'new' && newTaken >= newCap) break;
      if (takenIds.has(w.i)) continue;
      takenIds.add(w.i);
      picked.push({ id: w.i, kind });
      if (kind === 'new') newTaken += 1;
      n--;
    }
  };

  take(due, Math.ceil(target * SHARE_REVIEW), 'review');
  take(fresh, Math.max(2, Math.round(target * SHARE_NEW)), 'new');
  take(maintenance, Math.floor(target * SHARE_MAINTENANCE), 'maintenance');
  // Leftover room goes to the rest of the genuine backlog, then to new
  // material, and only then to words that are merely close to due.
  take(due, target, 'review');
  take(fresh, target, 'new');
  take(upcoming, target, 'review');

  const queue = rampOrder(picked, words, progress, ability.theta);

  // Anything not picked, kept in priority order. If the user answers faster
  // than predicted we extend from here rather than ending the session early.
  const reserve = [];
  for (const w of due) if (!takenIds.has(w.i) && reserve.length < 40) reserve.push({ id: w.i, kind: 'review' });
  for (const w of upcoming) if (!takenIds.has(w.i) && reserve.length < 70) reserve.push({ id: w.i, kind: 'review' });
  let spare = Math.max(0, newCap - newTaken);
  const overflow = [];
  for (const w of fresh) {
    if (takenIds.has(w.i)) continue;
    if (spare > 0) { reserve.push({ id: w.i, kind: 'new' }); spare -= 1; continue; }
    // Beyond the cap. Only ever reached when the queue has run dry with time
    // still on the clock — better than ending a 20-minute session at 17.
    if (overflow.length < 120) overflow.push({ id: w.i, kind: 'new' });
  }
  reserve.push(...overflow);

  return {
    queue,
    reserve,
    target,
    sessionIndex,
    ability,
    newLevel,
    counts: {
      review: picked.filter((p) => p.kind === 'review').length,
      new: picked.filter((p) => p.kind === 'new').length,
      maintenance: picked.filter((p) => p.kind === 'maintenance').length,
      dueTotal: due.length,
      budget,
    },
  };
}

/**
 * Sort the chosen items easy → hard *for this user*, then pull one genuinely
 * easy familiar item to the very front as a warm-up.
 */
function rampOrder(picked, words, progress, theta) {
  const byId = Object.fromEntries(words.map((w) => [w.i, w]));
  const load = ({ id, kind }) => {
    let d = perceivedDifficulty(byId[id], progress[id], theta);
    // A maintenance check on a mastered word is a formality, not a test.
    if (kind === 'maintenance') d *= 0.5;
    // Just enough noise to break exact ties. Any more and the ramp stops
    // reading as deliberate, which is most of what makes it work.
    return d + (Math.random() - 0.5) * 0.03;
  };

  const out = picked.map((p) => ({ ...p, load: load(p) })).sort((a, b) => a.load - b.load);

  // Unseen words are the heaviest items in any session, so a pure sort tends to
  // park them at the very end — where an over-running session never reaches
  // them. Only the ones that fall past the band get moved, and they keep their
  // order relative to each other, so the ramp survives the rescue.
  const last = Math.floor(out.length * NEW_BAND[1]);
  const stranded = [];
  for (let i = out.length - 1; i > last; i--) {
    if (out[i].kind === 'new') stranded.unshift(...out.splice(i, 1));
  }
  if (stranded.length) {
    const from = Math.max(1, Math.floor(out.length * NEW_BAND[0]));
    const span = Math.max(1, Math.floor(out.length * NEW_BAND[1]) - from);
    stranded.forEach((item, i) => {
      const at = Math.min(out.length, from + Math.round((i / stranded.length) * span) + i);
      out.splice(at, 0, item);
    });
  }

  // Open on something familiar and easy.
  const warmIdx = out.findIndex((p) => p.kind !== 'new');
  if (warmIdx > 0) out.unshift(...out.splice(warmIdx, 1));
  return out.map(({ id, kind }) => ({ id, kind }));
}

/* -------------------------------------------------------------- runtime --- */

export class StudySession {
  constructor({ plan, words, byId, progress, settings, onFinish }) {
    this.plan = plan;
    this.words = words;
    this.byId = byId;
    this.progress = progress;
    this.settings = settings;
    this.onFinish = onFinish;

    this.queue = plan.queue.slice();
    this.reserve = (plan.reserve || []).slice();
    this.cursor = 0;
    this.maxItems = Math.round(plan.target * OVERRUN);
    this.sessionIndex = plan.sessionIndex;

    this.startedAt = Date.now();
    this.durationMs = settings.minutes * 60000;
    this.questionShownAt = 0;

    this.answered = 0;
    this.correct = 0;
    this.firstSeenIds = new Set();
    this.missedIds = new Set();
    this.recoveredIds = new Set();
    this.newIds = new Set();
    this.log = [];
    this.finished = false;
    this.id = `s_${this.startedAt.toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  }

  timeLeftMs() { return Math.max(0, this.durationMs - (Date.now() - this.startedAt)); }
  timeFraction() { return this.durationMs ? this.timeLeftMs() / this.durationMs : 0; }
  get total() { return this.queue.length; }

  isOver() {
    if (this.finished) return true;
    if (this.timeLeftMs() <= 0) return true;
    if (this.cursor < this.queue.length) return false;
    // Queue drained: only continue if a top-up could actually supply something.
    return this.reserve.length === 0 || this.roomForMore() < 1;
  }

  /** Time one more question needs, measured from this session where possible. */
  paceMs() {
    if (this.answered < 3) return TOPUP_ITEM_MS;
    const spent = Date.now() - this.startedAt;
    return Math.max(2500, Math.min(15000, spent / this.answered));
  }

  roomForMore() { return Math.floor(this.timeLeftMs() / this.paceMs()); }

  /** Pull more material in when the clock still has room for it. */
  topUp() {
    const n = Math.min(this.roomForMore(), 8, this.reserve.length);
    if (n < 1) return 0;
    this.queue.push(...this.reserve.splice(0, n));
    return n;
  }

  /** Next question, or null when the session is done. */
  next() {
    if (this.finished || this.timeLeftMs() <= 0) return null;
    if (this.cursor >= this.queue.length) {
      this.topUp();
      if (this.cursor >= this.queue.length) return null;
    }
    const entry = this.queue[this.cursor];
    const word = this.byId[entry.id];
    const rec = this.progress[entry.id];
    const q = buildQuestion(word, {
      words: this.words,
      byId: this.byId,
      allowReverse: this.settings.reverse && !!rec && rec.n > 0,
      seen: !!rec,
      // Whatever caught them last time comes back with the word. Same
      // mechanism for the retry a few questions later and for the review a
      // fortnight from now — the record carries it either way.
      pin: rec && rec.tr >= 0 ? rec.tr : -1,
    });
    this.current = { ...q, entry };
    this.questionShownAt = Date.now();
    return this.current;
  }

  /**
   * Record an answer. Returns detail for the feedback panel.
   * The first time a word is answered in a session it drives the scheduler;
   * within-session retries only record that a recovery happened, so beating a
   * word on the third try does not fake a real memory interval.
   */
  answer(optionId) {
    const q = this.current;
    if (!q) return null;
    const ms = Math.min(60000, Date.now() - this.questionShownAt);
    const correct = optionId === q.correctId;
    const id = q.word.i;
    const isRetry = this.firstSeenIds.has(id);

    let rec = this.progress[id];
    const isNew = !rec;
    if (isNew) {
      rec = this.progress[id] = freshRecord();
      this.newIds.add(id);
    }

    if (!isRetry) {
      this.firstSeenIds.add(id);
      applyAnswer(rec, { correct, ms, sessionIndex: this.sessionIndex });
      // Getting it right first time, unprompted, is what retires the trap.
      // Until then the same wrong answer keeps coming back with the word.
      if (correct) rec.tr = -1;
      else if (optionId !== q.correctId) rec.tr = optionId;
    } else {
      rec.n += 1;
      if (correct) { rec.k += 1; this.recoveredIds.add(id); } else rec.m += 1;
      // Beating it on the retry does not clear the trap: they had just been
      // shown the answer. It stays pinned until they get it cold.
      if (!correct && optionId !== q.correctId) rec.tr = optionId;
      rec.up = Date.now();
      // Still fighting it at the end of the session — make sure it is not
      // scheduled out too far.
      if (!correct) rec.du = Math.min(rec.du, Date.now() + 0.6 * DAY);
    }

    this.answered += 1;
    if (correct) this.correct += 1;
    else {
      this.missedIds.add(id);
      this.scheduleRetry(id);
    }
    this.log.push({ id, correct, ms, retry: isRetry, mode: q.mode });

    const chosen = q.options.find((o) => o.id === optionId) || null;
    this.cursor += 1;

    return {
      correct,
      ms,
      word: q.word,
      chosen,
      isRetry,
      isNew,
      willReturn: !correct,
    };
  }

  /** Put a missed word back into the queue a few items later — never next. */
  scheduleRetry(id) {
    if (this.queue.length >= this.maxItems) return;
    const seenTimes = this.log.filter((l) => l.id === id && !l.correct).length;
    const base = RETRY_OFFSETS[Math.min(seenTimes, RETRY_OFFSETS.length - 1)];
    const want = this.cursor + 1 + base + Math.floor(Math.random() * 3);

    // Near the end of the queue the desired slot does not exist yet. Pull in
    // real material first so the retry still lands after a gap, rather than
    // being clamped onto the very next question.
    if (want > this.queue.length) this.topUp();

    const at = Math.min(this.queue.length, want);
    // Still no room to space it out: leave it to the scheduler, which will
    // bring it back in a later session. Re-asking it immediately would test
    // short-term recall of the answer just shown, which teaches nothing.
    if (at - this.cursor < MIN_RETRY_GAP) return;
    this.queue.splice(at, 0, { id, kind: 'retry' });
  }

  finish() {
    if (this.finished) return this.summary;
    this.finished = true;
    const ended = Date.now();
    this.summary = {
      id: this.id,
      start: this.startedAt,
      end: ended,
      planMin: this.settings.minutes,
      ms: ended - this.startedAt,
      items: this.answered,
      correct: this.correct,
      newWords: this.newIds.size,
      reviews: this.firstSeenIds.size - this.newIds.size,
      missed: [...this.missedIds],
      learned: [...this.newIds],
      recovered: [...this.recoveredIds],
    };
    this.onFinish?.(this.summary);
    return this.summary;
  }
}

