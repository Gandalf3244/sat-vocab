/**
 * sheets.js — builds a real, formatted Google Sheets workbook from the user's
 * progress: eight tabs, live formulas, conditional formatting and four charts.
 *
 * Scope used is drive.file, which only ever grants access to files this app
 * itself creates — it cannot read anything else in the user's Drive.
 */

import { googleClientId, hasSheets } from './config.js';
import * as S from './stats.js';

const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const API = 'https://sheets.googleapis.com/v4/spreadsheets';

const SHEETS = {
  dashboard: { id: 0, title: 'Dashboard' },
  missed: { id: 1, title: 'Missed Words' },
  all: { id: 2, title: 'All Words' },
  sessions: { id: 3, title: 'Sessions' },
  dailyTab: { id: 4, title: 'Daily' },
  tiers: { id: 5, title: 'Tiers' },
  trouble: { id: 6, title: 'Trouble Words' },
  forecast: { id: 7, title: 'Forecast' },
};

/* ----------------------------------------------------------------- auth --- */

let tokenClient = null;
let cachedToken = null;
let tokenExpiry = 0;

function loadGis() {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const existing = document.querySelector('script[data-gis]');
    if (existing) { existing.addEventListener('load', resolve); existing.addEventListener('error', reject); return; }
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true; s.defer = true; s.dataset.gis = '1';
    s.onload = resolve;
    s.onerror = () => reject(new Error('Could not load Google sign-in script'));
    document.head.appendChild(s);
  });
}

async function getToken() {
  if (!hasSheets()) throw new Error('No Google client ID configured — see README, "Turning on Sheets export".');
  if (cachedToken && Date.now() < tokenExpiry - 60000) return cachedToken;
  await loadGis();
  return new Promise((resolve, reject) => {
    tokenClient = window.google.accounts.oauth2.initTokenClient({
      client_id: googleClientId,
      scope: SCOPE,
      callback: (res) => {
        if (res.error) return reject(new Error(res.error_description || res.error));
        cachedToken = res.access_token;
        tokenExpiry = Date.now() + (Number(res.expires_in) || 3600) * 1000;
        resolve(cachedToken);
      },
      error_callback: (err) => reject(new Error(err?.message || 'Google authorisation was cancelled')),
    });
    tokenClient.requestAccessToken({ prompt: '' });
  });
}

async function api(url, method, body, token) {
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let msg = `${res.status} ${res.statusText}`;
    try { msg = JSON.parse(text).error?.message || msg; } catch { /* keep status */ }
    throw new Error(msg);
  }
  return res.json();
}

/* ---------------------------------------------------------------- table --- */

