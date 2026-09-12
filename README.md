# pi-tab-focus

Crush-style transcript focus mode for Pi, designed to compose with `pi-vim` without replacing or wrapping its editor instance.

## Installation

Install `pi-vim` first, then this package so Pi preserves the required package order:

```sh
pi install npm:pi-vim
pi install npm:pi-tab-focus
```

Equivalent `settings.json` ordering:

```json
{
  "packages": [
    "npm:pi-vim",
    "npm:pi-tab-focus"
  ]
}
```

The order matters because `pi-tab-focus` uses `ctx.ui.getEditorComponent()` to capture the editor factory registered by `pi-vim`, then returns the resulting pi-vim editor instance unchanged.

Run Pi in fullscreen TUI mode:

```sh
pi --tui-mode fullscreen
```

Use `/reload` after changing the package. The current development baseline is Pi 0.85.1 and pi-vim 0.14.2.

## Keys

| Key | Transcript mode |
| --- | --- |
| `Tab` | enter/leave transcript focus |
| `j`, `↓` | scroll down one line |
| `k`, `↑` | scroll up one line |
| `u` | scroll up half a page |
| `d` | scroll down half a page |
| `Shift+J`, `Shift+↓` | select next transcript item |
| `Shift+K`, `Shift+↑` | select previous transcript item |
| `b`, `PgUp` | page up |
| `f`, `PgDn` | page down |
| `g`, `Home` | top |
| `G`, `End` | bottom |
| `Ctrl+O` (or configured `app.tools.expand` binding) | toggle Pi tool-output expansion and refresh transcript geometry |
| `Ctrl+T` (or configured `app.thinking.toggle` binding) | toggle Pi thinking visibility and refresh transcript geometry |
| `Ctrl+D` | shut down Pi |
| `Ctrl+C` | leave transcript focus so Pi handles subsequent input normally |
| `v` | enter visual cursor mode; press `v` again to start character selection; press `v` while selecting to return to visual cursor mode |
| `V` | enter visual mode and select the current rendered line |
| `h/j/k/l`, arrows | move the visual cursor and extend an active selection |
| `w/b/e/ge`, `W/B/E/gE` | Vim word/WORD motions in visual mode; counts such as `3w` are supported |
| `0`, `^`, `$` | move to rendered-line start, first non-whitespace grapheme, or final grapheme |
| `gg`, `G`, `{`, `}`, `%` | move to a line/document or paragraph boundary, match brackets, or use counted `%` for a document percentage |
| `f/F/t/T`, `;`, `,` | find/till a character on the rendered line and repeat the last find |
| `iw/aw`, `iW/aW` | select inner/around word or WORD from visual cursor mode |
| `i/a` + quotes/brackets | select quoted or bracketed text objects, including `i"`, `a(`, `i[`, `a{` and `i<` |
| `o` | swap the active end of a visual selection |
| `y`, `c` | copy the selected transcript item, or the exact visual selection when one is active |
| `Enter` | follow a link in the selected item; in visual mode, prefer the link under the visual cursor |
| `:` | temporarily enter pi-vim EX mode, then return to transcript focus when the command/cancel path finishes; `Tab` cancels EX and returns immediately |
| `Esc` | visual selection → visual cursor → transcript mode → editor focus |

Transcript mode is implemented through Pi's `ctx.ui.onTerminalInput()` hook. The real pi-vim `ModalEditor` is returned unchanged, so Pi can continue to wire the full `CustomEditor` surface including app actions, escape handling, image paste and extension shortcuts.

The active transcript-mode hint is shown with `ctx.ui.setStatus()` in Pi's footer rather than by modifying pi-vim's rendered editor.

`Shift+J/K` walks the rendered transcript item-by-item: user prompts, assistant messages, tool executions, bash entries, skill invocations, summaries and custom transcript entries. The transcript reserves a one-column Crush-style gutter from startup, before transcript focus is entered, so pressing `Tab` never moves its text. The gutter holds the heavy `┃` marker directly beside the transcript and spans visible item content plus at most one adjacent blank transcript row above and below, giving each selection the same padded Crush-style treatment without swallowing unrelated layout space. Prompt markers are pink and response/tool markers are green. `y/c` copies the unhighlighted rendered item.

Visual mode starts as cursor navigation on the currently selected item. Press `v` again to anchor a character selection at the cursor, or press `V` to start a whole-line selection. Vim-style motions are implemented by a Pi-independent navigation state machine in `src/vim-navigation.ts`, including counts, word/WORD motions, character finds, `gg/G`, paragraph motions and common text objects such as `iw`, `aw`, quoted strings and bracket pairs. It intentionally implements the read-only navigation/selection subset rather than insert mode, editing operators or registers. Motions extend the active selection and `y/c` copies it exactly. While selecting, either `v` or `Esc` returns to visual cursor mode; `Esc` from visual cursor mode returns to transcript mode.

Entering transcript mode automatically selects the bottom-most visible item unless the previous selection is still visible. Line/page/top/bottom scrolling preserves the current selection while it remains on-screen; once it scrolls out of view, selection stays attached to the edge it exited through: the bottom-most visible item when scrolling up, or the top-most visible item when scrolling down.

## Pi API compatibility note

Pi 0.85.1 does not expose a public transcript-item/viewport API. Item discovery therefore uses Pi's mounted component tree. The permanent gutter is composed beside Pi's existing fullscreen transcript `ScrollView`, smooth reveal scrolling uses its private viewport state and visual selections use Pi's private fullscreen selection state. Those private accesses are guarded, and the package peer range is intentionally constrained to the Pi 0.85.x API line (`^0.85.1`) so incompatible private-layout changes are not silently accepted.

## Development

```sh
npm ci
npm run typecheck
npm test
```

The test suite covers transcript focus entry/exit, viewport-following selection, visual character and line selection, Vim motions and text objects, link following, all supported transcript item kinds, gutter rendering, copy mappings, Pi layout-changing actions, completion-triggered geometry refresh, EX-mode detours and session cleanup.
