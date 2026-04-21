# LogSim — Infrastructure Log Simulation Platform

## Overview

LogSim simulates realistic infrastructure logs (VPC flow logs, application logs, database logs, load balancer access logs, etc.) from a declarative scenario. It ships in two pieces:

1. **`logsim` (Go binary)** — the simulation engine. Parses a scenario YAML, advances a tick loop, and emits logs to stdout, a file, or a streaming destination (Cribl Stream HEC). Runs as a one-shot CLI **or** as a long-lived HTTP server.
2. **LogSim Editor (Next.js app)** — a browser UI for visually building scenarios. Drag-and-drop infrastructure components onto a canvas, configure their properties, then hand the scenario to the Go backend over HTTP/SSE to stream live logs into the browser.

Both pieces share the same scenario YAML format, so a scenario built in the UI can be saved to disk and replayed by the CLI, and vice versa.

---

## Core Concepts

### Mental Model

A user builds a **scenario**: a directed graph of infrastructure components plus a set of services and connections between them. Each node has a **type** (VPC, subnet, virtual_server, load_balancer, user_clients) and **configuration**. Each service has a generator (`nodejs`, `mysql`, `nginx`, etc.) describing how it produces logs. Connections describe network paths.

When the simulation runs, a **tick engine** advances time. On each tick, the traffic simulator computes flows across each connection, and each generator emits log lines consistent with its type, configuration, and the traffic it received this tick.

### Scenario Data Model (logical)

```
Scenario
├── name: string
├── description: string
├── nodes: Node[]
│   ├── type: "vpc" | "subnet" | "virtual_server" | "load_balancer" | "user_clients"
│   ├── name: string                 (unique, used for connection refs)
│   ├── description: string?
│   ├── provider: "aws" | "gcp" | "azure" | null
│   ├── region: string?
│   ├── (type-specific fields: cidr_block, instance_type, private_ip, etc.)
│   └── (for user_clients) clients: Client[]
├── services: Service[]
│   ├── type: "nodejs" | "golang" | "mysql" | "postgres" | "redis" | "nginx" | "custom"
│   ├── name: string                 (unique, used for connection refs)
│   ├── description: string?
│   ├── host: string                 (REQUIRED — name of a virtual_server node)
│   └── generator: GeneratorConfig   (port, log_format, endpoints, etc.)
└── connections: Connection[]
    ├── source: string               (node or service name)
    ├── target: string               (node or service name)
    ├── protocol: "tcp"|"udp"|"http"|"https"|"mysql"|"postgres"|"redis"|"grpc"
    └── port: number
```

Names are the primary keys on the wire. The Go engine resolves names to internal IDs at parse time and validates that every connection endpoint and every `service.host` resolves.

### Node Hierarchy & Containment (editor-only)

In the editor, nodes have a visual containment hierarchy (VPC ⊃ Subnet ⊃ Virtual Server) for layout and channel naming. Containment is reconstructed from the YAML by the editor based on `subnet:` references and CIDR membership; the Go engine doesn't need a tree to run a simulation, only the flat node + service + connection lists.

---

## Architecture

### Two-process design

```
┌──────────────────────────┐         SSE (logs)          ┌────────────────────────────┐
│  Next.js Editor (browser)│ ◀─────────────────────────  │  logsim serve (Go process) │
│  - canvas, palette       │                              │  - scenario parser          │
│  - config panel          │  HTTP POST /v1/simulate ──▶  │  - tick engine              │
│  - log panel viewer      │  HTTP POST /v1/forward       │  - generators               │
│  - YAML serializer       │  HTTP /v1/destinations       │  - sinks (stdout/file/cribl)│
└──────────────────────────┘                              └────────────────────────────┘
                                                                  ▲
                                                                  │  reads
                                            ┌──────────────────┐  │
                                            │ scenarios/*.yaml │──┘
                                            │ destinations.yaml│
                                            └──────────────────┘

CLI mode: same Go binary, no browser, reads scenario YAML directly,
writes to stdout / file / Cribl HEC.
```

The browser UI no longer runs a simulation engine. The Web Worker, in-browser log generators, in-browser traffic simulator, and the Cribl proxy `/api/cribl` route are all removed. The UI's only job is to build scenarios, hand them off, and render the resulting log stream.

### Tech Stack

