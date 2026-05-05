# LogSim — Infrastructure Log Simulation Platform

## Overview

LogSim simulates realistic infrastructure logs (VPC flow logs, application logs, database logs, load balancer access logs, etc.) from a declarative scenario. It ships in three shapes that all share one Go engine:

1. **`logsim` (Go CLI)** — single static binary. Parses a scenario YAML, advances a tick loop, and emits logs to stdout, a file, or a streaming destination (Cribl Stream / Splunk HEC). Subcommands: `run`, `validate`, `list`, `serve`, `destinations`, `upgrade`. Distributed via the install script (`scripts/install.sh`) and GitHub Releases tarballs.
2. **Vercel serverless functions** — three Go lambdas under `api/` (`generate`, `run`, `logs_at`) that wrap the same engine for the hosted editor. Designed around the platform's per-request budget (10s on Hobby, 300s on Pro; ~4.5 MiB response body cap).
3. **`logsim serve` (long-lived HTTP server)** — same engine, richer surface. SSE streaming, bulk ZIP export, destinations API. Used by self-hosters who want the editor to talk to their own backend.

The editor (Next.js app in `src/`) is a thin client across all three. It builds scenarios on a React Flow canvas, ships the YAML to whichever backend is configured, and renders the resulting log stream.

A scenario built in the UI can be exported, run by the CLI, or replayed against any backend; all three paths agree on the same canonical YAML format.

---

## Core Concepts

### Mental Model

A user builds a **scenario**: a directed graph of infrastructure components plus a set of services and connections between them. Each node has a **type** (`vpc`, `subnet`, `virtual_server`, `load_balancer`, `user_clients`) and **configuration**. Each service has a generator (`nodejs`, `mysql`, `nginx`, `custom`, …) describing how it produces logs. Connections describe network paths.

When the simulation runs, a **tick engine** advances time. On each tick, the traffic simulator computes flows across each connection, and each generator emits log lines consistent with its type, configuration, the traffic it received this tick, and any **timeline override** active at that tick.

### Scenario Data Model (logical)

```
Scenario
├── name: string
├── description: string
├── duration: int                    (total ticks; CLI plays the whole episode by default)
├── tick_interval_ms: int            (simulated ms per tick; default 1000)
├── nodes: Node[]
│   ├── type: "vpc" | "subnet" | "virtual_server" | "load_balancer" | "user_clients"
│   ├── name: string                 (unique, used for connection refs)
│   ├── description: string?
│   ├── provider: "aws" | "gcp" | "azure" | null
│   ├── region: string?
│   ├── (type-specific fields: cidr_block, instance_type, private_ip, subnet, …)
│   └── (for user_clients) clients: Client[]
├── services: Service[]
│   ├── type: "nodejs" | "golang" | "mysql" | "postgres" | "redis" | "nginx" | "custom"
│   ├── name: string                 (unique, used for connection refs)
│   ├── host: string                 (REQUIRED — name of a virtual_server node)
│   ├── generator: GeneratorConfig   (port, log_format, endpoints, custom_type, …)
│   └── timeline: TimelineBlock[]?   (per-service behavior overrides over [from, to))
├── connections: Connection[]
│   ├── source: string               (node or service name)
│   ├── target: string               (node or service name)
│   ├── protocol: "tcp"|"udp"|"http"|"https"|"mysql"|"postgres"|"redis"|"grpc"
│   └── port: number
├── custom_types: CustomType[]?      (user-defined log shapes — templates + placeholders)
└── editor: EditorMeta?              (UI-only canvas positions; ignored by engine)
```

Names are the primary keys on the wire. The Go engine resolves names to internal IDs at parse time and validates that every connection endpoint and every `service.host` resolves.

### Timelines & Behavior States

Each service can carry an ordered list of `TimelineBlock`s. A block declares an override over a `[from, to)` tick range. Later blocks in slice order win on overlap. Pointer fields are tri-state (nil = inherit baseline).

Built-in **state presets** seed the override modifiers; explicit fields then override the preset:

| State | error_rate | latency_mul | log_vol_mul |
|-------|-----------:|------------:|------------:|
| `healthy` | (identity) | 1× | 1× |
| `degraded` | 0.10 | 2× | 1.2× |
| `down` | 1.00 | 5× | 0.3× |
| `recovering` | 0.05 | 1.5× | 1.4× |
| `under_attack` | 0.30 | 3× | 4× |
| `throttled` | 0.15 | 2.5× | 0.5× |
| `compromised` | … | … | … |

Blocks may also carry `template_weights`, `placeholders`, `config_overrides` (partial GeneratorConfig replacement), `custom_log` (a one-off string injected as a log line), and a free-form `note`. The frontend Episode mode and the Go engine produce identical overrides for the same block at the same tick — the engine resolves overrides via `service.ResolveOverride(tick)`.

### Custom Types

`custom_types[]` lets users define their own log shapes — a set of weighted templates plus the placeholders they reference. Mirrors the editor's `CustomNodeType` so a preview rendered in the canvas matches what the engine emits:

