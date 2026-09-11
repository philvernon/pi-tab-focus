# pi-tab-focus

Crush-style transcript focus mode for Pi, designed to compose with `pi-vim` without replacing or wrapping its editor instance.

## Installation

Install `pi-vim` first, then this package so Pi preserves the required package order:

```sh
pi install npm:pi-vim
pi install git:github.com/philvernon/pi-tab-focus
```

Equivalent `settings.json` ordering:

```json
{
  "packages": [
    "npm:pi-vim",
    "git:github.com/philvernon/pi-tab-focus"
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
| `v` | enter visual navigation mode; while visual, cancel back to transcript mode |
| `V` | start rendered-text selection at the visual cursor |
| `h/j/k/l`, arrows | move visual cursor while visual mode is active |
| `0`, `^`, `$` | move to rendered-line start, first non-whitespace grapheme, or final grapheme in visual mode |
| `y`, `c` | copy selected transcript item; in visual selection mode, copy exact selected text |
| `Enter` | follow a link in the selected item; in visual mode, prefer the link under the visual cursor |
| `:` | temporarily enter pi-vim EX mode, then return to transcript focus when the command/cancel path finishes; `Tab` cancels EX and returns immediately |
| `Esc` | cancel visual mode; a second `Esc` leaves transcript mode |

Transcript mode is implemented through Pi's `ctx.ui.onTerminalInput()` hook. The real pi-vim `ModalEditor` is returned unchanged, so Pi can continue to wire the full `CustomEditor` surface including app actions, escape handling, image paste and extension shortcuts.

The active transcript-mode hint is shown with `ctx.ui.setStatus()` in Pi's footer rather than by modifying pi-vim's rendered editor.

`Shift+J/K` walks the rendered transcript item-by-item: user prompts, assistant messages, tool executions, bash entries, skill invocations, summaries and custom transcript entries. The transcript reserves a one-column Crush-style gutter from startup, before transcript focus is entered, so pressing `Tab` never moves its text. The gutter holds the heavy `┃` marker directly beside the transcript and spans visible item content plus at most one adjacent blank transcript row above and below, giving each selection the same padded Crush-style treatment without swallowing unrelated layout space. Prompt markers are pink and response/tool markers are green. Outside visual mode, `y/c` copies the unhighlighted rendered item.

Visual mode starts as navigation-only at the currently selected item, so you can move the visual cursor before highlighting anything. Press `V` to anchor a rendered-text selection at that cursor; from there Pi's native fullscreen transcript selection engine provides inverse-video highlighting, rendered-row/terminal-column selection, and exact `y/c` copied text.

Entering transcript mode automatically selects the bottom-most visible item unless the previous selection is still visible. Line/page/top/bottom scrolling preserves the current selection while it remains on-screen; once it scrolls out of view, selection stays attached to the edge it exited through: the bottom-most visible item when scrolling up, or the top-most visible item when scrolling down.

## Pi API compatibility note

Pi 0.85.1 does not expose a public transcript-item/viewport API. Item discovery therefore uses Pi's mounted component tree. The permanent gutter is composed beside Pi's existing fullscreen transcript `ScrollView`, smooth reveal scrolling uses its private viewport state, and visual mode writes Pi's private native text-selection fields/methods when available. Those private reads/writes are guarded, and the package peer range is intentionally constrained to the Pi 0.85.x API line (`^0.85.1`) so incompatible private-layout changes are not silently accepted.

## Development

```sh
npm ci
npm test
```

The test suite covers transcript focus entry/exit, viewport-following selection, visual text selection and copy, link following, all supported transcript item kinds, gutter rendering, copy mappings, Pi layout-changing actions, completion-triggered geometry refresh, EX-mode detours and session cleanup.
