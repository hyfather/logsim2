# LogSim

Drag-and-drop infrastructure log simulator. A Next.js editor in the browser drives
a Go simulation engine that runs as a Vercel serverless function, with optional
forwarding to a Cribl Stream HEC endpoint.

## Architecture

- **Frontend** — Next.js 14 (App Router) in `src/`. React Flow canvas, palette,
  log panel. Owns the simulated clock and polls the backend once per second.
- **Backend** — Go serverless function at [`api/generate.go`](api/generate.go).
  Each request runs the engine for a short window (≤30 ticks) and returns logs
  as JSON. If a Cribl destination is configured on the frontend, the same batch
  is forwarded to Cribl HEC before the response is sent.
- **Local CLI** — `cmd/logsim` still builds as a standalone binary for batch
  generation; it is not deployed to Vercel.

The serverless model is a deliberate concession to Vercel Hobby's 10s execution
cap: instead of an open SSE stream, the browser asks the backend for one
simulated second at a time. Fast-forward mode just asks for more ticks per
window. State lives in the client; the function is stateless.

## Deploying to Vercel

1. Push this repo to GitHub/GitLab/Bitbucket.
2. Import the repo into Vercel. Framework preset is auto-detected as **Next.js**.
3. Deploy. Vercel picks up `vercel.json` and compiles any `api/*.go` file as a
   standalone Go function. No extra configuration needed.

After the first deploy, `git push` is the full deploy flow.

### Configuring Cribl forwarding from the browser

The frontend never needs a Cribl token baked into the build. Open the deployed
app, go to **Configure → Manage Destinations…**, add a Cribl Stream HEC entry
with URL + token, and toggle it on. Those values live in `localStorage` and are
attached to each `/api/generate` request. The Go function performs the
forwarding server-side so no HEC token is exposed to other clients and no CORS
dance is needed against Cribl.

If Cribl's receiver has an IP allowlist, note that `/api/generate` runs from
Vercel's edge IPs — allow them (or disable the allowlist) for forwarding to
succeed.

## Local development

```bash
# Next.js UI only — /api/generate returns 404 in this mode
npm install
npm run dev
```

To exercise the Go function locally, use `vercel dev`:

```bash
npm install -g vercel
vercel dev
```

This runs Next.js and the Go function together on one port, matching the
production routing.

To run the CLI (independent of Vercel):

```bash
go run ./cmd/logsim run --scenario scenarios/web-service.yaml --ticks 60
```

### CLI destinations (optional)

`logsim run` writes to stdout by default — pipe it into another tool, redirect
to a file, whatever you like. Configuring a destination is entirely optional
and only needed if you want `logsim` to forward to Cribl Stream / Splunk HEC
on your behalf.

If you do want forwarding, the CLI keeps a destinations dotfile at
`~/.config/logsim/destinations.yaml` (`$XDG_CONFIG_HOME/logsim/destinations.yaml`
if set, or override with `$LOGSIM_CONFIG`):

```bash
go run ./cmd/logsim destinations add       # TUI form: name, URL, token, format, ...
go run ./cmd/logsim destinations list
go run ./cmd/logsim destinations test prod-cribl
go run ./cmd/logsim destinations disable prod-cribl
go run ./cmd/logsim destinations remove prod-cribl
```

Then opt in to a destination with `--to`:

```bash
# pick one or more by name (or `all` for every enabled destination)
go run ./cmd/logsim run --scenario scenarios/web-service.yaml --to prod-cribl
go run ./cmd/logsim run --scenario scenarios/web-service.yaml --to prod-cribl,staging

# forward and keep a local copy at the same time
go run ./cmd/logsim run --scenario scenarios/web-service.yaml --to prod-cribl -o ./trace.jsonl
```

#### Output targets

`-o, --out` is the unified file/stdout flag — pass a path, `-` for stdout, or
repeat / comma-separate to fan out:

```bash
go run ./cmd/logsim run --scenario scenarios/web-service.yaml -o /tmp/logs.jsonl
go run ./cmd/logsim run --scenario scenarios/web-service.yaml -o -            # explicit stdout
go run ./cmd/logsim run --scenario scenarios/web-service.yaml -o a.jsonl,b.jsonl
```

#### Schema (OCSF, OTEL, …)

`--format` selects the wire schema. Two convenience shortcuts:

```bash
go run ./cmd/logsim run --scenario scenarios/web-service.yaml --ocsf
go run ./cmd/logsim run --scenario scenarios/web-service.yaml --otel
go run ./cmd/logsim run --list-formats        # prints valid --format values
```

When you write to a file, the format is auto-inferred from a `.ocsf.*` or
`.otel.*` suffix unless `--format` is set explicitly:

```bash
go run ./cmd/logsim run --scenario scenarios/web-service.yaml -o trace.ocsf.json
# logsim: inferred --format=ocsf from trace.ocsf.json
```

`logsim run` never prompts and stdout is the silent default — destinations
are opt-in. The legacy `--output stdout|file|destination` form (with `--path`
/ `--destination` / `--config`) still works for scripts.

## Known limits

- **Hobby 10s cap.** Each `/api/generate` request runs the engine for up to 30
  simulated ticks and completes well under the limit. Heavier scenarios may
  need to be broken into smaller windows.
- **Scenario source.** The editor canvas and the scenario sent to the backend
  are not yet wired together — `/api/generate` currently loads the bundled
  `public/scenarios/web-service.yaml`. Full YAML serialization from the canvas
  is a follow-up task.
- **Channels filter, bulk export, destination test button** currently still use
  the pre-pivot code paths (worker / Next.js `/api/cribl` proxy). They continue
  to work but will move to the Go backend in a later pass.
