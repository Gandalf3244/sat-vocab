# SAT Vocab

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

This is the part that makes or breaks a vocabulary quiz. The goal is that
**nothing can be eliminated without knowing the word** — no throwaway option
that is obviously the wrong kind of thing.

| Word | The four choices |
|---|---|
| benign | mild · exact · crazed · instinctive |
| retract | take back · go over · bend sharply · show off |
| apprehension | dread · specter · criticism · scrape |
| palatable | acceptable to the taste · impossible to rely on · hard to manage · possible to quantify |

What makes those work is not that the wrong answers are *close in meaning* —
they are not. It is that all four are the **same part of speech, the same shape,
and the same register**, so grammar and style give nothing away. An earlier
version of this offered "high priest" against "prevent", which anyone can cross
off on sight.

`tools/build-words.mjs` enforces, in order:

1. **Same part of speech** — from the Moby POS list (public domain), not from
   guessing at suffixes, which was only ~77% accurate. The *gloss* has to read
   that way too: "reciprocal" is an adjective but its meaning "exchange" reads
   as a noun, so it is never offered among adjectives.
2. **Same surface shape** — one word against one word, phrase against phrase,
   `-ing` against `-ing`, and matching openings for phrases ("impossible to…"
   against "hard to…").
3. **Not a synonym** — checked four ways: definition overlap, shared word stems,
   each entry's definition naming the other's meaning, and mutual links in the
   Moby Thesaurus. That last one catches pairs whose definitions look unrelated
   but whose meanings are not, like *broadcast* / *distribute*.
4. **Distinct from each other** — candidates are picked greedily so that no two
   stored options mean the same thing. Two wrong answers that agree would let
   you rule both out.
5. **Nothing conspicuous** — options built from rare or very specific words
   ("having muted rainbow colors") are penalised, because they stand out.

Sound-alikes (*precede* for *preclude*, *palpable* for *palatable*) still get a
scoring bonus where they survive all of the above — they make excellent traps —
but they are no longer the basis of selection. When you do slip, the feedback
names the word that caught you.

### After you answer

The correct meaning is shown with the full definition and, for the
highest-frequency band, an example sentence with the word picked out in
context — seeing it used is what makes it stick.

Examples live in `tools/examples.json` as a plain `word: sentence` map and are
folded into the build. All 449 top-frequency words are covered; add entries to
that file and re-run the build to cover more.

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

## The logo

Put your artwork at `icons/source-logo.png` and run:

```bash
python tools/make-icons.py
```

That centre-crops it to a square, lays **SAT** across it, and writes every icon
size the app and the phone home screen need. Without a source image it falls
back to a plain dark tile, so the app still runs.

## Rebuilding the word list

`data/words.json` is generated. The source HTML pages are in `tools/`.

```bash
node tools/build-words.mjs
```

It parses the three frequency lists, de-duplicates across them (a word in more
than one list keeps its highest-frequency entry), scores difficulty, folds in
`tools/examples.json`, and precomputes each word's answer choices.

It reads two derived lexicons that are already committed:

```bash
node tools/fetch-pos.mjs         # part of speech  -> tools/pos-lexicon.json
node tools/fetch-thesaurus.mjs   # synonyms        -> tools/synonyms.json
```

Those only need re-running if the word lists change. Each downloads a large
public-domain file once, caches it under `tools/` (git-ignored), and keeps only
the slice this project looks up.

Bump `CACHE` in `sw.js` after any rebuild so returning visitors pick up the new
file.

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
tools/
  build-words.mjs       word-list + answer-choice generator
  examples.json         example sentences, word -> sentence
  pos-lexicon.json      part-of-speech data (derived, committed)
  synonyms.json         mutual synonym links (derived, committed)
  fetch-pos.mjs         rebuilds pos-lexicon.json
  fetch-thesaurus.mjs   rebuilds synonyms.json
  make-icons.py         builds the icon set from icons/source-logo.png
```

## Keyboard

`1`–`4` answer · `Enter` / `Space` continue · `Esc` end session.

## Credit

Word list and definitions from
[sesamewords](https://sites.google.com/site/sesamewords/home).
Part-of-speech and thesaurus data from the Moby Project (public domain).
