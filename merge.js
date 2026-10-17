'use strict';

// Pure text-merging logic for the virtualized chat list.
// Kept free of Electron APIs so it can be tested with plain Node.js.

const GAP_MARKER = '<!-- No overlap found here; some content may be missing. -->';

// How many recent output lines to search when looking for the overlap.
const SEARCH_WINDOW = 2000;
// An overlap that has no unique line is trusted only if its text is at least this many characters.
// Short repeated lines ("Read", "Ran 2 commands", timestamps) match by accident, so they need more evidence.
const MIN_OVERLAP_CHARS = 40;
// A visible block of at least this many lines can be recognised as already captured.
const CONTAIN_MIN = 5;

// Private Use Area characters: icon-font glyphs (e.g. the \ue02a icons in claude.ai).
const PUA = /[\uE000-\uF8FF]/g;

// Lines the UI repeats on every viewport. They carry no message content.
const UI_NOISE = new Set([
  'Use the up and down arrow keys to move between messages.',
  'Load later messages',
  'Open usage settings',
  'Message collapsed',
  'Show more',
  'Show less',
]);

// Labels the page puts in front of a message body. The body follows as its own line,
// so the label is removed to avoid showing the same text twice.
const LABEL_PREFIX = /^(Claude responded|You said):\s*/;

// Relative timestamps ("3 minutes ago") change with time, so they are
// compared as one key. The stored text keeps the value that was seen.
const RELATIVE_TIME = /^(\d+\s*(seconds?|minutes?|hours?|days?|weeks?|months?|years?)\s+ago|just now)$/;

// Comparison key for a line. Output keeps the original text.
function keyOf(line) {
  return RELATIVE_TIME.test(line) ? '<time>' : line;
}

// Turn the raw innerText of the scroll container into clean content lines.
function prepareVisible(text) {
  const out = [];
  for (const raw of text.split('\n')) {
    const line = raw.replace(PUA, '').replace(LABEL_PREFIX, '').trim();
    if (!line) continue;
    if (UI_NOISE.has(line)) continue;
    out.push(line);
  }
  return out;
}

// Find where the newest captured lines (end of acc) reappear inside the
// visible block. Returns { end, k }: visible[end - k + 1 .. end] equals the
// last k lines of acc. The longest such run wins; ties go to the later match,
// which keeps duplicates lowest.
function findTailOverlap(accKeys, visKeys) {
  const lastKey = accKeys[accKeys.length - 1];
  let best = null;
  for (let e = 0; e < visKeys.length; e++) {
    if (visKeys[e] !== lastKey) continue;
    let k = 0;
    while (
      k < accKeys.length &&
      e - k >= 0 &&
      visKeys[e - k] === accKeys[accKeys.length - 1 - k]
    ) {
      k++;
    }
    if (!best || k > best.k || (k === best.k && e > best.end)) {
      best = { end: e, k };
    }
  }
  return best;
}

// Is the overlap strong enough to trust?
// It is trusted if one of its lines occurs only once in the recent output (so it anchors the position),
// or if its text is long enough that a chance match is unlikely.
function isConvincing(overlap, accKeys, counts) {
  if (!overlap || overlap.k === 0) return false;
  const run = accKeys.slice(accKeys.length - overlap.k);
  if (run.some((key) => counts.get(key) === 1)) return true;
  let chars = 0;
  for (const key of run) chars += key.length;
  return chars >= MIN_OVERLAP_CHARS;
}

// Is the whole visible block already present, contiguous and in order, in acc?
function isContained(accKeys, visKeys) {
  if (visKeys.length < CONTAIN_MIN) return false;
  const first = visKeys[0];
  for (let p = 0; p + visKeys.length <= accKeys.length; p++) {
    if (accKeys[p] !== first) continue;
    let ok = true;
    for (let i = 1; i < visKeys.length; i++) {
      if (accKeys[p + i] !== visKeys[i]) { ok = false; break; }
    }
    if (ok) return true;
  }
  return false;
}

// Merge the newly visible lines into the accumulated output.
// `visible` must come from prepareVisible().
function mergeLines(acc, visible) {
  if (visible.length === 0) return acc;
  if (acc.length === 0) return visible.slice();

  const visKeys = visible.map(keyOf);

  // 1. The newest captured lines reappear in the visible block: append only what is after them.
  const tail = acc.slice(Math.max(0, acc.length - SEARCH_WINDOW)).map(keyOf);
  const counts = new Map();
  for (const key of tail) counts.set(key, (counts.get(key) || 0) + 1);
  const overlap = findTailOverlap(tail, visKeys);
  if (overlap && isConvincing(overlap, tail, counts)) {
    return acc.concat(visible.slice(overlap.end + 1));
  }

  // 2. The whole visible block is already captured (e.g. the view jumped back): add nothing.
  if (isContained(acc.map(keyOf), visKeys)) {
    return acc;
  }

  // 3. No reliable overlap: mark the possible gap and add the visible block once.
  const addMarker = acc[acc.length - 1] !== GAP_MARKER;
  return acc.concat(addMarker ? [GAP_MARKER] : [], visible);
}

// A collapsed summary is a shorter preview of a later line, e.g.
// "Ran 4 commands (1 failed), read" and "Ran 4 commands (1 failed), read 42d7...".
// Only the detailed line is kept.
const PREVIEW_MIN = 10;
const PREVIEW_LOOKAHEAD = 5;

function isPreviewOf(short, long) {
  if (short.length < PREVIEW_MIN || long.length <= short.length) return false;
  if (!long.startsWith(short)) return false;
  return /[\s,、]/.test(long.charAt(short.length));
}

// Clean the final output before it is written. Operates on lines that were already merged,
// so it does not affect the overlap matching during capture.
function cleanOutput(lines) {
  const out = [];
  const lastContent = () => {
    for (let i = out.length - 1; i >= 0; i--) if (out[i] !== GAP_MARKER) return out[i];
    return undefined;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === GAP_MARKER) {
      if (out[out.length - 1] !== GAP_MARKER) out.push(line);
      continue;
    }
    // Drop a collapsed preview when its detailed line follows nearby.
    let superseded = false;
    let seen = 0;
    for (let j = i + 1; j < lines.length && seen < PREVIEW_LOOKAHEAD; j++) {
      if (lines[j] === GAP_MARKER) continue;
      seen++;
      if (isPreviewOf(line, lines[j])) { superseded = true; break; }
    }
    if (superseded) continue;
    // Drop an immediate repeat of the previous content line.
    if (lastContent() === line) continue;
    out.push(line);
  }
  return out;
}

module.exports = { mergeLines, prepareVisible, cleanOutput, keyOf, GAP_MARKER };
