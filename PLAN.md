# LogSim — Implementation Plan

This is the phased roadmap. The architecture target is in [SPEC.md](SPEC.md); the user-facing intro and CLI quickstart are in [README.md](README.md).

The reference scenario throughout is `scenarios/web-service.yaml`. Each phase finishes with a concrete demoable artifact. Phases 1–7 below are **shipped** — they describe what was built and how to verify it. Phase 8 is the active edge of work; the "Future" section is the queue beyond that.

---

## Status snapshot

| Area | Status | Where |
|------|:------:|-------|
| Scenario YAML parser + validator | shipped | `pkg/scenario/` |
| Tick engine (deterministic, seeded) | shipped | `pkg/engine/` |
| Generators: nodejs, mysql, loadbalancer, vpc_flow, custom | shipped | `pkg/generators/` |
| Generators: golang, postgres, redis, nginx | shipped via fallback | `nodejs`/`mysql` analogue in `ForService` |
| Sinks: stdout, file, cribl_hec | shipped | `pkg/sinks/` |
| Wire schemas: jsonl, raw, ocsf, otel | shipped | `pkg/encoders/` |
| Wire schemas: udm, asim | reserved (fall back to native) | `pkg/encoders/` |
| `logsim run` (path / URL / slug) | shipped | `cmd/logsim/run.go` |
| `logsim validate` | shipped | `cmd/logsim/validate.go` |
| `logsim list` (catalog browser) | shipped | `cmd/logsim/list.go` |
| `logsim serve` (SSE + bulk + destinations) | shipped | `cmd/logsim/serve.go`, `pkg/server/` |
| `logsim destinations` (TUI form) | shipped | `cmd/logsim/destinations.go` |
| `logsim upgrade` (self-update) | shipped | `cmd/logsim/upgrade.go` |
| Install script + GitHub Releases | shipped | `scripts/install.sh`, `.github/workflows/release.yml` |
| Vercel functions (`api/generate`, `api/run`, `api/logs_at`) | shipped | `api/` |
| Custom types (templates + placeholders) | shipped | `pkg/scenario/types.go`, `pkg/generators/custom.go` |
| Timelines + behavior states + overrides | shipped | `pkg/scenario/timeline.go` |
| Episode mode (timeline scrub, block inspector, forward status) | shipped | `src/components/episodes/` |
| Forward mode (server-side HEC streaming) | shipped | `cmd/logsim/run.go --to`, `api/run` `mode:"forward"` |
| Datasets / SFT export | not started | (future) |
| GCP / Azure VPC flow log shapes | not started | (future) |
| Generic webhook / Loki / Datadog / Elastic destinations | not started | (future) |

---

## Phase 1 — Go scaffolding + scenario YAML parser ✅

**Goal**: `logsim validate scenarios/web-service.yaml` exits 0; the same command on a broken scenario prints a useful error and exits 1.

### Done
- `go mod init github.com/nikhilm/logsim2` (Go 1.25.5).
- Cobra-based CLI scaffold in `cmd/logsim/main.go` with `run`, `validate`, `list`, `serve`, `destinations`, `upgrade` subcommands.
- `pkg/scenario/types.go` — `Scenario`, `Node`, `Service`, `Connection`, `Client`, `GeneratorConfig`, `CustomType`, `LogTemplate`, `Placeholder`, `TimelineBlock`, `Override`, `EditorMeta`.
- `pkg/scenario/parse.go` — handles the top-level-list YAML shape (each list item is a single-key map: `name`, `description`, `duration`, `tick_interval_ms`, `nodes`, `services`, `connections`, `custom_types`, `editor`).
- `pkg/scenario/validate.go` — name uniqueness, connection endpoint resolution, `service.host` resolution, CIDR containment, `custom_type` references, `traffic_pattern` mapping.
- `pkg/scenario/load.go` — accepts a local path or http(s) URL (4 MiB cap, 15s timeout). `LoadAndValidate` is the one-call entry point.
- `pkg/scenario/resolve.go` — bare slug → `${LOGSIM_BASE_URL:-https://logsim2.vercel.app}/s/<slug>.yaml`.

### Verify
```bash
logsim validate scenarios/web-service.yaml             # OK
logsim validate https://logsim2.vercel.app/s/db-slowdown-cascade.yaml
logsim validate db-slowdown-cascade                    # bare slug
```
Mutating a copy to break each rule produces a precise error message.

