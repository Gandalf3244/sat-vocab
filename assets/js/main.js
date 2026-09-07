/**
 * main.js — wiring. Loads the word list, renders the three tabs, and drives a
 * session from the first question to the summary screen.
 */

import { state, save, resetProgress, replaceState, snapshot } from './store.js';
import { planSession, StudySession, estimateItems } from './session.js';

import * as S from './stats.js';
import { $, $$, el, toast, lineChart, barChart, renderHeatmap } from './ui.js';
import { hasSync, hasSheets } from './config.js';
import { initAuth, onAuthChange, signIn, signOut, authState, push, flush } from './auth.js';
import { exportToSheets, wordCsv, download } from './sheets.js';

let WORDS = [];
let BY_ID = {};
let META = {};
let session = null;
let timerId = null;

/* ------------------------------------------------------------------ boot -- */

(async function boot() {
  try {
    const res = await fetch('data/words.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    WORDS = data.words;
    BY_ID = Object.fromEntries(WORDS.map((w) => [w.i, w]));
    META = { version: data.version, built: data.built, count: WORDS.length };
  } catch (err) {
    $('#boot').innerHTML = `<div class="boot-text" style="max-width:34ch;text-align:center;line-height:1.5">
      Could not load the word list.<br><br>If you opened this file directly, run it from a server instead —
      <code>python -m http.server</code> in this folder, then visit localhost:8000.</div>`;
    console.error(err);
    return;
  }

  bindSettings();
  bindNav();
  bindStudy();
  bindQuiz();
  bindSummary();
  bindExport();
  bindAccount();

  renderAll();
  $('#boot').hidden = true;
  $('#app').hidden = false;

  if (hasSync()) initAuth();
  registerServiceWorker();

  document.addEventListener('visibilitychange', () => { if (document.hidden) flush(); });
  window.addEventListener('pagehide', flush);
})();

/* -------------------------------------------------------------- rendering -- */

function renderAll() {
  renderStudy();
  renderProgress();
  renderAccount();
  $('#dataMeta').textContent = `${META.count.toLocaleString()} words · built ${META.built}`;
}

function renderStudy() {
  const { progress, sessions, settings } = state;
  const ov = S.overview(WORDS, progress, sessions);
  const st = S.streaks(sessions, settings.dailyGoal);
  const due = S.dueNow(progress, sessions.length);

  $('#statDue').textContent = due;
  $('#statMastered').textContent = ov.mastered;
  $('#statSeen').textContent = ov.seen.toLocaleString();
  $('#statAcc').textContent = ov.totalAsked ? `${ov.accuracy}%` : '—';
  $('#streakNum').textContent = st.current;

  const todayKey = S.dateKey(Date.now());
  const todaySessions = S.daily(sessions).get(todayKey)?.sessions || 0;
  const frac = Math.min(1, todaySessions / (settings.dailyGoal || 1));
  const ring = $('#goalRing');
  const circumference = 2 * Math.PI * 52;
  ring.style.strokeDasharray = circumference;
  ring.style.strokeDashoffset = circumference * (1 - frac);
  ring.style.stroke = frac >= 1 ? 'var(--good)' : 'var(--accent)';

  // Coverage bars
  const host = $('#tierBars');
  host.textContent = '';
  // Named by band, not by the source list's size — deduplication across the
  // three lists leaves fewer unique words than the original page advertises.
  const names = { 1: 'Highest frequency', 2: 'Mid frequency', 3: 'Lower frequency' };
  for (const t of S.tierProgress(WORDS, progress)) {
    const seenPct = (t.seen / t.total) * 100;
    const masteredPct = (t.mastered / t.total) * 100;
    host.append(el('div', {}, [
      el('div', { class: 'tierbar-label' }, [
        el('span', { text: names[t.tier] || `Tier ${t.tier}` }),
        el('span', { text: `${t.mastered} mastered · ${t.seen}/${t.total.toLocaleString()} seen` }),
      ]),
      el('div', { class: 'tierbar-track' }, [
        el('i', { class: 'tierbar-mastered', style: `width:${masteredPct}%` }),
        el('i', { class: 'tierbar-seen', style: `width:${Math.max(0, seenPct - masteredPct)}%` }),
      ]),
    ]));
  }

  // Needs-work shortlist
  const rows = S.missedWords(S.wordRows(WORDS, progress)).slice(0, 6);
  $('#weakCard').hidden = rows.length === 0;
  fillWordList($('#weakList'), rows.map((r) => ({
    word: r.word, gloss: r.gloss,
    meta: `${r.missed}× missed`, bad: true,
  })));

  updatePlanLine();
}

function updatePlanLine() {
  const minutes = state.settings.minutes;
  const n = estimateItems({ minutes, sessions: state.sessions });
  $('#itemEstimate').textContent = `~${n} words`;
  const due = S.dueNow(state.progress, state.sessions.length);
  const seen = Object.keys(state.progress).length;
  $('#planLine').textContent = seen === 0
    ? 'Starts with the highest-frequency words.'
    : due > 0
      ? `${due} due for review · easiest first, hardest last`
      : 'Nothing due — this session will be mostly new words.';
}

function fillWordList(host, items) {
  host.textContent = '';
  for (const it of items) {
    host.append(el('li', {}, [
      el('span', { class: 'wl-word', text: it.word }),
      el('span', { class: 'wl-gloss', text: it.gloss }),
      el('span', { class: `wl-meta${it.bad ? ' bad' : ''}`, text: it.meta || '' }),
    ]));
  }
}

function renderProgress() {
  const { progress, sessions, settings } = state;
  const series = S.sessionSeries(sessions);

  lineChart($('#chartAcc'), series.map((s) => ({ x: `${s.n}`, y: s.accuracy })), {
    yMax: 1, yFormat: (v) => `${Math.round(v * 100)}%`,
  });

  const masteredPts = series.filter((s) => s.mastered !== null);
  lineChart($('#chartMastered'), masteredPts.map((s) => ({ x: `${s.n}`, y: s.mastered })), {
    good: true, yFormat: (v) => Math.round(v),
  });

  renderHeatmap($('#heatmap'), S.activityGrid(sessions, 18));

  const fc = S.forecast(progress, 14);
  barChart($('#chartForecast'), fc.map((d, i) => ({ x: i === 0 ? 'now' : d.date.slice(5), y: d.count })), {
    yFormat: (v) => Math.round(v), emptyText: 'No reviews scheduled yet',
  });

  const ov = S.overview(WORDS, progress, sessions);
  const st = S.streaks(sessions, settings.dailyGoal);
  const kv = $('#lifetime');
  kv.textContent = '';
  const pairs = [
    ['Sessions', ov.sessions],
    ['Time studied', S.fmtMinutes(ov.studyMs)],
    ['Questions answered', ov.totalAsked.toLocaleString()],
    ['Overall accuracy', ov.totalAsked ? `${ov.accuracy}%` : '—'],
    ['Words studied', `${ov.seen.toLocaleString()} of ${ov.totalWords.toLocaleString()}`],
    ['Mastered', ov.mastered.toLocaleString()],
    ['Still learning', ov.learning.toLocaleString()],
    ['Trouble words', ov.trouble.toLocaleString()],
    ['Longest streak', `${st.longest} day${st.longest === 1 ? '' : 's'}`],
  ];
  for (const [k, v] of pairs) kv.append(el('span', { text: k }), el('span', { text: String(v) }));

  const leech = S.leeches(S.wordRows(WORDS, progress)).slice(0, 12);
  fillWordList($('#leechList'), leech.length
    ? leech.map((r) => ({ word: r.word, gloss: r.gloss, meta: `${r.lapses} lapses`, bad: true }))
    : [{ word: '—', gloss: 'No words are giving you repeated trouble.', meta: '' }]);
}

/* ----------------------------------------------------------------- nav --- */

function bindNav() {
  $$('.tab').forEach((tab) => tab.addEventListener('click', () => {
    const view = tab.dataset.view;
    $$('.tab').forEach((t) => t.classList.toggle('is-on', t === tab));
    $$('.view').forEach((v) => v.classList.toggle('is-active', v.id === `view-${view}`));
    if (view === 'progress') renderProgress();
    window.scrollTo(0, 0);
  }));
  $('#accountBtn').addEventListener('click', () => {
    $$('.tab').find((t) => t.dataset.view === 'settings')?.click();
  });
}

/* --------------------------------------------------------------- study --- */

function bindStudy() {
  const slider = $('#lenSlider');
  const setMinutes = (m, fromSlider = false) => {
    state.settings.minutes = m;
    $('#lenOut').textContent = `${m} min`;
    if (!fromSlider) slider.value = m;
    $$('#lenChips .chip').forEach((c) => c.classList.toggle('is-on', Number(c.dataset.min) === m));
    updatePlanLine();
    save();
  };

  $$('#lenChips .chip').forEach((chip) => chip.addEventListener('click', () => setMinutes(Number(chip.dataset.min))));
  slider.addEventListener('input', () => setMinutes(Number(slider.value), true));
  setMinutes(state.settings.minutes);

  $('#startBtn').addEventListener('click', startSession);
}

function startSession() {
  const plan = planSession({
    words: WORDS,
    progress: state.progress,
    settings: state.settings,
    sessions: state.sessions,
    minutes: state.settings.minutes,
  });

  if (!plan.queue.length) {
    toast('Nothing to study right now — everything is scheduled for later.');
    return;
  }

  session = new StudySession({
    plan,
    words: WORDS,
    byId: BY_ID,
    progress: state.progress,
    settings: state.settings,
    onFinish: recordSession,
  });

  $('#app').hidden = true;
  $('#quiz').hidden = false;
  startTimer();
  showQuestion();
}

function startTimer() {
  clearInterval(timerId);
  timerId = setInterval(() => {
    if (!session) return clearInterval(timerId);
    const frac = session.timeFraction();
    const fill = $('#timeFill');
    fill.style.width = `${frac * 100}%`;
    fill.classList.toggle('low', frac <= 0.25 && frac > 0.08);
    fill.classList.toggle('out', frac <= 0.08);
    if (frac <= 0 && !$('#qFeedback').hidden === false) { /* wait for answer */ }
  }, 250);
}

function showQuestion() {
  const q = session.next();
  if (!q) return endSession();

  $('#qFeedback').hidden = true;
  $('#qKind').textContent = q.mode === 'reverse' ? 'Which word means this?' : 'What does this word mean?';
  const prompt = $('#qPrompt');
  prompt.textContent = q.prompt;
  prompt.classList.toggle('is-def', q.mode === 'reverse');

  const rec = state.progress[q.word.i];
  const kind = q.entry.kind;
  $('#qTag').textContent = kind === 'new' && (!rec || rec.n === 0)
    ? 'new word'
    : kind === 'retry' ? 'seen earlier in this session'
      : rec && rec.lp >= 4 ? 'this one keeps slipping'
        : '';

  // The queue grows during a session (missed words are re-asked, and a fast
  // run tops up), so the denominator is the time budget, not the queue length.
  const est = Math.max(session.total, session.plan.counts.budget || session.total);
  $('#quizCount').textContent = `${session.cursor + 1}/${est}`;

  const host = $('#qOptions');
  host.textContent = '';
  q.options.forEach((opt, i) => {
    host.append(el('button', {
      class: 'opt',
      type: 'button',
      'data-id': opt.id,
      onclick: () => handleAnswer(opt.id),
    }, [
      el('span', { class: 'opt-key', text: String(i + 1) }),
      el('span', { class: 'opt-text', text: opt.text }),
    ]));
  });
}

function handleAnswer(optionId) {
  const buttons = $$('#qOptions .opt');
  if (buttons.some((b) => b.disabled)) return;
  const result = session.answer(optionId);
  if (!result) return;

  const correctId = session.current.correctId;
  buttons.forEach((b) => {
    const id = Number(b.dataset.id);
    b.disabled = true;
    if (id === correctId) b.classList.add('is-right');
    else if (id === optionId) b.classList.add('is-wrong');
    else b.classList.add('is-dim');
  });

  beep(result.correct);
  showFeedback(result);
}

function showFeedback(result) {
  const { word, correct, chosen } = result;
  const title = $('#fbTitle');
  const body = $('#fbBody');

  title.className = `fb-title ${correct ? 'good' : 'bad'}`;
  title.textContent = correct ? 'Correct' : 'Not quite';

  body.innerHTML = '';
  body.append(el('span', { html: `<b>${escapeHtml(word.w)}</b> — ${escapeHtml(word.d)}` }));

  // Seeing the word used is what makes it stick; the definition alone rarely does.
  if (word.e) {
    body.append(el('span', {
      class: 'example',
      html: highlightWord(word.e, word.w),
    }));
  }

  // The teaching moment: name the look-alike that caught them out.
  if (!correct && chosen && !chosen.correct) {
    body.append(el('span', {
      class: 'trap',
      html: session.current.mode === 'reverse'
        ? `You picked <b>${escapeHtml(chosen.word.w)}</b>, which means “${escapeHtml(chosen.word.g)}”.`
        : `“${escapeHtml(chosen.text)}” is <b>${escapeHtml(chosen.word.w)}</b> — easy to mix up.`,
    }));
  }
  if (!correct) body.append(el('span', { class: 'trap', text: 'You will see this one again shortly.' }));

  $('#qFeedback').hidden = false;
  $('#nextBtn').textContent = session.isOver() ? 'Finish' : 'Continue';

  if (state.settings.autoAdvance && correct) setTimeout(() => { if (!$('#qFeedback').hidden) advance(); }, 850);
  else $('#nextBtn').focus({ preventScroll: true });

  save();
}

function advance() {
  if (session.isOver()) endSession();
  else showQuestion();
}

function bindQuiz() {
  $('#nextBtn').addEventListener('click', advance);
  $('#quitBtn').addEventListener('click', () => {
    if (session && session.answered > 0) endSession();
    else closeQuiz();
  });

  document.addEventListener('keydown', (e) => {
    if ($('#quiz').hidden) return;
    if (e.key === 'Escape') { $('#quitBtn').click(); return; }
    if (!$('#qFeedback').hidden) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); advance(); }
      return;
    }
    const n = Number(e.key);
    if (n >= 1 && n <= 4) {
      const btn = $$('#qOptions .opt')[n - 1];
      if (btn && !btn.disabled) { e.preventDefault(); btn.click(); }
    }
  });
}

