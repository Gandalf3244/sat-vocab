/**
 * auth.js — optional Google account + Firestore sync.
 *
 * Nothing here runs until config.js has a Firebase project in it. Without one
 * the app stays in local mode and every other feature works unchanged.
 *
 * Sync model: one document per user holding the whole state blob. On sign-in
 * and on every remote change we merge (see store.mergeStates) rather than
 * overwrite, so a session studied on the phone while offline survives the
 * laptop's next write.
 */

import { firebaseConfig, hasSync } from './config.js';
import { state, snapshot, replaceState, mergeStates, onSave } from './store.js';

const CDN = 'https://www.gstatic.com/firebasejs/10.12.2';
const PUSH_DEBOUNCE = 2500;

let fb = null;              // { app, auth, db, fns }
let unsubscribeDoc = null;
let pushTimer = null;
let lastPushedAt = 0;
let starting = null;

export const authState = {
  mode: hasSync() ? 'signed-out' : 'local',   // local | signed-out | signed-in | error
  user: null,
  syncing: false,
  lastSync: 0,
  error: null,
};

const listeners = new Set();
export function onAuthChange(fn) { listeners.add(fn); fn(authState); return () => listeners.delete(fn); }
const emit = () => listeners.forEach((fn) => { try { fn(authState); } catch (e) { console.warn(e); } });

async function boot() {
  if (fb) return fb;
  if (starting) return starting;
  starting = (async () => {
    const [appMod, authMod, fsMod] = await Promise.all([
      import(`${CDN}/firebase-app.js`),
      import(`${CDN}/firebase-auth.js`),
      import(`${CDN}/firebase-firestore.js`),
    ]);
    const app = appMod.initializeApp(firebaseConfig);
    const auth = authMod.getAuth(app);
    const db = fsMod.getFirestore(app);
    fb = { app, auth, db, a: authMod, f: fsMod };
    return fb;
  })();
  return starting;
}

/** Wire up auth listening. Safe to call when sync is not configured. */
export async function initAuth() {
  if (!hasSync()) return;
  try {
    const { auth, a } = await boot();
    await a.setPersistence(auth, a.browserLocalPersistence).catch(() => {});
    a.onAuthStateChanged(auth, async (user) => {
      if (user) {
        authState.mode = 'signed-in';
        authState.user = { uid: user.uid, name: user.displayName, email: user.email, photo: user.photoURL };
        emit();
        await attach(user.uid);
      } else {
        detach();
        authState.mode = 'signed-out';
        authState.user = null;
        emit();
      }
    });
    // Completes a redirect sign-in (the fallback path on mobile).
    a.getRedirectResult(auth).catch(() => {});
  } catch (err) {
    console.warn('[auth] init failed', err);
    authState.mode = 'error';
    authState.error = String(err?.message || err);
    emit();
  }
}

export async function signIn() {
  const { auth, a } = await boot();
  const provider = new a.GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  try {
    await a.signInWithPopup(auth, provider);
  } catch (err) {
    // Popups get blocked in installed PWAs and on some mobile browsers.
    if (['auth/popup-blocked', 'auth/operation-not-supported-in-this-environment', 'auth/cancelled-popup-request'].includes(err?.code)) {
      await a.signInWithRedirect(auth, provider);
      return;
    }
    if (err?.code === 'auth/popup-closed-by-user') return;
    throw err;
  }
}

export async function signOut() {
  const { auth, a } = await boot();
  detach();
  await a.signOut(auth);
}

/* ------------------------------------------------------------ document --- */

function docRef() {
  const { db, f } = fb;
  return f.doc(db, 'users', authState.user.uid);
}

async function attach(uid) {
  const { f } = await boot();
  authState.syncing = true;
  emit();

  try {
    const snap = await f.getDoc(docRef());
    const remote = snap.exists() ? decode(snap.data()) : null;
    if (remote) replaceState(mergeStates(snapshot(), remote));
    await push({ force: true });
  } catch (err) {
    console.warn('[auth] initial sync failed', err);
    authState.error = String(err?.message || err);
  }

  // Live updates from the other device.
  unsubscribeDoc = f.onSnapshot(docRef(), (snap) => {
    if (!snap.exists() || snap.metadata.hasPendingWrites) return;
    const remote = decode(snap.data());
    if (!remote) return;
    if (remote.meta?.device === state.meta.device && (remote.meta?.updatedAt || 0) <= lastPushedAt) return;
    const merged = mergeStates(snapshot(), remote);
    replaceState(merged);
    authState.lastSync = Date.now();
    emit();
  }, (err) => console.warn('[auth] listener error', err));

  authState.syncing = false;
  authState.lastSync = Date.now();
  emit();

  // Any local save from here on schedules a push.
  onSave(() => scheduleRepush());
}

function detach() {
  unsubscribeDoc?.();
  unsubscribeDoc = null;
  clearTimeout(pushTimer);
}

function scheduleRepush() {
  if (authState.mode !== 'signed-in') return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => push(), PUSH_DEBOUNCE);
}

/** Firestore rejects deeply nested plain objects with numeric-ish keys poorly;
 *  the progress map is stored as JSON text, which is also far cheaper to write. */
function encode(s) {
  return {
    schema: 1,
    settings: s.settings,
    progressJson: JSON.stringify(s.progress),
    sessionsJson: JSON.stringify(s.sessions),
    meta: s.meta,
    updatedAt: s.meta.updatedAt,
  };
}

function decode(d) {
  if (!d) return null;
  try {
    return {
      settings: d.settings || {},
      progress: d.progressJson ? JSON.parse(d.progressJson) : (d.progress || {}),
      sessions: d.sessionsJson ? JSON.parse(d.sessionsJson) : (d.sessions || []),
      meta: d.meta || { updatedAt: d.updatedAt || 0 },
    };
  } catch (err) {
    console.warn('[auth] could not decode remote state', err);
    return null;
  }
}

export async function push({ force = false } = {}) {
  if (authState.mode !== 'signed-in') return;
  if (!force && Date.now() - lastPushedAt < 1200) return;
  try {
    const { f } = await boot();
    const payload = encode(snapshot());
    await f.setDoc(docRef(), payload, { merge: false });
    lastPushedAt = payload.updatedAt;
    authState.lastSync = Date.now();
    authState.error = null;
    emit();
  } catch (err) {
    console.warn('[auth] push failed', err);
    authState.error = String(err?.message || err);
    emit();
  }
}

/** Best-effort flush when the tab is being hidden or closed. */
export function flush() {
  if (authState.mode !== 'signed-in') return;
  clearTimeout(pushTimer);
  push({ force: true });
}
