# pi-tab-focus

Crush-style transcript focus mode for Pi, designed to compose with `pi-vim` without replacing or wrapping its editor instance.

## Installation

Add both packages to Pi's `settings.json`, with `pi-vim` before `pi-tab-focus`:

```json
{
  "packages": [
    "npm:pi-vim",
    "/Users/phil/dev-trash/pi-tab-focus"
  ]
}
```

The order matters because `pi-tab-focus` uses `ctx.ui.getEditorComponent()` to capture the editor factory registered by `pi-vim`, then returns the resulting pi-vim editor instance unchanged.

Run Pi in fullscreen TUI mode:

```sh
pi --tui-mode fullscreen
```

Use `/reload` after changing the package.

## Keys

| Key | Transcript mode |
| --- | --- |
| `Tab` | enter/leave transcript focus |
| `j`, `↓` | scroll down one line |
| `k`, `↑` | scroll up one line |
| `Shift+J`, `Shift+↓` | next semantic user prompt |
| `Shift+K`, `Shift+↑` | previous semantic user prompt |
| `b`, `PgUp` | page up |
| `f`, `PgDn` | page down |
| `g`, `Home` | top |
| `G`, `End` | bottom |
| `y`, `c` | copy selected prompt using Pi's clipboard helper |
| `:` | temporarily enter pi-vim EX mode, then return to transcript focus when the command/cancel path finishes; `Tab` cancels EX and returns immediately |
| `Esc` | leave transcript mode |

Transcript mode is implemented through Pi's `ctx.ui.onTerminalInput()` hook. The real pi-vim `ModalEditor` is returned unchanged, so Pi can continue to wire the full `CustomEditor` surface including app actions, escape handling, image paste and extension shortcuts.

The active transcript-mode hint is shown with `ctx.ui.setStatus()` in Pi's footer rather than by modifying pi-vim's rendered editor.

## Current Pi API limitation

Pi 0.85.1 exposes fullscreen line/page scrolling and semantic prompt jumps but does not expose a public transcript-item model that maps every rendered assistant block, tool call and tool result to viewport rows.

For that reason `Shift+J/K` currently selects **user prompts**, not every rendered transcript block, and logical prompt selection is only best-effort aligned with Pi's viewport prompt jump. `y/c` copies the logically selected prompt.

Implementing exact Crush-style selection of assistant messages and individual tool calls requires a Pi API that exposes rendered transcript items and their viewport row bounds.