function endSession() {
  const summary = session.finish();
  clearInterval(timerId);
  showSummary(summary);
}

function closeQuiz() {
  clearInterval(timerId);
  session = null;
  $('#quiz').hidden = true;
  $('#app').hidden = false;
  renderAll();
}

/** Called by StudySession.finish — appends to the log and syncs. */
function recordSession(summary) {
  const mastered = Object.values(state.progress).filter((r) => r.ma).length;
  state.sessions.push({
    id: summary.id,
    start: summary.start,
    end: summary.end,
    planMin: summary.planMin,
    ms: summary.ms,
    items: summary.items,
    correct: summary.correct,
    newWords: summary.newWords,
    reviews: summary.reviews,
    masteredAfter: mastered,
    seenAfter: Object.keys(state.progress).length,
  });
  save({ immediate: true });
  push({ force: true });
}

/* -------------------------------------------------------------- summary --- */

function showSummary(sum) {
  $('#quiz').hidden = true;
  $('#summary').hidden = false;

  const acc = sum.items ? Math.round((sum.correct / sum.items) * 100) : 0;
  $('#sumAcc').textContent = `${acc}%`;
  $('#sumItems').textContent = sum.items;
  $('#sumNew').textContent = sum.newWords;
  $('#sumTime').textContent = S.fmtMinutes(sum.ms);
  $('#sumTitle').textContent = acc >= 90 ? 'Strong session' : acc >= 70 ? 'Session complete' : 'Session complete';

  const missed = sum.missed.map((id) => BY_ID[id]).filter(Boolean);
  $('#sumMissedWrap').hidden = missed.length === 0;
  fillWordList($('#sumMissed'), missed.map((w) => ({
    word: w.w, gloss: w.g,
    meta: sum.recovered.includes(w.i) ? 'got it on retry' : 'coming back',
    bad: !sum.recovered.includes(w.i),
  })));

  const learned = sum.learned.map((id) => BY_ID[id]).filter(Boolean);
  $('#sumLearnedWrap').hidden = learned.length === 0;
  fillWordList($('#sumLearned'), learned.slice(0, 25).map((w) => ({ word: w.w, gloss: w.g, meta: '' })));
}

