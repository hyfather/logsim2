# LogSim — Implementation Plan (Go backend pivot)

This is the phased work plan to take LogSim from "in-browser TS simulation engine" to "Go backend (CLI + HTTP server) with the existing Next.js editor as a thin client." See `SPEC.md` for the target architecture.

The reference scenario throughout is `scenarios/web-service.yaml`. Each phase finishes with a concrete demoable artifact. No phase merges until that artifact works end-to-end.

---

## Phase 1 — Go scaffolding + scenario YAML parser

**Goal**: `logsim validate --scenario scenarios/web-service.yaml` exits 0; the same command on a broken scenario prints a useful error and exits 1.

### Tasks
- `go mod init github.com/nikhilm/logsim` (use the user's actual GH path).
- Add deps: `github.com/spf13/cobra`, `github.com/spf13/viper`, `gopkg.in/yaml.v3`.
- `cmd/logsim/main.go` — cobra root with `run`, `serve`, `validate` stubs.
- `internal/scenario/types.go` — `Scenario`, `Node`, `Service`, `Connection`, `Client`, `GeneratorConfig`. Tag each field with `yaml:"..."`.
- `internal/scenario/parse.go` — `Parse(io.Reader) (*Scenario, error)`. Handles the top-level-list shape (each list item is a single-key map: `name`, `description`, `nodes`, `services`, `connections`, optional `editor`).
- `internal/scenario/validate.go`:
  - Unique names across nodes + services.
  - Every connection endpoint resolves.
  - Every `service.host` resolves to a `virtual_server`.
  - `private_ip` (if set) inside the parent subnet's `cidr_block`.
  - Channel computation walks resolve cleanly.
- `logsim validate` wires these together with formatted error output.

### Tests
- `internal/scenario/parse_test.go` — round-trips the reference scenario.
- `internal/scenario/validate_test.go` — table tests for each validation rule (positive + negative cases).

### Done when
- `logsim validate --scenario scenarios/web-service.yaml` → 0.
- Mutating a copy to break each rule produces a precise error message.

---

## Phase 2 — Tick engine, first generator, stdout sink

**Goal**: `logsim run --scenario scenarios/web-service.yaml --ticks 10` prints realistic Node.js access logs to stdout.

### Tasks
- `internal/engine/engine.go` — `Engine` struct, `Run(ctx, ticks, rate)`. Seeded `*rand.Rand`. Channel computation lives here.
- `internal/engine/traffic.go` — given the scenario, produce per-tick `Flow` objects. For now: `user_clients` → direct connections → target. (Load balancer fan-out comes in Phase 3.)
- `internal/engine/patterns.go` — `steady`, `bursty`, `diurnal`, `incident` multipliers. String-match `traffic_pattern` substrings to a pattern.
- `internal/generators/base.go` — shared helpers: latency distribution (exp around mean), user agents, IP pool from CIDR.
- `internal/generators/registry.go` — type → constructor map.
- `internal/generators/nodejs.go` — first concrete generator. JSON and text formats. Honors `endpoints[]`, `error_rate`, `avg_latency_ms`.
- `internal/sinks/sink.go` — `Sink` interface.
- `internal/sinks/stdout.go` — writes JSONL by default, raw on `--format raw`.
- `cmd/logsim/run.go` — wires CLI flags into engine + sinks.

### Tests
- `internal/engine/engine_test.go` — fixed seed produces identical output across runs (determinism test).
- `internal/generators/nodejs_test.go` — produces N lines for N inbound flow requests; respects `error_rate` over a large sample.

### Done when
- The reference scenario's `User Directory Service` produces realistic Node.js access logs visible on stdout for 10 ticks.
- Re-running with the same `--seed` produces byte-identical output.

---

## Phase 3 — Remaining generators, file sink, pacing

**Goal**: All five reference-scenario sources produce correlated logs. Output to file works. `--rate` paces emission against wall clock.

### Tasks
- `internal/generators/userclient.go` — generates flows toward its connection target at `rps × pattern_multiplier`. Emits no logs itself.
- `internal/generators/loadbalancer.go` — Nginx-combined access log per request; round-robins across upstream connections; bumps the per-upstream flow's request_count.
- `internal/generators/mysql.go` — query log per inbound request; slow-query log when sampled latency > `slow_query_threshold`.
- `internal/generators/vpcflow.go` — emits AWS VPC flow log v2 lines for every flow whose endpoints are inside the VPC.
- `internal/sinks/file.go` — writes to a path; `--append` opt-in.
- `--rate` wired into the engine: `time.Sleep(interval / rate)` between ticks; `0` = instant.

### Tests
- Integration: run the reference scenario for 60 ticks; assert that `user-directory-service` logs and `app-database` logs share request rates within tolerance.
- File sink: writes the expected number of lines and the file is valid JSONL.

### Done when
- `logsim run --scenario scenarios/web-service.yaml --ticks 60 --output file --path /tmp/out.jsonl` produces ~60 ticks of correlated multi-source logs.
- `--rate 1` makes 60 ticks take ~60 seconds; `--rate 0` (default) finishes instantly.

---

## Phase 4 — Destinations config + Cribl Stream sink

**Goal**: `logsim run ... --output destination --destination prod-cribl --config destinations.yaml` forwards to a real Cribl HEC endpoint.

### Tasks
- `internal/config/destinations.go` — parser for `destinations.yaml`. Validates `type`, required fields per type, batch_size in [1,500].
- `internal/sinks/cribl.go` — implements `Sink`. Buffers up to `batch_size` events, flushes on size or `flush_interval_ms`. POSTs Splunk HEC newline-delimited JSON. Auth header `Splunk <token>`. 3-retry exponential backoff on 5xx; drops batch with stderr warning on permanent failure.
- `internal/sinks/registry.go` — `type:` → constructor.
- CLI: `--output destination`, `--destination`, `--config` flags. Validates that the named destination exists and is `enabled: true`.
- `destinations.yaml.example` committed.

### Tests
- `internal/sinks/cribl_test.go` — `httptest.Server` standing in for Cribl; verifies batching, retry, auth header.
- `internal/config/destinations_test.go` — parses example, rejects invalid configs.

### Done when
- Pointing `--config` at a real Cribl Stream HEC endpoint shows events arriving in Cribl.
- Killing the Cribl endpoint mid-stream produces a stderr warning and the CLI keeps running (drops failed batches).

---

## Phase 5 — HTTP server (`logsim serve`)

**Goal**: `logsim serve --port 8080` exposes SSE simulate, bulk ZIP export, destinations API, and the forward endpoint. `curl` can drive a simulation end-to-end.

### Tasks
- `internal/server/server.go` — `chi` router, CORS middleware (origin from `--cors-origin`), JSON middleware, panic recovery.
- `internal/server/simulate.go` — `POST /v1/simulate`. Parses the body, builds an Engine with an SSE sink that writes `event: batch\ndata: {...}\n\n` per tick. Closes cleanly on client disconnect (`r.Context().Done()`).
- `internal/server/bulk.go` — `POST /v1/simulate/bulk`. Streams a ZIP via `archive/zip` over the response body. Splits by channel when requested.
- `internal/server/destinations.go` — `GET /v1/destinations` (tokens redacted), `POST /v1/destinations/:name/test` (sends one canned event).
- `internal/server/forward.go` — `POST /v1/forward`. Looks up the destination, batches and forwards the body's logs.
- SIGHUP reloads `destinations.yaml`.

### Tests
- `internal/server/simulate_test.go` — uses `httptest` to run a real simulation, asserts SSE framing and that disconnect stops the engine.
- `internal/server/bulk_test.go` — parses the returned ZIP, asserts manifest + per-channel files.

### Done when
- `curl -N -X POST http://localhost:8080/v1/simulate -d @body.json` streams batches.
- `curl -X POST http://localhost:8080/v1/simulate/bulk -d @body.json -o out.zip` produces a valid ZIP.
- SIGHUP picks up edits to `destinations.yaml` without restart.

---

## Phase 6 — Frontend cutover (delete TS engine)

**Goal**: The Next.js editor uses only the Go backend. All deleted TS code is gone. Existing UX (Play/Step/Stop, log panel, bulk generate, destination manager, save/load) works.

### Tasks
- **Delete**:
  - `src/engine/SimulationEngine.ts`
  - `src/engine/simulation.worker.ts`
  - `src/engine/generators/` (all)
  - `src/engine/traffic/` (all)
  - `src/engine/output/` (all)
  - `src/lib/criblForwarder.ts`
  - `src/app/api/cribl/route.ts` (and the `api/` folder if empty)
- **Keep but rework**:
  - `src/engine/channels/` — only the matcher used by the filter UI; channel computation moves to "for autocomplete display" (server is authority).
  - `src/store/useSimulationStore.ts` — `tick` / `play` / `stop` now drive an `EventSource` instead of `Worker.postMessage`. `logBuffer` accumulates entries from SSE events.
  - `src/store/useDestinationsStore.ts` — becomes a read-only mirror of `GET /v1/destinations`. Add a refresh action and a "test destination" action that hits the Go endpoint.
  - `src/components/panels/LogPanel.tsx` — no change to UI, but the data path is the simulation store (no Worker).
  - `src/components/panels/SimulationControls.tsx` — Play opens EventSource, Stop closes it.
  - `src/components/panels/BulkGenerateModal.tsx` — POSTs `/v1/simulate/bulk`, downloads the ZIP from the response.
  - `src/components/panels/DestinationManagerModal.tsx` — read-only list with "Test" button per row; "Add destination" shows a dialog explaining "edit `destinations.yaml` and SIGHUP the server."
- **Add**:
  - `src/lib/api.ts` — typed client: `simulate(body): EventSource`, `simulateBulk(body): Promise<Blob>`, `listDestinations()`, `testDestination(name)`, `forward(name, logs)`.
  - `src/lib/scenarioYaml.ts` — `serializeToYaml(scenario): string` and `deserializeFromYaml(string): Scenario`. Round-trips with editor positions in `editor:` block. Use `js-yaml` (browser-safe).
  - `src/components/panels/BackendStatus.tsx` — small indicator in the toolbar showing backend reachability (`GET /v1/destinations` ping every 30s).
  - Settings entry in `Configure → Backend URL` (persists to localStorage).
- **Save/Load** updated to YAML (replaces `.logsim.json`).

### Tests
- Manual smoke: open editor, build the reference scenario, hit Play, see logs stream in.
- Bulk generate produces a downloadable ZIP.
- Destination manager lists destinations from the YAML the server was started with.

### Done when
- Grep shows zero references to `SimulationEngine`, `simulation.worker`, `criblForwarder`, `/api/cribl` in `src/`.
- Editor produces logs in the panel only when `logsim serve` is running.
- All previously-working buttons still do their thing.

---

## Phase 7 — Polish

**Goal**: Smooth developer + user experience. Production-ish ergonomics.

### Tasks
- **Schema errors in UI**: when `/v1/simulate` returns an `error` SSE event, surface it in the log panel as a red banner with the message.
- **Channel parity tests**: a small Go-side test that emits channel names for every node/service in the reference scenario, plus a TS test that the editor's channel computation produces the same strings. Catches drift.
- **Dev script**: `npm run dev` boots both `next dev` and `go run ./cmd/logsim serve` (using `concurrently` or a tiny shell script).
- **Build script**: `make build` produces `dist/logsim` (Go) and `dist/editor` (Next static export, where possible).
- **README**: getting-started — install Go, build the binary, start serve, open editor, point at `scenarios/web-service.yaml`.
- **goreleaser config**: cross-compiled `logsim` binaries (darwin/linux/windows × amd64/arm64) built on tag.
- **Healthcheck endpoint**: `GET /v1/healthz` returning `{ ok: true, version: "...", destinations_loaded: N }`.

### Done when
- A new contributor can clone, run `npm run dev`, and watch logs stream in their browser within 5 minutes.
- `git tag v0.1.0 && git push --tags` produces release binaries via CI.

---

## Future (post-V1)

- **Episodes & Datasets**: incident recipes (credential compromise, bad deploy, etc.), entity pools, ground-truth-attached events, SFT/RL JSONL exporters. Lives in `internal/episodes/` and `internal/datasets/`. Editor's Episodes/Datasets modes wire up.
- **More generators**: `golang`, `postgres`, `redis`, `nginx` (standalone), `custom` template generator.
- **More destinations**: `splunk-hec`, `elasticsearch`, `loki`, `datadog`, generic webhook.
- **Provider variety**: GCP and Azure VPC flow log formats; provider-specific service-discovery log shapes.
- **Env interpolation in destinations.yaml**: `${ENV_VAR}` substitution.
- **Auth on the HTTP API**: bearer token for `serve` mode when not bound to localhost.
- **Scenario templates**: `logsim init --template 3-tier-web` scaffolds a starter YAML.
- **Terraform import**: parse `.tf` to build a starter scenario.

---

## Risks & open questions

- **Channel naming parity**: the editor used to compute channels from a parent-child tree; the Go engine computes them from `subnet:` references and CIDR containment. The Phase 7 parity test is the safety net — until then, editor filter autocomplete might briefly show channels that differ in slugification edge cases.
- **YAML editor round-trip**: `gopkg.in/yaml.v3` and `js-yaml` may differ on quoting / ordering. We don't promise byte-identical round-trips, only semantic equivalence. Document this.
- **CORS in production**: `--cors-origin` defaults to `http://localhost:3000` for dev. Hosted deployment needs a real config story.
- **SSE through corporate proxies**: some buffer SSE indefinitely. The bulk export endpoint exists partly as an escape hatch.
- **Backend not running**: editor must degrade gracefully — disabled Play button, clear "Backend offline" banner, no silent failures.
