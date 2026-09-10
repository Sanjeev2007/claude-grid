# Changelog

All notable changes to the Claude Grid extension are documented here.

## [Unreleased]

### Added

- **Codex-first agent switch.** Presets and Add Terminal now launch Codex by
  default. The sidebar has a persistent Codex/Claude switch, with separate
  configurable commands for each CLI; explicit commands in custom presets are
  still honored. The README now includes real six-terminal screenshots for both
  the default Codex mode and optional Claude mode.

- **Cursor support.** Installing into Cursor works the same as VS Code, just
  under Cursor's data folder: symlink into `~/.cursor/extensions` and enable the
  `terminalDataWriteEvent` proposal in `~/.cursor/argv.json`. Cursor 3.16
  (VS Code 1.128 base) ships that proposal, so finish notifications work there
  too. README documents both paths, and the "proposed API not enabled" console
  warning now names the right `argv.json` for the running editor (VS Code,
  Insiders, or Cursor) instead of always saying `~/.vscode/argv.json`.

### Fixed

- **Cursor: opening any preset tore its own grid down and closed the window.**
  Terminals appeared, focus ping-ponged between them, `claude` never started,
  and the window vanished (the app stayed running, so it read as "Cursor
  crashed").

  Root cause: Cursor doesn't surface terminal *editors* through the
  `window.tabGroups` API — the group holding a terminal reports zero tabs.
  Every layout primitive here reads that model, so `closeEmptyGroups()` saw a
  grid of "empty" groups and reaped the ones holding the terminals (the visible
  focus dance is its focus-then-close loop), the staggered `sendText` then had
  no terminals left to type into, and the emptied editor area took the window
  with it.

  Fix: probe the host once, with terminals known to be in the editor area
  (`probeTabModel`). If the tab model can't see them, skip every tab-driven
  step — empty-group reaping, non-terminal folding, one-tab-per-group
  distribution, grid reconcile passes — and tile with a single
  `vscode.setEditorLayout`, which needs no tab model. `regridAfterClose` falls
  back to its own `owned` tally there. The verdict is cached in `globalState`
  (re-probed each session, so a fork that gains terminal tabs isn't stuck with
  a stale verdict) and logged once to the extension host console. Also route
  the last raw `instanceof vscode.TabInputTerminal` checks through a helper —
  the type is missing on some forks, where `instanceof undefined` throws.

- **VS Code and Cursor stole each other's terminals.** All cross-window
  handoff files (spill, heartbeats, routing messages) had fixed names in a
  shared `tmpdir`, so with both editors open a Cursor preset's overflow specs
  could be claimed by a VS Code window, and a `+` press routed into the other
  app — terminals landing in the wrong editor with focus jumping out from under
  you. The filenames are now namespaced per editor app (`vscode.env.appName`).

- **Overflow window flashed open then closed, creating no extra terminals.**
  Opening a preset for more than the spillover threshold (default 6), or pressing
  the sidebar + past the threshold, opened a second window that immediately
  disappeared and spawned nothing.

  Root cause: the overflow window was opened *blank* and then re-opened the
  originating project folder into itself via `openFolder(..., forceReuseWindow)`.
  But that folder is already open in the originating window, and VS Code
  de-duplicates open folders — so instead of loading the folder into the blank
  window, it focused the existing window and absorbed (closed) the blank one. The
  spill file was never consumed, so no terminals were created.

  Fix: open the overflow window with `workbench.action.duplicateWorkspaceInNewWindow`
  (the one command that opens the current folder in a genuinely separate window
  without de-duplicating), and drop the self-absorbing `openFolder` reload from
  `consumeSpill` — the window now just claims the spill and spawns its terminals.
  Falls back to a blank window (terminals still use the pre-resolved absolute
  cwds) when no folder is open or the command is unavailable.

- **Broken terminal grid: empty first tile + two terminals merged into one
  tile.** Opening a preset (e.g. "4 Claudes") could produce a grid with an empty
  leading tile and the last two terminals tabbed together in a single tile.

  Root cause: `spawnTerminals` tiled the editor area with a *fixed* group count
  of only the terminals it created (`gridCount = reused + created`), but
  `vscode.setEditorLayout` reshapes the **entire editor area**. When a phantom
  **empty** editor group was present — commonly left behind by a closed terminal
  or a collapsed split, and invisible to the old `areaEmpty` check because it
  counts *tabs* not *groups* — there were more real groups than the layout
  defined. VS Code resolved the mismatch by keeping the stray group as a blank
  tile and collapsing two real terminals together.

  Fix:
  - New `closeEmptyGroups()` removes phantom empty editor groups before tiling
    (always leaves at least one group).
  - New `distributeOneTabPerGroup()` guarantees one terminal per tile even if a
    layout collapse tabbed two together (extracted from the existing
    `rearrangeAllEditors` bubble-distribute logic).
  - The grid is now sized from the **actual** number of editor groups that
    remain, not a pre-computed tally.
  - Unrelated non-terminal tabs (a code file, a Claude chat) are kept **out** of
    the terminal grid — folded behind a terminal via `vscode.TabInputTerminal`
    detection so they never claim a tile and are never closed. No-op in a
    dedicated terminal window.

- **"Super weird" grid for odd terminal counts (notably 5).** Opening a 5-Claude
  preset produced a broken layout — a tab in the wrong tile, two terminals merged
  into one, or a blank tile — instead of a clean 3-over-2.

  Root cause: terminals are created in a flat left-to-right row and then reshaped
  into the target grid by `setEditorLayout`. For counts that don't fill a
  rectangle (5 → 3/2, 7 → 3/2/2, …) that target tree is **asymmetric**, and a
  single reshape pass maps the flat groups onto it unreliably — VS Code drops a
  tab into the wrong tile, tabs two together, or leaves a blank. Even counts
  (4 → 2/2, 6 → 3/3) have symmetric rows and were unaffected.

  Fix:
  - New `applyGridReconcile(intended)` replaces the one-shot
    setLayout → distribute → setLayout in every tiling path. It loops up to 5×
    {`setEditorLayout` → `distributeOneTabPerGroup` → `closeEmptyGroups`} and
    exits the instant the editor area is exactly `intended` groups with one tab
    each — so a grid that lands cleanly on the first pass costs no extra work.
  - All four tiling sites now call it: `spawnTerminals`, `regridAfterClose`,
    `rearrangeGrid`, and `rearrangeAllEditors` (the last three previously each had
    their own ad-hoc, non-looping tiling).
  - `buildGridLayout` now emits an explicit `size: 1` on every row and every tile
    so the split is deterministic — even row heights and even tile widths within
    each row. (The short bottom row's tiles are still wider than the top's; that's
    inherent to a 3/2 and not a bug.)

### Changed

- Extracted `sortedGroups()` and `focusGroup()` to module scope so
  `spawnTerminals` and `rearrangeAllEditors` share one implementation.

### Changed

- Renamed the extension's display name from **Claude Terminals** to **Claude
  Grid** (command titles, activity-bar/sidebar title, settings category, OS
  notification title, README). Internal ids are unchanged — the package id stays
  `claude-terminals`, commands stay `claudeTerminals.*`, settings keys stay
  `claudeTerminals.*`, and the proposed-API id stays `local.claude-terminals` —
  so existing `settings.json` presets and `argv.json` enablement keep working.

### Docs

- Added a grid screenshot (`media/screenshots/grid.png`) to the README hero.
- Added a copy-paste "Set it up with Claude Code" prompt to the README that
  automates the symlink install and proposed-API notification wiring.

### Notes

- The reuse prompt ("Keep N open, open M new" vs "Open N brand-new terminals")
  was already correct and is unchanged.
