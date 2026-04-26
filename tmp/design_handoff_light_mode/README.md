# Handoff: logsim2 — Light Mode Scenario Editor

## Overview

This handoff converts logsim2's Scenario Editor (the canvas-based topology builder where users drag service nodes and wire them together with TCP connections) from its current dark-leaning treatment to a **light-mode visual system** aligned with the existing repo conventions in `src/components/nodes/ServiceNode.tsx` and `src/components/palette/Palette.tsx`.

The end goal is the same canvas, same component structure, same React Flow graph — just a refined, fully light-mode visual layer with cleaner type, more consistent slate-based neutrals, and a small set of new affordances (top bar, log/inspector right panel) layered on top.

## About the design files

The files in `prototype/` are **design references created in HTML + standalone React via Babel**. They are *not* production code to lift verbatim — they intentionally don't import from the repo's component tree, don't use React Flow, and don't talk to the backend.

Your task is to **recreate the look and behavior of the prototype inside the existing logsim2 codebase**, using its established patterns:
- Existing `ServiceNode` / `Palette` components
- Existing React Flow setup
- Existing Tailwind utility classes (or the project's CSS module convention — match what's already there)
- Existing state stores

When prototype HTML/CSS contradicts repo conventions, **the repo wins**. The prototype is a target appearance, not a target implementation.

## Fidelity

**High-fidelity.** All colors, spacing, typography, and border radii in the prototype are intended as final values. Recreate pixel-perfectly using the codebase's libraries.

The one exception is the right-side **log panel** and **inspector** — these are new surfaces. Treat their visuals as final but feel free to wire them to whatever data sources/stores the existing app uses.

## Scope of changes

| Surface | Change |
|---|---|
| Theme / tokens | Switch to light mode. Establish slate-based neutrals + blue-600 accent. |
| `ServiceNode` | Keep the green-border / blue-when-selected pattern. Tighten spacing, restyle the address + channel block, lighten the title-bar gradient. |
| `Palette` | Light card surface, grouped headers (`Network` / `Compute` / `Services`), hover states. |
| Top bar (new) | Logo, breadcrumbs, build/run/replay/datasets tab group, status indicator, time-multiplier segmented control, Pause/Run + Export. |
| Right panel (new) | Live streaming logs view (default) or per-node Inspector (when a node is selected). |
| Edges | Animated dashed connection-flow lines. |

## Design tokens

Define these as CSS custom properties (or Tailwind theme extensions). Match `prototype/tokens.css` exactly.

### Colors
```css
--ls-bg:            #f8fafc;   /* slate-50  — app background */
--ls-bg-1:          #ffffff;   /* surfaces (cards, panels) */
--ls-bg-2:          #f1f5f9;   /* slate-100 — subtle fills, badges */
--ls-bg-3:          #e2e8f0;   /* slate-200 — track / divider fills */
--ls-border:        #e2e8f0;   /* slate-200 — default borders */
--ls-border-strong: #cbd5e1;   /* slate-300 — input + button borders */

--ls-text:   #0f172a;          /* slate-900 — primary */
--ls-text-2: #334155;          /* slate-700 — body */
--ls-text-3: #64748b;          /* slate-500 — secondary / labels */
--ls-text-4: #94a3b8;          /* slate-400 — tertiary / placeholder */

--ls-accent:        #2563eb;   /* blue-600  — selected, primary buttons, focus */
--ls-accent-soft:   rgba(37,99,235,0.10);
--ls-accent-border: rgba(37,99,235,0.32);

--ls-green: #16a34a;           /* live indicator, follow-tail */
--ls-green-soft: #86efac;      /* default node border */
--ls-amber: #d97706;           /* WARN level */
--ls-red:   #dc2626;           /* ERROR level, destructive */
```

### Typography
- Sans: `Inter` (already in repo) for everything except monospace contexts
- Mono: `ui-monospace, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace` — used for IPs, ports, log lines, hostnames, kbd badges
- **No JetBrains Mono.** Use system mono only.