| Layer | Choice | Rationale |
|-------|--------|-----------|
| Backend | **Go 1.22+** | Single static binary, fast, easy concurrency for tick + sinks |
| CLI framework | **cobra** + **viper** | Standard Go CLI ergonomics, env/flag/file config layering |
| YAML | **gopkg.in/yaml.v3** | Mature; supports the unusual top-level-list scenario format |
| HTTP server | **net/http** + **chi** router | Minimal, fast, no framework lock-in |
| Streaming | **Server-Sent Events** | One-way, browser-native, no upgrade dance |
| Frontend framework | Next.js 14+ (App Router) | Existing — kept for canvas + UI |
| Canvas / Graph | **React Flow** (@xyflow/react) | Existing |
| State Management | **Zustand** | Existing |
| Styling | **Tailwind CSS + shadcn/ui** | Existing |
| Log viewer | EventSource consuming SSE | Replaces Web Worker postMessage |
| ZIP bulk export | Server-side via `archive/zip`, streamed to client | Replaces in-browser `fflate` |
| Testing | Go: `go test`. Frontend: Vitest + Playwright | |

### Repository Layout

```
logsim2/
├── cmd/
│   └── logsim/
│       └── main.go                  # CLI entrypoint (cobra root)
├── internal/
│   ├── scenario/
│   │   ├── parse.go                 # YAML → Scenario struct
│   │   ├── validate.go              # name resolution, host refs, CIDR sanity
│   │   └── types.go                 # Scenario, Node, Service, Connection
│   ├── engine/
│   │   ├── engine.go                # tick loop, RNG, channel computation
│   │   ├── traffic.go               # connection → flows per tick
│   │   └── patterns.go              # steady, bursty, diurnal, incident
│   ├── generators/
│   │   ├── registry.go              # type → constructor
│   │   ├── base.go                  # shared helpers (latency dist, UAs, IPs)
│   │   ├── nodejs.go
│   │   ├── golang.go
│   │   ├── mysql.go
│   │   ├── postgres.go
│   │   ├── nginx.go
│   │   ├── redis.go
│   │   ├── userclient.go            # synthesizes client request flows
│   │   ├── loadbalancer.go          # nginx-style access logs + upstream fanout
│   │   └── vpcflow.go               # AWS VPC flow log lines per tick
│   ├── sinks/
│   │   ├── sink.go                  # interface { Write([]Event); Flush(); Close() }
│   │   ├── stdout.go
│   │   ├── file.go
│   │   └── cribl.go                 # batched HEC POST
│   ├── config/
│   │   └── destinations.go          # destinations.yaml parser
│   └── server/
│       ├── server.go                # chi router setup
│       ├── simulate.go              # POST /v1/simulate (SSE)
│       ├── bulk.go                  # POST /v1/simulate/bulk (ZIP)
│       ├── forward.go               # POST /v1/forward
│       └── destinations.go          # GET/POST /v1/destinations
├── go.mod
├── go.sum
├── scenarios/
│   └── web-service.yaml             # reference scenario
├── destinations.yaml.example
├── src/                             # Next.js editor (existing)
│   ├── app/
│   │   ├── editor/page.tsx
│   │   └── layout.tsx               # API proxy routes removed
│   ├── components/
│   │   ├── canvas/                  # unchanged
│   │   ├── nodes/                   # unchanged
│   │   ├── edges/                   # unchanged
│   │   ├── palette/                 # unchanged
│   │   ├── panels/                  # LogPanel reads from EventSource
│   │   └── toolbar/                 # unchanged
│   ├── lib/
│   │   ├── scenarioYaml.ts          # NEW: serialize/deserialize YAML
│   │   ├── api.ts                   # NEW: Go backend client
│   │   └── ...
│   ├── store/                       # SimulationStore now drives EventSource
│   └── types/                       # scenario types kept for editor model
└── SPEC.md / PLAN.md / README.md
```

The TS files removed in the cutover: `src/engine/SimulationEngine.ts`, `src/engine/simulation.worker.ts`, `src/engine/generators/*`, `src/engine/traffic/*`, `src/lib/criblForwarder.ts`, `src/app/api/cribl/route.ts`. Channel computation (`src/engine/channels/*`) stays for the editor's filter UI but the backend is the source of truth for channels on emitted log entries.

### Communication contract