```yaml
custom_types:
  - id: my-custom-app
    name: Custom App
    default_port: 8080
    placeholders:
      level:    { kind: enum,  enum_values: [info, warn, error] }
      user_id:  { kind: int,   min: 1, max: 9999 }
      latency:  { kind: float, min: 1, max: 500 }
    templates:
      - { template: '{{level}} request from user={{user_id}} took {{latency}}ms', weight: 1.0 }
      - { template: '{{level}} db query timeout', weight: 0.05, is_error: true }
```

Services reference a custom type via `generator.type: custom` and `generator.custom_type: my-custom-app`.

### Node Hierarchy & Containment (editor-only)

In the editor, nodes have a visual containment hierarchy (VPC ⊃ Subnet ⊃ Virtual Server) for layout and channel naming. Containment is reconstructed from the YAML by the editor based on `subnet:` references and CIDR membership; the Go engine doesn't need a tree to run a simulation, only the flat node + service + connection lists.

---

## Architecture

### Three deployment surfaces, one engine

```
┌──────────────────────────┐
│   Next.js Editor (browser)
│   - canvas, palette, config panel
│   - timeline / episode scrubber
│   - log panel (NDJSON / SSE consumer)
│   - YAML serializer (canvasToScenarioYaml.ts)
└────────────┬─────────────┘
             │ HTTPS POST { scenario_yaml, … }
             ▼
   ┌─────────────────────────────────────────────────────────────┐
   │                                                             │
   │  Hosted (Vercel)                Self-hosted               CLI
   │  api/generate (single batch)    logsim serve              logsim run
   │  api/run      (NDJSON stream)   /v1/simulate (SSE)        (no HTTP)
   │  api/logs_at  (random scrub)    /v1/simulate/bulk (ZIP)
   │                                 /v1/destinations
   │                                 /v1/forward
   │                                                             │
   │      ┌──────────────────────────────────────────────┐       │
   │      │  pkg/engine — tick loop, RNG, traffic, channels       │
   │      │  pkg/generators — nodejs/mysql/loadbalancer/vpcflow/custom
   │      │  pkg/sinks — stdout / file / cribl_hec        │       │
   │      │  pkg/encoders — native / ocsf / otel / udm / asim
   │      │  pkg/scenario — parse / validate / load(URL|slug)     │
   │      │  pkg/config — destinations dotfile            │       │
   │      └──────────────────────────────────────────────┘       │
   └─────────────────────────────────────────────────────────────┘

The CLI talks to nothing — it is the engine, called directly. The hosted
editor and a self-hosted editor differ only in which HTTP endpoint they hit;
the parsing, validation, generators, and sinks are identical.
```

### Tech Stack

| Layer | Choice |
|-------|--------|
| Backend | **Go 1.25+** (single static binary) |
| CLI framework | **`spf13/cobra`** + **`charmbracelet/huh`** (TUI forms) |
| YAML | **`gopkg.in/yaml.v3`** |
| HTTP server | **`net/http`** + **`go-chi/chi/v5`** router |
| Serverless | Vercel Go runtime (`api/**/*.go` auto-detected via `vercel.json`) |
| Streaming | NDJSON over POST (Vercel) and SSE (`logsim serve`) |
| Frontend framework | Next.js 14 (App Router) |
| Canvas / Graph | **`@xyflow/react`** (React Flow) |
| State Management | **Zustand** |
| Styling | Tailwind CSS + shadcn/ui + Radix primitives |
| ZIP bulk export | Server-side via `archive/zip` |
| Testing | Go: `go test ./...`. Frontend: Next.js + ESLint |
| Distribution | `scripts/install.sh`, `.github/workflows/release.yml` (cross-compile darwin/linux × amd64/arm64) |

### Repository Layout