---

## Phase 2 — Tick engine, first generators, stdout sink ✅

**Goal**: `logsim run scenarios/web-service.yaml --ticks 10` prints realistic logs to stdout.

### Done
- `pkg/engine/engine.go` — `Engine`, seeded `*rand.Rand`, deterministic target ordering. Pre-builds `(target, generator)` pairs at construction so the per-tick path stays allocation-light.
- `pkg/engine/traffic.go` — per-tick `Flow` synthesis from `user_clients[].rps` × pattern multiplier × any active timeline override.
- `pkg/engine/patterns.go` — `steady`, `bursty`, `diurnal`, `incident` multipliers. Substring match on `traffic_pattern`.
- `pkg/engine/channels.go` — slugifies names + walks containment to produce per-target source paths (`vpc/subnet/host/svc`).
- `pkg/generators/base.go` — latency distribution (exp around mean), user agents, IP pool from CIDR.
- `pkg/generators/nodejs.go` — JSON and text formats; honors `endpoints[]`, `error_rate`, `avg_latency_ms`. Used directly for `nodejs`, and as fallback for `golang` / `nginx` until they get dedicated generators.
- `pkg/sinks/sink.go` — `Sink` interface (`Write([]event.LogEntry) error`, `Flush() error`, `Close() error`).
- `pkg/sinks/stdout.go` + `pkg/sinks/file.go` — share a `WriterSink` core.

### Verify
- `logsim run scenarios/web-service.yaml --ticks 10` produces realistic Node.js access logs.
- Same `--seed` produces byte-identical output across runs (`pkg/engine/engine_test.go`).

---

## Phase 3 — Remaining generators, file sink, pacing ✅

**Goal**: All five reference-scenario sources produce correlated logs; `--rate`-style pacing is replaced by the simpler "sleep `tick_interval` between ticks" path used by streaming consumers.

### Done
- `pkg/generators/loadbalancer.go` — Nginx-combined access log per request; round-robins inbound flows across upstream connections.
- `pkg/generators/mysql.go` — query log per inbound request; slow-query log when sampled latency > `slow_query_threshold`. Fallback for `postgres` / `redis`.
- `pkg/generators/vpcflow.go` — AWS VPC flow log v2 lines for every flow whose endpoints are inside the VPC.
- `pkg/sinks/file.go` — writes to a path; `--append` opt-in.
- `pkg/engine/phase3_test.go` — integration test that 60 ticks of the reference scenario produces correlated multi-source logs with request rates within tolerance.

### Verify
- `logsim run scenarios/web-service.yaml -o /tmp/out.jsonl` produces ~60 ticks of correlated multi-source logs.
- `logsim run --tick-interval 1s` makes ticks pace against wall clock; default is instant.

---

## Phase 4 — Destinations dotfile + Cribl Stream sink ✅

**Goal**: `logsim run … --to prod-cribl` forwards to a real Cribl HEC endpoint.

### Done
- `pkg/config/destinations.go` — parser for `destinations.yaml`. Validates `type`, required fields per type, `batch_size` ∈ [1, 500].
- `pkg/config/path.go` — XDG-style dotfile resolution (`$LOGSIM_CONFIG` → `$XDG_CONFIG_HOME/logsim/destinations.yaml` → `$HOME/.config/logsim/destinations.yaml`).
- `pkg/config/save.go` — atomic write with `0600` perms.
- `pkg/sinks/cribl.go` — buffers up to `batch_size` events, flushes on size or `flush_interval_ms`. POSTs Splunk HEC newline-delimited JSON. `Authorization: Splunk <token>`. 3-retry exponential backoff (1s, 2s, 4s) on 5xx and transport errors; 4xx are permanent. Drops batch with stderr warning after retries (engine keeps running).
- `pkg/sinks/cribl.go` exposes `SendObserver` callbacks per HTTP attempt — used by both the CLI (`forwardingReporter` in `cmd/logsim/run.go`) and the Vercel `api/run` forward-mode handler.
- `pkg/sinks/registry.go` — `cribl_hec` → `NewCriblWithFormat`. Per-destination `format:` honored.
- `cmd/logsim/destinations.go` — interactive `huh` form for `add`; plus `list`, `remove`, `enable`, `disable`, `test`, `path`.
- `destinations.yaml.example` committed.