- **UI → backend**: `POST /v1/simulate` with `{ scenario_yaml, ticks, channel_filter, seed?, tick_interval_ms?, rate? }`. Response is `text/event-stream`. Each SSE event is a JSON batch `{ tick, ts, logs: LogEntry[] }`. Stream ends when `ticks` are emitted or the client disconnects.
- **UI → backend (forward)**: `POST /v1/forward` with `{ destination_name, logs: LogEntry[] }` — used when the user wants to mirror in-UI logs to a configured destination.
- **CLI**: writes directly to whatever sink was selected. No HTTP involved.

---

## Scenario YAML Format

The canonical format on disk. Top-level is a YAML list of single-key maps (matching `scenarios/web-service.yaml`):

```yaml
- name: Web Service
- description: |
    An AWS web service with two Node.js instances behind a load balancer
    and a MySQL database, all in one VPC.
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
    region: us-east-1
    instance_type: t3.medium
    os: ubuntu-22.04
    private_ip: 10.0.1.10
    subnet: Web Service Subnet
    security_groups: [sg-01234567890123456]
  - type: load_balancer
    name: Load Balancer
    provider: aws
    region: us-east-1
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
    host: App Server 1                # REQUIRED — must resolve to a virtual_server
    generator:
      type: nodejs
      port: 3000
      log_format: json
      log_level: info
      endpoints:
        - { method: GET,  path: /api/users, avg_latency_ms: 100, error_rate: 0.01 }
        - { method: POST, path: /api/users, avg_latency_ms: 500, error_rate: 0.01 }
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
```

### Validation rules

- Every `connections[].source` and `connections[].target` must resolve to a node or service `name`.
- Every `services[].host` must resolve to a `virtual_server` node `name`.
- `private_ip`, when set, should fall inside the parent subnet's `cidr_block`. If absent, auto-assigned from the subnet CIDR.
- `name` collisions across nodes and services are rejected.
- `traffic_pattern` is a free-form string mapped to a known pattern (`steady`, `bursty`, `diurnal`, `incident`); unknown patterns fall back to `steady` with a warning.

The editor's in-memory model layers `position`, `size`, and `parent_id` (UI-only). When saving from the editor, those fields go into a separate `- editor:` top-level entry that the Go engine ignores:

```yaml
- editor:
    nodes:
      App Server 1: { position: { x: 240, y: 180 }, size: { width: 220, height: 120 } }
```

---

## CLI Usage

```
logsim run     [flags]    # one-shot: parse scenario, generate ticks, emit
logsim serve   [flags]    # long-running HTTP server
logsim validate [flags]   # parse + validate scenario, exit non-zero on error
```

### `logsim run`

```
Flags:
  --scenario PATH        path to scenario YAML            (required)
  --ticks N              number of ticks to emit          (default 100)
  --tick-interval DUR    simulated time per tick          (default 1s)
  --rate FLOAT           wall-clock pacing multiplier      (default 0 = instant)
                          1.0 = real-time, 10 = 10× faster than real-time
  --output KIND          stdout | file | destination       (default stdout)
  --path PATH            file path (when --output=file)
  --destination NAME     destination name from --config    (when --output=destination)
  --config PATH          destinations.yaml                 (required if --output=destination)
  --channel-filter GLOB  filter logs by channel glob       (default *)
  --seed N               RNG seed                          (default time-based)
  --format jsonl|raw     output line format                (default jsonl)
  --quiet                suppress progress to stderr
```

Examples:

```bash
# Stream to stdout (default)
logsim run --scenario scenarios/web-service.yaml --ticks 60

# Write to a file
logsim run --scenario scenarios/web-service.yaml --ticks 3600 \
  --output file --path /tmp/web-service.jsonl

# Forward to a Cribl Stream HEC endpoint, paced 10× real-time
logsim run --scenario scenarios/web-service.yaml --ticks 600 \
  --rate 10 --output destination --destination prod-cribl \
  --config destinations.yaml
```

### `logsim serve`

```
Flags:
  --port N               HTTP port                         (default 8080)
  --host HOST            bind address                      (default 127.0.0.1)
  --config PATH          destinations.yaml                 (optional)
  --cors-origin ORIGIN   allowed origin for CORS           (default http://localhost:3000)
```

The server hot-reloads `destinations.yaml` on SIGHUP.

### `logsim validate`

```
Flags:
  --scenario PATH    path to scenario YAML  (required)
```

Prints a human-readable error report (unresolved connection refs, dangling host references, CIDR mismatches) and exits 1 on any error.

---

## HTTP API

All requests/responses are JSON unless noted. CORS is enabled for the configured origin.

