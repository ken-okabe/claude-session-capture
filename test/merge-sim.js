'use strict';

// Simulates a virtualized claude.ai chat list and runs the capture loop from main.js
// against it, with the old and new merge functions. The ground truth is known,
// so duplicates, gaps and misses can be counted exactly.

const { mergeLines, prepareVisible, keyOf, GAP_MARKER } = require('../merge');

// ---- Old implementation (copied verbatim from main.js before the fix) ------
function oldPrepare(text) {
  return text.split('\n').map((s) => s.trim()).filter(Boolean);
}
function oldMergeLines(acc, visible) {
  if (visible.length === 0) return acc;
  if (acc.length === 0) return visible.slice();
  const first = visible[0];
  for (let p = 0; p + visible.length <= acc.length; p++) {
    if (acc[p] !== first) continue;
    let ok = true;
    for (let i = 0; i < visible.length; i++) {
      if (acc[p + i] !== visible[i]) { ok = false; break; }
    }
    if (ok) return acc;
  }
  const maxK = Math.min(acc.length, visible.length);
  for (let k = maxK; k >= 3; k--) {
    let ok = true;
    for (let i = 0; i < k; i++) {
      if (acc[acc.length - k + i] !== visible[i]) { ok = false; break; }
    }
    if (ok) return acc.concat(visible.slice(k));
  }
  return acc.concat(['<!-- No overlap found here; some content may be missing. -->'], visible);
}

// ---- Deterministic random ---------------------------------------------------
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// Short, repeated UI-like lines are the hardest case: they match everywhere.
const SHORT = [
  'Ran 2 commands', 'Ran 3 commands', 'Ran 6 commands', 'Read', 'Pushed',
  'Ran 4 commands (1 failed), read', 'OK', 'はい', '完了しました。',
];

function makeChat(rand, nRows) {
  const rows = [];
  for (let i = 0; i < nRows; i++) {
    const nl = 1 + Math.floor(rand() * 4);
    const lines = [];
    for (let j = 0; j < nl; j++) {
      if (rand() < 0.45) {
        lines.push(SHORT[Math.floor(rand() * SHORT.length)]);
      } else {
        lines.push(`項目${i}-${j}: 内容の説明（${Math.floor(rand() * 100000)}）`);
      }
    }
    rows.push({ lines, ago: 1 + Math.floor(rand() * 600) });
  }
  return rows;
}

const HEADER = 'Use the up and down arrow keys to move between messages.';
const CLIENT = 300;

// Lay out rows, render only those near the viewport (virtualization),
// and return what innerText would contain at this scroll position.
function render(rows, scrollTop, clock) {
  const pos = [];
  let y = 0;
  for (const r of rows) {
    const h = 16 + r.lines.length * 20 + 10;
    pos.push([y, y + h]);
    y += h;
  }
  const height = y;
  const top = Math.max(0, Math.min(scrollTop, height - CLIENT));
  const parts = [HEADER];
  rows.forEach((r, i) => {
    const [a, b] = pos[i];
    if (b < top - 600 || a > top + CLIENT + 600) return; // removed from DOM
    if (i % 3 === 0) parts.push('\ue02a'); // icon glyph
    r.lines.forEach((ln) => parts.push(ln));
    parts.push(`${r.ago + clock} minutes ago`); // relative time changes each step
  });
  return { text: parts.join('\n'), top, client: CLIENT, height };
}

// Same loop as runCapture in main.js.
function capture(rows, prepare, merge) {
  let acc = [];
  let scrollTop = 0;
  let clock = 0;
  let stable = 0;
  let lastHeight = -1;
  for (let step = 1; step <= 500; step++) {
    const snap = render(rows, scrollTop, clock);
    acc = merge(acc, prepare(snap.text));
    const atBottom = snap.top + snap.client >= snap.height - 4;
    if (atBottom && snap.height === lastHeight) {
      stable++;
      if (stable >= 3) break;
    } else {
      stable = 0;
    }
    lastHeight = snap.height;
    scrollTop = snap.top + Math.round(snap.client * 0.7);
    clock++;
  }
  return acc;
}

function truthOf(rows) {
  return rows.flatMap((r) => [...r.lines, '<time>']);
}

function evaluate(out, truth) {
  const gaps = out.filter((l) => l === GAP_MARKER).length;
  const content = out.filter((l) => l !== GAP_MARKER).map(keyOf);
  const exact = content.length === truth.length && content.every((x, i) => x === truth[i]);
  return { exact, gaps, extra: content.length - truth.length };
}

// ---- Run ------------------------------------------------------------------
const CASES = 60;
const stats = {
  old: { exact: 0, gaps: 0, extra: 0 },
  new: { exact: 0, gaps: 0, extra: 0 },
};
const failures = [];

for (let seed = 1; seed <= CASES; seed++) {
  const rand = rng(seed * 7919);
  const nRows = 30 + Math.floor(rand() * 370);
  const rows = makeChat(rand, nRows);
  const truth = truthOf(rows);

  const oldOut = capture(rows, oldPrepare, oldMergeLines);
  const newOut = capture(rows, prepareVisible, mergeLines);
  const o = evaluate(oldOut, truth);
  const n = evaluate(newOut, truth);

  for (const [key, r] of [['old', o], ['new', n]]) {
    if (r.exact) stats[key].exact++;
    stats[key].gaps += r.gaps;
    stats[key].extra += Math.max(0, r.extra);
  }
  if (!n.exact) failures.push({ seed, nRows, truthLen: truth.length, newOut: newOut.length, n });
}

console.log(`cases: ${CASES}`);
for (const key of ['old', 'new']) {
  const s = stats[key];
  console.log(
    `${key}: exact ${s.exact}/${CASES}, gap markers ${s.gaps}, extra duplicate lines ${s.extra}`
  );
}
if (failures.length) {
  console.log('new failures:', JSON.stringify(failures.slice(0, 5), null, 2));
}

// Hard assertions: the new merge must reproduce the page exactly.
const assert = require('assert');
assert.strictEqual(stats.new.exact, CASES, `new merge not exact in ${CASES - stats.new.exact} cases`);
assert.strictEqual(stats.new.gaps, 0, 'new merge produced gap markers');
assert.strictEqual(stats.new.extra, 0, 'new merge produced duplicate lines');
console.log('OK: new merge reproduces the page exactly in all cases.');
