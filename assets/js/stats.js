/**
 * stats.js — every derived number the app shows, in one place.
 * The Progress tab and the Google Sheets export both read from here, so the
 * spreadsheet can never disagree with the screen.
 */

import { statusOf, isLeech, strength, DAY } from './scheduler.js';

export const dateKey = (ts) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
export const fmtMinutes = (ms) => {
  if (ms < 60000) return `${Math.max(0, Math.round(ms / 1000))}s`;
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
};

/** Per-day rollup derived from the session log (never stored separately). */
export function daily(sessions) {
  const map = new Map();
  for (const s of sessions) {
    const key = dateKey(s.start);
    const d = map.get(key) || { date: key, sessions: 0, ms: 0, items: 0, correct: 0, newWords: 0 };
    d.sessions += 1;
    d.ms += s.ms || 0;
    d.items += s.items || 0;
    d.correct += s.correct || 0;
    d.newWords += s.newWords || 0;
    map.set(key, d);
  }
  return map;
}

/** Consecutive days meeting the daily goal, counting back from today. */
export function streaks(sessions, goal = 1) {
  const map = daily(sessions);
  const met = (key) => (map.get(key)?.sessions || 0) >= goal;

  let current = 0;
  const cursor = new Date();
  // Today not being done yet should not break yesterday's streak.
  if (!met(dateKey(cursor.getTime()))) cursor.setDate(cursor.getDate() - 1);
  for (let guard = 0; guard < 3650; guard++) {
    if (!met(dateKey(cursor.getTime()))) break;
    current += 1;
    cursor.setDate(cursor.getDate() - 1);
  }

  let longest = 0, run = 0, prev = null;
  for (const key of [...map.keys()].sort()) {
    if (!met(key)) { run = 0; prev = key; continue; }
    const gap = prev ? Math.round((new Date(key) - new Date(prev)) / DAY) : 99;
    run = gap === 1 ? run + 1 : 1;
    longest = Math.max(longest, run);
    prev = key;
  }
  return { current, longest: Math.max(longest, current) };
}

export function overview(words, progress, sessions) {
  const ids = Object.keys(progress);
  let mastered = 0, learning = 0, trouble = 0, totalAsked = 0, totalRight = 0;
  for (const id of ids) {
    const r = progress[id];
    if (r.ma) mastered += 1;
    else if (isLeech(r)) trouble += 1;
    else learning += 1;
    totalAsked += r.n || 0;
    totalRight += r.k || 0;
  }
  const studyMs = sessions.reduce((a, s) => a + (s.ms || 0), 0);
  return {
    totalWords: words.length,
    seen: ids.length,
    mastered,
    learning,
    trouble,
    unseen: words.length - ids.length,
    accuracy: pct(totalRight, totalAsked),
    totalAsked,
    totalRight,
    sessions: sessions.length,
    studyMs,
    avgSessionMs: sessions.length ? Math.round(studyMs / sessions.length) : 0,
  };
}

export function dueNow(progress, sessionIndex, now = Date.now()) {
  let n = 0;
  for (const r of Object.values(progress)) {
    if (r.ma) continue;
    if (now >= r.du && !(r.sq >= 0 && sessionIndex < r.sq + (r.sg || 1))) n += 1;
  }
  return n;
}

export function tierProgress(words, progress) {
  const tiers = new Map();
  for (const w of words) {
    const t = tiers.get(w.t) || { tier: w.t, total: 0, seen: 0, mastered: 0 };
    t.total += 1;
    const r = progress[w.i];
    if (r) { t.seen += 1; if (r.ma) t.mastered += 1; }
    tiers.set(w.t, t);
  }
  return [...tiers.values()].sort((a, b) => a.tier - b.tier);
}

/** Every word the user has actually met, with its full record, newest data first. */
export function wordRows(words, progress) {
  const rows = [];
  for (const w of words) {
    const r = progress[w.i];
    if (!r) continue;
    rows.push({
      word: w.w,
      gloss: w.g,
      definition: w.d,
      tier: w.t,
      tierName: ['', 'Highest', 'Mid', 'Lower'][w.t] || `Tier ${w.t}`,
      lesson: w.l || '',
      rank: w.r + 1,
      difficulty: w.x,
      status: statusOf(r),
      asked: r.n || 0,
      correct: r.k || 0,
      missed: r.m || 0,
      accuracy: r.n ? Math.round((r.k / r.n) * 10000) / 10000 : 0,
      lapses: r.lp || 0,
      streak: r.st || 0,
      sessionsSeen: r.ns || 0,
      intervalDays: Math.round((r.iv || 0) * 10) / 10,
      ease: Math.round((r.ea || 0) * 100) / 100,
      strength: Math.round(strength(r) * 100) / 100,
      avgMs: r.ms || 0,
      firstSeen: r.fs || 0,
      lastSeen: r.ls || 0,
      due: r.du || 0,
      mastered: !!r.ma,
    });
  }
  return rows;
}

export const missedWords = (rows) => rows
  .filter((r) => r.missed > 0)
  .sort((a, b) => b.missed - a.missed || a.accuracy - b.accuracy);

export const leeches = (rows) => rows
  .filter((r) => r.lapses >= 4 && !r.mastered)
  .sort((a, b) => b.lapses - a.lapses || a.accuracy - b.accuracy);

/** Reviews landing on each of the next `days` days. */
export function forecast(progress, days = 14, now = Date.now()) {
  const out = Array.from({ length: days }, (_, i) => ({ day: i, date: dateKey(now + i * DAY), count: 0 }));
  let overdue = 0;
  for (const r of Object.values(progress)) {
    if (r.ma) continue;
    const diff = Math.floor((r.du - now) / DAY);
    if (diff < 0) overdue += 1;
    else if (diff < days) out[diff].count += 1;
  }
  if (out.length) out[0].count += overdue;
  return out;
}

/** Per-session series for the accuracy / mastery charts. */
export function sessionSeries(sessions) {
  return sessions.map((s, i) => ({
    n: i + 1,
    date: dateKey(s.start),
    accuracy: s.items ? s.correct / s.items : 0,
    items: s.items || 0,
    minutes: Math.round((s.ms || 0) / 60000),
    newWords: s.newWords || 0,
    mastered: s.masteredAfter ?? null,
    seen: s.seenAfter ?? null,
  }));
}

/** Rolling activity grid for the heatmap: `weeks` columns of 7 days. */
export function activityGrid(sessions, weeks = 18) {
  const map = daily(sessions);
  const cells = [];
  const end = new Date();
  end.setHours(12, 0, 0, 0);
  end.setDate(end.getDate() + (6 - end.getDay()));      // pad to end of this week
  const total = weeks * 7;
  let peak = 1;
  for (const d of map.values()) peak = Math.max(peak, d.items);
  for (let i = total - 1; i >= 0; i--) {
    const t = new Date(end);
    t.setDate(end.getDate() - i);
    const key = dateKey(t.getTime());
    const d = map.get(key);
    const items = d?.items || 0;
    cells.push({
      date: key,
      items,
      future: t.getTime() > Date.now(),
      level: items === 0 ? 0 : Math.min(4, 1 + Math.floor((items / peak) * 3.99)),
    });
  }
  return cells;
}