### `POST /v1/simulate` — stream simulation results

Request body:
```json
{
  "scenario_yaml": "<full YAML document as a string>",
  "ticks": 600,
  "tick_interval_ms": 1000,
  "rate": 10.0,
  "channel_filter": "prod.vpc-1.*",
  "seed": 42
}
```

Response: `text/event-stream`. Each event:

```
event: batch
data: {"tick": 0, "ts": "2026-04-19T10:30:00Z", "logs": [{...LogEntry...}, ...]}

event: batch
data: {"tick": 1, ...}

event: done
data: {"total_ticks": 600, "total_logs": 18432}
```

If parsing/validation fails:

```
event: error
data: {"message": "service 'User Directory Service' references unknown host 'App Server 9'"}
```

Client closes the EventSource to abort. The server stops generating immediately on disconnect.

### `POST /v1/simulate/bulk` — bulk export as ZIP

Same body as `/v1/simulate` plus:
```json
{ "split_by_channel": true, "format": "jsonl" }
```

Response: `application/zip` with `Content-Disposition: attachment`. Layout matches the existing bulk export contract (`manifest.json`, `all.jsonl`, `channels/<channel>.jsonl`).

### `GET /v1/destinations`

Returns the destinations loaded from `--config`:
```json
{ "destinations": [{ "name": "prod-cribl", "type": "cribl-stream", "enabled": true, "url": "https://...", "sourcetype": "logsim:json" }] }
```

Tokens are redacted in the response.

### `POST /v1/destinations/:name/test`

Sends a single canned event to the named destination. Returns `{ ok: true }` or `{ ok: false, status, body }`.

### `POST /v1/forward` — UI mirrors logs to a destination

Body: `{ "destination_name": "prod-cribl", "logs": [...] }`. The server batches and forwards. Response: `{ ok: true, sent: N }`.

This replaces the previous `/api/cribl` Next.js proxy route. The UI never holds a Cribl token.

---

## Destinations Config

A YAML file describing forwarding targets. Tokens live in the file (no env interpolation in V1).

```yaml
# destinations.yaml
destinations:
  - name: prod-cribl
    type: cribl-stream
    enabled: true
    url: https://cribl.example.com:9000/services/collector/event
    token: 8f3a2b1c-xxxx-xxxx-xxxx-xxxxxxxxxxxx
    sourcetype: logsim:json
    source: ""                # empty = use log channel per event
    batch_size: 100           # 1–500 events per HEC POST
    flush_interval_ms: 1000   # max latency between flushes

  - name: dev-cribl
    type: cribl-stream
    enabled: false
    url: https://cribl-dev.example.com:9000/services/collector/event
    token: 11111111-xxxx-xxxx-xxxx-xxxxxxxxxxxx
    sourcetype: logsim:json
    batch_size: 50
```

Adding new destination types is a matter of implementing the `sinks.Sink` interface and registering the type. V1 ships with `cribl-stream` only.

---

## Interaction Model (Editor)

Unchanged from the original spec for canvas, palette, config panel, log panel, episodes, datasets, save/load, undo/redo, mode switching, and keyboard shortcuts. The only difference is what happens behind the **Play / Step / Generate Batch** buttons:

- **Play** → opens an `EventSource` against `POST /v1/simulate` and pipes batches into the log buffer.
- **Step** → POSTs `/v1/simulate` with `ticks=1` and consumes the single batch.
- **Stop** → closes the EventSource. Backend stops on disconnect.
- **Generate Batch** → POSTs `/v1/simulate/bulk`, shows a progress bar (driven by `Content-Length` if available, otherwise indeterminate), then triggers a download.
- **Configure → Log Destinations** → reads `GET /v1/destinations`. The UI no longer stores tokens. To add a destination, the user edits `destinations.yaml` and SIGHUPs the server (or restarts). The Destination Manager modal becomes read-only with a "Test" button per row.

Channel filter, level filter, search, auto-scroll, copy-to-clipboard, and incident highlighting all work the same — they operate on `LogEntry` objects after they arrive from the SSE stream.

---

## Log Channels

A `channel` is a hierarchical, dot-delimited identifier reflecting the position of an emitting node/service in the containment tree:

```
<scenario>.<vpc-label>.<subnet-label>.<host-label>.<service-label>
```

