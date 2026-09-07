/**
 * quiz.js — turns a word into a multiple-choice question.
 *
 * The wrong answers are the meanings of words that LOOK or SOUND like the
 * target (precede/preclude, palpable/palatable, dissemble/disseminate). Those
 * pairs are precomputed in data/words.json by tools/build-words.mjs, which also
 * throws out any candidate whose meaning overlaps the target's — so a wrong
 * answer is never quietly also correct.
 *
 * The rule this enforces: someone who actually knows the word gets it right;
 * someone who only half-recognises the shape of it does not.
 *
 * Distractors otherwise rotate between encounters so a word does not become a
 * memorised pattern of four boxes — with one exception. Once a particular wrong
 * answer has actually caught you, it is pinned to that word (`ctx.pin`) until
 * you beat it. Re-asking with three fresh wrong answers would be re-asking an
 * easier question, and passing it would prove nothing.
 */

const OPTIONS = 4;

/** Recently-used distractors per word, so repeat encounters vary. Session-scoped. */
const recent = new Map();

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();

/** Two answer texts are too close to sit in the same question. */
function collides(a, b) {
  const x = norm(a), y = norm(b);
  if (!x || !y) return true;
  if (x === y) return true;
  if (x.includes(y) || y.includes(x)) return true;
  const xs = new Set(x.split(' ').filter((w) => w.length > 3));
  const ys = y.split(' ').filter((w) => w.length > 3);
  if (xs.size && ys.length) {
    const hits = ys.filter((w) => xs.has(w)).length;
    if (hits / Math.max(xs.size, ys.length) >= 0.6) return true;
  }
  return false;
}

function shuffle(arr, rng = Math.random) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Order the confusable pool: strongest traps first, but rotate so the same
 * three do not appear every single time this word comes up.
 */
function orderedPool(word) {
  const used = recent.get(word.i) || [];
  const pool = (word.c || []).slice();
  // Light shuffle inside the top band keeps traps strong but not identical.
  const top = shuffle(pool.slice(0, 6));
  const rest = shuffle(pool.slice(6));
  return [...top, ...rest].sort((a, b) => used.indexOf(a) - used.indexOf(b));
}

/** Surface shape of an answer text — must match, or one option stands out. */
function glossClass(g) {
  const parts = String(g || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 1) {
    if (/ly$/.test(parts[0]) && parts[0].length > 4) return '1ly';
    if (/ing$/.test(parts[0])) return '1ing';
    return '1';
  }
  return 'n';
}

/**
 * Used only for the ~2% of words with too few precomputed candidates. It holds
 * to the same rules the build applies: same part of speech, same surface shape,
 * similar length — so a fallback question still cannot be solved by spotting
 * the odd one out.
 */
function fallbackPool(word, words) {
  const out = [];
  const cls = glossClass(word.g);
  const targetLen = String(word.g).trim().split(/\s+/).length;
  const n = words.length;
  let cursor = Math.floor(Math.random() * n);
  for (let guard = 0; guard < 1200 && out.length < 30; guard++) {
    cursor = (cursor + 1 + Math.floor(Math.random() * 17)) % n;
    const cand = words[cursor];
    if (!cand || cand.i === word.i) continue;
    if (word.p && cand.p && cand.p !== word.p) continue;
    if (glossClass(cand.g) !== cls) continue;
    if (Math.abs(String(cand.g).trim().split(/\s+/).length - targetLen) > 1) continue;
    out.push(cand.i);
  }
  return out;
}

/**
 * Build a question.
 *
 * @param {object}  word     entry from words.json
 * @param {object}  ctx      { words, byId, allowReverse, seen, pin }
 *                           `pin` is a word id that must appear as a wrong
 *                           answer — the distractor that caught them last.
 * @returns {{ word, mode, prompt, subPrompt, correctId, options: [{id,text,word,gloss}] }}
 */
export function buildQuestion(word, ctx) {
  const { words, byId } = ctx;
  const reverse = !!ctx.allowReverse && !!ctx.seen && Math.random() < 0.28;

  const answerText = (w) => (reverse ? w.w : w.g);
  const chosen = [];
  const texts = [answerText(word)];

  const consider = (id) => {
    if (chosen.length >= OPTIONS - 1) return;
    const cand = byId[id];
    if (!cand || cand.i === word.i) return;
    const text = answerText(cand);
    if (texts.some((t) => collides(t, text))) return;
    // In reverse mode the *meanings* must also stay distinct, or two word
    // choices could both fit the prompt.
    if (reverse && collides(word.g, cand.g)) return;
    chosen.push(cand);
    texts.push(text);
  };

  // The answer that caught them last time goes in first, so it cannot be
  // rotated out. Swapping in three fresh wrong answers on the retry turns the
  // question into a different, easier one — you can be re-asked a word you have
  // not learned and get it right because the thing that fooled you is gone.
  if (ctx.pin >= 0 && ctx.pin !== word.i) consider(ctx.pin);

  for (const id of orderedPool(word)) consider(id);
  if (chosen.length < OPTIONS - 1) for (const id of fallbackPool(word, words)) consider(id);

  const picked = chosen.slice(0, OPTIONS - 1);
  recent.set(word.i, [...picked.map((w) => w.i), ...(recent.get(word.i) || [])].slice(0, 9));

  const options = shuffle([
    { id: word.i, text: answerText(word), word, gloss: word.g, correct: true },
    ...picked.map((w) => ({ id: w.i, text: answerText(w), word: w, gloss: w.g, correct: false })),
  ]);

  return {
    word,
    mode: reverse ? 'reverse' : 'forward',
    prompt: reverse ? word.d : word.w,
    subPrompt: reverse ? null : null,
    correctId: word.i,
    options,
  };
}

export function resetQuizMemory() { recent.clear(); }
