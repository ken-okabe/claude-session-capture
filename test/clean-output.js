'use strict';
const assert = require('assert');
const { prepareVisible, cleanOutput, GAP_MARKER } = require('../merge');

// 1. Labels and UI text are removed or unwrapped.
assert.deepStrictEqual(
  prepareVisible('Message collapsed\nShow more\nYou said: 添付です\nClaude responded: 了解です'),
  ['添付です', '了解です']
);

// 2. Collapsed preview is dropped when the detailed line follows (with an icon line between).
assert.deepStrictEqual(
  cleanOutput([
    'Ran 4 commands (1 failed), read',
    '42d7ff5a-claude-session-1792061243627.md',
    'Ran 4 commands (1 failed), read 42d7ff5a-claude-session-1792061243627.md',
  ]),
  [
    '42d7ff5a-claude-session-1792061243627.md',
    'Ran 4 commands (1 failed), read 42d7ff5a-claude-session-1792061243627.md',
  ]
);

// 3. Consecutive identical lines collapse to one.
assert.deepStrictEqual(cleanOutput(['Ran 2 commands', 'Ran 2 commands', '本文']), ['Ran 2 commands', '本文']);

// 4. Short words that merely start a longer sentence are kept.
assert.deepStrictEqual(cleanOutput(['Read', 'Read the file carefully']), ['Read', 'Read the file carefully']);

// 5. Gap markers are kept once, not stacked.
assert.deepStrictEqual(cleanOutput(['a', GAP_MARKER, GAP_MARKER, 'b']), ['a', GAP_MARKER, 'b']);

// 6. Label + body pair from the captured text becomes a single line.
assert.deepStrictEqual(
  cleanOutput(prepareVisible('You said: 添付MDファイルは前セッションのログなので、要約して説明して\n添付MDファイルは前セッションのログなので、要約して説明して')),
  ['添付MDファイルは前セッションのログなので、要約して説明して']
);

console.log('OK: clean-output tests passed');