The Go engine computes channels by:
1. Slugifying each `name` (lowercase, spaces → hyphens).
2. For services: walking `service.host` → `virtual_server.subnet` → `subnet` (find VPC by CIDR containment).
3. For nodes: walking the same chain based on `subnet:` references.

Examples for the reference scenario (`scenarios/web-service.yaml`, scenario name = `Web Service`):

| Source | Channel |
|--------|---------|
| User Directory Service | `web-service.web-service-vpc.web-service-subnet.app-server-1.user-directory-service` |
| App Database | `web-service.web-service-vpc.web-service-subnet.database-server.app-database` |
| Load Balancer | `web-service.web-service-vpc.web-service-subnet.load-balancer` |
| VPC flow logs | `web-service.web-service-vpc.flow` |
| User Clients (synthetic source) | `web-service.user-clients` |

Glob filters (`*`, `web-service.web-service-vpc.*`, `*.app-database`) work as before, evaluated in the engine before logs cross the SSE boundary so we don't pay to serialize logs the UI is going to drop.

The editor's TS channel matcher exists for autocomplete / filter-as-you-type only. Authority lives in Go.

---

## Simulation Engine (Go)

### Tick model

```go
type Engine struct {
    scenario  *scenario.Scenario
    rng       *rand.Rand
    tickIndex int
    startTime time.Time
    interval  time.Duration
    sinks     []sinks.Sink
}

func (e *Engine) Run(ctx context.Context, totalTicks int, rate float64) error {
    for i := 0; i < totalTicks; i++ {
        if ctx.Err() != nil { return ctx.Err() }
        flows := e.traffic.Flows(e.scenario, e.tickIndex, e.rng)
        events := e.generators.Generate(e.scenario, flows, e.tickContext())
        for _, sink := range e.sinks { sink.Write(events) }
        e.tickIndex++
        if rate > 0 {
            time.Sleep(time.Duration(float64(e.interval) / rate))
        }
    }
    for _, s := range e.sinks { s.Flush() }
    return nil
}
```

Per tick:
1. **Traffic generation** — for each connection, the `traffic` package computes a `Flow{ src, dst, protocol, port, request_count, bytes_sent, bytes_recv, error_count, src_ip, dst_ip, ts }`. Rates come from `user_clients[].rps` and propagate through load balancers based on upstream count.
2. **Log generation** — each generator gets the flows that touch its node/service plus the tick context, and returns `[]LogEntry`. `LogEntry` carries `id, ts, channel, level, source, raw, fields`.
3. **Sink dispatch** — events are written to every active sink. Sinks batch internally and flush on `Flush()` or on their own interval.
4. **Pacing** — when `rate > 0`, sleep `tick_interval / rate` between ticks; when `rate == 0`, run as fast as possible.

### Traffic patterns

`steady`, `bursty`, `diurnal`, `incident`. Each is a function `(tickIndex, rng) → multiplier` applied to the base `rps`. `traffic_pattern` strings on `user_client` entries are matched substring-wise (e.g., `"steady mix of GET and POST"` → `steady`).

### Bulk generation

`POST /v1/simulate/bulk` runs the engine with a `bulk` sink that streams to a `archive/zip.Writer` writing to the response body. No in-memory buffering of the full log set — chunks flush as ticks complete. Splits per channel by routing each event to a per-channel writer inside the ZIP.

### Generators (V1, sufficient for the reference scenario)

| Source | Output |
|--------|--------|
| `user_client` | No logs. Synthesizes outbound flows toward its connection target at `rps × pattern_multiplier`. |
| `load_balancer` | Nginx-combined access log per upstream request; distributes inbound flows across upstream connections (round-robin). |
| `nodejs` | Per-request log line in JSON or text. Picks an `endpoints[]` entry per request, applies `error_rate` and `avg_latency_ms` distribution. |
| `mysql` | Query log per request inbound; emits a slow-query log line when sampled latency exceeds `slow_query_threshold`. |
| `vpc_flow` | One line per flow in AWS VPC flow log v2 format, emitted under the VPC's flow channel. |

Generators added later: `golang`, `postgres`, `redis`, `nginx` (standalone), `custom` (handlebars-style template).

### Determinism

A scenario + seed reproduces the same logs. The engine seeds `math/rand.Rand` once and never reads from the global RNG. Generators take the same `*rand.Rand` so ordering matters — generators iterate nodes in parsed order, services in parsed order.

---

## Log Output

### `LogEntry` schema (wire format)