### Verify
- `logsim destinations add` walks through name/URL/token/format/batch/flush/enabled, writes to the dotfile.
- `logsim destinations test prod-cribl` POSTs one canned event, prints the response.
- `logsim run web-service --to prod-cribl` shows live `POST → 200 OK (100 events, 142ms)` lines on stderr and a closing tally.
- Killing the Cribl endpoint mid-stream produces stderr warnings; the CLI keeps running and exits cleanly.

---

## Phase 5 — `logsim serve` ✅

**Goal**: A long-lived HTTP backend the editor can talk to.

### Done
- `pkg/server/server.go` — `chi` router, CORS middleware (origin from `--cors-origin`), panic recovery, JSON helpers. SIGHUP reloads `destinations.yaml`.
- `pkg/server/simulate.go` — `POST /v1/simulate` (SSE). Per tick: `event: batch\ndata: <JSON array>\n\n`. Closes cleanly on client disconnect (`r.Context().Done()`).
- `pkg/server/bulk.go` — `POST /v1/simulate/bulk`. Streams a ZIP via `archive/zip` over the response body. One `<source>.jsonl` per channel + `manifest.json`.
- `pkg/server/destinations.go` — `GET /v1/destinations` (tokens redacted), `POST /v1/destinations/{name}/test` (one canned event), `POST /v1/forward?destination=<name>` (forward an arbitrary `LogEntry[]`).
- `pkg/server/simulate_test.go` + `bulk_test.go` — `httptest`-based coverage of SSE framing, disconnect-stops-engine, ZIP layout.
- `cmd/logsim/serve.go` — graceful shutdown on SIGINT/SIGTERM; configurable port, CORS origin, destinations path.

### Verify
- `curl -N -X POST http://localhost:8080/v1/simulate -d @body.json` streams batches.
- `curl -X POST http://localhost:8080/v1/simulate/bulk -d @body.json -o out.zip` produces a valid ZIP.
- `kill -HUP $PID` picks up edits to `destinations.yaml` without restart.

---

## Phase 6 — Vercel functions for the hosted editor ✅

**Goal**: The hosted editor runs the same engine without operating a long-lived backend.

This phase replaced the original "frontend cutover" plan. Instead of one `logsim serve`, the hosted editor talks to three Go lambdas under `api/`. The CLI and `logsim serve` continue to exist for self-hosters; the lambdas exist because Vercel's no-ops story is too good to pass up for a demo deployment.

### Done
- `api/generate/index.go` — `POST /api/generate`. ≤30 ticks per call; legacy single-tick path. `cribl?` block lets the function forward server-side without exposing the token to the browser.
- `api/run/index.go` — `POST /api/run`. NDJSON stream, one frame per tick (`{tick,ts,logs}`), then `{done,total_logs}`. Caps each request at 600 ticks and ~3 MiB body — emits `{partial:true,next_tick,total_logs}` and the client resumes by sending `start_tick` on the follow-up. Also implements `mode:"forward"`: same engine, but events stream to the configured Cribl HEC and the response body carries only `start` / `post` / `progress` / `done` frames so the function timeout is the only upper bound.
- `api/logs_at/index.go` — `POST /api/logs_at`. Re-runs the engine deterministically from tick 0 to `to`, returns logs in `[from, to)`. Powers timeline scrubbing in Episode mode.
- `pkg/apihelp/` — shared CORS, error helpers, `CriblConfig` request types so the three lambdas don't drift.
- `cmd/devserver/main.go` — local emulator that mounts all three functions on `:8787` for browser testing without `vercel dev`.
- `vercel.json` — `api/**/*.go` → Go function (memory: 512, maxDuration: 300).
- Editor wiring: `src/lib/backendClient.ts`, `runStream.ts` (NDJSON consumer with chunked-resume), `logsAt.ts`, `runForward.ts`, `criblForwarder.ts` (browser fallback proxied through `src/app/api/cribl/route.ts`).
- `src/store/useSimulationStore.ts` drives the log buffer from whichever stream is active.
- `src/components/episodes/` — `EpisodeTimeline`, `BlockInspector`, `ScrubbedLogs`, `ForwardStatusPanel` for Episode mode.
- `src/lib/canvasToScenarioYaml.ts` — canvas → YAML serializer.

