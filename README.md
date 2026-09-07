# Lexicon — SAT vocabulary trainer

A short-session SAT vocab trainer that works on a phone and a computer and keeps
one shared record of what you know. 3,660 words, ordered by how often they
actually turn up, with a spaced-repetition scheduler and multiple-choice
questions whose wrong answers are the words people genuinely mix up.

Static site — no server to run. Host it free on GitHub Pages.

---

## How it decides what to ask

**High-frequency first.** The word list comes from
[sesamewords](https://sites.google.com/site/sesamewords/home), which is already
sorted into three frequency bands. New words are always introduced in that
order, so the top band is finished before the mid band is touched. That is also
what keeps difficulty from jumping between sessions: tomorrow's session is the
same shape as today's, one notch along.

**Each session ramps on its own.** Items are ordered by how hard they should
feel *to you* — a rare word you know well is an easy item; a common word you
keep missing is a hard one. Sessions open with a warm-up you can definitely get,
and the stretch material lands at the end. Difficulty climbs *within* a session,
not *across* them.

**You set the clock.** Pick 3–45 minutes. The app estimates how many questions
fit from your own answering speed, and tops the queue up if you are moving
faster than expected, so a 15-minute session takes 15 minutes.

**Missed words come back — but not immediately.** Miss a word and it returns
later in the same session, never sooner than 5 questions later. After that it is
handed to the scheduler, which deliberately skips a session before showing it
again, then widens the gap each time you get it right. It does not hound you
with the same word every single session.

**Learned means learned.** A word is marked mastered after roughly four correct
answers in a row, spread over at least three separate sessions and about two
weeks of widening gaps, with lifetime accuracy of 75%+ on it. Mastered words
drop out of rotation but still get occasional maintenance checks; missing one
un-masters it immediately.

### The wrong answers

This is the part that makes or breaks a vocabulary quiz. Each question shows a
word and four short meanings. The three wrong ones are the meanings of words
that *look or sound like* the target:

| Word | Correct | Wrong answers actually belong to |
|---|---|---|
| preclude | prevent | precede, seclude, prelate |
| palatable | acceptable to the taste | palpable, palliate, palliative |
| disseminate | broadcast | dissemble, dissipate, dissent |
| expedite | rush | expedient, expiate, exploit |

Candidates are precomputed by `tools/build-words.mjs` using a phonetic key, edit
distance and shared-prefix weighting. Crucially, any candidate whose *meaning*
overlaps the target's is thrown out — no synonyms, no morphological relatives
like *innovation/innovative*. A wrong answer is never quietly also right, so if
you know the word you get it right; if you only half-recognise its shape, you
don't. When you do slip, the feedback names the word that caught you.

---

## Running it

Any static file server. Opening `index.html` directly will **not** work — ES
modules and `fetch` need a real origin.

```bash
python -m http.server 8000
```

Then open <http://localhost:8000>.

## Putting it on GitHub Pages

```bash
git remote add origin https://github.com/YOUR-USERNAME/YOUR-REPO.git
git push -u origin main
```

In the repo, **Settings ▸ Pages ▸ Source: GitHub Actions**. The included
workflow (`.github/workflows/deploy.yml`) publishes on every push to `main`.
Your app lands at `https://YOUR-USERNAME.github.io/YOUR-REPO/`.

On your phone, open that URL and use **Add to Home Screen** — it installs as an
app and works offline.

---

## Turning on sync (optional)

Without this, progress is saved per-browser and the app says "Local". Everything
else works. To share progress between devices you need a free Firebase project.

1. <https://console.firebase.google.com> → **Add project** (disable Analytics).
2. **Build ▸ Authentication ▸ Get started ▸ Google** → enable → Save.
3. **Build ▸ Firestore Database ▸ Create database** → production mode.
4. Firestore ▸ **Rules** → paste this and Publish. It lets each person read and
   write only their own document:

   ```
   rules_version = '2';
   service cloud.firestore {
     match /databases/{database}/documents {
       match /users/{uid} {
         allow read, write: if request.auth != null && request.auth.uid == uid;
       }
     }
   }
   ```

5. **Project settings ▸ General ▸ Your apps ▸ Web (`</>`)** → register the app →
   copy the config values into `assets/js/config.js`.
6. **Authentication ▸ Settings ▸ Authorized domains** → add
   `YOUR-USERNAME.github.io`.

Sign in with the same Google account on both devices and they stay in step.
Merges are per-word: a session studied on the phone while offline is not erased
by the laptop's next write.

## Turning on Google Sheets export (optional)

1. <https://console.cloud.google.com> → pick the same project as Firebase.
2. **APIs & Services ▸ Library** → enable **Google Sheets API**.
3. **OAuth consent screen** → External → add yourself under **Test users**.
4. **Credentials ▸ Create credentials ▸ OAuth client ID ▸ Web application**.
   Under *Authorised JavaScript origins* add `http://localhost:8000` and
   `https://YOUR-USERNAME.github.io`.
5. Paste the client ID into `googleClientId` in `assets/js/config.js`.

The export asks only for the `drive.file` scope, which grants access to files
this app itself creates — it cannot see anything else in your Drive.

### What lands in the spreadsheet

Eight tabs, formatted, with four charts and live formulas:

| Tab | What it is for |
|---|---|
| **Dashboard** | Coverage, performance, habit and "what to do next", with formulas that recalculate if you edit the other tabs |
| **Missed Words** | Every word you have ever missed, worst first, with a red→green scale on miss rate |
| **All Words** | Full record per word: interval, ease, strength, streak, next review |
| **Sessions** | One row per session + charts for accuracy and cumulative mastery |
| **Daily** | Per-day rollup + a questions-per-day chart |
| **Tiers** | How far through each frequency band you are, as a chart |
| **Trouble Words** | Words that keep lapsing, with a suggested action for each |
| **Forecast** | Reviews coming due over the next 14 days |

No Google account? **Download CSV** gives you the All Words table, and
**Download JSON backup** gives you everything back (restorable from Settings).

---

## Rebuilding the word list

`data/words.json` is generated. The source HTML pages are in `tools/`.

```bash
node tools/build-words.mjs
```

It parses the three frequency lists, de-duplicates across them (a word in more
than one list keeps its highest-frequency entry), scores difficulty, and
precomputes each word's confusable set. Bump `CACHE` in `sw.js` afterwards so
returning visitors pick up the new file.

## Layout

```
index.html              app shell
assets/css/style.css    all styling
assets/js/
  main.js               wiring, rendering, session flow
  session.js            session planning, the difficulty ramp, in-session retries
  scheduler.js          spaced repetition, mastery, the "skip a session" gate
  quiz.js               question building and distractor fairness rules
  stats.js              every derived number, shared by the UI and the export
  store.js              persistence and the two-device merge rules
  auth.js               optional Google sign-in + Firestore sync
  sheets.js             Google Sheets workbook builder, CSV/JSON fallbacks
  ui.js                 DOM helpers and inline SVG charts
  config.js             ← the only file you edit
data/words.json         generated word list
tools/build-words.mjs   generator
```

## Keyboard

`1`–`4` answer · `Enter` / `Space` continue · `Esc` end session.

## Credit

Word list and definitions from
[sesamewords](https://sites.google.com/site/sesamewords/home).