```
logsim2/
├── cmd/
│   ├── logsim/                       # CLI entrypoint
│   │   ├── main.go                   # cobra root
│   │   ├── run.go                    # `logsim run`
│   │   ├── validate.go               # `logsim validate`
│   │   ├── list.go                   # `logsim list`
│   │   ├── serve.go                  # `logsim serve`
│   │   ├── destinations.go           # `logsim destinations …` (huh TUI)
│   │   └── upgrade.go                # `logsim upgrade` (re-runs install.sh)
│   └── devserver/                    # local Vercel-functions emulator
│       └── main.go                   # mounts api/* at :8787
├── api/                              # Vercel Go lambdas
│   ├── generate/                     # POST /api/generate (≤30 ticks per call)
│   ├── run/                          # POST /api/run (NDJSON stream, full episode + forward mode)
│   └── logs_at/                      # POST /api/logs_at (random-access scrub)
├── pkg/
│   ├── apihelp/                      # CORS, error helpers, Cribl request types
│   ├── scenario/                     # parse, validate, load (file/url/slug), catalog, timeline
│   ├── engine/                       # tick loop, RNG, channels, traffic
│   ├── generators/                   # nodejs, mysql (+postgres/redis fallback), nginx,
│   │                                 # loadbalancer, vpcflow, custom (template engine)
│   ├── sinks/                        # stdout/file/cribl_hec, format = jsonl|raw|ocsf|otel|udm|asim
│   ├── encoders/                     # native / ocsf / otel mapping
│   ├── event/                        # LogEntry, Flow, TickContext (no deps on engine/generators)
│   ├── config/                       # destinations.yaml parser + dotfile path resolution
│   └── server/                       # `logsim serve` chi handlers
│       ├── server.go                 # router, CORS, SIGHUP reload
│       ├── simulate.go               # POST /v1/simulate (SSE)
│       ├── bulk.go                   # POST /v1/simulate/bulk (ZIP)
│       └── destinations.go           # GET /v1/destinations, POST /v1/destinations/:n/test, /v1/forward
├── scenarios/
│   └── web-service.yaml              # reference scenario
├── public/
│   ├── s/index.json                  # scenario catalog (built by scripts/build-preset-yaml.mjs)
│   └── s/<slug>.yaml                 # one YAML per built-in scenario
├── scripts/
│   ├── install.sh                    # `curl … | sh` installer
│   ├── build-preset-yaml.mjs         # JSON-to-YAML preset compiler (pre-build hook)
│   └── build-example-episodes.mjs
├── .github/workflows/release.yml     # cross-compile + release on tag push
├── destinations.yaml.example
├── vercel.json                       # api/**/*.go → Go function (memory: 512, maxDuration: 300)
├── go.mod                            # module github.com/nikhilm/logsim2
├── package.json                      # next, @xyflow/react, zustand, …
└── src/                              # Next.js editor
    ├── app/
    │   ├── editor/                   # main canvas page
    │   ├── run-locally/              # CLI install + scenario browser landing page
    │   ├── s/[slug]/                 # /s/<slug> opens a built-in in the canvas
    │   └── api/cribl/                # legacy Next.js Cribl proxy (retained for fallback)
    ├── components/
    │   ├── canvas/, edges/, nodes/   # React Flow surface
    │   ├── palette/                  # drag sources
    │   ├── panels/                   # ConfigPanel, NodeInspector, SimulationControls, …
    │   ├── episodes/                 # EpisodeTimeline, BlockInspector, ScrubbedLogs, ForwardStatusPanel
    │   └── toolbar/                  # menus
    ├── engine/                       # in-browser SimulationEngine + Worker (legacy fallback when no backend)
    ├── lib/
    │   ├── canvasToScenarioYaml.ts   # canvas → YAML
    │   ├── backendClient.ts          # /api/* fetcher
    │   ├── runStream.ts              # /api/run NDJSON consumer
    │   ├── logsAt.ts                 # /api/logs_at client
    │   ├── runForward.ts             # `--to <dest>` forward mode driver
    │   └── criblForwarder.ts         # browser-side HEC fallback (via /api/cribl proxy)
    └── store/                        # Zustand stores (simulation, scenario, destinations, episode, UI, …)
```

### Communication contracts

The same scenario YAML and the same `LogEntry` shape flow through every surface. What differs is the framing:

#### Vercel functions (hosted editor)

- **`POST /api/generate`** — one short window. Body: `{ scenario_yaml, ticks (≤30), tick_interval_ms, start_time_ms, seed, source_filter, cribl? }`. Response: `{ logs: LogEntry[], ticks, forwarded, forward_error? }`. Used by the legacy single-tick frontend path.
- **`POST /api/run`** — full episode, NDJSON stream. Body adds `duration`, `start_tick`, `format` (`native|ocsf|otel`), `mode` (`""` | `"forward"`). Frame shapes:
  - Default (log frames): `{"tick":N,"ts":<ms>,"logs":[…]}` per tick, then `{"done":true,"total_logs":M}` (or `{"partial":true,"next_tick":N,"total_logs":M}` if the response would exceed the ~3 MiB body cap, or `{"error":"…"}`).
  - Forward mode (`mode:"forward"`): `start` → `post` (one per HTTP attempt against Cribl) → `progress` (every ~10 ticks) → `done` (or `error`). No log frames are streamed back; the body stays tiny. Requires `cribl.{enabled,url,token}` in the request body.
- **`POST /api/logs_at`** — random-access scrub. Body: `{ scenario_yaml, from, to, seed, … }`. Re-runs the engine deterministically from tick 0 up to `to`, returns logs in `[from, to)`. Same scenario+seed → same output, so timeline scrubs show stable previews.

The Vercel function timeout is the only upper bound on runtime. To stay under the response-body cap, `/api/run` chunks long episodes — the frontend resumes by sending the `next_tick` from the `partial` frame as `start_tick` on the follow-up request.

#### `logsim serve` (self-hosted)

- **`POST /v1/simulate`** — `text/event-stream`. Body: `{ scenario_yaml, ticks, tick_interval, seed, source_filter, format }`. Each tick emits `event: batch\ndata: <JSON array>\n\n`; stream ends with `event: done\ndata: {}\n\n` (or `event: error\ndata: {…}` on parse failure).
- **`POST /v1/simulate/bulk`** — runs the full episode, returns `application/zip` containing `manifest.json` plus one `<source>.jsonl` per channel.
- **`GET /v1/destinations`** — returns the loaded destinations with tokens redacted.
- **`POST /v1/destinations/{name}/test`** — sends one canned event to verify connectivity.
- **`POST /v1/forward?destination=<name>`** — forwards a JSON array of `LogEntry` to the named destination.

The server hot-reloads `destinations.yaml` on `SIGHUP`. CORS is open to `*` by default; pin with `--cors-origin`.

#### CLI (no HTTP)

