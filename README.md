# Claude Terminals

A tiny personal VS Code extension: pick a preset and it opens that many
`claude` terminals, tiled into a grid in the editor area.

## What it does

- Presets like **6 Claudes** → opens 6 terminals arranged in a 3×2 grid,
  each running `claude` in your workspace folder.
- A **dark / monochrome sidebar** (activity-bar icon on the left) with a
  clickable button per preset.
- Also available from the Command Palette: **“Claude Terminals: Open Preset…”**
- **Close All** removes just the terminals this extension opened.

## Install it for yourself (no publishing)

Pick whichever is easier.

### Option A — run from source (fastest to try)

1. Open this folder in VS Code.
2. Press **F5**. A second VS Code window (“Extension Development Host”) opens
   with the extension loaded. Use it there.

### Option B — install it permanently into your VS Code

Symlink (or copy) this folder into your extensions directory, then restart
VS Code:

```sh
ln -s "$(pwd)" ~/.vscode/extensions/claude-terminals
# (VS Code Insiders: ~/.vscode-insiders/extensions/claude-terminals)
```

Now the sidebar icon and commands are always available — no dev host needed.

### Option C — build a .vsix

```sh
npm install -g @vscode/vsce
vsce package --allow-missing-repository
code --install-extension claude-terminals-0.0.1.vsix
```

## Customizing presets

Open **Settings → search “Claude Terminals”**, or click **“Edit presets”** in
the sidebar. Edit `claudeTerminals.presets` in `settings.json`.

Two forms are supported:

```jsonc
{
  "claudeTerminals.defaultCommand": "claude",
  "claudeTerminals.presets": [
    // simple: N terminals, all running the default command
    { "name": "6 Claudes", "count": 6 },

    // advanced: per-terminal name, folder, and command
    {
      "name": "Review setup",
      "terminals": [
        { "name": "api", "cwd": "api",  "command": "claude" },
        { "name": "web", "cwd": "web",  "command": "claude" },
        { "name": "notes", "command": "claude --model opus" }
      ]
    }
  ]
}
```

- `cwd` is relative to the workspace folder (or an absolute path).
- If a terminal has no `command`, it runs `claudeTerminals.defaultCommand`.

## Notes / limits

- Grid layout uses VS Code’s editor-area tiling (`vscode.setEditorLayout`).
  Columns = `ceil(sqrt(N))`, so 6 → 3×2, 4 → 2×2, 9 → 3×3.
- VS Code can’t pixel-position terminals; the grid is as precise as the
  editor-group layout allows.
- The command assumes `claude` is on your `PATH`. If not, set
  `claudeTerminals.defaultCommand` to the full path.