```json
{
  "id": "01HXY...",
  "ts": "2026-04-19T10:30:00.123Z",
  "channel": "web-service.web-service-vpc.web-service-subnet.app-server-1.user-directory-service",
  "level": "INFO",
  "source": "nodejs",
  "raw": "{\"level\":\"info\",\"timestamp\":\"...\",\"method\":\"GET\",\"path\":\"/api/users\",\"statusCode\":200,\"responseTime\":45}",
  "fields": { "method": "GET", "path": "/api/users", "status_code": 200, "response_time_ms": 45 }
}
```

`raw` is what the user/model sees as a log line. `fields` is the canonical structured form for filtering/scoring (kept compatible with the future Episodes/Datasets work).

### Sinks

- **stdout** — writes `raw` (when `--format raw`) or the full JSON `LogEntry` (when `--format jsonl`), one per line.
- **file** — same, to a file. Rotation/append is out of scope for V1 (overwrites by default; `--append` opt-in).
- **cribl-stream** — POSTs Splunk HEC events in batches:
  ```json
  { "time": 1745059800.123, "host": "...", "source": "<channel>", "sourcetype": "logsim:json", "event": <LogEntry.fields or raw> }
  ```
  Newline-delimited per HEC convention. Auth header: `Authorization: Splunk <token>`. Retries with exponential backoff on 5xx; drops batch with a stderr warning after 3 retries.

### Editor log panel

Consumes the SSE stream from `/v1/simulate`. The same ring-buffer behavior (~10K lines) and filter UI applies. Mirroring to a configured destination is opt-in via "Send to destination" in the log panel header — toggling it on streams every received batch back through `POST /v1/forward`.

---

## Scenario Save / Load

- **File format**: YAML, matching the spec above. Editor-only fields go under a `- editor:` block.
- **Editor save**: `Cmd+S` serializes to YAML and downloads `<scenario-name>.logsim.yaml`. Also persisted to `localStorage` as YAML for auto-recovery.
- **Editor open**: file picker for `*.yaml` / `*.logsim.yaml`. The editor parses the YAML, restores `editor:` positions if present, and lays nodes out automatically otherwise.
- **CLI**: only reads YAML — never writes scenarios.

---

## Toolbar / Menus (Editor)

```
File      → New, Open YAML, Save YAML, Export Logs (.log/.jsonl), Export Bulk ZIP
Insert    → (palette items)
Run       → Step, Play/Pause, Stop, Generate Batch...
Configure → Rename, Edit Description, Backend URL, View Destinations
Help      → Keyboard Shortcuts, About
Mode      → [ Design | Episodes | Datasets ]   (Episodes/Datasets are future)
```

"Backend URL" is a setting (default `http://localhost:8080`) the editor uses for all API calls. Persisted in `localStorage`.

---

## Extensibility Design

### New node or service type

1. Add the type literal to `internal/scenario/types.go` and a struct for type-specific fields.
2. Implement a generator in `internal/generators/<name>.go` satisfying the `Generator` interface:
   ```go
   type Generator interface {
       Generate(node *scenario.Node, flows []traffic.Flow, ctx TickContext) []LogEntry
   }
   ```
3. Register it in `internal/generators/registry.go`.
4. (Editor side) Add a node/service entry to the React palette + a config schema for the right-hand panel — the editor schema is decoupled from the Go engine; what matters at runtime is what the YAML carries.

### New destination type

1. Implement `sinks.Sink` (`Write([]Event) error`, `Flush() error`, `Close() error`).
2. Register the `type:` string in `internal/sinks/registry.go`.
3. Add config field validation in `internal/config/destinations.go`.

### New cloud provider

Each generator that emits provider-specific lines (today: `vpc_flow`) checks `node.provider` and switches its renderer. Adding GCP VPC flow logs is a new renderer in the same generator file.

---

## Dataset Generation (Episodes & Training Data)

The Episodes and Datasets modes from the original spec remain a goal — the only change is where the simulation runs. The Go engine grows an `episode` mode that accepts an injected incident recipe + entity pool and returns canonical events with ground truth attached. Task renderers (Query Generation, Incident Summary, Redaction, etc.) live in `internal/datasets/` and produce SFT/RL JSONL exports.

Phase ordering: episodes/datasets land **after** the Go cutover is solid (Phase 6+). Until then, the in-memory editor state for episodes is preserved but not generatable.

---

## UI Layout

