# Changelog

All notable changes to the Claude Terminals extension are documented here.

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

### Changed

- Extracted `sortedGroups()` and `focusGroup()` to module scope so
  `spawnTerminals` and `rearrangeAllEditors` share one implementation.

### Docs

- Added a grid screenshot (`media/screenshots/grid.png`) to the README hero.
- Added a copy-paste "Set it up with Claude Code" prompt to the README that
  automates the symlink install and proposed-API notification wiring.

### Notes

- The reuse prompt ("Keep N open, open M new" vs "Open N brand-new terminals")
  was already correct and is unchanged.
