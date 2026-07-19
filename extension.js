const vscode = require("vscode");
const os = require("os");
const fs = require("fs");
const path = require("path");
const cp = require("child_process");

/** Terminals we opened, so "Close All" only touches ours. */
const owned = new Set();

/**
 * `owned` holds live Terminal objects, which are lost on window reload. VS Code
 * restores the terminals themselves, so we persist their names to workspace
 * state and re-adopt the matching restored terminals on activation — otherwise
 * "Close all" / "Rearrange" would treat everything as gone after a reload.
 */
let extContext = null;
const OWNED_KEY = "claudeTerminals.ownedNames";
const PIDS_KEY = "claudeTerminals.ownedPids";
/** Terminals we create are named "Claude 1", "Claude 2", … — a stable pattern. */
const CLAUDE_NAME_RE = /^Claude \d+$/i;
/** Names we owned pre-reload but haven't matched to a restored terminal yet. */
let restorePending = new Set();
/** Process ids we owned pre-reload — stable across a window reload (same pty). */
let restorePendingPids = new Set();
/** True while the extension host is tearing down, so we don't persist [] then. */
let deactivating = false;
/** True while closeAll() is disposing our terminals, so per-close auto-regrid stays quiet. */
let closingAll = false;
/** Debounce handle for re-tiling after a terminal is closed. */
let autoRegridTimer = null;
/**
 * Per-terminal timestamp of the last "finished" notification, so a burst of
 * bells (Claude re-rings, or the TUI repaints) collapses into a single banner.
 */
const lastNotified = new Map();

/**
 * The terminal that most recently finished, so that when this window regains
 * focus (e.g. the user clicked the notification and VS Code came forward) we can
 * jump straight to it. macOS can't target a window/terminal for us, so the
 * extension reveals it itself — and only in the window that actually owns it.
 */
let pendingReveal = null; // { terminal, at }
/** Ignore a stale pending reveal so an old finish can't hijack a later focus. */
const REVEAL_TTL_MS = 10 * 60 * 1000;

/**
 * Save the identity of the terminals we currently own for post-reload recovery:
 * both their names and their process ids. On a window reload VS Code reconnects
 * the same pty, so the persisted pid still matches even when the `claude` TUI
 * has since overwritten the terminal's title — which the name alone would miss.
 */
async function persistOwnedNames() {
  if (!extContext) return;
  const terminals = Array.from(owned);
  const names = terminals.map((t) => t.name);
  const pids = (
    await Promise.all(terminals.map((t) => t.processId.catch(() => undefined)))
  ).filter((pid) => typeof pid === "number");
  extContext.workspaceState.update(OWNED_KEY, names);
  extContext.workspaceState.update(PIDS_KEY, pids);
}

/**
 * If a restored terminal is one we owned before a reload, re-adopt it (once).
 * We match on any of: a name we persisted, our "Claude N" naming pattern, or a
 * process id we persisted (the sturdiest signal across a reload).
 */
async function tryAdopt(terminal) {
  if (owned.has(terminal)) return;
  let match = restorePending.has(terminal.name) || CLAUDE_NAME_RE.test(terminal.name);
  if (!match && restorePendingPids.size > 0) {
    const pid = await terminal.processId.catch(() => undefined);
    if (typeof pid === "number" && restorePendingPids.has(pid)) match = true;
  }
  if (match && !owned.has(terminal)) {
    restorePending.delete(terminal.name);
    owned.add(terminal);
  }
}

/**
 * On activation, reclaim ownership of terminals VS Code restored across a
 * reload by matching them against the names and process ids we persisted. Late-
 * restored terminals are caught by the onDidOpenTerminal handler in activate.
 */
async function adoptRestoredTerminals() {
  if (!extContext) return;
  const names = extContext.workspaceState.get(OWNED_KEY, []);
  const pids = extContext.workspaceState.get(PIDS_KEY, []);
  restorePending = new Set(Array.isArray(names) ? names : []);
  restorePendingPids = new Set(Array.isArray(pids) ? pids : []);
  await Promise.all(vscode.window.terminals.map((t) => tryAdopt(t)));
}

/**
 * Cross-window handoff file. When a preset asks for more terminals than fit
 * comfortably in one window, the current window writes the overflow specs here
 * and opens a second window; that window's copy of the extension reads this on
 * startup and opens its share. Each window only ever grids its own terminals.
 */
const SPILL_FILE = path.join(os.tmpdir(), "claude-terminals-spill.json");
const SPILL_TTL_MS = 90000;

// --- Cross-window overflow routing -----------------------------------------
// Each window advertises itself with a heartbeat file and receives terminals
// via message files, both in tmpdir. When the + button is pressed in a window
// already at the spillover threshold, the new terminal is routed to another
// window (the newest one on the same project that still has room) instead of
// crowding this one; if none has room, a fresh window is opened to take it.
// This lets you keep pressing + in the main sidebar while each overflow lands
// and re-tiles in the extra window. File-per-window/-message avoids write races.
const HB_PREFIX = "claude-terminals-hb-";
const MSG_PREFIX = "claude-terminals-msg-";
const HB_TTL_MS = 6000; // a heartbeat older than this ⇒ that window is gone
const MSG_TTL_MS = 90000; // orphaned messages older than this get reaped
const PENDING_TTL_MS = 20000; // trust a just-opened window this long pre-heartbeat
/** This window's id (may be reassigned from a spill payload on startup). */
let WIN_ID = null;
/** Creation order — newer windows sort later, so we fill the newest with room. */
let WIN_ORDER = 0;
/** Disambiguates messages sent within the same millisecond. */
let msgSeq = 0;
/** Guards against two inbox drains running at once (each re-tiles the layout). */
let processingInbox = false;
/** A window we just opened but whose heartbeat isn't up yet: { winId, folder, queued, since }. */
let pendingOverflow = null;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Editor groups in stable left-to-right / top-to-bottom order. */
function sortedGroups() {
  return vscode.window.tabGroups.all
    .slice()
    .sort((a, b) => (a.viewColumn || 0) - (b.viewColumn || 0));
}

/**
 * Focus the group at position `idx` (0-based) using relative navigation, which
 * works for any number of groups (the numbered focus commands stop at 8).
 */
async function focusGroup(idx) {
  await vscode.commands.executeCommand("workbench.action.focusFirstEditorGroup");
  for (let k = 0; k < idx; k++) {
    await vscode.commands.executeCommand("workbench.action.focusNextGroup");
  }
}

