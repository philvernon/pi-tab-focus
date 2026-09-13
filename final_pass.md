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

- [ ] **Handle runtime TUI mode switching safely.**
  - Ensure switching from regular mode to fullscreen installs the transcript fullscreen integration on the active renderer.
  - Ensure switching from fullscreen to regular and back to fullscreen does not reuse stale layout, scroll-view, gutter or root references.
  - Re-establish fullscreen integration against the current renderer when required.
  - Add tests covering regular → fullscreen and fullscreen → regular → fullscreen transitions.

- [ ] **Restrict compatibility to versions actually verified.**
  - Gate runtime compatibility to Pi `0.85.1` rather than automatically accepting future `0.85.x` patches.
  - Update README compatibility wording to match the runtime gate.
  - Keep the Pi peer dependencies as `"*"`.

## Release necessities

- [ ] **Make README link-opening behaviour accurate.**
  - Either support opening the first OSC8 link from the selected item or describe the item-mode behaviour specifically as opening a literal URL.
  - Verify the documented behaviour matches the implementation.

- [ ] **Restore the printable `focusKey` warning.**
  - Document that an unmodified printable key such as `f` can intercept normal typing.
  - Recommend modifier/function-style bindings for `focusKey`.

- [ ] **Add a package/tarball smoke check.**
  - Verify the npm tarball contains the intended runtime files and excludes development/test-only files.
  - Prefer packing and installing the generated tarball in a temporary consumer project over only running `npm pack --dry-run`.
  - Make the smoke check part of the release verification or CI path.