The CLI calls the engine directly. Sinks are constructed from `--out`, `--to`, and `--tee` flags; flags layer in any combination (file + destination + stdout fan-out are all valid).

---

## Scenario YAML Format

The canonical format on disk. Top-level is a YAML list of single-key maps:

```yaml
- name: Web Service
- description: |
    An AWS web service with two Node.js instances behind a load balancer
    and a MySQL database, all in one VPC.
- duration: 300                 # total ticks for the episode (optional)
- tick_interval_ms: 1000        # simulated ms per tick (optional, default 1000)
- nodes:
  - type: vpc
    name: Web Service VPC
    provider: aws
    region: us-east-1
    cidr_block: 10.0.0.0/16
  - type: subnet
    name: Web Service Subnet
    provider: aws
    region: us-east-1
    cidr_block: 10.0.1.0/24
  - type: virtual_server
    name: App Server 1
    provider: aws
    instance_type: t3.medium
    os: ubuntu-22.04
    private_ip: 10.0.1.10
    subnet: Web Service Subnet
    security_groups: [sg-01234567890123456]
  - type: load_balancer
    name: Load Balancer
    provider: aws
    private_ip: 10.0.1.13
    subnet: Web Service Subnet
  - type: user_clients
    name: User Clients
    clients:
      - name: Web Client 1
        user-agent: Mozilla/5.0 ...
        ip: 45.45.45.1
        rps: 1
        traffic_pattern: steady mix of GET and POST requests
- services:
  - type: nodejs
    name: User Directory Service
    host: App Server 1            # REQUIRED — must resolve to a virtual_server
    generator:
      type: nodejs
      port: 3000
      log_format: json
      log_level: info
      endpoints:
        - { method: GET,  path: /api/users, avg_latency_ms: 100, error_rate: 0.01 }
        - { method: POST, path: /api/users, avg_latency_ms: 500, error_rate: 0.01 }
    timeline:
      - from: 60
        to:   180
        state: degraded                   # preset; explicit fields below override its defaults
        latency_mul: 4
        note: "DB connection pool exhausted"
  - type: mysql
    name: App Database
    host: Database Server
    generator:
      type: mysql
      port: 3306
      database: users
      slow_query_threshold: 1000
- connections:
  - { source: User Clients,           target: Load Balancer,         protocol: https, port: 443 }
  - { source: Load Balancer,          target: User Directory Service, protocol: http,  port: 3000 }
  - { source: User Directory Service, target: App Database,           protocol: mysql, port: 3306 }
- custom_types: []                # optional; populate to use `service.type: custom`
- editor:                         # ignored by the engine; preserves canvas layout
    nodes:
      App Server 1: { position: { x: 240, y: 180 }, size: { width: 220, height: 120 } }
```

### Validation rules (`pkg/scenario/validate.go`)

- Every `connections[].source` and `connections[].target` must resolve to a node or service `name`.
- Every `services[].host` must resolve to a `virtual_server` node `name`.
- `private_ip`, when set, should fall inside the parent subnet's `cidr_block`. If absent, auto-assigned from the subnet CIDR.
- `name` collisions across nodes and services are rejected.
- Custom-typed services must reference an existing `custom_types[].id`.
- `traffic_pattern` is a free-form string mapped to a known pattern (`steady`, `bursty`, `diurnal`, `incident`); unknown patterns fall back to `steady` with a warning.

### Loading scenarios

`pkg/scenario.Load(src)` resolves three source kinds:

1. **Local path** — `scenarios/web-service.yaml`.
2. **HTTP(S) URL** — fetched with a 15s timeout and 4 MiB cap.
3. **Bare slug** — resolved to `${LOGSIM_BASE_URL:-https://logsim2.vercel.app}/s/<slug>.yaml`.

`logsim list` fetches the catalog (`/s/index.json`) and prints a tab-separated table of slugs. The slug → URL resolution makes `logsim run db-slowdown-cascade` work without any local files.

---

## CLI Usage

```
logsim run        [flags] [scenario]   # one-shot: parse, run, emit
logsim validate   [flags] [scenario]   # parse + validate, exit non-zero on error
logsim list                            # print the public scenario catalog
logsim serve      [flags]              # long-running HTTP/SSE server
logsim destinations <subcommand>       # manage forwarding dotfile
logsim upgrade    [--version vX.Y.Z]   # self-update via install.sh
```

### `logsim run` flags (the ones you'll use)

| Flag | Default | Effect |
|------|---------|--------|
| (positional) | required | Path, URL, or slug. `--scenario` is the legacy form. |
| `--ticks N` | scenario `duration:`, else 100 | How many ticks to play. |
| `--tick-interval DUR` | scenario `tick_interval_ms:`, else `1s` | Simulated time per tick. |
| `-o, --out PATH\|-` | (none) | File path, `-` for stdout. Repeat or comma-split to fan out. |
| `--to NAME[,NAME…\|all]` | (none) | Forward to one or more configured destinations. |
| `--tee PATH` | (none) | Always layer in this file in addition to whatever else is set. |
| `-f, --format F` | `jsonl` | `jsonl` \| `raw` \| `ocsf` \| `otel` \| `udm` \| `asim`. |
| `--ocsf` / `--otel` | off | Shortcuts for `--format`. |
| `--list-formats` | off | Print supported `--format` values and exit. |
| `--seed N` | random | RNG seed (0 = pick a fresh random seed). |
| `--source-filter GLOB` | `*` | Channel-path glob; pre-emission filtering in the engine. |
| `--quiet` | off | Silence informational stderr lines. |
| `--force` | off | Skip the >5k-log confirmation prompt. |
| `--config PATH` | dotfile | Override the destinations YAML. |

