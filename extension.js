const vscode = require("vscode");

/** Terminals we opened, so "Close All" only touches ours. */
const owned = new Set();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getConfig() {
  return vscode.workspace.getConfiguration("claudeTerminals");
}

/**
 * Normalize a preset into a flat list of terminal specs:
 *   { name, cwd, command }
 */
function expandPreset(preset) {
  const defaultCommand = getConfig().get("defaultCommand") || "claude";

  if (Array.isArray(preset.terminals) && preset.terminals.length > 0) {
    return preset.terminals.map((t, i) => ({
      name: t.name || `Claude ${i + 1}`,
      cwd: t.cwd || undefined,
      command: t.command || defaultCommand,
    }));
  }

  const count = Math.max(1, Number(preset.count) || 1);
  const command = preset.command || defaultCommand;
  const specs = [];
  for (let i = 0; i < count; i++) {
    specs.push({ name: `Claude ${i + 1}`, cwd: undefined, command });
  }
  return specs;
}

/**
 * Build a VS Code editor layout tree that tiles `n` groups into a grid.
 * Columns = ceil(sqrt(n)); rows filled left-to-right, top-to-bottom.
 * orientation 1 = stack rows vertically; inner groups split horizontally.
 */
function buildGridLayout(n) {
  const cols = Math.ceil(Math.sqrt(n));
  const rows = [];
  let remaining = n;
  while (remaining > 0) {
    const inRow = Math.min(cols, remaining);
    const rowGroups = [];
    for (let c = 0; c < inRow; c++) rowGroups.push({});
    rows.push({ groups: rowGroups });
    remaining -= inRow;
  }
  return { orientation: 1, groups: rows };
}

async function openPreset(preset) {
  const specs = expandPreset(preset);
  const workspaceFolder =
    vscode.workspace.workspaceFolders &&
    vscode.workspace.workspaceFolders[0] &&
    vscode.workspace.workspaceFolders[0].uri.fsPath;

  const created = [];

  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i];
    const cwd = spec.cwd || workspaceFolder || undefined;

    const terminal = vscode.window.createTerminal({
      name: spec.name,
      cwd,
      location: { viewColumn: vscode.ViewColumn.Beside },
    });
    terminal.show(false);
    owned.add(terminal);
    created.push({ terminal, command: spec.command });

    // Let the editor group settle before creating the next split.
    await sleep(120);
  }

  // Reflow the row of terminals into a grid.
  if (created.length > 1) {
    try {
      await vscode.commands.executeCommand(
        "vscode.setEditorLayout",
        buildGridLayout(created.length)
      );
    } catch (err) {
      // Layout is best-effort; terminals still work if it fails.
      console.error("Claude Terminals: setEditorLayout failed", err);
    }
    await sleep(150);
  }

  // Send the command into each terminal.
  for (const { terminal, command } of created) {
    if (command) terminal.sendText(command, true);
  }
}

async function pickAndOpenPreset() {
  const presets = getConfig().get("presets") || [];
  if (presets.length === 0) {
    vscode.window.showWarningMessage(
      "No presets configured. Add some under the 'claudeTerminals.presets' setting."
    );
    return;
  }

  const items = presets.map((p) => ({
    label: p.name || "Preset",
    description: Array.isArray(p.terminals)
      ? `${p.terminals.length} terminals`
      : `${p.count || 1} terminals`,
    preset: p,
  }));

  const choice = await vscode.window.showQuickPick(items, {
    placeHolder: "Select a Claude terminal preset",
  });
  if (choice) await openPreset(choice.preset);
}

function closeAll() {
  for (const t of owned) {
    try {
      t.dispose();
    } catch (_) {}
  }
  owned.clear();
}

/** Sidebar webview: monochrome dark list of preset buttons. */
class PresetsViewProvider {
  constructor(context) {
    this.context = context;
  }

