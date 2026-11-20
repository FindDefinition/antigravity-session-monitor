# Antigravity Session Monitor

A lightweight, zero-dependency **Google Antigravity** plugin providing a live right-sidebar monitor for long-running and multi-model sessions, plus an always-on rule for concise milestone progress updates.

Reads `<appData>/brain/<conversationId>/.system_generated/logs/transcript.jsonl` read-only with **zero LLM calls** and **zero external npm dependencies**.

## Features

- **Compact Context Bar:** Live progress bar toward the ~500K auto-compaction threshold, active model pill, compaction & call counts, and an instant hover tooltip with exact input/output token counts.
- **Per-Model Token & Throughput Stats:** Uncached input, cached read, output tokens, max context, cache hit rate, **historical output TPS (`tok/s`)**, and model-switch cache miss impact (excluding compaction checkpoints to save vertical space).
- **Filterable Live Activity Timeline:**
  - Color-coded badges for **`SUMMARY`** (final replies), **`PROGRESS`** (mid-task milestone updates), **`USER`**, **`COMPACT`**, **`THOUGHT`**, and **`TOOL`** steps.
  - Per-type filter toggle chips (chips with count `0` auto-hide; selection persists in `localStorage`).
  - Chronological order (newest at bottom) with sticky-bottom auto-scroll that preserves scroll position when browsing history.
  - **Antigravity-style User-Prompt Dot Navigator:** Vertical dot rail along the left edge — hover any dot for a preview card (prompt, assistant reply preview, turn index, timestamp), click to jump directly to its page and scroll to that turn.
  - **On-Demand Full Message Expansion:** Click **`Expand full ▾`** on any truncated card to load the complete message (and optional internal thinking + one-click Copy) straight from `transcript.jsonl` / `transcript_full.jsonl`.
- **Automatic Host Theme Sync:** Loads Antigravity's `/preload.js` bridge and binds to host CSS tokens (`--background`, `--foreground`, `--muted-foreground`, `--card`, `--border`) for seamless light and dark mode support.
- **Always-On Milestone Progress Rule (`rules/AGENTS.md`):** Guides models to emit brief 1–2 sentence visible progress updates alongside `tool_calls` at meaningful milestones during multi-step tasks.

## Installation

### Option 1: Clone directly into Antigravity's global plugins directory (Recommended)

```bash
git clone https://github.com/FindDefinition/antigravity-session-monitor.git \
  ~/.gemini/config/plugins/session-monitor
```

To update later:

```bash
git -C ~/.gemini/config/plugins/session-monitor pull
```

### Option 2: Install via `agy` CLI

```bash
git clone https://github.com/FindDefinition/antigravity-session-monitor.git
agy plugin install ./antigravity-session-monitor
```

## Usage

1. Once installed, Antigravity discovers and enables `session-monitor` automatically (or manage it under **Customizations → Plugins → Session Monitor**).
2. Open the **Session Monitor** panel from the right auxiliary pane's **`+`** menu (or via a `sidecar://session-monitor/session_monitor/` pill in chat).
3. The panel polls `transcript.jsonl` incrementally every 2 seconds using `mtime:size` etags.
4. **Reloading after local edits without restarting Antigravity:**
   - **UI-only edits (`index.html`):** **Shift+Click** the **Refresh** button in the panel.
   - **Backend edits (`main.mjs`):** Toggle **Session Monitor** off → on in Antigravity's Customizations page.

## Structure

```text
.
├── plugin.json                         # Plugin manifest
├── rules/
│   └── AGENTS.md                       # Always-on milestone progress update rule
└── sidecars/
    └── session_monitor/
        ├── sidecar.json                # Aux-pane sidecar manifest
        ├── main.mjs                    # Read-only transcript indexer & API server
        └── index.html                  # Theme-aware sidebar UI
```

## License

MIT — see [LICENSE](LICENSE).