Legacy: `--output stdout|file|destination` plus `--path` / `--destination` still work for scripts.

When forwarding, `logsim run` does **not** print log lines — it streams HEC progress to stderr (one line per HTTP attempt) and finishes with a per-destination tally:

```
logsim: forwarding → prod-cribl
logsim:   POST → 200 OK (100 events, 142ms)
…
logsim: sent 5421 events to prod-cribl in 55 batches
```

### `logsim serve` flags

| Flag | Default | Effect |
|------|---------|--------|
| `--port N` | `8080` | HTTP port. |
| `--cors-origin ORIGIN` | `*` | Allowed origin. Pin in production. |
| `--config PATH` | (none) | `destinations.yaml`. Reload on `SIGHUP`. |

### `logsim destinations` subcommands

```
logsim destinations add                    # interactive huh form
logsim destinations list
logsim destinations test <name>            # one canned event
logsim destinations enable <name>
logsim destinations disable <name>
logsim destinations remove <name>
logsim destinations path                   # print the resolved dotfile path
```

The dotfile lives at `$LOGSIM_CONFIG`, else `$XDG_CONFIG_HOME/logsim/destinations.yaml`, else `$HOME/.config/logsim/destinations.yaml`. Saved with `0600` perms.

---

## Destinations Config

A YAML file describing forwarding targets. Tokens live in the file (no env interpolation in V1).

```yaml
# ~/.config/logsim/destinations.yaml
destinations:
  - name: prod-cribl
    type: cribl_hec
    enabled: true
    url: https://cribl.example.com:9000/services/collector/event
    token: 8f3a2b1c-xxxx-xxxx-xxxx-xxxxxxxxxxxx
    batch_size: 100           # 1–500 events per HEC POST
    flush_interval_ms: 2000   # 0 = flush on full batches only
    format: native            # native | ocsf | otel | udm | asim

  - name: staging-cribl-ocsf
    type: cribl_hec
    enabled: false
    url: https://staging.example.com/services/collector/event
    token: staging-token-here
    batch_size: 50
    flush_interval_ms: 5000
    format: ocsf
```

Adding new destination types is a matter of implementing the `sinks.Sink` interface and registering it in `pkg/sinks/registry.go`. V1 ships with `cribl_hec` only (Splunk HEC works as a drop-in over the same protocol).

---

## Interaction Model (Editor)

Canvas, palette, config panel, log panel, save/load, undo/redo, mode switching, and keyboard shortcuts work as in the original spec. What's behind the **Play / Step / Generate Batch** buttons depends on which backend the editor is configured against:

- **Hosted (default `/api`)**:
  - **Play** → `POST /api/run` (NDJSON), pipes per-tick frames into the log buffer. The frontend chunks long episodes by reading `partial` frames and re-issuing with `start_tick`.
  - **Scrub timeline** → `POST /api/logs_at` with `{from, to}`.
  - **Generate Batch / Forward** → `POST /api/run` with `mode: "forward"` plus a `cribl` block; the function forwards events directly to the configured HEC and streams progress (no log frames back).
- **Self-hosted (`logsim serve`)**:
  - **Play** → `POST /v1/simulate` (SSE).
  - **Stop** → close the EventSource.
  - **Generate Batch** → `POST /v1/simulate/bulk` and download the ZIP.
  - **Configure → Log Destinations** → reads `GET /v1/destinations`. Add/edit destinations by editing `destinations.yaml` and `SIGHUP`-ing the server.

Source filter, level filter, search, auto-scroll, copy-to-clipboard, and incident highlighting all operate on `LogEntry` objects after they arrive from whichever stream is in use.

The Episode mode adds a timeline scrubber that drives `/api/logs_at` (or `/v1/simulate` with `start_tick` on serve), `BlockInspector` for editing timeline overrides, and `ForwardStatusPanel` for live HEC progress while `mode: "forward"` is running.

---

## Log Channels (Source Paths)

A **source** is a hierarchical, slash-delimited identifier reflecting the position of an emitting node/service in the containment tree:

```
<vpc-label>/<subnet-label>/<host-label>/<service-label>
```

The scenario name is deliberately *not* part of the source path: scenario titles often describe the root cause ("JVM Memory Leak Death Spiral", "Disk Full From Runaway Debug Logs"), and embedding them in every log line would give the investigation away.

The Go engine computes sources by:
1. Slugifying each `name` (lowercase, spaces → hyphens).
2. For services: walking `service.host` → `virtual_server.subnet` → `subnet` (find VPC by CIDR containment).
3. For nodes: walking the same chain based on `subnet:` references.

Examples for the reference scenario (`scenarios/web-service.yaml`):

| Source | Path |
|--------|------|
| User Directory Service | `web-service-vpc/web-service-subnet/app-server-1/user-directory-service` |
| App Database | `web-service-vpc/web-service-subnet/database-server/app-database` |
| Load Balancer | `web-service-vpc/web-service-subnet/load-balancer` |
| VPC flow logs | `web-service-vpc/flow` |

