# Claude Session Capture

Opens claude.ai in an Electron window, lets you log in there, then auto-scrolls the page and captures the visible text into Markdown and JSON files. It works on any claude.ai page you open, not only one specific session.

## Setup

```bash
npm install
npm start
```

## Usage

1. Run `npm start`. The app clears all stored data of its session (cookies included), then opens claude.ai in one window.
2. Log in in that window and open the session you want to capture.
3. Click **Start capture** in the button panel at the bottom right of the page.
4. When the bottom of the page is reached, capture stops and a save dialog appears. Two files are written: a `.md` file and a `.json` file with the same name.

Every start begins at the login screen, because the stored login state is cleared on launch.

## How it works

- **Scroll container detection**: Instead of assuming the window scrolls, the app picks the element with `overflow: auto/scroll` that has the largest scrollable range.
- **Virtualized lists**: Off-screen rows are removed from the DOM, so each step reads the visible text and merges it with the rows already captured (`merge.js`). Before matching, the text is cleaned: icon glyphs (Private Use Area characters) and repeated UI lines (such as the screen-reader hint at the top of the list) are dropped, and relative timestamps such as "3 minutes ago" are compared as one key, since they change over time.
- **Overlap matching**: The newest captured lines are searched for at the end of the visible block, and only the lines after them are appended. An overlap is accepted only if it contains a line that occurs once in the recent output, or if its text is long enough (at least 40 characters) that a chance match is unlikely. Short repeated lines alone are never enough. If the whole visible block is already captured, nothing is added. Where no reliable overlap can be found, the output contains a comment marking a possible gap, and the log reports how many gaps there are.
- **Rendering wait**: The app waits 1 second after each scroll step.
- **Empty result**: If nothing is captured, the full page HTML is saved to the Electron `userData` folder as `debug-*.html`, and its path is shown in the error message.

## Tests

```bash
npm test
```

`test/merge-sim.js` simulates a virtualized chat list with known content and runs the same capture loop against it. It reports the number of exact matches, gap markers, and duplicate lines.

## Limitations

- Only text is captured. Images, formatting, and collapsed sections may be lost.
- The page structure of claude.ai may change, which could break capture. If the output is empty, check the `debug-*.html` file.
- Check the claude.ai Terms of Service before automating access. Use this tool only for your own sessions that you are authorized to view.
- Do not use this tool to capture private sessions belonging to other people.