function bindSummary() {
  $('#doneBtn').addEventListener('click', () => {
    $('#summary').hidden = true;
    closeQuiz();
  });
  $('#againBtn').addEventListener('click', () => {
    $('#summary').hidden = true;
    session = null;
    startSession();
  });
}

/* ------------------------------------------------------------- settings --- */

function bindSettings() {
  const bind = (sel, key, kind = 'check') => {
    const node = $(sel);
    if (kind === 'check') node.checked = !!state.settings[key];
    else node.value = String(state.settings[key]);
    node.addEventListener('change', () => {
      state.settings[key] = kind === 'check' ? node.checked
        : key === 'dailyGoal' ? Number(node.value) : node.value;
      save();
      if (key === 'dailyGoal') renderStudy();
    });
  };
  bind('#optReverse', 'reverse');
  bind('#optSound', 'sound');
  bind('#optAuto', 'autoAdvance');
  bind('#optTier', 'tierMode', 'value');
  bind('#optGoal', 'dailyGoal', 'value');

  $('#resetBtn').addEventListener('click', () => {
    if (!confirm('Erase all progress on this account? This cannot be undone.')) return;
    resetProgress();
    push({ force: true });
    renderAll();
    toast('Progress erased.');
  });

  $('#importBtn').addEventListener('click', () => $('#importFile').click());
  $('#importFile').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      if (!parsed || typeof parsed !== 'object' || !parsed.progress) throw new Error('Not a SAT Vocab backup');
      replaceState(parsed);
      push({ force: true });
      renderAll();
      toast('Backup restored.', 'good');
    } catch (err) {
      toast(`Could not read that file: ${err.message}`, 'bad');
    }
    e.target.value = '';
  });
}