Glob filters (`*`, `web-service-vpc/*`, `*/app-database`) work via `--source-filter`, evaluated in the engine before logs cross the streaming boundary so we don't pay to serialize logs the UI is going to drop.

The editor's TS source matcher exists for autocomplete / filter-as-you-type only. Authority lives in Go.

---

## Simulation Engine (Go)

### Tick model

```go
type Engine struct {
    scenario *scenario.Scenario
    cfg       Config
    traffic   *trafficSimulator
    channels  SourceMap
    rng       *rand.Rand
    targets   []generatorEntry      // built once at New()
}

type Config struct {
    Seed           int64
    StartTime      time.Time
    StartTick      int           // resume mid-episode
    TickIntervalMs int           // default 1000
    SourceFilter   string        // glob; "" or "*" = all
}

func (e *Engine) Run(ctx context.Context, totalTicks int, sinks []sinks.Sink) error {
    for tick := e.cfg.StartTick; tick < totalTicks; tick++ {
        if ctx.Err() != nil { return ctx.Err() }
        ts := e.cfg.StartTime.Add(time.Duration(tick) * tickInterval)
        flows := e.traffic.Flows(e.scenario, tick, e.cfg.TickIntervalMs, e.rng, ts)
        entries := e.generateTick(flows, event.TickContext{TickIndex: tick, Timestamp: ts, …})
        for _, s := range sinks { s.Write(entries) }
    }
    for _, s := range sinks { s.Flush() }
    return nil
}
```

Per tick:
1. **Traffic generation** — for each connection, the traffic simulator computes a `Flow{src, dst, protocol, port, request_count, bytes_sent, bytes_recv, error_count, src_ip, dst_ip, ts}`. Rates come from `user_clients[].rps` and propagate through load balancers based on upstream count.
2. **Override resolution** — for each service-level target, `service.ResolveOverride(tick)` returns the merged effect of every active timeline block (later blocks win on overlap). Node-level targets get the identity override.
3. **Log generation** — each generator gets the flows that touch its node/service plus the tick context (with `Override`), and returns `[]LogEntry`. `LogEntry` carries `id, ts, source, level, sourcetype, class, raw, fields`.
4. **Channel filter** — entries whose `Source` doesn't match `cfg.SourceFilter` are dropped before they reach any sink.
5. **Sort + dispatch** — entries are sorted by timestamp within the tick (chronological), then written to every active sink. Sinks batch internally and flush on `Flush()` or on their own interval.

`StartTick` lets the streaming `/api/run` endpoint resume mid-episode after a `partial` frame, and lets `/api/logs_at` re-run from tick 0 deterministically (same seed → same output) while only retaining `[from, to)`.

### Traffic patterns

`steady`, `bursty`, `diurnal`, `incident`. Each is a function `(tickIndex, rng) → multiplier` applied to the base `rps`. `traffic_pattern` strings on `user_client` entries are matched substring-wise.

### Bulk generation

`POST /v1/simulate/bulk` runs the engine with a collector sink, then writes one `<source>.jsonl` file per channel into a streamed `archive/zip.Writer`. A `manifest.json` lists every file with a line count. Splits per channel by routing each event to a per-channel writer inside the ZIP.

### Generators

| Source | Output | Notes |
|--------|--------|-------|
| `user_client` | (no logs) | Synthesizes outbound flows toward connection targets at `rps × pattern_multiplier`. |
| `load_balancer` | Nginx-combined access log per upstream request. | Round-robins inbound flows across upstream connections. |
| `nodejs` | Per-request log line in JSON or text. | Picks an `endpoints[]` entry per request, applies `error_rate` and `avg_latency_ms` distribution. Used for `golang` and `nginx` services too (closest analogue) until they get dedicated generators. |
| `mysql` | Query log per inbound request; slow-query log when sampled latency exceeds `slow_query_threshold`. | Used for `postgres` and `redis` services too. |
| `vpc_flow` | One AWS VPC flow log v2 line per flow whose endpoints are inside the VPC. | Provider-specific renderers added in the same generator (today: AWS only). |
| `custom` | Renders one weighted template per tick into a log line. | Placeholders are filled by a typed renderer (enum / int / float / literal / format). Templates can be marked `is_error` to roll into the override's error rate. |

Adding a generator: implement `Generator.Generate(target, flows, ctx) []LogEntry`, register in `pkg/generators/registry.go` (`ForService` / `ForNode`).

### Determinism

Same scenario + same seed reproduces the same logs. The engine seeds `math/rand.Rand` once and never reads from the global RNG. Generators take the same `*rand.Rand` so ordering matters — generators iterate services in parsed order, then nodes in parsed order.

This is what makes `/api/logs_at` work: re-running from tick 0 to `to` produces byte-identical output to a streaming run, so timeline scrubs show stable previews.

---

## Log Output

### `LogEntry` schema (wire format)