  resolveWebviewView(webviewView) {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = this.html();

    webviewView.webview.onDidReceiveMessage((msg) => {
      if (msg && msg.type === "open" && typeof msg.index === "number") {
        const presets = getConfig().get("presets") || [];
        const preset = presets[msg.index];
        if (preset) openPreset(preset);
      } else if (msg && msg.type === "closeAll") {
        closeAll();
      } else if (msg && msg.type === "settings") {
        vscode.commands.executeCommand(
          "workbench.action.openSettings",
          "claudeTerminals.presets"
        );
      }
    });

    // Re-render when presets change.
    const sub = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("claudeTerminals")) {
        webviewView.webview.html = this.html();
      }
    });
    webviewView.onDidDispose(() => sub.dispose());
  }

  html() {
    const presets = getConfig().get("presets") || [];
    const rows = presets
      .map((p, i) => {
        const name = escapeHtml(p.name || `Preset ${i + 1}`);
        const count = Array.isArray(p.terminals)
          ? p.terminals.length
          : p.count || 1;
        return `<button class="preset" data-index="${i}">
          <span class="name">${name}</span>
          <span class="count">${count}×</span>
        </button>`;
      })
      .join("");

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<style>
  :root {
    --bg: #0a0a0a;
    --fg: #e6e6e6;
    --muted: #8a8a8a;
    --line: #262626;
    --hover: #161616;
    --accent: #ffffff;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 10px;
    background: var(--bg);
    color: var(--fg);
    font-family: var(--vscode-font-family, ui-monospace, monospace);
    font-size: 12px;
  }
  h2 {
    font-size: 11px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--muted);
    margin: 2px 2px 12px;
    font-weight: 600;
  }
  .preset {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    padding: 10px 12px;
    margin: 0 0 8px;
    background: transparent;
    color: var(--fg);
    border: 1px solid var(--line);
    border-radius: 8px;
    cursor: pointer;
    text-align: left;
    transition: background 0.12s ease, border-color 0.12s ease;
  }
  .preset:hover {
    background: var(--hover);
    border-color: var(--accent);
  }
  .preset:active { background: #202020; }
  .name { font-weight: 600; }
  .count {
    color: var(--muted);
    font-variant-numeric: tabular-nums;
    border: 1px solid var(--line);
    border-radius: 999px;
    padding: 1px 8px;
    font-size: 11px;
  }
  .footer {
    display: flex;
    gap: 8px;
    margin-top: 12px;
    padding-top: 12px;
    border-top: 1px solid var(--line);
  }
  .link {
    flex: 1;
    background: transparent;
    color: var(--muted);
    border: 1px solid var(--line);
    border-radius: 6px;
    padding: 7px 8px;
    cursor: pointer;
    font-size: 11px;
  }
  .link:hover { color: var(--fg); border-color: var(--accent); }
  .empty { color: var(--muted); padding: 8px 2px; }
</style>
</head>
<body>
  <h2>Presets</h2>
  ${rows || '<div class="empty">No presets. Click “Edit presets”.</div>'}
  <div class="footer">
    <button class="link" id="close">Close all</button>
    <button class="link" id="edit">Edit presets</button>
  </div>
  <script>
    const vscode = acquireVsCodeApi();
    document.querySelectorAll('.preset').forEach((btn) => {
      btn.addEventListener('click', () => {
        vscode.postMessage({ type: 'open', index: Number(btn.dataset.index) });
      });
    });
    document.getElementById('close').addEventListener('click', () => {
      vscode.postMessage({ type: 'closeAll' });
    });
    document.getElementById('edit').addEventListener('click', () => {
      vscode.postMessage({ type: 'settings' });
    });
  </script>
</body>
</html>`;
  }
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function activate(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "claudeTerminals.openPreset",
      pickAndOpenPreset
    ),
    vscode.commands.registerCommand("claudeTerminals.closeAll", closeAll),
    vscode.window.registerWebviewViewProvider(
      "claudeTerminals.presetsView",
      new PresetsViewProvider(context)
    ),
    vscode.window.onDidCloseTerminal((t) => owned.delete(t))
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