/**
 * Close editor groups that hold no tabs. VS Code leaves these phantom empty
 * groups behind after a terminal is closed or a split is collapsed, and because
 * they still count as groups, a subsequent `setEditorLayout` keeps them as blank
 * tiles and collapses two real terminals together. We always leave at least one
 * group standing. Guarded against runaway loops.
 */
async function closeEmptyGroups() {
  let guard = 0;
  while (guard++ < 40) {
    const groups = sortedGroups();
    if (groups.length <= 1) return;
    const idx = groups.findIndex((g) => g.tabs.length === 0);
    if (idx === -1) return;
    await focusGroup(idx);
    await vscode.commands.executeCommand("workbench.action.closeGroup");
    await sleep(50);
  }
}

/**
 * Bubble-distribute: repeatedly take the leftmost group that still has more than
 * one tab and push its active editor into the next group, so overflow ripples
 * rightward until every group holds at most one tab. Prevents two terminals from
 * sharing a tile after a layout collapse.
 */
async function distributeOneTabPerGroup(maxGroups) {
  let guard = 0;
  while (guard++ < maxGroups * maxGroups + 8) {
    const groups = sortedGroups();
    const idx = groups.findIndex((g) => g.tabs.length > 1);
    if (idx === -1) break;
    await focusGroup(idx);
    await vscode.commands.executeCommand("workbench.action.moveEditorToNextGroup");
    await sleep(50);
  }
}

/**
 * Tile the editor area into a clean `intended`-tile grid, one tab per tile, and
 * keep reconciling until it actually lands that way (or we run out of passes).
 *
 * A single setEditorLayout is not reliable for counts that don't fill a
 * rectangle — 5 (→ 3/2), 7 (→ 3/2/2), etc. Reshaping a flat row of terminals
 * into an asymmetric tree, VS Code can drop one tab into the wrong tile, tab two
 * together, or leave a blank — the "super weird" 5-terminal grid. Each pass:
 * impose the grid, spread any doubled-up tile rightward (creating groups as
 * needed), reap the phantom empties that leaves, then re-impose. We stop as soon
 * as the real editor area is exactly `intended` groups with one tab each, so a
 * grid that lands cleanly on the first pass costs nothing extra.
 */
async function applyGridReconcile(intended) {
  if (intended < 2) return;
  for (let pass = 0; pass < 5; pass++) {
    await vscode.commands.executeCommand(
      "vscode.setEditorLayout",
      buildGridLayout(intended)
    );
    await sleep(120);
    await distributeOneTabPerGroup(intended);
    await sleep(80);
    await closeEmptyGroups();
    const groups = sortedGroups();
    if (
      groups.length === intended &&
      groups.every((g) => g.tabs.length === 1)
    ) {
      return;
    }
  }
  // Best effort: whatever we ended up with, size the grid to the real count.
  await vscode.commands.executeCommand(
    "vscode.setEditorLayout",
    buildGridLayout(sortedGroups().length)
  );
}

function getConfig() {
  return vscode.workspace.getConfiguration("claudeTerminals");
}

/**
 * Bundle id of the running editor app, used so a clicked notification activates
 * VS Code (or Insiders/VSCodium/Cursor) rather than whatever ran the notifier.
 * macOS sets `__CFBundleIdentifier` for Launch-Services-started apps and the
 * extension host inherits it, which covers every fork for free; we fall back to
 * mapping the app name for the common cases.
 */
function appBundleId() {
  const fromEnv = process.env.__CFBundleIdentifier;
  if (fromEnv) return fromEnv;
  switch (vscode.env.appName) {
    case "Visual Studio Code":
      return "com.microsoft.VSCode";
    case "Visual Studio Code - Insiders":
      return "com.microsoft.VSCodeInsiders";
    case "VSCodium":
      return "com.vscodium";
    default:
      return undefined;
  }
}

/**
 * Fire an OS-native notification banner that shows even when VS Code is in the
 * background — a real system notification, not an in-app toast. On macOS we
 * prefer `terminal-notifier`, whose notification is a real signed app bundle, so
 * a click can ACTIVATE VS Code (`-activate <bundleId>`) — after which the
 * onDidChangeWindowState handler reveals the finished terminal. This is the only
 * way to redirect the click: `osascript`'s `display notification` is owned by
 * Script Editor, so clicking it launches Script Editor (and Finder), never VS
 * Code. We fall back to `osascript` when terminal-notifier isn't installed, and
 * to an in-window message (with a working Show button) if even that fails.
 */
function notifyOS(title, body, terminal) {
  const fallback = () =>
    vscode.window
      .showInformationMessage(`${title}: ${body}`, "Show")
      .then((pick) => {
        if (pick === "Show" && terminal && owned.has(terminal)) {
          try {
            terminal.show(false);
          } catch (_) {}
        }
      });
  try {
    if (process.platform === "darwin") {
      // AppleScript string literals: escape backslashes first, then quotes.
      const esc = (s) =>
        String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      const osascriptBanner = () => {
        const script = `display notification "${esc(body)}" with title "${esc(title)}"`;
        cp.execFile("osascript", ["-e", script], (err) => {
          if (err) fallback();
        });
      };
      // Prefer terminal-notifier so the click activates VS Code; on ENOENT (not
      // installed) or any failure, fall back to the osascript banner.
      const bundleId = appBundleId();
      const tnArgs = ["-title", String(title), "-message", String(body)];
      if (bundleId) tnArgs.push("-activate", bundleId, "-sender", bundleId);
      cp.execFile("terminal-notifier", tnArgs, (err) => {
        if (err) osascriptBanner();
      });
    } else if (process.platform === "linux") {
      cp.execFile("notify-send", [String(title), String(body)], (err) => {
        if (err) fallback();
      });
    } else if (process.platform === "win32") {
      // A dependency-free toast via PowerShell's BurntToast-less WinRT API is
      // fiddly and version-sensitive; use the in-window message on Windows.
      fallback();
    } else {
      fallback();
    }
  } catch (_) {
    fallback();
  }
}

/**
 * Called for every chunk of output from any terminal. When one of OUR Claude
 * terminals emits a bell (\x07) — which `claude` rings on finishing a turn and
 * awaiting you — raise a "finished" notification, gated by config and a
 * per-terminal cooldown so repeated bells don't spam.
 */