/* --------------------------------------------------------------- export --- */

function bindExport() {
  const msg = $('#exportMsg');
  const btn = $('#exportSheetBtn');
  if (!hasSheets()) {
    btn.disabled = true;
    btn.textContent = 'Export to Google Sheets (needs setup)';
    msg.textContent = 'Add a Google OAuth client ID in assets/js/config.js to enable this. CSV works without setup.';
  }

  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      const { url, meta } = await exportToSheets(
        { words: WORDS, progress: state.progress, sessions: state.sessions, settings: state.settings },
        (s) => { msg.textContent = s; },
      );
      msg.innerHTML = `Done — <a href="${url}" target="_blank" rel="noopener">open your spreadsheet</a> (${meta.rows} words, ${meta.sessions} sessions).`;
      window.open(url, '_blank', 'noopener');
    } catch (err) {
      msg.textContent = `Export failed: ${err.message}`;
      toast(`Export failed: ${err.message}`, 'bad');
    } finally {
      btn.disabled = false;
    }
  });

  $('#exportCsvBtn').addEventListener('click', () => {
    if (!Object.keys(state.progress).length) return toast('Study something first.', 'bad');
    download(`sat-vocab-words-${S.dateKey(Date.now())}.csv`,
      wordCsv({ words: WORDS, progress: state.progress, sessions: state.sessions, settings: state.settings }));
    msg.textContent = 'CSV downloaded — File ▸ Import in Google Sheets.';
  });

  $('#exportJsonBtn').addEventListener('click', () => {
    download(`sat-vocab-backup-${S.dateKey(Date.now())}.json`,
      JSON.stringify(snapshot(), null, 2), 'application/json');
    msg.textContent = 'Backup downloaded.';
  });
}