### Why three lambdas instead of one

- `api/generate` exists for the legacy single-tick path and any client that wants a tiny synchronous response.
- `api/run` is the streaming hot path. Streaming over POST (NDJSON) survives Vercel's proxy stack better than SSE GET, and the body cap is the only thing the chunked-resume needs to dodge.
- `api/logs_at` is deliberately stateless and re-runnable. Same scenario+seed → same output, so the timeline scrubber never shows logs that don't match a Play run.

### Verify
- Open the hosted editor, drag the reference scenario, hit Play — logs stream in.
- Scrub the timeline — logs at the scrubbed window load deterministically.
- Hit Forward → live HEC POST status streams back through `ForwardStatusPanel`.

---

## Phase 7 — Distribution + polish ✅

**Goal**: A new contributor can install the CLI in 10 seconds and replay any built-in scenario without cloning anything.

### Done
- `scripts/install.sh` — `curl -fsSL …/install.sh | sh`. Detects OS/arch, fetches matching tarball from GitHub Releases, verifies SHA-256 (when `shasum` present), installs to `/usr/local/bin` (or `$HOME/.local/bin` if writable). Pin via `LOGSIM_VERSION=vX.Y.Z`; relocate via `LOGSIM_PREFIX`.
- `.github/workflows/release.yml` — cross-compiles `darwin/amd64`, `darwin/arm64`, `linux/amd64`, `linux/arm64` on tag push. Uploads `logsim-<os>-<arch>.tar.gz` plus `.sha256` to the release.
- `cmd/logsim/upgrade.go` — `logsim upgrade` resolves the latest tag, re-runs `install.sh` with `LOGSIM_VERSION=$tag`. `--version vX.Y.Z` pins.
- `cmd/logsim/list.go` — fetches `${LOGSIM_BASE_URL:-…}/s/index.json`, prints a tab-separated table. `-q` for slugs only (suitable for `xargs`).
- `pkg/scenario/catalog.go` — typed catalog client; mirrors `scripts/build-preset-yaml.mjs` output.
- `src/app/run-locally/` — landing page on the hosted site that walks through install → verify → run a scenario by URL. Lists every catalog entry with copy-to-clipboard CLI commands.
- README + SPEC + PLAN aligned with shipped reality (this revision).
- `--source-filter`, `--ocsf`, `--otel`, `-o`, `--to`, `--tee`, `--list-formats`, `--quiet`, `--force`, `--seed` all wired with cohesive help text.
- `>5k log line confirmation prompt` (`promptThreshold` in `cmd/logsim/run.go`) keeps a runaway `logsim run cache-failure-cascade` from drowning a terminal. Skipped under `--quiet` / `--force` / non-tty stdin.

### Verify
- `curl -fsSL …/install.sh | sh && logsim run db-slowdown-cascade | head` prints valid JSONL.
- `git tag v0.X.Y && git push --tags` produces release tarballs in CI.
- `logsim upgrade` swaps a `dev` build for a real release.

---

## Phase 8 — Episodes & ground-truth datasets (active)

**Goal**: Every scenario can be played as an "episode" — a labeled training example with ground truth attached. Datasets export as SFT/RL JSONL ready for fine-tuning.

### In flight
- Editor's Episode mode (timeline + block inspector + scrubber) is shipped; ground-truth generation lives partially in `src/lib/scenarioGroundTruth.ts`.
- `programs/` directory holds agent instructions for an autoresearch-style training loop (`scenario_author.md`, `investigator.md`, `grader.md`, `TRAINING_PLAN.md`).
- `scripts/build-example-episodes.mjs` builds canned episode fixtures.

### Remaining
- `pkg/datasets/` — task renderers (Query Generation, Incident Summary, Redaction, Root-Cause Identification). Take an episode + scenario + ground truth, emit one or more JSONL rows.
- `pkg/episodes/` — incident recipes, entity pools. Today scenarios are hand-authored; recipes will let a runner generate parametrized variants.
- `logsim datasets render --episode <path> --task root-cause` CLI subcommand.
- Editor's Datasets mode (currently parked behind a feature flag).

