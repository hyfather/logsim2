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

To run the CLI (unchanged, independent of Vercel):

```bash
go run ./cmd/logsim run --scenario scenarios/web-service.yaml --ticks 60
```

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