function handleTerminalData(terminal, data) {
  if (!owned.has(terminal)) return;
  if (!data || data.indexOf("\u0007") === -1) return; // fast path: no BEL at all
  // A BEL byte isn't only the audible bell -- it is also the string terminator
  // for OSC escape sequences (ESC ] ... BEL), which is how programs set the
  // terminal title/tab name. Claude Code rewrites its title constantly (status,
  // spinner), so a naive indexOf fires on every repaint. Strip OSC strings first
  // (BEL- or ST-terminated); only a bare BEL that survives is a genuine bell.
  const stripped = data.replace(/\u001b\][\s\S]*?(?:\u0007|\u001b\\)/g, "");
  if (stripped.indexOf("\u0007") === -1) return; // only OSC terminators, no bell

  const cfg = getConfig();
  if (!cfg.get("notifyOnFinish", true)) return;
  if (cfg.get("notifyOnlyWhenUnfocused", false) && vscode.window.state.focused) {
    return;
  }

  const now = Date.now();
  const cooldown = Math.max(0, Number(cfg.get("notifyCooldownMs")) || 0);
  const last = lastNotified.get(terminal) || 0;
  if (now - last < cooldown) return;
  lastNotified.set(terminal, now);

  const folder =
    vscode.workspace.workspaceFolders &&
    vscode.workspace.workspaceFolders[0] &&
    vscode.workspace.workspaceFolders[0].name;
  const body = folder ? `${terminal.name} finished — ${folder}` : `${terminal.name} finished`;
  // Remember which terminal to jump to when this window next gains focus (the
  // user clicking the notification brings VS Code forward). Only this window has
  // the terminal in `owned`, so only it will reveal — the right window wins.
  pendingReveal = { terminal, at: now };
  notifyOS("Claude Grid", body, terminal);
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
 * Build a VS Code editor layout tree that tiles `n` groups into a balanced
 * grid. We pick the fewest rows that keep each row within `maxColumns`, then
 * spread the terminals across those rows as evenly as possible (e.g. 10 with a
 * cap of 5 → 5/5; with a cap of 3 → 3/3/2/2). The `maxColumns` cap keeps cells
 * from getting too narrow to render Claude's UI on small displays.
 * orientation 1 = stack rows vertically; inner groups split horizontally.
 */
function buildGridLayout(n) {
  const maxCols = Math.max(1, Number(getConfig().get("maxColumns")) || 3);
  const numRows = Math.max(1, Math.ceil(n / maxCols));
  const base = Math.floor(n / numRows);
  let extra = n % numRows; // first `extra` rows get one more terminal

  const rows = [];
  for (let r = 0; r < numRows; r++) {
    const inRow = base + (extra > 0 ? 1 : 0);
    if (extra > 0) extra--;
    const rowGroups = [];
    // Equal `size` within the row → even tile widths; equal `size` per row →
    // even row heights. Making the split explicit keeps VS Code from handing a
    // reshaped grid uneven fractions (the "super weird" 5-terminal proportions).
    for (let c = 0; c < inRow; c++) rowGroups.push({ size: 1 });
    rows.push({ size: 1, groups: rowGroups });
  }
  return { orientation: 1, groups: rows };
}

async function openPreset(preset) {
  const specs = expandPreset(preset);
  const total = specs.length;

  // If we already have Claude terminals open, ask whether to fold them into
  // this preset (reuse the open ones, only spin up the difference) or ignore
  // them and open a fresh set. Reused terminals go first in the grid.
  const existing = Array.from(owned);
  let reuseCount = 0;
  if (existing.length > 0) {
    const reuseN = Math.min(existing.length, total);
    const newN = total - reuseN;
    const plural = existing.length === 1 ? "" : "s";
    const reuseItem = {
      label:
        newN > 0
          ? `$(add) Keep ${reuseN} open, open ${newN} new`
          : `$(layout) Reuse ${reuseN} existing, re-tile`,
      description: `${total} total`,
      mode: "reuse",
    };
    const newItem = {
      label: `$(terminal) Open ${total} brand-new terminals`,
      description: `keeps the ${existing.length} already open, separate`,
      mode: "new",
    };
    const choice = await vscode.window.showQuickPick([reuseItem, newItem], {
      placeHolder: `${existing.length} Claude terminal${plural} already open — reuse or open new?`,
    });
    if (!choice) return; // cancelled
    if (choice.mode === "reuse") reuseCount = reuseN;
  }

  const workspaceFolder =
    vscode.workspace.workspaceFolders &&
    vscode.workspace.workspaceFolders[0] &&
    vscode.workspace.workspaceFolders[0].uri.fsPath;

  // Resolve every spec's working directory up front so overflow specs sent to
  // a second window (which may have no workspace folder) still land correctly.
  const resolved = specs.map((s) => ({
    name: s.name,
    cwd: s.cwd || workspaceFolder || undefined,
    command: s.command,
  }));

  const reused = existing.slice(0, reuseCount);

  // Decide how many terminals this window keeps. Anything past the spillover
  // threshold is handed to a second window so a small screen isn't crammed.
  const threshold = Math.max(0, Number(getConfig().get("spilloverThreshold")) || 0);
  let keepCount = total;
  if (threshold > 0 && total > threshold) {
    keepCount = Math.max(reuseCount, threshold);
  }

  const currentSpecs = resolved.slice(reuseCount, keepCount);
  const overflowSpecs = resolved.slice(keepCount);

  await spawnTerminals(currentSpecs, reused);

  // Hand the remainder to a fresh window. The specs carry absolute, pre-resolved
  // cwds, and the workspace folder rides along in the spill file so the new
  // window can land on the same project (see openOverflowWindow / consumeSpill).
  if (overflowSpecs.length > 0) {
    writeSpill(overflowSpecs, workspaceFolder);
    // Announce in the current window before focus shifts to the new one.
    vscode.window.showInformationMessage(
      `Opened ${keepCount} here; ${overflowSpecs.length} more opening in a new window.`
    );
    await openOverflowWindow(workspaceFolder);
  }
}

/**
 * Create each spec as a terminal in its OWN editor group, tile the whole set
 * (any `reused` terminals first, then the new ones) into a balanced grid, and
 * send each new terminal its command — staggered to avoid the auth race.
 *
 * We split a fresh empty group (newGroupRight) and drop the terminal into it
 * via ViewColumn.Active rather than relying on `Beside`, which intermittently
 * tabs terminals together and leaves the grid lopsided.
 */