### Done when
- `logsim datasets render` produces SFT JSONL that round-trips through the trainer in `programs/`.
- Episode mode in the editor can export the same JSONL.

---

## Future (post-Phase 8)

- **First-class generators** for `golang`, `postgres`, `redis`, `nginx` (today they fall back to the closest analogue). Each will replace the fallback in `ForService` and add a dedicated test suite.
- **More destinations**: `splunk-hec` (likely a thin alias on `cribl_hec` since the wire protocol is identical), `elasticsearch`, `loki`, `datadog`, generic `webhook`. Each is a new `Sink` plus a `pkg/sinks/registry.go` entry plus config-field validation.
- **GCP and Azure VPC flow log formats**. Each generator that emits provider-specific lines (today `vpc_flow`) switches its renderer on `node.provider`.
- **UDM / ASIM encoders**. Format identifiers are reserved (`pkg/encoders.FormatUDM`, `FormatASIM`) and the wire selection works end-to-end; the mapping tables themselves are missing.
- **Env interpolation in `destinations.yaml`**: `${LOGSIM_CRIBL_TOKEN}` substitution for shared / committed configs.
- **Auth on `logsim serve`**: bearer token when the bind address isn't `127.0.0.1`. Today the assumption is "behind a reverse proxy or VPN."
- **Scenario templates**: `logsim init --template 3-tier-web` scaffolds a starter YAML.
- **Terraform / k8s manifest import**: parse `.tf` or k8s manifests to build a starter scenario.
- **Windows binaries**: today Windows users must `go install`. Adding `windows/amd64` + `windows/arm64` to the release matrix is mostly an installer-script refactor (the Go compile is already cross-platform).
- **`logsim run --rate`-style real-time pacing**: today `--tick-interval` controls simulated time between ticks; a separate "wall-clock pacing multiplier" was in the original spec but isn't wired. Trivially adds back via `time.Sleep(interval / rate)` in `Engine.Run`.

---

## Risks & open questions

- **Vercel response budget vs. very large scenarios.** `api/run` chunks at ~3 MiB and 600 ticks per call. The largest catalog scenario (`cache-failure-cascade`) is 1080 ticks; the frontend handles the chunk-and-resume cleanly today, but a 10× larger scenario could need a more aggressive pre-filter on the server side. Watch for this when generators get more verbose.
- **Generator fallback hides bugs.** `golang`/`nginx`/`postgres`/`redis` services run through the `nodejs`/`mysql` fallback. That's good UX (every service emits *something*) but it means a scenario that names a `redis` service is silently rendered as MySQL queries. The simplify is to ship dedicated generators; until then, the editor's preview should make the fallback obvious.
- **Catalog drift.** The CLI fetches scenarios from a hard-coded default `LOGSIM_BASE_URL`. If the hosted site goes down or moves, every CLI install breaks. Mitigation: respect `LOGSIM_BASE_URL`, document it in `--help`, and consider mirroring the catalog in the release tarball as an offline fallback.
- **OCSF / OTEL coverage.** Today's mappings cover the classes the shipped generators emit (`http_activity`, `datastore_activity`, `network_activity`, `application_lifecycle`, `api_activity`). New generators will need to set `LogEntry.Class` correctly or the encoder falls back to a generic shape. A schema-coverage test (one fixture per class × encoder pair) would catch silent regressions.
- **No backwards-compat story for destinations.yaml.** Today the parser uses `KnownFields(true)`, so unknown keys hard-fail. Fine for a v0 — easy to relax later when the schema needs to evolve.
- **Determinism guarantees.** `--seed` reproduces output byte-for-byte today. Adding wall-clock-dependent fields (real `time.Now()` instead of `cfg.StartTime + tick × interval`) would silently break this. Tests in `pkg/engine/engine_test.go` lock the contract; reviewers should keep it that way.
- **Vercel cold starts.** The Go runtime cold-starts in ~1s on Vercel Hobby. The streaming `/api/run` consumer doesn't notice, but `/api/generate` users see it as added latency on the first tick. No mitigation today; a "Pro" deployment with provisioned concurrency is the upgrade path.
- **Editor / engine source-path parity.** The editor computes source paths in TS for filter autocomplete; the engine is authoritative. A small parity test (one fixture, both implementations) would catch drift early. Low priority because filter mismatches are visible to the user instantly.