### Spacing & radii
- Border radius: `4px` small, `6px` default, `8px` cards
- Node card: `220px` wide, ~`80px` tall (title bar 32px + body)
- Right panel: `380px` wide
- Left palette: `220px` wide
- Top bar: `48px` tall

### Shadows
```css
--ls-shadow-sm: 0 1px 2px rgba(15, 23, 42, 0.05);
--ls-shadow:    0 4px 12px rgba(15, 23, 42, 0.08);
--ls-shadow-lg: 0 12px 32px rgba(15, 23, 42, 0.10);
```

## Components

### 1. ServiceNode (existing — restyle)

**File to edit:** `src/components/nodes/ServiceNode.tsx`

**Layout:**
- White background, 8px border radius
- **1.5px border, color `#86efac` (green-300) by default, `#3b82f6` (blue-500) when selected**
- Soft shadow: `0 14px 32px -28px rgba(15,23,42,0.30)` default; `0 18px 40px -24px rgba(37,99,235,0.30)` when selected
- Title bar (32px tall): subtle vertical gradient `linear-gradient(180deg, #f8fafc 0%, #ffffff 100%)`, bottom border `--ls-border`
- Title bar contains, left to right:
  - Emoji glyph (14px font-size, native emoji from Palette config)
  - Label (font-weight 600, 13px, slate-900) — flex-grow 1
  - Service-type badge (mono, 9.5px, slate-500, slate-100 bg, slate-200 1px border, 3px radius, uppercase, 2px×6px padding) — only shown for service nodes (not VPC/Subnet/Custom)
  - Settings gear button (lucide `Settings` icon, 14px, slate-500; on hover slate-100 bg / slate-900 text)
- Body (10px 12px 12px padding):
  - Address (mono, 13px, slate-900, font-weight 500) — e.g. `10.183.164.128`
  - Channel (mono, 11px, slate-500, 4px top margin) — e.g. `tcp:8080`
- React Flow handles ("ports") on top + bottom centers: 11px circle, white fill, 2px slate-400 border. Hidden by default; visible on node hover. Hover state: blue-600 border, blue-soft fill, scale 1.3.

### 2. Palette (existing — restyle)

**File to edit:** `src/components/palette/Palette.tsx`

- White background, 220px wide, right-edge 1px slate-200 border
- Header: 12px×14px padding, "ADD NODE" (11px, uppercase, letter-spacing 0.06em, slate-500, font-weight 600), bottom 1px slate-200 border
- Group headers ("Network" / "Compute" / "Services"): 10px uppercase, letter-spacing 0.08em, slate-400, font-weight 600
- Items: 7px×10px padding, 6px radius, 13px slate-700 font-weight 500, 8px gap between emoji + label. Hover: slate-100 bg + slate-900 text.
- Footer: "Click to add · Drag to position" (10.5px, slate-400, centered, top 1px border)
- Items are draggable (HTML5 dnd) AND clickable (adds with default position)

### 3. Top bar (new)

**Suggested file:** `src/components/topbar/Topbar.tsx`

48px tall, white bg, bottom 1px slate-200 border. Three-column grid: `1fr auto 1fr`, 12px gap.

**Left column:**
- Logo: 4-square SVG glyph in blue-600 (two corners full, two at 0.4 opacity), word "logsim" (700/14px), "v2" badge (mono, 11px, slate-500)
- Breadcrumbs: "Workspace / Scenarios / **three-tier-web**" — slate-500, current page slate-900 weight 500, separator opacity 0.4

**Center column — tab group:**
- Background slate-100, 1px slate-200 border, 6px radius, 3px inner padding
- Tabs: Build, Run, Replay, Datasets
- Inactive: slate-500, 12px, weight 500, transparent bg
- Active: white bg, slate-900 text, sm shadow

**Right column:**
- Status pill: animated green dot + "streaming" / amber dot + "paused" (mono, 11px, slate-500). The green dot has a 1.6s ease-out pulse keyframe (see `tokens.css`).
- Time-multiplier segmented control: 1× / 2× / 4× / 8× — same segmented-control pattern as the tab group
- Pause/Run button: secondary (`--ls-btn` style)
- Export dataset button: primary blue-600