```json
{
  "id": "01HXY…",
  "ts": "2026-04-19T10:30:00.123Z",
  "source": "web-service-vpc/web-service-subnet/app-server-1/user-directory-service",
  "level": "INFO",
  "sourcetype": "nodejs",
  "class": "http_activity",
  "raw": "{\"level\":\"info\",\"timestamp\":\"…\",\"method\":\"GET\",\"path\":\"/api/users\",\"statusCode\":200,\"responseTime\":45}",
  "fields": { "method": "GET", "path": "/api/users", "status_code": 200, "response_time_ms": 45 }
}
```

`raw` is what the user/model sees as a log line. `fields` is the canonical structured form used by encoders. `class` is a generator-supplied hint that picks an OCSF event class (`http_activity`, `network_activity`, `datastore_activity`, `application_lifecycle`, `api_activity`).

### Encoders (wire schemas)

`pkg/encoders` translates `LogEntry` into a target schema. Each encoder is side-effect-free (`Encode(entry) → bytes`).

| Format | Status | Notes |
|--------|--------|-------|
| `native` | shipped | Pass-through. Sinks emit `Raw` (Format=`raw`) or the full JSON `LogEntry` (Format=`jsonl`). |
| `ocsf` | shipped | OCSF v1.x JSON event. Class-aware via `LogEntry.Class`. |
| `otel` | shipped | OpenTelemetry OTLP/JSON `LogRecord` envelope. |
| `udm` | reserved | Falls back to native today. |
| `asim` | reserved | Falls back to native today. |

The CLI's `--format` (and `--ocsf` / `--otel` shortcuts) selects which encoder runs before bytes hit the sink. Per-destination `format:` in `destinations.yaml` does the same for forwarded events. The hosted `/api/run` and `/api/logs_at` accept a `format` field that rewrites each entry's `Raw` in place before streaming.

### Sinks

- **stdout** (`pkg/sinks.NewStdout`) — `WriterSink` over `os.Stdout`. Emits per Format selection.
- **file** (`pkg/sinks.NewFile`) — `WriterSink` over a file. `--append` for append mode, otherwise truncates on open.
- **cribl_hec** (`pkg/sinks.NewCriblWithFormat`) — POSTs Splunk HEC events in batches:
  ```json
  { "time": 1745059800.123, "host": "…", "source": "<source-path>", "sourcetype": "logsim:json", "event": <Raw or schema-encoded JSON> }
  ```
  Newline-delimited per HEC convention. Auth header: `Authorization: Splunk <token>`. 3-retry exponential backoff (1s, 2s, 4s) on 5xx and transport errors; 4xx are permanent. Drops batch with stderr warning after retries (engine keeps running). Exposes a `SendObserver` callback that fires per HTTP attempt — the CLI's `forwardingReporter` and the `/api/run` forward-mode handler both use this to render live HEC status.

### Editor log panel

Consumes the NDJSON / SSE stream from whichever backend is configured. Ring-buffer behavior (~10K lines) and filter UI applies. Mirroring to a configured destination is a separate "forward run" rather than per-frame mirroring — the user clicks Forward and the backend takes over.

---

## Scenario Save / Load

- **File format**: YAML, matching the spec above. Editor-only fields go under a top-level `editor:` block.
- **Editor save**: `Cmd+S` serializes via `src/lib/canvasToScenarioYaml.ts` and downloads `<scenario-name>.logsim.yaml`. Also persisted to `localStorage` for auto-recovery.
- **Editor open**: file picker for `*.yaml` / `*.logsim.yaml`. The editor parses the YAML, restores `editor:` positions if present, and lays nodes out automatically otherwise.
- **CLI**: only reads YAML — never writes scenarios.
- **Catalog**: built-in scenarios live as `public/scenarios/presets/*.scenario.json` and are compiled to `public/s/<slug>.yaml` + `public/s/index.json` by `scripts/build-preset-yaml.mjs` (run via `npm run build:scenarios`, also wired as a `prebuild` hook).

---

## Toolbar / Menus (Editor)

```
File      → New, Open YAML, Save YAML, Export Logs (.log/.jsonl), Export Bulk ZIP
Insert    → (palette items)
Run       → Step, Play/Pause, Stop, Generate Batch...
Configure → Rename, Edit Description, Backend URL, Manage Destinations…
Help      → Keyboard Shortcuts, About
Mode      → [ Design | Episodes ]
```

"Backend URL" is a setting (default `/api` for hosted, configurable for self-hosters) the editor uses for all backend calls. Persisted in `localStorage`.

---

## Extensibility Design

### New service or node type

1. Add the type literal to `pkg/scenario/types.go` and a struct for type-specific fields.
2. Implement a generator in `pkg/generators/<name>.go`:
   ```go
   type Generator interface {
       Generate(target Target, flows []event.Flow, ctx event.TickContext) []event.LogEntry
   }
   ```
3. Register it in `pkg/generators/registry.go` (`ForService` / `ForNode`).
4. (Editor side) Add a node/service entry to the React palette + a config schema for the right-hand panel — the editor schema is decoupled from the Go engine; what matters at runtime is what the YAML carries.

### New destination type

1. Implement `sinks.Sink` (`Write([]event.LogEntry) error`, `Flush() error`, `Close() error`).
2. Register the `type:` string in `pkg/sinks/registry.go` (`ForDestination`).
3. Add config field validation in `pkg/config/destinations.go`.

### New wire schema