const ts = (v) => {
  if (!v) return '';
  const d = new Date(v);
  return `${S.dateKey(v)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
const day = (v) => (v ? S.dateKey(v) : '');
const sec = (ms) => (ms ? Math.round(ms / 100) / 10 : '');

function buildTables({ words, progress, sessions, settings }) {
  const rows = S.wordRows(words, progress);
  const ov = S.overview(words, progress, sessions);
  const st = S.streaks(sessions, settings.dailyGoal || 1);
  const tiers = S.tierProgress(words, progress);
  const dailyMap = S.daily(sessions);
  const series = S.sessionSeries(sessions);
  const fc = S.forecast(progress, 14);
  const missed = S.missedWords(rows);
  const leech = S.leeches(rows);
  const dueToday = fc[0]?.count || 0;
  const due7 = fc.slice(0, 7).reduce((a, d) => a + d.count, 0);
  const avgMs = rows.length ? rows.reduce((a, r) => a + (r.avgMs || 0) * r.asked, 0) / Math.max(1, ov.totalAsked) : 0;

  /* ---- Dashboard: labels + values, with formulas where staying live helps -- */
  const A = SHEETS.all.title;
  const dashboard = [
    ['SAT Vocab — Vocabulary Report', ''],
    ['Generated', ts(Date.now())],
    ['', ''],
    ['COVERAGE', ''],
    ['Words in the list', ov.totalWords],
    ['Words studied', `=COUNTA('${A}'!A2:A)`],
    ['Mastered', `=COUNTIF('${A}'!J2:J,"mastered")`],
    ['Still learning', `=COUNTIF('${A}'!J2:J,"learning")+COUNTIF('${A}'!J2:J,"relearning")+COUNTIF('${A}'!J2:J,"strong")`],
    ['Trouble words', `=COUNTIF('${A}'!J2:J,"trouble")`],
    ['Not started yet', `=B5-B6`],
    ['Share of list studied', `=IFERROR(B6/B5,0)`],
    ['Share of list mastered', `=IFERROR(B7/B5,0)`],
    ['', ''],
    ['PERFORMANCE', ''],
    ['Questions answered', ov.totalAsked],
    ['Answered correctly', ov.totalRight],
    ['Overall accuracy', ov.totalAsked ? ov.totalRight / ov.totalAsked : 0],
    ['Accuracy, last 10 sessions', `=IFERROR(AVERAGE(QUERY('${SHEETS.sessions.title}'!H2:H,"order by Col1 desc limit 10")),0)`],
    ['Average seconds per question', Math.round((avgMs / 1000) * 10) / 10],
    ['', ''],
    ['HABIT', ''],
    ['Sessions completed', sessions.length],
    ['Total study time (minutes)', Math.round(ov.studyMs / 60000)],
    ['Average session (minutes)', Math.round((ov.avgSessionMs / 60000) * 10) / 10],
    ['Current streak (days)', st.current],
    ['Longest streak (days)', st.longest],
    ['Days studied', dailyMap.size],
    ['Daily goal (sessions/day)', settings.dailyGoal || 1],
    ['', ''],
    ['WHAT TO DO NEXT', ''],
    ['Reviews due now', dueToday],
    ['Reviews due in the next 7 days', due7],
    ['Words missed at least once', missed.length],
    ['Worst word right now', missed[0] ? `${missed[0].word} — ${missed[0].gloss}` : '—'],
    ['Suggested next session (minutes)', Math.max(5, Math.min(30, Math.ceil(due7 / 7 / 8) * 5 || 10))],
  ];

  const missedHeader = ['Word', 'Meaning', 'Full definition', 'Tier', 'Lesson', 'Freq rank',
    'Asked', 'Missed', 'Miss rate', 'Accuracy', 'Lapses', 'Status', 'Last seen', 'Next review', 'Avg sec'];
  const missedRows = missed.map((r) => [
    r.word, r.gloss, r.definition, r.tierName, r.lesson, r.rank,
    r.asked, r.missed, r.asked ? r.missed / r.asked : 0, r.accuracy, r.lapses, r.status,
    day(r.lastSeen), day(r.due), sec(r.avgMs),
  ]);

  const allHeader = ['Word', 'Meaning', 'Full definition', 'Tier', 'Lesson', 'Freq rank', 'Difficulty',
    'Asked', 'Correct', 'Status', 'Accuracy', 'Missed', 'Lapses', 'Streak', 'Sessions seen',
    'Interval (days)', 'Ease', 'Strength', 'Avg sec', 'First seen', 'Last seen', 'Next review'];
  const allRows = rows
    .slice()
    .sort((a, b) => a.tier - b.tier || a.rank - b.rank)
    .map((r) => [
      r.word, r.gloss, r.definition, r.tierName, r.lesson, r.rank, r.difficulty,
      r.asked, r.correct, r.status, r.accuracy, r.missed, r.lapses, r.streak, r.sessionsSeen,
      r.intervalDays, r.ease, r.strength, sec(r.avgMs), day(r.firstSeen), day(r.lastSeen), day(r.due),
    ]);

  const sessionHeader = ['#', 'Date', 'Started', 'Planned min', 'Actual min', 'Questions', 'Correct',
    'Accuracy', 'New words', 'Reviews', 'Sec per question', 'Mastered after'];
  const sessionRows = sessions.map((s, i) => [
    i + 1, day(s.start), ts(s.start), s.planMin || '', Math.round((s.ms / 60000) * 10) / 10,
    s.items || 0, s.correct || 0, s.items ? s.correct / s.items : 0,
    s.newWords || 0, s.reviews || 0,
    s.items ? Math.round((s.ms / s.items / 100)) / 10 : '',
    s.masteredAfter ?? '',
  ]);

  const dailyHeader = ['Date', 'Sessions', 'Minutes', 'Questions', 'Correct', 'Accuracy', 'New words'];
  const dailyRows = [...dailyMap.values()]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((d) => [d.date, d.sessions, Math.round(d.ms / 60000), d.items, d.correct,
      d.items ? d.correct / d.items : 0, d.newWords]);

  const tierNames = { 1: 'Highest frequency', 2: 'Mid frequency', 3: 'Lower frequency (rarest)' };
  const tierHeader = ['Tier', 'Band', 'Words', 'Studied', 'Mastered', 'Share studied', 'Share mastered', 'Remaining'];
  const tierRows = tiers.map((t) => [
    t.tier, tierNames[t.tier] || `Tier ${t.tier}`, t.total, t.seen, t.mastered,
    t.total ? t.seen / t.total : 0, t.total ? t.mastered / t.total : 0, t.total - t.seen,
  ]);

  const troubleHeader = ['Word', 'Meaning', 'Full definition', 'Lapses', 'Asked', 'Accuracy',
    'Interval (days)', 'Next review', 'Suggested action'];
  const troubleRows = leech.map((r) => [
    r.word, r.gloss, r.definition, r.lapses, r.asked, r.accuracy, r.intervalDays, day(r.due),
    r.lapses >= 8 ? 'Write your own sentence with it — the multiple choice is not sticking'
      : r.accuracy < 0.4 ? 'Look at which look-alike word keeps fooling you'
        : 'Keep reviewing; it is close',
  ]);

  const forecastHeader = ['Date', 'Reviews due'];
  const forecastRows = fc.map((d) => [d.date, d.count]);

  return {
    dashboard,
    missed: [missedHeader, ...missedRows],
    all: [allHeader, ...allRows],
    sessions: [sessionHeader, ...sessionRows],
    dailyTab: [dailyHeader, ...dailyRows],
    tiers: [tierHeader, ...tierRows],
    trouble: [troubleHeader, ...troubleRows],
    forecast: [forecastHeader, ...forecastRows],
    meta: { rows: rows.length, missed: missed.length, sessions: sessions.length, daily: dailyMap.size, leech: leech.length },
  };
}

/* ------------------------------------------------------------ formatting --- */

const HEADER_BG = { red: 0.13, green: 0.16, blue: 0.22 };
const HEADER_FG = { red: 0.91, green: 0.93, blue: 0.96 };

const headerFormat = (sheetId, cols) => ([
  {
    repeatCell: {
      range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: cols },
      cell: {
        userEnteredFormat: {
          backgroundColor: HEADER_BG,
          textFormat: { bold: true, foregroundColor: HEADER_FG },
          verticalAlignment: 'MIDDLE',
        },
      },
      fields: 'userEnteredFormat(backgroundColor,textFormat,verticalAlignment)',
    },
  },
  { updateSheetProperties: { properties: { sheetId, gridProperties: { frozenRowCount: 1 } }, fields: 'gridProperties.frozenRowCount' } },
  { setBasicFilter: { filter: { range: { sheetId, startRowIndex: 0, startColumnIndex: 0, endColumnIndex: cols } } } },
  { autoResizeDimensions: { dimensions: { sheetId, dimension: 'COLUMNS', startIndex: 0, endIndex: cols } } },
]);

const percentCols = (sheetId, colIndexes, rowCount) => colIndexes.map((c) => ({
  repeatCell: {
    range: { sheetId, startRowIndex: 1, endRowIndex: Math.max(2, rowCount), startColumnIndex: c, endColumnIndex: c + 1 },
    cell: { userEnteredFormat: { numberFormat: { type: 'PERCENT', pattern: '0.0%' } } },
    fields: 'userEnteredFormat.numberFormat',
  },
}));

const colWidth = (sheetId, index, pixels) => ({
  updateDimensionProperties: {
    range: { sheetId, dimension: 'COLUMNS', startIndex: index, endIndex: index + 1 },
    properties: { pixelSize: pixels },
    fields: 'pixelSize',
  },
});

/** Red-to-green scale across a numeric column. */
const colorScale = (sheetId, col, rowCount, reverse = false) => ({
  addConditionalFormatRule: {
    rule: {
      ranges: [{ sheetId, startRowIndex: 1, endRowIndex: Math.max(2, rowCount), startColumnIndex: col, endColumnIndex: col + 1 }],
      gradientRule: {
        minpoint: { color: reverse ? { red: 0.36, green: 0.79, blue: 0.6 } : { red: 0.96, green: 0.55, blue: 0.6 }, type: 'MIN' },
        maxpoint: { color: reverse ? { red: 0.96, green: 0.55, blue: 0.6 } : { red: 0.36, green: 0.79, blue: 0.6 }, type: 'MAX' },
      },
    },
    index: 0,
  },
});

function chartRequest({ sheetId, title, chartType, domain, series, anchorCol, anchorRow, legend = 'NONE' }) {
  return {
    addChart: {
      chart: {
        spec: {
          title,
          basicChart: {
            chartType,
            legendPosition: legend,
            headerCount: 1,
            domains: [{ domain: { sourceRange: { sources: [domain] } } }],
            series: series.map((s) => ({ series: { sourceRange: { sources: [s] } }, targetAxis: 'LEFT_AXIS' })),
          },
        },
        position: { overlayPosition: { anchorCell: { sheetId, rowIndex: anchorRow, columnIndex: anchorCol }, widthPixels: 620, heightPixels: 320 } },
      },
    },
  };
}

const src = (sheetId, startCol, endCol, rowCount) => ({
  sheetId, startRowIndex: 0, endRowIndex: Math.max(2, rowCount), startColumnIndex: startCol, endColumnIndex: endCol,
});

function formatRequests(t) {
  const r = [];
  const n = (k) => t[k].length;

  /* Dashboard ------------------------------------------------------------- */
  r.push(
    { updateSheetProperties: { properties: { sheetId: SHEETS.dashboard.id, gridProperties: { frozenRowCount: 2 } }, fields: 'gridProperties.frozenRowCount' } },
    {
      repeatCell: {
        range: { sheetId: SHEETS.dashboard.id, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 2 },
        cell: { userEnteredFormat: { textFormat: { bold: true, fontSize: 15 } } },
        fields: 'userEnteredFormat.textFormat',
      },
    },
    colWidth(SHEETS.dashboard.id, 0, 250),
    colWidth(SHEETS.dashboard.id, 1, 210),
  );
  // Bold the section headers (rows are fixed by buildTables).
  for (const row of [3, 13, 20, 29]) {
    r.push({
      repeatCell: {
        range: { sheetId: SHEETS.dashboard.id, startRowIndex: row, endRowIndex: row + 1, startColumnIndex: 0, endColumnIndex: 2 },
        cell: { userEnteredFormat: { backgroundColor: HEADER_BG, textFormat: { bold: true, foregroundColor: HEADER_FG } } },
        fields: 'userEnteredFormat(backgroundColor,textFormat)',
      },
    });
  }
  for (const row of [10, 11, 16, 17]) {
    r.push({
      repeatCell: {
        range: { sheetId: SHEETS.dashboard.id, startRowIndex: row, endRowIndex: row + 1, startColumnIndex: 1, endColumnIndex: 2 },
        cell: { userEnteredFormat: { numberFormat: { type: 'PERCENT', pattern: '0.0%' } } },
        fields: 'userEnteredFormat.numberFormat',
      },
    });
  }

  /* Missed Words ---------------------------------------------------------- */
  r.push(...headerFormat(SHEETS.missed.id, 15));
  r.push(...percentCols(SHEETS.missed.id, [8, 9], n('missed')));
  r.push(colWidth(SHEETS.missed.id, 2, 380), colorScale(SHEETS.missed.id, 8, n('missed')));

  /* All Words ------------------------------------------------------------- */
  r.push(...headerFormat(SHEETS.all.id, 22));
  r.push(...percentCols(SHEETS.all.id, [10], n('all')));
  r.push(colWidth(SHEETS.all.id, 2, 380), colorScale(SHEETS.all.id, 10, n('all'), true));

  /* Sessions -------------------------------------------------------------- */
  r.push(...headerFormat(SHEETS.sessions.id, 12));
  r.push(...percentCols(SHEETS.sessions.id, [7], n('sessions')));
  r.push(chartRequest({
    sheetId: SHEETS.sessions.id, title: 'Accuracy by session', chartType: 'LINE',
    domain: src(SHEETS.sessions.id, 0, 1, n('sessions')),
    series: [src(SHEETS.sessions.id, 7, 8, n('sessions'))],
    anchorCol: 13, anchorRow: 1,
  }));
  r.push(chartRequest({
    sheetId: SHEETS.sessions.id, title: 'Words mastered over time', chartType: 'LINE',
    domain: src(SHEETS.sessions.id, 0, 1, n('sessions')),
    series: [src(SHEETS.sessions.id, 11, 12, n('sessions'))],
    anchorCol: 13, anchorRow: 20,
  }));

  /* Daily ----------------------------------------------------------------- */
  r.push(...headerFormat(SHEETS.dailyTab.id, 7));
  r.push(...percentCols(SHEETS.dailyTab.id, [5], n('dailyTab')));
  r.push(chartRequest({
    sheetId: SHEETS.dailyTab.id, title: 'Questions answered per day', chartType: 'COLUMN',
    domain: src(SHEETS.dailyTab.id, 0, 1, n('dailyTab')),
    series: [src(SHEETS.dailyTab.id, 3, 4, n('dailyTab'))],
    anchorCol: 8, anchorRow: 1,
  }));

  /* Tiers ----------------------------------------------------------------- */
  r.push(...headerFormat(SHEETS.tiers.id, 8));
  r.push(...percentCols(SHEETS.tiers.id, [5, 6], n('tiers')));
  r.push(chartRequest({
    sheetId: SHEETS.tiers.id, title: 'Progress through each frequency band', chartType: 'COLUMN',
    domain: src(SHEETS.tiers.id, 1, 2, n('tiers')),
    series: [src(SHEETS.tiers.id, 5, 6, n('tiers')), src(SHEETS.tiers.id, 6, 7, n('tiers'))],
    anchorCol: 9, anchorRow: 1, legend: 'BOTTOM_LEGEND',
  }));

  /* Trouble --------------------------------------------------------------- */
  r.push(...headerFormat(SHEETS.trouble.id, 9));
  r.push(...percentCols(SHEETS.trouble.id, [5], n('trouble')));
  r.push(colWidth(SHEETS.trouble.id, 2, 340), colWidth(SHEETS.trouble.id, 8, 320));

  /* Forecast -------------------------------------------------------------- */
  r.push(...headerFormat(SHEETS.forecast.id, 2));
  r.push(chartRequest({
    sheetId: SHEETS.forecast.id, title: 'Reviews coming due', chartType: 'COLUMN',
    domain: src(SHEETS.forecast.id, 0, 1, n('forecast')),
    series: [src(SHEETS.forecast.id, 1, 2, n('forecast'))],
    anchorCol: 3, anchorRow: 1,
  }));

  return r;
}

/* ----------------------------------------------------------------- main --- */

export async function exportToSheets(data, onStatus = () => {}) {
  onStatus('Asking Google for permission…');
  const token = await getToken();

  onStatus('Building the workbook…');
  const t = buildTables(data);

  const title = `SAT Vocab — ${S.dateKey(Date.now())}`;
  const created = await api(API, 'POST', {
    properties: { title, locale: 'en_US' },
    sheets: Object.values(SHEETS).map((s) => ({
      properties: { sheetId: s.id, title: s.title, gridProperties: { rowCount: 1000, columnCount: 26 } },
    })),
  }, token);

  const spreadsheetId = created.spreadsheetId;
  onStatus('Writing your data…');
  await api(`${API}/${spreadsheetId}/values:batchUpdate`, 'POST', {
    valueInputOption: 'USER_ENTERED',
    data: [
      { range: `'${SHEETS.dashboard.title}'!A1`, values: t.dashboard },
      { range: `'${SHEETS.missed.title}'!A1`, values: t.missed },
      { range: `'${SHEETS.all.title}'!A1`, values: t.all },
      { range: `'${SHEETS.sessions.title}'!A1`, values: t.sessions },
      { range: `'${SHEETS.dailyTab.title}'!A1`, values: t.dailyTab },
      { range: `'${SHEETS.tiers.title}'!A1`, values: t.tiers },
      { range: `'${SHEETS.trouble.title}'!A1`, values: t.trouble },
      { range: `'${SHEETS.forecast.title}'!A1`, values: t.forecast },
    ],
  }, token);

  onStatus('Formatting and adding charts…');
  try {
    await api(`${API}/${spreadsheetId}:batchUpdate`, 'POST', { requests: formatRequests(t) }, token);
  } catch (err) {
    // The data is already safely written; losing the cosmetics is survivable.
    console.warn('[sheets] formatting pass failed', err);
  }

  return { url: created.spreadsheetUrl || `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`, title, meta: t.meta };
}

/* ------------------------------------------------------- offline exports --- */

const csvCell = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function toCsv(rows) {
  return rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
}

/** Same word table as the "All Words" tab, for people who would rather not
 *  connect a Google account at all. */
export function wordCsv(data) {
  const t = buildTables(data);
  return toCsv(t.all);
}

export function download(filename, text, type = 'text/csv;charset=utf-8') {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