### 4. Right panel — Logs (new, default state)

**Suggested file:** `src/components/logs/LogPanel.tsx`

380px wide, white bg, left 1px slate-200 border. Vertical flex column.

**Header (11px×14px padding, bottom 1px border):**
- Left: green pulsing dot + "Live logs" (12px, slate-900, weight 600) + rate badge ("4/s", mono 10.5px, slate-100 bg, slate-500, 3px radius, 1px×6px padding)
- Right: 3 count pills (mono 10px, weight 600, 2px×7px padding, 3px radius):
  - INFO count — slate-100 bg, slate-200 border, slate-500 text
  - WARN count — amber-tinted (`rgba(217,119,6,0.08)` bg, `rgba(217,119,6,0.32)` border, `#d97706` text)
  - ERROR count — red-tinted (`rgba(220,38,38,0.08)` bg, `rgba(220,38,38,0.32)` border, `#dc2626` text)

**Toolbar (8px×12px padding, bottom 1px border):**
- Filter input (flex-grow): white bg, slate-300 1px border, 5px×9px padding, mono 11.5px. Focus: blue-600 border + 2px blue-soft ring.
- Level segmented control (ALL / INFO / WARN / ERROR): mono 10.5px uppercase, weight 600, slate-100 bg, 4px radius, slate-200 border, 2px inner padding
- Follow toggle: mono 10.5px, slate-100 bg, slate-200 border, dot icon. On state: green text + green-tinted border + bg.

**Body (scrollable, mono 11.5px):**
- Each log line is a 4-column grid: `84px (timestamp) 84px (source) 44px (level) 1fr (message)`, 8px gap, 2px×12px padding, line-height 1.55, white-space nowrap, overflow-ellipsis on source + message
- Timestamp: slate-400, format `HH:MM:SS.mmm`
- Source: blue-600 (the node id, e.g. `mysql-1`)
- Level: weight 700; INFO slate-500, WARN amber, ERROR red
- WARN row: amber-tinted bg (`rgba(217,119,6,0.06)`) + 2px amber left-border
- ERROR row: red-tinted bg (`rgba(220,38,38,0.06)`) + 2px red left-border
- Hover: slate-100 row bg
- Empty state: "Add a node from the palette to start emitting logs." centered, slate-400, 12px sans

### 5. Right panel — Inspector (new, when a node is selected)

**Suggested file:** `src/components/inspector/Inspector.tsx`

Replaces the log panel when a node is selected. Same 380px width.

**Header:** emoji + label (14px weight 600) + close ✕ button.

**Sections (14px padding, 1px slate-200 dividers):**

1. **Identity:**
   - Label (text input, ln-input style)
   - Address (mono input)
   - Channel (mono input — format `tcp:3306`)
   - Resource (read-only field, e.g. "MySQL")

2. **"LOG GENERATION" section header** (10.5px uppercase, letter-spacing 0.08em, slate-500 weight 600):
   - Volume slider (0–100, suffix " EPS" in slate-500)
   - Anomaly rate slider (0–30, suffix "%" in slate-500)

3. **"CONNECTIONS (n)" section header**, then a list of conn rows:
   - 3-column grid `16px 1fr auto`, 8px gap, 6px×0 padding, 12px font, 1px slate-200 top border between rows
   - direction arrow (mono `→` / `←`, slate-500), other-node id (mono slate-900), label (mono slate-500)

**Footer (auto-pushed bottom, 14px padding):** Delete node button — full-width, red text on red-soft bg, red-tinted border.

### 6. Edges (existing — restyle)

- Default: 1.5px stroke, slate-400 (`#94a3b8`), opacity 0.6
- Hovered or `highlight`: 1.5px blue-500 (`#3b82f6`), opacity 1
- When animating (run state): a second overlay path with `stroke-dasharray: 4 6`, `strokeOpacity: 0.85`, animated via `connection-flow` keyframe (already in `tokens.css`)
- Arrowhead: 5px triangle in same color as stroke
- Optional label pill: 64×20 white rect with slate-300 border, 4px radius, mono 10.5px slate-600 text (e.g. "TCP:3306")

## Interactions & behavior