/* -------------------------------------------------------------- account --- */

function bindAccount() {
  onAuthChange(() => { renderAccount(); renderSyncPill(); });
  renderSyncPill();
}

function renderSyncPill() {
  const pill = $('#syncPill');
  const map = {
    local: ['Local', 'pill pill-muted'],
    'signed-out': ['Not synced', 'pill pill-warn'],
    'signed-in': ['Synced', 'pill pill-ok'],
    error: ['Sync error', 'pill pill-warn'],
  };
  const [text, cls] = map[authState.mode] || map.local;
  pill.textContent = authState.syncing ? 'Syncing…' : text;
  pill.className = cls;
  pill.title = authState.error || (authState.lastSync ? `Last sync ${new Date(authState.lastSync).toLocaleTimeString()}` : '');
}

function renderAccount() {
  const box = $('#accountBox');
  box.textContent = '';

  if (!hasSync()) {
    box.append(
      el('p', { class: 'hint', text: 'Progress is saved in this browser only. To share it between your phone and your computer, add a Firebase project to assets/js/config.js — see the README.' }),
    );
    return;
  }

  if (authState.mode === 'signed-in') {
    const u = authState.user;
    box.append(el('div', { class: 'account-user' }, [
      u.photo ? el('img', { src: u.photo, alt: '', referrerpolicy: 'no-referrer' }) : null,
      el('div', {}, [el('b', { text: u.name || 'Signed in' }), el('small', { text: u.email || '' })]),
    ]));
    box.append(el('button', {
      class: 'btn btn-ghost', text: 'Sign out',
      onclick: async () => { await signOut(); renderAll(); },
    }));
    return;
  }

  box.append(el('button', {
    class: 'btn btn-secondary', text: 'Sign in with Google',
    onclick: async (e) => {
      e.target.disabled = true;
      try { await signIn(); } catch (err) { toast(`Sign-in failed: ${err.message}`, 'bad'); }
      e.target.disabled = false;
    },
  }));
  if (authState.error) box.append(el('p', { class: 'hint', text: authState.error }));
}

/* ---------------------------------------------------------------- misc --- */

/** Show the example sentence with the target word picked out. */
function highlightWord(sentence, word) {
  const safe = escapeHtml(sentence);
  const stem = word.replace(/[^a-z]/gi, '').slice(0, Math.max(4, word.length - 3));
  if (!stem) return safe;
  const re = new RegExp(`\\b(${stem}[a-z]*)`, 'i');
  return safe.replace(re, '<em>$1</em>');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

let audioCtx = null;
function beep(good) {
  if (!state.settings.sound) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain); gain.connect(audioCtx.destination);
    osc.frequency.value = good ? 660 : 220;
    osc.type = 'sine';
    gain.gain.setValueAtTime(0.0001, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.06, audioCtx.currentTime + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.16);
    osc.start(); osc.stop(audioCtx.currentTime + 0.18);
  } catch { /* audio is a nicety */ }
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  if (location.protocol === 'file:') return;
  navigator.serviceWorker.register('sw.js').catch((err) => console.warn('[sw]', err));
}