Unchanged from the original spec. The bottom log panel reads from an `EventSource` instead of a Web Worker `MessagePort`, but the visual layout (palette left, canvas center, config panel right, log panel bottom) is identical.

---

## Implementation Phases

See `PLAN.md` for the full breakdown. Summary:

1. **Phase 1** — Go scaffolding, scenario YAML parser + validator, `logsim validate` works against `scenarios/web-service.yaml`.
2. **Phase 2** — Tick engine, RNG, traffic simulator, `nodejs` generator, stdout sink. `logsim run --ticks 10` produces realistic Node.js access logs end-to-end.
3. **Phase 3** — Remaining V1 generators (`user_client`, `load_balancer`, `mysql`, `vpc_flow`). File sink. `--rate` pacing. The full reference scenario produces correlated logs.
4. **Phase 4** — `destinations.yaml` parser, Cribl Stream HEC sink with batching + retries, `--destination` flag works end-to-end.
5. **Phase 5** — `logsim serve`, SSE simulate endpoint, bulk ZIP endpoint, destinations API, `/v1/forward`.
6. **Phase 6** — Frontend cutover: delete TS engine, Worker, Cribl proxy. Add YAML serializer, EventSource-driven log panel, backend client. Editor talks only to Go.
7. **Phase 7** — Polish: schema errors surfaced in UI, channel parity tests (FE matcher vs BE channels), `npm run dev` boots both processes, README + getting-started docs.
8. **Future** — Episodes (incident recipes, entity pools, ground truth), Datasets (task renderers, SFT/RL JSONL export), additional generators, GCP/Azure flow log formats.

---

## Key Design Decisions & Rationale

1. **Go for the engine, not TypeScript-on-Node**. Single static binary deployable anywhere, much faster than V8 for tight tick loops, easy to ship a CLI artifact alongside the web service. The editor keeping TS is fine — it's a UI, not a hot loop.

2. **One binary, two modes (`run` and `serve`)**. Reuses parser, engine, generators, sinks across both. The CLI is not a thin wrapper around HTTP — it's the same engine, called directly. This means the CLI works without any network and the server adds ~no code beyond the HTTP plumbing.

3. **YAML as the canonical scenario format**. Human-editable, diffable, easy to drop into a git repo. The unusual top-level-list shape comes from the reference scenario the user wrote and is preserved as-is — `gopkg.in/yaml.v3` handles it without contortion.

4. **SSE for streaming logs to the browser**. One-way fits the use case (server pushes logs, client never pushes back during a stream). Native `EventSource`, no library needed, no upgrade dance, works through proxies. WebSocket would be overkill.

5. **Tokens in the destinations config file**. Simpler than env interpolation for V1. The file is local-only (gitignored by convention). When this becomes a real shared deployment, env interpolation is a small follow-up.

6. **UI fully cuts over to the Go backend**. No dual-engine maintenance burden. The editor becomes a thin client. The cutover is one phase, not a long migration with a feature flag.

7. **Ring-buffer log viewer (~10K lines)**. Unchanged. Backend can produce arbitrarily many; UI shows a window. Bulk export is the path for "I want all of them."

8. **Service ↔ host as an explicit `host:` field**. The reference scenario only said "running on App Server 1" in a description — generators need this resolved, so it's now a required schema field. Validator catches dangling references at parse time.

9. **No migration of saved JSON scenarios**. Pre-pivot `.logsim.json` files are not loaded. The pivot is greenfield — old files can be re-created in the editor. Saves time we'd spend writing a converter that nobody uses.

10. **Channel filter applied in the engine**. Sending the full firehose over SSE just to drop most of it in the browser is wasteful. The engine takes a `channel_filter` param and only emits matching events.

---

## Resolved Decisions

- **Log volume management**: Ring buffer in the UI (~10K lines). Bulk export streams directly to ZIP. No IndexedDB.
- **Connection validation**: Warn but allow. Topology violations show as warnings, not errors.
- **IP assignment**: Auto-assign from CIDR; manual override via `private_ip:` in YAML.
- **Episode storage**: Recipe + seed only. Events regenerated deterministically from the Go engine on demand.
- **Scenario format**: YAML. The pre-pivot JSON format is dropped.
- **CLI distribution**: Single static binary built per platform via `go build`. `goreleaser` configured later.
- **Backend deployment**: For the editor's hosted version, `logsim serve` runs as a sidecar process. Vercel-only deployment is no longer the target — anywhere you can run a Go binary works.
