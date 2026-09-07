# SAT Vocab

A short-session SAT vocab trainer that works on a phone and a computer and keeps
one shared record of what you know. 3,876 words, each scored for how hard it
actually is, with a spaced-repetition scheduler and multiple-choice questions
whose wrong answers are the words people genuinely mix up.

Static site — no server to run. Host it free on GitHub Pages.

---

## How it decides what to ask

**Difficulty is measured, not assumed.** Every word carries a difficulty score
`x` in 0..1 — a percentile across the whole list. Frequency is the backbone of
it, blended from two corpora on purpose (OpenSubtitles for spoken English,
Wikipedia for written), because a word that is common in either is one you have
met. But frequency alone gets it badly wrong, so six more signals go in
alongside it (`tools/difficulty.mjs`):

| Signal | Why it moves the needle |
|---|---|
| Blended Zipf frequency | The backbone. How often you have met the word at all. |
| Derivational family | *allege* is rare, *alleged* is not. A common relative is most of knowing the word. |
| Meaning familiarity | How ordinary the words in the definition are. "servile" is a harder thing to be told than "talkative". |
| Sense gap | A common word with an uncommon meaning is being tested on a sense you do not have yet. |
| Look-alike shadowing | Words with a commoner near-twin (*ingenuous*/*ingenious*, *noisome*/*noisy*) get misread, not merely missed. |
| Syllables | A mild cost that survives controlling for frequency. |
| Trap strength | How good the word's own wrong answers are — difficulty of the *item*, not just the word. |
| Classical roots | *Subtracts.* A word that decomposes into a high-yield prefix and root can be reasoned out cold. |

The old score was position-in-the-source-list, which is a frequency ordering
wearing a difficulty label — it rated *obsequious* easier than *retract*, and
*visible* as mid-hard because of the band it was filed under. Now: *visible*
0.00, *retract* 0.17, *obsequious* 0.71, *perspicacious* 0.91.

**The ramp follows you, not the list.** `assets/js/ability.js` fits one number
from your answers — θ, the difficulty at which you are a coin-flip — on the same
0..1 scale as the words. New words are then drawn from a band around θ rather
than in list order, so beating today's material raises tomorrow's, and a student
who is cruising gets rare hard words instead of the rest of the common ones.
Frequency still breaks ties, because of two words at the right level the one you
are likelier to meet is worth more. θ is refitted from the record each time, not
stored, so there is nothing to migrate or merge between devices, and it cannot
climb more than one step past the hardest word you have actually got right.

**Each session ramps on its own too.** Items are ordered by how hard they should
feel *to you*: your own record on a word outweighs its corpus difficulty, so a
rare word you know cold opens the session and a common word you keep missing
lands near the end. Sessions start with a warm-up you can definitely get, and
the stretch material arrives last.

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
folded into the build. All 449 top-frequency words are covered, plus 665 more
across the other tiers; add entries to that file and re-run the build to cover
more.

---

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



## Layout

```
index.html              app shell
assets/css/style.css    all styling
assets/js/
  main.js               wiring, rendering, session flow
  session.js            session planning, the difficulty ramp, in-session retries
  ability.js            fits your level from your answers; predicts item difficulty
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
  build-words.mjs           word-list + answer-choice generator
  difficulty.mjs            the difficulty model, used by build-words.mjs
  examples.json             example sentences, word -> sentence
  pos-lexicon.json          part-of-speech data (derived, committed)
  synonyms.json             mutual synonym links (derived, committed)
  word-freq.json            corpus frequency evidence (derived, committed)
  fetch-pos.mjs             rebuilds pos-lexicon.json
  fetch-thesaurus.mjs       rebuilds synonyms.json
  fetch-freq.mjs            rebuilds word-freq.json
  parse-sat1000.mjs         parses a supplementary word-list PDF (see below)
  build-sat1000-extra.mjs   dedupes + frequency-tiers that list into sat1000-extra.json
  sat1000-extra.json        its output — extra words merged in by build-words.mjs
  make-icons.py             builds the icon set from icons/source-logo.png
```

## Keyboard

`1`–`4` answer · `Enter` / `Space` continue · `Esc` end session.

## Credit

Word list and definitions from
[sesamewords](https://sites.google.com/site/sesamewords/home), plus 216
additional words from a supplementary SAT vocabulary list. Frequency data —
which tiers those extra words and feeds the difficulty model — from
[hermitdave/FrequencyWords](https://github.com/hermitdave/FrequencyWords)
(OpenSubtitles-derived) and
[IlyaSemenov/wikipedia-word-frequency](https://github.com/IlyaSemenov/wikipedia-word-frequency).
Part-of-speech and thesaurus data from the Moby Project (public domain).
