/**
 * session.js — plans and runs one study session.
 *
 * Two ideas do most of the work here:
 *
 *  · WITHIN a session the difficulty ramps. Items are ordered by how hard they
 *    should feel *to this user* (a word you already know well is easy even if
 *    it is a rare word), so a session opens with warm-ups and closes with the
 *    stretch material.
 *
 *  · ACROSS sessions difficulty creeps slowly, because new words are always
 *    drawn in frequency order — the top-450 list is exhausted before the mid
 *    list is touched. Tomorrow's session is not meaningfully harder than
 *    today's; it is the same shape, one notch along.
 */

import { applyAnswer, freshRecord, isDue, overdueRatio, strength, DAY } from './scheduler.js';
import { buildQuestion } from './quiz.js';

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
  // Frequency order: tier first, then rank. This is what keeps the ramp gentle
  // from one session to the next.
  fresh.sort((a, b) => a.t - b.t || a.r - b.r);

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

  const queue = rampOrder(picked, words, progress);

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
 * Sort the chosen items easy → hard *for this user*, then pull two genuinely
 * easy familiar items to the very front as a warm-up.
 */
function rampOrder(picked, words, progress) {
  const byId = Object.fromEntries(words.map((w) => [w.i, w]));
  const load = ({ id, kind }) => {
    const w = byId[id];
    const rec = progress[id];
    let d = w.x;
    if (rec) d *= 1 - 0.55 * strength(rec);
    else d += 0.12;                                   // unseen words cost more
    if (kind === 'maintenance') d *= 0.5;
    return d + (Math.random() - 0.5) * 0.06;
  };

  const scored = picked.map((p) => ({ ...p, load: load(p) })).sort((a, b) => a.load - b.load);

  // Unseen words are the heaviest items in any session, so a pure sort parks
  // them all at the very end — where an over-running session never reaches
  // them. Spread them across the middle instead: the ramp still climbs, but
  // new material is guaranteed to get asked.
  const fresh = scored.filter((p) => p.kind === 'new');
  const known = scored.filter((p) => p.kind !== 'new');
  const out = known.slice();
  if (fresh.length) {
    const from = Math.floor(out.length * NEW_BAND[0]);
    const span = Math.max(1, Math.floor(out.length * NEW_BAND[1]) - from);
    fresh.forEach((item, i) => {
      const at = Math.min(out.length, from + Math.round((i / fresh.length) * span) + i);
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
    } else {
      rec.n += 1;
      if (correct) { rec.k += 1; this.recoveredIds.add(id); } else rec.m += 1;
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