| Interaction | Behavior |
|---|---|
| Drag from Palette to canvas | Creates a new node at drop position. Auto-name `${kind}-${n}`. Auto-IP based on kind (datastores → `10.133.78.x`, services → `10.183.164.x`). Auto-channel using the kind's default port. |
| Click a Palette item | Same as drag, but places at a default offset. |
| Click a node | Selects it. Right panel switches from Logs → Inspector. |
| Drag bottom port → another node | Creates a new edge labeled `TCP:${target.port}`. |
| Drag empty canvas | Pans. |
| Pause / Run button | Stops/starts the log stream and connection-flow animation. |
| Time multiplier (1×–8×) | Multiplies the log emission rate. |
| Filter input | Substring match on log message OR source node id. |
| Level chips | Filter by level (ALL/INFO/WARN/ERROR). |
| Follow toggle | When on, log body auto-scrolls to bottom on each new line. |
| Inspector field changes | Update the node in the store; if `id` changes, update edges that reference it. |
| Delete node | Removes the node + any edges touching it. |

## State

Add (or thread into the existing graph store):

```ts
type ScenarioState = {
  selectedNodeId: string | null;
  running: boolean;          // log stream + connection animation
  timeMultiplier: 1|2|4|8;   // event rate multiplier
  logs: LogEntry[];          // ring buffer, max ~600
  filter: { text: string; level: 'ALL'|'INFO'|'WARN'|'ERROR'; follow: boolean };
};

type LogEntry = {
  ts: Date;
  source: string;            // node id
  kind: string;              // resource kind, for routing
  channel: string;
  lvl: 'INFO'|'WARN'|'ERROR';
  msg: string;
};
```

## Realistic log generation

The prototype includes per-resource log templates in `prototype/data.jsx`. The generator picks INFO 75% / WARN 18% / ERROR 7% and substitutes `{ms}`, `{uid}`, `{pid}`, `{cid}`, `{job}`, `{rows}`, `{bytes}`, `{ip}`, `{port}`, `{ts}` placeholders.

Templates exist for: `nodejs`, `golang`, `mysql`, `postgres`, `nginx`, `redis`, `virtual_server`, `custom`. **Lift the templates and `fillTemplate` / `nextLogLine` helpers** from `prototype/data.jsx` into the new log-generation module — they're written for direct copy.

## Files in this handoff

```
design_handoff_light_mode/
├── README.md                       (this file)
└── prototype/
    ├── Scenario Editor.html        Entry point — open in browser to see the live design
    ├── tokens.css                  Source of truth for colors, type, radii, shadows
    ├── scenario-editor.css         Layout + component styles (ln- prefix)
    ├── scenario-editor.jsx         Top-level shell (top bar, panel layout, drag/drop, pan)
    ├── topology.jsx                ServiceNodeCard, Edge, Palette, LogPanel, Inspector
    ├── data.jsx                    Resource catalog, log templates, generator helpers
    └── tweaks-panel.jsx            Tweaks UI plumbing — IGNORE for handoff (designer-only)
```

## Implementation checklist

- [ ] Add the design tokens to the project's theme / tailwind config
- [ ] Switch the app shell to light mode (slate-50 background, slate-900 text)
- [ ] Restyle `ServiceNode.tsx` to match the new card spec
- [ ] Restyle `Palette.tsx` (header, group labels, items, footer hint)
- [ ] Add the top bar component above the existing canvas
- [ ] Add the right-side panel container that switches between LogPanel and Inspector based on selection
- [ ] Implement LogPanel with filtering + follow + level pills
- [ ] Implement Inspector with the field set described above
- [ ] Update edges to use the `connection-flow` animated dash overlay when running
- [ ] Lift the log templates from `data.jsx` and wire to the simulation tick

## Things to confirm with the designer

- Should the time multiplier (1×–8×) actually scale the simulation clock in the existing simulator, or just scale the visual log emission rate?
- The Inspector's "Volume (EPS)" and "Anomaly rate (%)" — are these existing fields on the node config or new ones I should plumb?
- The "Export dataset" button — what's the actual export format / destination?