1. Add a constant to `pkg/encoders.Format` and a struct that satisfies `Encoder.Encode(entry) ([]byte, error)`.
2. Register it in `encoders.For` and `encoders.Parse`.
3. Add the same constant to `pkg/sinks.Format` so the CLI's `--format` and per-destination `format:` flags accept it.

### New cloud provider

Each generator that emits provider-specific lines (today: `vpc_flow`) checks `node.provider` and switches its renderer. Adding GCP VPC flow logs is a new renderer in the same generator file.

---

## Episodes & Datasets

Episodes are first-class today: services carry timeline blocks, the editor has an Episode mode (`src/components/episodes/`) with a scrubber, block inspector, and forward-status panel, and `/api/logs_at` powers deterministic random-access. The `programs/` directory holds agent instructions used by an external training loop (autoresearch-style); `programs/TRAINING_PLAN.md` describes how scenarios feed an investigator/grader pipeline.

Dataset export (SFT/RL JSONL with ground truth attached) is a roadmap item — the engine emits everything needed (deterministic seeds, structured fields, timeline metadata), so the missing piece is renderers in `pkg/datasets/`.

---

## UI Layout

Unchanged from the original spec for the canvas, palette, config panel, and log panel. The Episode mode adds a timeline strip across the bottom edge of the canvas; the log panel is overlaid by the timeline scrubber when Episode mode is active.

---

## Implementation Phases

See [PLAN.md](PLAN.md) for status and what's next.

---

## Key Design Decisions & Rationale

1. **Go for the engine, not TypeScript-on-Node**. Single static binary deployable anywhere, much faster than V8 for tight tick loops, easy to ship a CLI artifact alongside the web service. The editor keeping TS is fine — it's a UI, not a hot loop.

2. **One engine, three deployment shapes**. The CLI, the Vercel functions, and `logsim serve` all share `pkg/engine`, `pkg/generators`, `pkg/sinks`, `pkg/encoders`. New generators and schemas land in one place and propagate everywhere.

3. **Vercel functions as the default hosted backend**. Zero-ops for the editor demo, no "is the server up" question. The 10s/300s function timeout is the only real constraint, and the streaming `/api/run` chunks long episodes by emitting `partial` frames the client uses to resume.

4. **`logsim serve` for self-hosting**. The same engine, fewer constraints (long-lived SSE, ZIP export, SIGHUP reload). Production-grade hosting → run `logsim serve` behind a reverse proxy.

5. **YAML as the canonical scenario format**. Human-editable, diffable, easy to drop into a git repo. The unusual top-level-list shape comes from the reference scenario and is preserved as-is.

6. **Catalog by URL, not embedded**. The CLI ships with no scenarios. `logsim run <slug>` fetches `${LOGSIM_BASE_URL:-https://logsim2.vercel.app}/s/<slug>.yaml` on demand. New scenarios published to the site are immediately runnable from the existing CLI.

7. **Tokens in the destinations dotfile**. `chmod 0600`. Simpler than env interpolation for V1. The hosted editor never persists tokens server-side — they ride in the request body and are forwarded by the function on behalf of the user.

8. **NDJSON + SSE, not WebSocket**. One-way fits the use case (server pushes logs, client never pushes back during a stream). NDJSON is what the Vercel runtime serves cleanly through its proxy stack; SSE is what `logsim serve` uses for the same reason. WebSocket is overkill.

9. **Service ↔ host as an explicit `host:` field**. Generators need this resolved, so it's a required schema field. Validator catches dangling references at parse time.

10. **Source filter applied in the engine**. Sending the full firehose just to drop most of it on the client is wasteful. The engine takes a `source_filter` glob and only emits matching events.

11. **Determinism is the API**. `/api/logs_at`, the streaming `start_tick` resume path, and the CLI's `--seed` flag all depend on it. The engine seeds `math/rand.Rand` once, never reads from the global RNG, and iterates targets in parsed order.

12. **HEC observer pattern**. The Cribl sink calls a `SendObserver` per HTTP attempt. The CLI uses this to print per-attempt status (`POST → 200 OK (100 events, 142ms)`); the `/api/run` forward-mode handler uses the same hook to stream `post` frames to the browser. One mechanism, two surfaces.

---

## Resolved Decisions

- **Log volume management**: Ring buffer in the UI (~10K lines). Bulk export streams directly to ZIP. No IndexedDB.
- **Connection validation**: Warn but allow. Topology violations show as warnings, not errors.
- **IP assignment**: Auto-assign from CIDR; manual override via `private_ip:` in YAML.
- **Episode storage**: Recipe + seed only. Events regenerated deterministically on demand.
- **Scenario format**: YAML. The pre-pivot JSON format is dropped.
- **CLI distribution**: Single static binary cross-compiled in CI per tag, plus a `curl … | sh` installer and `logsim upgrade` for self-update. `goreleaser` not needed — the GitHub Actions matrix in `.github/workflows/release.yml` is enough.
- **Backend deployment**: Hosted version runs as Vercel functions (`api/**/*.go`). Self-hosters run `logsim serve`. Both surfaces are first-class.
- **Authentication**: None on the public hosted endpoints today (rate-limited by Vercel). Self-hosters who expose `logsim serve` to the internet should sit it behind a reverse proxy or VPN.