async function spawnTerminals(specs, reused) {
  reused = reused || [];
  const created = [];

  // Whether the editor area currently holds nothing — the very first terminal
  // can then reuse the empty group instead of splitting a redundant one.
  const areaEmpty =
    vscode.window.tabGroups.all.reduce((s, g) => s + g.tabs.length, 0) === 0;

  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i];

    const firstIntoEmpty =
      created.length === 0 && reused.length === 0 && areaEmpty;
    if (!firstIntoEmpty) {
      await vscode.commands.executeCommand("workbench.action.newGroupRight");
      await sleep(50);
    }

    const terminal = vscode.window.createTerminal({
      name: spec.name || nextClaudeName(),
      cwd: spec.cwd || undefined,
      location: { viewColumn: vscode.ViewColumn.Active },
    });
    terminal.show(false);
    owned.add(terminal);
    created.push({ terminal, command: spec.command });

    // Let the editor group settle before splitting the next one.
    await sleep(100);
  }

  persistOwnedNames();

  // Reveal reused terminals so each occupies its own group before tiling.
  for (const t of reused) t.show(false);
  await sleep(120);

  // Drop phantom empty groups so they can't become blank tiles or throw off the
  // group count when we tile — the root cause of the "empty first tile + two
  // terminals merged" bug.
  await closeEmptyGroups();

  // Keep unrelated tabs (a file, a Claude chat) out of the terminal grid: fold
  // any group that holds no terminal into a neighbour, so its editors get tabbed
  // behind a terminal instead of claiming their own tile. Files are preserved,
  // never closed, and no two terminals get merged. Once a non-terminal tab lands
  // in a group that also has a terminal, that group no longer matches, so this
  // converges (guard-bounded). In a dedicated terminal window it's a no-op.
  const isTerminalTab = (t) => t.input instanceof vscode.TabInputTerminal;
  let guard = 0;
  while (guard++ < 60) {
    const groups = sortedGroups();
    if (groups.length <= 1) break;
    const idx = groups.findIndex(
      (g) => g.tabs.length > 0 && !g.tabs.some(isTerminalTab)
    );
    if (idx === -1) break;
    const forward = idx !== groups.length - 1;
    await focusGroup(idx);
    // Move the active editor to a neighbouring group, then reap the group it
    // left behind if it's now empty.
    await vscode.commands.executeCommand(
      forward
        ? "workbench.action.moveEditorToNextGroup"
        : "workbench.action.moveEditorToPreviousGroup"
    );
    await sleep(50);
    await closeEmptyGroups();
  }

  // Grid order: reused terminals first, then the newly created ones. Count the
  // groups that actually remain rather than trusting our own tally.
  const gridCount = sortedGroups().length;
  if (gridCount > 1) {
    try {
      await applyGridReconcile(gridCount);
    } catch (err) {
      // Layout is best-effort; terminals still work if it fails.
      console.error("Claude Grid: setEditorLayout failed", err);
    }
    await sleep(150);
  }

  // Send the command into each terminal, staggered.
  //
  // Launching several `claude` processes at the exact same instant makes them
  // race on refreshing the OAuth token in the keychain; the losers get bounced
  // to a login prompt. Staggering lets the first session settle auth before the
  // rest start, so they reuse the refreshed token instead of re-authenticating.
  const stagger = Math.max(0, Number(getConfig().get("launchStaggerMs")) || 0);
  for (let i = 0; i < created.length; i++) {
    const { terminal, command } = created[i];
    if (command) terminal.sendText(command, true);
    if (stagger && i < created.length - 1) await sleep(stagger);
  }

  // Publish the new count so other windows route overflow adds correctly.
  writeHeartbeat();
  return created;
}

/**
 * Write overflow specs for a second window to pick up on startup. `folder` (an
 * fsPath, may be undefined) is the project the originating window had open; the
 * overflow window is opened onto that same folder by openOverflowWindow, and the
 * specs carry absolute cwds as a fallback for when no folder is open.
 */
function writeSpill(specs, folder, assignedWinId) {
  try {
    fs.writeFileSync(
      SPILL_FILE,
      JSON.stringify({
        at: Date.now(),
        specs,
        folder: folder || undefined,
        assignedWinId: assignedWinId || undefined,
      })
    );
  } catch (err) {
    console.error("Claude Grid: writeSpill failed", err);
  }
}

/**
 * Open the overflow window that will consume the spill file. It must land on the
 * SAME folder the originating window has open, and that is exactly the case VS
 * Code fights us on:
 *   - `openFolder(folder, { forceNewWindow })` de-duplicates against the folder
 *     that's already open and just focuses the existing window — no new window.
 *   - `newWindow()` + `openFolder(folder, { forceReuseWindow })` from the blank
 *     window hits the same de-dup: the already-open folder wins, the blank window
 *     is absorbed into the existing one and closes. This was the bug — the extra
 *     window flashed open then vanished and no terminals were ever created.
 * `duplicateWorkspaceInNewWindow` is the one command that deliberately opens the
 * current folder in a *second* window without de-duplicating, which is precisely
 * what we want. We fall back to a blank `newWindow` (the spill specs carry
 * absolute cwds, so terminals still land in the right directory) if it's missing
 * or there's no folder to duplicate.
 */
async function openOverflowWindow(folder) {
  if (folder) {
    try {
      await vscode.commands.executeCommand(
        "workbench.action.duplicateWorkspaceInNewWindow"
      );
      return;
    } catch (err) {
      console.error(
        "Claude Grid: duplicateWorkspaceInNewWindow failed, opening a blank window",
        err
      );
    }
  }
  await vscode.commands.executeCommand("workbench.action.newWindow");
}

/**
 * On startup, if a fresh spill file exists, claim it and open its terminals in
 * this window. The window is opened by openOverflowWindow, which already put us
 * on the right folder (or a blank window whose terminals use the pre-resolved
 * absolute cwds), so we simply claim the file and spawn — no folder reopen, which
 * previously absorbed and closed this window.
 */
async function consumeSpill() {
  let payload;
  try {
    if (!fs.existsSync(SPILL_FILE)) return;
    const raw = fs.readFileSync(SPILL_FILE, "utf8");
    payload = JSON.parse(raw);
  } catch (_) {
    try {
      fs.unlinkSync(SPILL_FILE);
    } catch (_) {}
    return;
  }
  if (
    !payload ||
    !Array.isArray(payload.specs) ||
    payload.specs.length === 0 ||
    Date.now() - (payload.at || 0) > SPILL_TTL_MS
  ) {
    try {
      fs.unlinkSync(SPILL_FILE);
    } catch (_) {}
    return;
  }

  try {
    fs.unlinkSync(SPILL_FILE); // claim so no other window double-opens
  } catch (_) {}

  // If the opening window addressed this one with a known id, adopt it so the
  // adds it already routed here (message files) land in THIS window.
  if (payload.assignedWinId) {
    try {
      if (WIN_ID) fs.unlinkSync(heartbeatPath(WIN_ID));
    } catch (_) {}
    WIN_ID = payload.assignedWinId;
    writeHeartbeat();
  }

  // Fresh spill window — clear any Welcome/Get Started editor first so the
  // grid isn't thrown off by an unrelated tab.
  try {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await sleep(200);
  } catch (_) {}

  await spawnTerminals(payload.specs, []);
}

