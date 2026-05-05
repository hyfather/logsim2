# LogSim

Drag-and-drop infrastructure log simulator. A Next.js editor in the browser
drives a Go simulation engine; the same engine ships as a single-binary CLI
(`logsim`) you can run on your laptop or in CI.

The hosted editor is at **https://logsim2.vercel.app** — open it, drag some
nodes, hit play. To run the same scenarios on your own machine (no Vercel
required), install the CLI:

```bash
curl -fsSL https://raw.githubusercontent.com/hyfather/logsim2/master/scripts/install.sh | sh
logsim run db-slowdown-cascade
```

That's it. The CLI fetches the scenario YAML from the public catalog, runs
the simulator locally, and prints JSONL to stdout.

---

## Install the CLI

### One-line install (macOS / Linux)

```bash
curl -fsSL https://raw.githubusercontent.com/hyfather/logsim2/master/scripts/install.sh | sh
```

The installer:

- detects your OS/arch (linux/darwin × amd64/arm64),
- downloads the matching pre-built binary from
  [GitHub Releases](https://github.com/hyfather/logsim2/releases),
- verifies the SHA-256 checksum (when `shasum` is present),
- drops it at `/usr/local/bin/logsim` (or `$HOME/.local/bin/logsim` if
  `/usr/local/bin` isn't writable),
- prints the line to add to `PATH` if the install dir isn't already on it.

Override the install location with `LOGSIM_PREFIX`, pin to a specific tag with
`LOGSIM_VERSION=v1.2.3`.

### From source (any platform with Go 1.25+)

```bash
go install github.com/hyfather/logsim2/cmd/logsim@latest
```

### Pre-built binaries

[Releases page](https://github.com/hyfather/logsim2/releases) — `tar.gz`
archives plus `.sha256` checksums for each platform. Windows users: use
`go install` for now.

### Self-update

```bash
logsim upgrade                # latest release
logsim upgrade --version v1.2.3
```

`logsim upgrade` re-runs the installer with the resolved tag.

### Verify

```bash
logsim --help
logsim --version
```

---

## Quickstart

### 1. Run a built-in scenario by slug

The CLI ships with no embedded scenarios — it pulls them from the public
catalog at `https://logsim2.vercel.app/s/index.json`. Pass a bare slug, an
http(s) URL, or a local path:

```bash
logsim list                                            # browse the catalog
logsim run db-slowdown-cascade                         # by slug
logsim run https://logsim2.vercel.app/s/db-slowdown-cascade.yaml
logsim run scenarios/web-service.yaml                  # local file
```

By default `logsim run` plays the entire scenario (every tick declared in the
YAML's `duration:` at the cadence in `tick_interval_ms:`) and writes JSONL to
stdout. Pipe it anywhere:

```bash
logsim run db-slowdown-cascade | jq 'select(.level == "ERROR")'
logsim run cache-failure-cascade --ticks 60 > sample.jsonl
```

Override `LOGSIM_BASE_URL` if you mirror the catalog on your own host.

### 2. Pick a wire schema

```bash
logsim run web-service --ocsf                          # shortcut
logsim run web-service --otel
logsim run web-service --format jsonl                  # default
logsim run --list-formats                              # all valid values
```

Schemas: `jsonl` (default — full LogEntry as JSON), `raw` (just the rendered
log line), `ocsf` (OCSF v1.x JSON events), `otel` (OTLP/JSON LogRecord),
`udm` and `asim` (reserved — fall back to native today).

When you write to a file, the format is auto-inferred from a `.ocsf.*` or
`.otel.*` suffix unless `--format` is set explicitly:

```bash
logsim run web-service -o trace.ocsf.json
# logsim: inferred --format=ocsf from trace.ocsf.json
```

### 3. Forward to a SIEM

`logsim destinations` manages a dotfile at
`$XDG_CONFIG_HOME/logsim/destinations.yaml` (defaults to
`~/.config/logsim/destinations.yaml`; override with `$LOGSIM_CONFIG`):

```bash
logsim destinations add               # interactive form: name, URL, token, format, ...
logsim destinations list
logsim destinations test prod-cribl
logsim destinations disable prod-cribl
logsim destinations remove prod-cribl
logsim destinations path              # print the resolved dotfile path
```

Once configured, opt in with `--to`:

```bash
# pick one or more by name (or `all` for every enabled destination)
logsim run web-service --to prod-cribl
logsim run web-service --to prod-cribl,staging
logsim run web-service --to all

# forward and keep a local copy at the same time
logsim run web-service --to prod-cribl -o ./trace.jsonl
```

When forwarding, `logsim run` switches off log-line output and instead streams
HEC progress to stderr:

```
logsim: forwarding → prod-cribl
logsim:   POST → 200 OK (100 events, 142ms)
logsim:   POST → 200 OK (100 events, 138ms)
…
logsim: sent 5421 events to prod-cribl in 55 batches
```

V1 supports Cribl Stream / Splunk HEC (`type: cribl_hec`). The destinations
file is `chmod 0600` and never logged.

### 4. Output targets

`-o, --out` is the unified file/stdout flag — pass a path, `-` for stdout, or
repeat / comma-separate to fan out:

```bash
logsim run web-service -o /tmp/logs.jsonl
logsim run web-service -o -                          # explicit stdout
logsim run web-service -o a.jsonl,b.jsonl
logsim run web-service --to prod-cribl --tee /tmp/logs.jsonl
```

`--tee` always layers in a file copy alongside whatever else `--out` / `--to`
asked for.

### 5. Validate without running

```bash
logsim validate scenarios/web-service.yaml
logsim validate https://logsim2.vercel.app/s/db-slowdown-cascade.yaml
```

Exits non-zero with a precise error message on any schema, name-resolution,
or CIDR-containment failure.

---

## CLI cheat sheet

| Command | What it does |
|---------|--------------|
| `logsim run <slug\|path\|url>` | Run a scenario, emit logs (stdout / file / destination). |
| `logsim validate <slug\|path\|url>` | Parse + validate; non-zero exit on error. |
| `logsim list` | Browse the public scenario catalog. `-q` prints slugs only. |
| `logsim serve` | Start the HTTP/SSE server (used by self-hosted editors). |
| `logsim destinations …` | Manage forwarding destinations (`add`, `list`, `test`, …). |
| `logsim upgrade` | Self-update via the official installer. |

`logsim run --help` enumerates every flag; the most useful are `--ticks`,
`--tick-interval`, `--seed`, `--format` / `--ocsf` / `--otel`,
`-o/--out`, `--to`, `--tee`, `--source-filter`, and `--quiet`.

---

## Architecture (one paragraph)

The Go engine in `pkg/engine` parses a scenario YAML, advances a
deterministic tick loop (seeded `math/rand`), and routes each tick's logs
through a chain of sinks (stdout, file, Cribl HEC). The CLI in `cmd/logsim`
is the engine in one shape; the Vercel functions in `api/` (`generate`, `run`,
`logs_at`) are the same engine wrapped in HTTP handlers, and `logsim serve`
exposes a richer set of routes (`/v1/simulate` SSE, `/v1/simulate/bulk` ZIP,
`/v1/destinations`, `/v1/forward`) for self-hosting. The Next.js editor in
`src/` is a thin client: it builds scenarios on a React Flow canvas, posts
the YAML to the backend, and streams logs back. See [SPEC.md](SPEC.md) for
the full architecture and [PLAN.md](PLAN.md) for the phased roadmap.

---

## Local development

### Editor only (no log generation)

```bash
npm install
npm run dev
```

Runs Next.js at `http://localhost:3000`. The `/api/*` Go functions return
404 in this mode — so the editor canvas works but Play / Step won't produce
logs.

### Editor + Vercel functions (full local production parity)

```bash
npm install -g vercel
vercel dev
```

Runs Next.js and the Go functions (`api/generate`, `api/run`, `api/logs_at`)
together on one port, matching the production routing.

### Editor + `logsim serve` (richer backend)

```bash
# terminal 1
go run ./cmd/logsim serve --port 8080

# terminal 2
npm run dev
```

In the editor, set **Configure → Backend URL** to `http://localhost:8080` to
talk to the long-lived Go process instead of the bounded Vercel functions.
`logsim serve` adds bulk ZIP export, SSE streaming, and a destinations API.

### Run the Go test suite

```bash
go test ./...
```

### Build a CLI binary

```bash
go build -o logsim ./cmd/logsim
./logsim --help
```

---

## Deploying the editor to Vercel

1. Push this repo to GitHub.
2. Import it into Vercel. Framework preset is auto-detected as **Next.js**.
3. Deploy. Vercel picks up `vercel.json` and compiles every `api/**/*.go`
   file as a standalone Go function. No extra configuration needed.

After the first deploy, `git push` is the full deploy flow.

### Configuring Cribl forwarding from the deployed editor

The editor never bakes a Cribl token into the build. Open the deployed app,
go to **Configure → Manage Destinations…**, add a Cribl Stream HEC entry
(URL + token), and toggle it on. Those values live in `localStorage` and are
attached to each `/api/run` request. The Go function performs the forwarding
server-side so the token never leaves the user's browser → your Vercel edge
→ Cribl path.

If Cribl's receiver has an IP allowlist, note that the Vercel functions run
from Vercel's edge IPs — allow them (or disable the allowlist) for forwarding
to succeed.

---

## Known limits

- **Vercel function timeouts.** `api/run` streams NDJSON one tick at a time
  but caps each request at 600 ticks and ~3 MiB of body. The frontend chunks
  long episodes (the largest catalog scenario is 1080 ticks). The CLI has no
  such cap — `logsim run` happily plays a 24-hour scenario.
- **Single-binary distribution today.** Pre-built binaries for darwin/linux
  on amd64 + arm64. Windows is `go install` only.
- **Cribl HEC is the only destination type.** Splunk HEC works as a drop-in
  (same wire protocol). Loki / Datadog / generic webhook are roadmap items
  in [PLAN.md](PLAN.md).
- **OCSF / OTEL coverage.** Mappings are present and stable for the
  generators that ship today (HTTP activity, datastore activity, network
  activity); UDM and ASIM are reserved format identifiers that fall back to
  native JSONL until the mappings land.
