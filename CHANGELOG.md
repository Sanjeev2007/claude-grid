# Changelog

All notable changes to the Claude Grid extension are documented here.

## [Unreleased]

### Fixed

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