/**
 * Next unused "Claude N" name based on the terminals we currently own, so adding
 * one after an earlier one was closed doesn't collide (owned {1,3} → "Claude 4").
 */
function nextClaudeName() {
  let max = 0;
  for (const t of owned) {
    const m = /^Claude (\d+)$/i.exec(t.name);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `Claude ${max + 1}`;
}

/**
 * Add a single Claude terminal. While this window is below the spillover
 * threshold, the terminal opens here and the grid rebalances (e.g. 4 open → add
 * one → a 5-tile grid). Once this window is full, the add is routed to an
 * overflow window instead (see routeOverflow), so the main sidebar's + keeps
 * filling and re-tiling the extra window rather than crowding this one.
 */
async function addTerminal() {
  const folder = currentFolder();
  const command = getConfig().get("defaultCommand") || "claude";
  const threshold = Math.max(
    0,
    Number(getConfig().get("spilloverThreshold")) || 0
  );

  if (threshold > 0 && owned.size >= threshold) {
    await routeOverflow(folder, threshold, command);
    return;
  }

  // Name is left to spawnTerminals so it stays sequential within this window.
  await spawnTerminals([{ cwd: folder || undefined, command }], Array.from(owned));
}

/**
 * Re-tile the Claude terminals we currently have open into a fresh grid,
 * without creating new ones. Lets you fix the layout after manually moving
 * terminals around, or after opening more than one preset.
 */
async function rearrangeGrid() {
  const n = owned.size;

  // After a reload `owned` is empty (live handles are gone) but the terminals
  // survive as editor tabs. Fall back to gridding the editor area with tab
  // commands, which don't need live handles — so "Rearrange" still works.
  if (n < 2) {
    const totalTabs = vscode.window.tabGroups.all.reduce(
      (s, g) => s + g.tabs.length,
      0
    );
    const hasTerminalTabs = vscode.window.tabGroups.all.some((g) =>
      g.tabs.some((t) => t.input instanceof vscode.TabInputTerminal)
    );
    if (hasTerminalTabs && totalTabs >= 2) {
      await rearrangeAllEditors();
      return;
    }
    if (n === 0) {
      vscode.window.showInformationMessage(
        hasTerminalTabs
          ? "Only one terminal open — nothing to tile."
          : "No Claude terminals open to rearrange. Open a preset first."
      );
    }
    return; // 0 with nothing to tile, or exactly 1 owned terminal
  }

  // Make sure each terminal is focused/revealed so it occupies its own group.
  for (const t of owned) t.show(false);
  await sleep(120);
  // Reap phantom empties before measuring, then tile the real group count and
  // reconcile until it's a clean one-per-tile grid.
  await closeEmptyGroups();

  try {
    await applyGridReconcile(sortedGroups().length);
  } catch (err) {
    console.error("Claude Grid: rearrange setEditorLayout failed", err);
    vscode.window.showWarningMessage(
      "Couldn't rearrange the terminal grid. Make sure the Claude terminals are in the editor area."
    );
  }
}

/**
 * Whether a just-closed terminal is plausibly one of ours even when the live
 * `owned` set has gone stale — the usual case after a window reload, where the
 * terminals survive as editor tabs but we couldn't re-adopt them (the `claude`
 * TUI overwrites the "Claude N" title, so name matching misses). Matches our
 * naming pattern or a name we persisted for this workspace.
 */
function looksLikeOurs(terminal) {
  if (!terminal) return false;
  if (CLAUDE_NAME_RE.test(terminal.name)) return true;
  const persisted = extContext
    ? extContext.workspaceState.get(OWNED_KEY, []) || []
    : [];
  return Array.isArray(persisted) && persisted.includes(terminal.name);
}

/** Count terminals living as tabs in the editor area (across all groups). */
function editorTerminalTabCount() {
  return vscode.window.tabGroups.all.reduce(
    (sum, g) =>
      sum +
      g.tabs.filter((t) => t.input instanceof vscode.TabInputTerminal).length,
    0
  );
}

/**
 * Debounced trigger for re-tiling after a terminal is closed. A single close, or
 * a burst of them, collapses into one regrid once the dust settles. No-op when
 * the user has turned the behaviour off, while closeAll is disposing our set, or
 * during host teardown.
 */
function scheduleAutoRegrid() {
  if (deactivating || closingAll) return;
  if (!getConfig().get("autoRegridOnClose", true)) return;
  if (autoRegridTimer) clearTimeout(autoRegridTimer);
  autoRegridTimer = setTimeout(() => {
    autoRegridTimer = null;
    regridAfterClose().catch((err) =>
      console.error("Claude Grid: auto-regrid failed", err)
    );
  }, 250);
}

/**
 * Re-tile the terminals still open after one (or several) were closed. Closing a
 * terminal leaves a phantom empty group where it sat, which would otherwise
 * linger as a blank tile — so we reap those first, then re-impose the balanced
 * grid over what remains. With fewer than two terminals left there's nothing to
 * tile (VS Code already gives the lone terminal the whole area).
 */
async function regridAfterClose() {
  if (deactivating || closingAll) return;

  // Let VS Code finish its own reflow first — killing a terminal asynchronously
  // empties (and often auto-closes) the group it sat in — then reap any phantom
  // empty group it left behind before we measure.
  await sleep(80);
  await closeEmptyGroups();

  // Pull each still-live terminal we own into its own group, so a close that
  // tabbed two together gets separated. Best-effort only: after a window reload
  // `owned` can be empty even though the terminals survive as editor tabs, so we
  // must NOT gate the regrid on it — the tile count below is read from the real
  // editor area instead. Dead handles from a reload may throw on show().
  const remaining = Array.from(owned);
  for (const t of remaining) {
    try {
      t.show(false);
    } catch (_) {}
  }
  if (remaining.length) {
    await sleep(120);
    await closeEmptyGroups();
  }

  // Tile based on the terminals actually present in the editor area, not our
  // (possibly stale) owned tally. Below two there's nothing to grid — VS Code
  // already gives a lone terminal the whole area.
  if (editorTerminalTabCount() < 2) return;

  const gridCount = sortedGroups().length;
  if (gridCount < 2) return;
  try {
    await applyGridReconcile(gridCount);
  } catch (err) {
    console.error("Claude Grid: regridAfterClose setEditorLayout failed", err);
  }
}

/**
 * Grid EVERYTHING in the editor area — any editor tab, whoever opened it
 * (Claude chat sessions, terminals we didn't create, regular files). Pulls
 * each tab into its own group, then imposes the balanced grid. Handy when a
 * reload has left the extension unaware of what's open, or for arbitrary tabs.
 */
async function rearrangeAllEditors() {
  const countTabs = () =>
    vscode.window.tabGroups.all.reduce((sum, g) => sum + g.tabs.length, 0);
  const total = countTabs();
  if (total < 2) {
    vscode.window.showInformationMessage(
      "Need at least 2 open editor tabs to arrange into a grid."
    );
    return;
  }

  // Tile all `total` tabs and reconcile until each holds its own tile — the same
  // loop that keeps odd counts (5, 7, …) from landing on a "super weird" grid.
  try {
    await applyGridReconcile(total);
  } catch (err) {
    console.error("Claude Grid: grid all failed", err);
    vscode.window.showWarningMessage("Couldn't grid the editor tabs.");
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

async function closeAll() {
  // Suppress per-close auto-regrid while we tear the whole set down; a burst of
  // close events would otherwise each try to re-tile a shrinking grid.
  closingAll = true;
  if (autoRegridTimer) {
    clearTimeout(autoRegridTimer);
    autoRegridTimer = null;
  }
  // "Close all" has to work after a window reload too, when our live Terminal
  // handles are gone AND VS Code hasn't revived the restored terminals back into
  // `vscode.window.terminals` yet (revival is lazy — often on first focus). The
  // one surface that lists them reliably post-reload is the editor TAB model:
  // each of our terminals is an editor tab whose label VS Code persisted (e.g.
  // "Claude 1"). So we close by tab, not by terminal handle.
  const persistedNames = extContext
    ? new Set(extContext.workspaceState.get(OWNED_KEY, []) || [])
    : new Set();
  const persistedPids = extContext
    ? new Set(extContext.workspaceState.get(PIDS_KEY, []) || [])
    : new Set();
  // Whether this workspace ever opened Claude terminals (used as a guard for the
  // rename fallback below).
  const openedHere = persistedNames.size > 0 || persistedPids.size > 0;

  // Every terminal that lives as an editor tab, and the subset that is "ours":
  // label is a persisted name or matches our "Claude N" pattern. If nothing
  // matches by label but we know we opened Claude terminals here and editor
  // terminals exist, treat them all as ours — covers a restored tab whose title
  // was renamed by the `claude` TUI.
  const editorTerminalTabs = [];
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      if (tab.input instanceof vscode.TabInputTerminal) editorTerminalTabs.push(tab);
    }
  }
  const editorTerminalLabels = new Set(editorTerminalTabs.map((t) => t.label));
  let claudeTabs = editorTerminalTabs.filter(
    (t) => persistedNames.has(t.label) || CLAUDE_NAME_RE.test(t.label)
  );
  if (claudeTabs.length === 0 && openedHere && editorTerminalTabs.length > 0) {
    claudeTabs = editorTerminalTabs;
  }

  // Collect any live handles we still hold (in-session precision) plus any
  // already-revived terminal that matches, so their processes end cleanly. The
  // "Claude N" pattern is scoped to editor tabs so we never kill a panel
  // terminal a user happened to name that way.
  const disposeTargets = new Set(owned);
  await Promise.all(
    vscode.window.terminals.map(async (t) => {
      if (disposeTargets.has(t)) return;
      if (persistedNames.has(t.name)) return void disposeTargets.add(t);
      if (CLAUDE_NAME_RE.test(t.name) && editorTerminalLabels.has(t.name)) {
        return void disposeTargets.add(t);
      }
      if (persistedPids.size > 0) {
        const pid = await t.processId.catch(() => undefined);
        if (typeof pid === "number" && persistedPids.has(pid)) disposeTargets.add(t);
      }
    })
  );

  // Close the editor tabs FIRST, while every tab reference is still fresh — this
  // is what actually removes the un-revived restored terminals that never showed
  // up in `vscode.window.terminals`. Closing per-tab so one stale ref can't abort
  // the rest. Then dispose the live handles as a belt-and-suspenders pass.
  for (const tab of claudeTabs) {
    try {
      await vscode.window.tabGroups.close(tab, false);
    } catch (_) {}
  }
  for (const t of disposeTargets) {
    try {
      t.dispose();
    } catch (_) {}
  }

  owned.clear();
  restorePending.clear();
  restorePendingPids.clear();
  if (extContext) {
    extContext.workspaceState.update(OWNED_KEY, []);
    extContext.workspaceState.update(PIDS_KEY, []);
  }

  // Close events fire slightly after dispose; keep auto-regrid suppressed until
  // that trailing burst has drained, then clear any regrid it managed to queue.
  await sleep(400);
  closingAll = false;
  if (autoRegridTimer) {
    clearTimeout(autoRegridTimer);
    autoRegridTimer = null;
  }
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
      } else if (msg && msg.type === "addTerminal") {
        addTerminal().catch((err) =>
          console.error("Claude Grid: addTerminal failed", err)
        );
      } else if (msg && msg.type === "rearrange") {
        rearrangeGrid();
      } else if (msg && msg.type === "rearrangeAll") {
        rearrangeAllEditors();
      } else if (msg && msg.type === "closeAll") {
        closeAll().catch((err) =>
          console.error("Claude Grid: closeAll failed", err)
        );
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
    const maxCols = Math.max(1, Number(getConfig().get("maxColumns")) || 3);
    const rows = presets
      .map((p, i) => {
        const name = escapeHtml(p.name || `Preset ${i + 1}`);
        const count = Array.isArray(p.terminals)
          ? p.terminals.length
          : p.count || 1;
        return `<button class="preset" data-index="${i}" aria-label="${name}, ${count} terminals">
          <span class="name">${name}</span>
          ${gridPreview(count, maxCols)}
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
  .add {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    width: 100%;
    padding: 9px 12px;
    margin: 0 0 14px;
    background: transparent;
    color: var(--fg);
    border: 1px dashed var(--line);
    border-radius: 8px;
    cursor: pointer;
    font-family: inherit;
    font-size: 12px;
    font-weight: 600;
    transition: background 0.12s ease, border-color 0.12s ease;
  }
  .add:hover { background: var(--hover); border-color: var(--accent); }
  .add:active { background: #202020; }
  .add .plus { font-size: 15px; line-height: 1; }
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
  .grid {
    display: flex;
    flex-direction: column;
    gap: 2px;
    width: 34px;
    height: 26px;
    padding: 3px;
    flex: none;
    border: 1px solid var(--line);
    border-radius: 4px;
    background: #0f0f0f;
  }
  .tile-row {
    display: flex;
    gap: 2px;
    flex: 1;
    min-height: 0;
  }
  .tile {
    flex: 1;
    min-width: 0;
    border-radius: 1.5px;
    background: var(--muted);
  }
  .preset:hover .grid { border-color: var(--accent); }
  .preset:hover .tile { background: var(--fg); }
  .footer {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 12px;
    padding-top: 12px;
    border-top: 1px solid var(--line);
  }
  .link {
    flex: 1 1 40%;
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
  <button class="add" id="add" title="Open one more Claude terminal and re-tile the grid">
    <span class="plus">+</span> Add terminal
  </button>
  ${rows || '<div class="empty">No presets. Click “Edit presets”.</div>'}
  <div class="footer">
    <button class="link" id="rearrange" title="Re-tile the Claude terminals this extension opened">Rearrange grid</button>
    <button class="link" id="rearrangeAll" title="Grid every tab in the editor area — Claude chats, terminals, files">Grid all tabs</button>
    <button class="link" id="close">Close all</button>
    <button class="link" id="edit">Edit presets</button>
  </div>
  <script>
    const vscode = acquireVsCodeApi();
    document.getElementById('add').addEventListener('click', () => {
      vscode.postMessage({ type: 'addTerminal' });
    });
    document.querySelectorAll('.preset').forEach((btn) => {
      btn.addEventListener('click', () => {
        vscode.postMessage({ type: 'open', index: Number(btn.dataset.index) });
      });
    });
    document.getElementById('rearrange').addEventListener('click', () => {
      vscode.postMessage({ type: 'rearrange' });
    });
    document.getElementById('rearrangeAll').addEventListener('click', () => {
      vscode.postMessage({ type: 'rearrangeAll' });
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

/**
 * Split `n` tiles into per-row counts the same way buildGridLayout() does, so
 * the sidebar preview matches the grid the preset will actually open.
 */
function gridRowCounts(n, maxCols) {
  const cap = Math.max(1, maxCols);
  const numRows = Math.max(1, Math.ceil(n / cap));
  const base = Math.floor(n / numRows);
  let extra = n % numRows;
  const counts = [];
  for (let r = 0; r < numRows; r++) {
    counts.push(base + (extra > 0 ? 1 : 0));
    if (extra > 0) extra--;
  }
  return counts;
}

/** A tiny grid-of-tiles thumbnail mirroring the layout this preset opens. */
function gridPreview(count, maxCols) {
  const rows = gridRowCounts(count, maxCols)
    .map((inRow) => {
      const tiles = Array.from({ length: inRow }, () => '<i class="tile"></i>').join("");
      return `<span class="tile-row">${tiles}</span>`;
    })
    .join("");
  return `<span class="grid" aria-hidden="true">${rows}</span>`;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// --- Cross-window overflow routing helpers ---------------------------------

function heartbeatPath(id) {
  return path.join(os.tmpdir(), `${HB_PREFIX}${id}.json`);
}

function messagePrefixFor(id) {
  return `${MSG_PREFIX}${id}-`;
}

/** fsPath of this window's first workspace folder, or undefined. */
function currentFolder() {
  return (
    (vscode.workspace.workspaceFolders &&
      vscode.workspace.workspaceFolders[0] &&
      vscode.workspace.workspaceFolders[0].uri.fsPath) ||
    undefined
  );
}

function sameFolder(a, b) {
  return (a || "") === (b || "");
}

/** Publish this window's identity + terminal count so other windows can find it. */
function writeHeartbeat() {
  if (!WIN_ID) return;
  try {
    const threshold = Math.max(
      0,
      Number(getConfig().get("spilloverThreshold")) || 0
    );
    fs.writeFileSync(
      heartbeatPath(WIN_ID),
      JSON.stringify({
        winId: WIN_ID,
        folder: currentFolder(),
        count: owned.size,
        threshold,
        order: WIN_ORDER,
        at: Date.now(),
      })
    );
  } catch (_) {}
}

/** Read every live (non-stale) window heartbeat; reap stale ones as we go. */
function readLiveWindows() {
  const dir = os.tmpdir();
  let files;
  try {
    files = fs.readdirSync(dir);
  } catch (_) {
    return [];
  }
  const now = Date.now();
  const out = [];
  for (const f of files) {
    if (!f.startsWith(HB_PREFIX) || !f.endsWith(".json")) continue;
    const p = path.join(dir, f);
    try {
      const w = JSON.parse(fs.readFileSync(p, "utf8"));
      if (!w || !w.winId) continue;
      if (now - (w.at || 0) > HB_TTL_MS) {
        try {
          fs.unlinkSync(p);
        } catch (_) {}
        continue;
      }
      out.push(w);
    } catch (_) {}
  }
  return out;
}

/** Drop a message file asking window `winId` to open + grid these specs. */
function sendToWindow(winId, specs) {
  try {
    const seq = `${Date.now()}-${msgSeq++}`;
    fs.writeFileSync(
      path.join(os.tmpdir(), `${messagePrefixFor(winId)}${seq}.json`),
      JSON.stringify({ at: Date.now(), specs })
    );
  } catch (err) {
    console.error("Claude Grid: sendToWindow failed", err);
  }
}

/** Delete message files addressed to dead windows so tmpdir doesn't accrete. */
function reapOrphanMessages() {
  const dir = os.tmpdir();
  let files;
  try {
    files = fs.readdirSync(dir);
  } catch (_) {
    return;
  }
  const now = Date.now();
  for (const f of files) {
    if (!f.startsWith(MSG_PREFIX) || !f.endsWith(".json")) continue;
    const p = path.join(dir, f);
    try {
      const m = JSON.parse(fs.readFileSync(p, "utf8"));
      if (now - ((m && m.at) || 0) > MSG_TTL_MS) fs.unlinkSync(p);
    } catch (_) {
      try {
        fs.unlinkSync(p);
      } catch (_) {}
    }
  }
}

/**
 * Pick up any terminals other windows routed to this one and open + grid them.
 * Serialized (processingInbox) so two drains never re-tile the layout at once.
 */
async function pollInbox() {
  if (!WIN_ID || processingInbox) return;
  processingInbox = true;
  try {
    const dir = os.tmpdir();
    let files;
    try {
      files = fs.readdirSync(dir);
    } catch (_) {
      return;
    }
    const mine = files
      .filter((f) => f.startsWith(messagePrefixFor(WIN_ID)) && f.endsWith(".json"))
      .sort();
    for (const f of mine) {
      const p = path.join(dir, f);
      let payload = null;
      try {
        payload = JSON.parse(fs.readFileSync(p, "utf8"));
      } catch (_) {}
      try {
        fs.unlinkSync(p);
      } catch (_) {}
      if (payload && Array.isArray(payload.specs) && payload.specs.length) {
        await spawnTerminals(payload.specs, Array.from(owned));
      }
    }
    if (mine.length) reapOrphanMessages();
  } finally {
    processingInbox = false;
  }
}

/**
 * This window is full, so hand the new terminal to another window: the one we
 * just opened but that's still booting (pendingOverflow), else the newest live
 * window on this project that still has room, else a brand-new window we open
 * and address by a known id (so subsequent adds can be queued to it too).
 */
async function routeOverflow(folder, threshold, command) {
  const now = Date.now();
  const spec = { cwd: folder || undefined, command };
  const live = readLiveWindows().filter(
    (w) => w.winId !== WIN_ID && sameFolder(w.folder, folder)
  );

  // Retire the pending record once its real heartbeat shows up or it goes stale.
  if (pendingOverflow) {
    const up = live.some((w) => w.winId === pendingOverflow.winId);
    if (
      up ||
      now - pendingOverflow.since > PENDING_TTL_MS ||
      !sameFolder(pendingOverflow.folder, folder)
    ) {
      pendingOverflow = null;
    }
  }

  // Prefer the window we just opened while it's still coming up.
  if (pendingOverflow && pendingOverflow.queued < threshold) {
    sendToWindow(pendingOverflow.winId, [spec]);
    pendingOverflow.queued++;
    return;
  }

  // Else the newest live window that still has room.
  const withRoom = live
    .filter((w) => w.count < (w.threshold || threshold))
    .sort((a, b) => (b.order || 0) - (a.order || 0));
  if (withRoom.length) {
    sendToWindow(withRoom[0].winId, [spec]);
    return;
  }

  // Else open a fresh window, addressed by a known id so we can queue to it.
  const newId = `${WIN_ID}-of-${now}`;
  writeSpill([spec], folder, newId);
  pendingOverflow = { winId: newId, folder, queued: 1, since: now };
  vscode.window.showInformationMessage(
    "This window is full — opening the extra terminal in a new window."
  );
  await openOverflowWindow(folder);
}

function activate(context) {
  // This window's identity for cross-window overflow routing. May be reassigned
  // by consumeSpill if we were opened to receive another window's overflow.
  WIN_ID = `${process.pid}-${Date.now()}`;
  WIN_ORDER = Date.now();

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "claudeTerminals.openPreset",
      pickAndOpenPreset
    ),
    vscode.commands.registerCommand("claudeTerminals.closeAll", closeAll),
    vscode.commands.registerCommand("claudeTerminals.addTerminal", addTerminal),
    vscode.commands.registerCommand("claudeTerminals.rearrange", rearrangeGrid),
    vscode.commands.registerCommand(
      "claudeTerminals.rearrangeAll",
      rearrangeAllEditors
    ),
    vscode.window.registerWebviewViewProvider(
      "claudeTerminals.presetsView",
      new PresetsViewProvider(context)
    ),
    vscode.window.onDidCloseTerminal((t) => {
      const wasOwned = owned.delete(t);
      lastNotified.delete(t);
      // Don't rewrite persisted state during shutdown: VS Code fires close
      // events for restorable terminals as the host tears down, which would
      // otherwise clobber our saved names/pids with an empty list and break
      // "Close all" on the next launch.
      if (!deactivating) {
        persistOwnedNames();
        writeHeartbeat();
        // Re-tile what's left so the grid closes the gap the terminal left
        // behind. Debounced, and skipped while closeAll disposes the whole set.
        // Fire when the closed terminal was ours — either a live-owned handle,
        // or (after a reload, when `owned` is stale) one that still carries our
        // name — as long as a grid of ours actually remains in the editor area.
        if (wasOwned || (looksLikeOurs(t) && editorTerminalTabCount() >= 2)) {
          scheduleAutoRegrid();
        }
      }
    }),
    // Adopt terminals that VS Code restores slightly after startup.
    vscode.window.onDidOpenTerminal((t) => tryAdopt(t)),
    // When this window comes to the foreground after a finish notification,
    // reveal the terminal that finished — this is the "take me to it" step the
    // OS can't do. Guarded so a stale finish, or a terminal we no longer own
    // (closed, or belongs to another window), never hijacks an unrelated focus.
    vscode.window.onDidChangeWindowState((state) => {
      if (!state.focused || !pendingReveal) return;
      const { terminal, at } = pendingReveal;
      pendingReveal = null;
      if (Date.now() - at > REVEAL_TTL_MS) return;
      if (!owned.has(terminal)) return;
      try {
        terminal.show(false);
      } catch (_) {}
    })
  );

  // Watch terminal output for Claude's finish bell and raise an OS notification.
  // `onDidWriteTerminalData` is a proposed API (terminalDataWriteEvent); guard on
  // its presence so the extension degrades gracefully when it isn't enabled.
  if (typeof vscode.window.onDidWriteTerminalData === "function") {
    context.subscriptions.push(
      vscode.window.onDidWriteTerminalData((e) =>
        handleTerminalData(e.terminal, e.data)
      )
    );
  } else {
    console.warn(
      "Claude Grid: terminalDataWriteEvent proposed API not enabled — " +
        "finish notifications disabled. Add \"local.claude-terminals\" to the " +
        "\"enable-proposed-api\" array in ~/.vscode/argv.json and restart."
    );
  }

  extContext = context;
  // Reclaim ownership of terminals that survived a window reload.
  adoptRestoredTerminals();

  // Advertise this window and listen for terminals other windows route to it,
  // so the + button's overflow can land here and re-tile. Cleared on dispose.
  writeHeartbeat();
  const hbTimer = setInterval(writeHeartbeat, 2000);
  const inboxTimer = setInterval(() => {
    pollInbox().catch((err) =>
      console.error("Claude Grid: pollInbox failed", err)
    );
  }, 1000);
  context.subscriptions.push({
    dispose() {
      clearInterval(hbTimer);
      clearInterval(inboxTimer);
      try {
        if (WIN_ID) fs.unlinkSync(heartbeatPath(WIN_ID));
      } catch (_) {}
    },
  });

  // If this window was opened to receive spillover terminals, pick them up.
  consumeSpill().catch((err) =>
    console.error("Claude Grid: consumeSpill failed", err)
  );
}

function deactivate() {
  deactivating = true;
}

module.exports = { activate, deactivate };
