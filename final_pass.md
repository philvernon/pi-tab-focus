# Final Pass

## Instructions

- Work through every item below before release.
- Change `[ ]` to `[x]` only after the implementation is complete and the relevant tests or verification pass.
- Do not check an item off for a partial fix or documentation-only workaround unless the item explicitly calls for documentation.
- Release only when every checkbox in **Release thresholds** and **Release necessities** is checked.

## Release thresholds

- [x] **Do not consume the focus key outside fullscreen mode.**
  - If transcript focus cannot activate because Pi is not in fullscreen mode, return control to Pi instead of consuming the key.
  - Update the existing non-fullscreen test so `Tab` is allowed to reach Pi/editor behaviour.
  - Verify fullscreen focus-key behaviour is unchanged.

- [x] **Fix the visual cursor for width-2 and multi-codepoint graphemes.**
  - Stop assuming the character under the cursor occupies one terminal column.
  - Render the visual cursor correctly on CJK characters, emoji and other wide graphemes.
  - Add tests covering at least CJK and emoji cursor positions.

- [x] **Handle runtime TUI mode switching safely.**
  - Ensure switching from regular mode to fullscreen installs the transcript fullscreen integration on the active renderer.
  - Ensure switching from fullscreen to regular and back to fullscreen does not reuse stale layout, scroll-view, gutter or root references.
  - Re-establish fullscreen integration against the current renderer when required.
  - Add tests covering regular → fullscreen and fullscreen → regular → fullscreen transitions.

- [x] **Document the verified Pi version.**
  - State that the extension is tested with Pi `0.85.1`.
  - Keep the Pi peer dependencies as `"*"`.

## Release necessities

- [x] **Document link-opening behaviour.**
  - Item mode opens the first link in the selected transcript item.
  - Visual mode opens the link under the cursor.

- [x] **Restore the printable `focusKey` warning.**
  - Document that an unmodified printable key such as `f` can intercept normal typing.
  - Recommend modifier/function-style bindings for `focusKey`.

- [ ] **Verify the npm package contents.**
  - Run `npm pack --dry-run` in CI and as part of release verification.
  - Confirm the output contains the intended runtime files and excludes development/test-only files such as `src/tests/` and `final_pass.md`.
