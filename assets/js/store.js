/**
 * store.js — all persistent state, plus the merge rules that make two devices
 * agree after they have both been used offline.
 *
 * Shape:
 *   settings  { minutes, reverse, sound, autoAdvance, tierMode, dailyGoal,
 *               avatar, username, nameCustom }
 *   progress  { [wordId]: Rec }          per-word spaced-repetition record
 *   sessions  [ Session ]                append-only log (daily stats derive from it)
 *   meta      { device, updatedAt, schema }
 *
 * Rec fields (short keys — this object is written on every answer):
 *   n  times asked        k  times correct      m  times missed
 *   st correct streak     lp lapses             ns distinct sessions seen in
 *   iv interval in days   ea ease factor        du due timestamp (ms)
 *   fs first seen (ms)    ls last seen (ms)     ms mean answer time (ms)
 *   ma mastered flag      up updated at (ms)
 *   tr the wrong answer that last caught them (word id), or -1
 */

const KEY = 'lexicon.state.v1';
const SCHEMA = 1;
const MAX_SESSIONS = 600;

export const DEFAULT_SETTINGS = {
  minutes: 10,
  reverse: true,
  sound: false,
  autoAdvance: false,
  tierMode: 'auto',
  dailyGoal: 1,
  // Filled in on first run by ensureProfile() in avatars.js. `nameCustom`
  // records that the user typed their own name, so changing picture stops
  // rewriting it.
  avatar: null,
  username: '',
  nameCustom: false,
};

function freshState() {
  return {
    settings: { ...DEFAULT_SETTINGS },
    progress: {},
    sessions: [],
    meta: { device: deviceId(), updatedAt: Date.now(), schema: SCHEMA },
  };
}

function deviceId() {
  let d = null;
  try { d = localStorage.getItem('lexicon.device'); } catch { /* private mode */ }
  if (!d) {
    d = Math.random().toString(36).slice(2, 10);
    try { localStorage.setItem('lexicon.device', d); } catch { /* ignore */ }
  }
  return d;
}

export const state = load();

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return freshState();
    const parsed = JSON.parse(raw);
    return normalize(parsed);
  } catch (err) {
    console.warn('[store] could not read saved state, starting fresh', err);
    return freshState();
  }
}

function normalize(s) {
  const base = freshState();
  if (!s || typeof s !== 'object') return base;
  return {
    settings: { ...base.settings, ...(s.settings || {}) },
    progress: s.progress && typeof s.progress === 'object' ? s.progress : {},
    sessions: Array.isArray(s.sessions) ? s.sessions : [],
    meta: { ...base.meta, ...(s.meta || {}), device: base.meta.device },
  };
}

let saveTimer = null;
const listeners = new Set();

/** Debounced write to localStorage + notify listeners (sync layer hooks in here). */
export function save({ immediate = false } = {}) {
  state.meta.updatedAt = Date.now();
  if (state.sessions.length > MAX_SESSIONS) {
    state.sessions = state.sessions.slice(-MAX_SESSIONS);
  }
  const write = () => {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
    } catch (err) {
      console.warn('[store] save failed (quota?)', err);
    }
    listeners.forEach((fn) => { try { fn(state); } catch (e) { console.warn(e); } });
  };
  clearTimeout(saveTimer);
  if (immediate) write();
  else saveTimer = setTimeout(write, 400);
}

export function onSave(fn) { listeners.add(fn); return () => listeners.delete(fn); }

export function replaceState(next) {
  const n = normalize(next);
  state.settings = n.settings;
  state.progress = n.progress;
  state.sessions = n.sessions;
  state.meta = { ...n.meta, device: state.meta.device };
  save({ immediate: true });
}

export function resetProgress() {
  state.progress = {};
  state.sessions = [];
  save({ immediate: true });
}

/* --------------------------------------------------------------- merge --- */

/**
 * Merge a remote snapshot into a local one.
 *
 * Scheduling fields follow whichever record was written last; cumulative
 * counters take the max of both sides, so a session studied offline on the
 * phone is not erased by a later write from the laptop. Sessions dedupe by id.
 */
export function mergeStates(local, remote) {
  if (!remote) return local;
  if (!local) return remote;

  const progress = { ...local.progress };
  for (const [id, r] of Object.entries(remote.progress || {})) {
    const l = progress[id];
    if (!l) { progress[id] = r; continue; }
    const newer = (r.up || 0) > (l.up || 0) ? r : l;
    progress[id] = {
      ...newer,
      n: Math.max(l.n || 0, r.n || 0),
      k: Math.max(l.k || 0, r.k || 0),
      m: Math.max(l.m || 0, r.m || 0),
      lp: Math.max(l.lp || 0, r.lp || 0),
      ns: Math.max(l.ns || 0, r.ns || 0),
      fs: Math.min(l.fs || Infinity, r.fs || Infinity) || newer.fs,
      ls: Math.max(l.ls || 0, r.ls || 0),
      ma: newer.ma,
      up: Math.max(l.up || 0, r.up || 0),
    };
  }

  const byId = new Map();
  for (const s of [...(local.sessions || []), ...(remote.sessions || [])]) {
    if (s && s.id && !byId.has(s.id)) byId.set(s.id, s);
  }
  const sessions = [...byId.values()].sort((a, b) => (a.start || 0) - (b.start || 0)).slice(-MAX_SESSIONS);

  const localNewer = (local.meta?.updatedAt || 0) >= (remote.meta?.updatedAt || 0);
  return {
    settings: localNewer ? local.settings : remote.settings,
    progress,
    sessions,
    meta: {
      ...local.meta,
      updatedAt: Math.max(local.meta?.updatedAt || 0, remote.meta?.updatedAt || 0),
      schema: SCHEMA,
    },
  };
}

/** Snapshot safe to hand to Firestore / a JSON download. */
export function snapshot() {
  return {
    settings: state.settings,
    progress: state.progress,
    sessions: state.sessions,
    meta: { ...state.meta, schema: SCHEMA },
  };
}
