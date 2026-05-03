# LogSim — Physics Plan

A plan to make LogSim's generated data **truthful at the level of cause and effect**, not
just plausible at the level of surface text. Companion to `SPEC.md` and `PLAN.md`. This
document is the substrate for discussion before code lands; everything here is up for
revision and several decisions are explicitly deferred at the end.

---

## 0. Why this exists

Today the engine renders log lines from per-tick aggregate counts. Reading the current
code, the failure modes are concrete and characteristic:

- **Layers don't agree on the same request.** The LB picks `method/path` randomly
  (`pkg/generators/loadbalancer.go:50-51`) and the backend picks again
  (`pkg/generators/nodejs.go:75`). For one logical request the two views can disagree.
- **Bytes are drawn three times for one byte.** Flow-level
  (`pkg/engine/traffic.go:122`), LB-level (`pkg/generators/loadbalancer.go:63`), VPC-flow
  (`pkg/generators/vpcflow.go:78-82`) — three independent random draws.
- **No connection identity.** `srcPort` redrawn per tick
  (`pkg/generators/vpcflow.go:71`); MySQL `connID` redrawn per query
  (`pkg/generators/mysql.go:66`). A real connection has stable identity across all its
  packets and queries.
- **Latency is independent of load.** `sampleLatency` always reads the configured
  `avg_latency_ms`; a 10× burst in RPS does not slow anything down.
- **Errors have no cause.** `i < totalErrs || rng.Float64() < ep.ErrorRate` produces a
  500 with no matching upstream timeout, no matching DB slow query, no narrative.
- **Time within a tick is acausal.** `spreadTimestamps` distributes events at uniform
  random offsets; the backend log can be timestamped *before* its parent LB log.
- **Timeline overrides prescribe symptoms** (latency × 5, error rate 30%) instead of
  injecting causes that *produce* those symptoms.

The first three are easy to brush off as "we'll fix that one." The fifth and sixth are
the deep ones: a model trained on this data learns to recognize symptom patterns
without ever connecting them to causes, because in our data the causes don't exist.

The goal of this plan is to fix that — to make the simulator's cause-effect structure
match production's cause-effect structure well enough that an investigator agent
trained on simulator output can do real work on production data.

---

## 1. Thesis

**The world is a partially-ordered set of events with causal links. Logs are
projections of that DAG through imperfect observers. The simulator's job is to produce
the DAG faithfully and then project it through observers that introduce realistic
imperfection.**

This separates two things the current engine conflates:

1. **The system** — what actually happens (capacity, queueing, dependencies, failures).
2. **The observation** — what the logs say happened (clock skew, buffering, loss,
   reordering, truncation).

A simulator that only models (1) and emits perfectly-ordered, perfectly-aligned,
never-dropped logs *gives itself away by being too clean*. Real production telemetry is
messier than that, in characteristic ways. Both layers need to be modeled; they should
be cleanly separated so they can be ablated independently for evaluation.

### Three orthogonal kinds of truthfulness

| Axis | What it means | How it's validated |
|---|---|---|
| **Structural** | Trace IDs propagate. 5xx at LB pairs with backend error. Bytes reconcile across layers. Connection identity stable. | DAG-level invariants run as Go tests against emitted batches. |
| **Dynamical** | Latency rises with utilization. Errors emerge from saturation. Caches warm and cool. Cascades propagate. Retries amplify. | Closed-form queueing predictions; injected-cause → expected-symptom-chain tests. |
| **Observational** | Logs occasionally arrive out of order. Clocks disagree by 1–50ms. Some lines are dropped. Long fields truncate. Different sources tell slightly different stories. | Distributional tests against real-corpus baselines (KS on inter-arrival, Hurst exponent, etc). |

Most synthetic-data tools have a smeared-together version of (3) only. A naive
"physics-y" rebuild gets (1) and partial (2). The distinguishing thing is doing all
three with separation, so each can be validated and tuned independently.

---

## 2. Architecture

```
┌────────────────────────────────────────────────────────────────────┐
│  Scenario (YAML)                                                   │
│   ├ topology (nodes, services, connections)                        │
│   ├ workload (user_clients, sessions, dependencies)                │
│   ├ causes (deploys, incidents, traffic shifts)  ← new             │
│   └ observability profile (per-host clock/buffer/loss)  ← new      │
└────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌────────────────────────────────────────────────────────────────────┐
│  Layer 1: Event substrate                                          │
│  pkg/event/dag.go — typed events + causal edges                    │
│   produces a single, internally-consistent DAG in a global frame   │
└────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌────────────────────────────────────────────────────────────────────┐
│  Layer 2: Component models  (state machines + interaction laws)    │
│  pkg/components/                                                   │
│   ├ ServiceRate, Concurrency, queue                                │
│   ├ ConnectionPool, Cache, Heap/GC                                 │
│   └ DependencyGraph: endpoint → downstream calls                   │
│  Consumes events, mutates state, emits caused events.              │
└────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌────────────────────────────────────────────────────────────────────┐
│  Layer 3: Observers  (per-logger projection)                       │
│  pkg/observers/                                                    │
│   ├ ClockSkew, Buffer, FlushPolicy                                 │
│   ├ DropProb, ReorderWindow, TruncationLen                         │
│   └ FormatQuirks (multi-line splits, encoding)                     │
│  Turn DAG events into log lines that look operational, not clean.  │
└────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌────────────────────────────────────────────────────────────────────┐
│  Layer 4: Sinks  (existing — stdout / file / Cribl HEC)            │
└────────────────────────────────────────────────────────────────────┘

  ┌───────────────────────────────────────────────────────────────┐
  │  Side branch: Invariant suite + validation rig                │
  │  pkg/invariants/  — runs on emitted log batches in tests + CI │
  │  cmd/logsim-validate/ — discriminator / corpus comparator     │
  └───────────────────────────────────────────────────────────────┘
```

### What each layer is responsible for

- **Substrate** owns identity (trace IDs, span IDs, session IDs, connection 5-tuples)
  and time (single global clock, partial-order edges). Knows nothing about latency or
  formats.
- **Components** own state (queue, pool, cache) and interaction laws. Compute timings
  and outcomes. Know nothing about log formats.
- **Observers** own imperfection (skew, buffering, loss). Format. Know nothing about
  causation.
- **Sinks** own transport. Unchanged from today.

The discipline matters: any layer reaching across (e.g., an observer "knowing" what
the cause of an event was) re-couples things we just decoupled.

---

## 3. Layer 1 — Event substrate

### 3.1 Event types

```go
// pkg/event/dag.go

type EventID string  // ULID

type Event interface {
    ID() EventID
    At() time.Time      // global frame; observer projection adds skew
    Kind() EventKind
}

type EventKind string

const (
    KindRequestStarted    EventKind = "request_started"
    KindRequestCompleted  EventKind = "request_completed"
    KindChildCall         EventKind = "child_call"        // service → service or service → datastore
    KindConnectionOpened  EventKind = "connection_opened"
    KindConnectionClosed  EventKind = "connection_closed"
    KindLifecycle         EventKind = "lifecycle"          // process start/restart/crash
    KindGCPause           EventKind = "gc_pause"
    KindHealthProbe       EventKind = "health_probe"
    KindDeploy            EventKind = "deploy"
    KindAutoscale         EventKind = "autoscale"
    KindCertRenewal       EventKind = "cert_renewal"
    KindScheduledJob      EventKind = "scheduled_job"
    KindNetworkBlip       EventKind = "network_blip"
    KindCauseInjection    EventKind = "cause_injection"   // synthetic — never observed, only logged in ground truth
)
```

A `Request` is not an event — it's a *subgraph*: `RequestStarted → ChildCall* →
RequestCompleted`, with edges to the request started/completed events at every hop.

### 3.2 Causal edges

```go
type Edge struct {
    From   EventID
    To     EventID
    Type   EdgeType   // CausedBy | PartOf | FollowsInSession
}
```

- **CausedBy**: A 502 at the LB is caused by a backend timeout. A retry is caused by a
  prior failure.
- **PartOf**: A `ChildCall` is part of a `RequestStarted`'s span tree.
- **FollowsInSession**: Sequential requests in one user session.

### 3.3 Identity

- **TraceID**: ULID, generated at request entry (user_clients), propagated through the
  whole call graph. Appears in every log line from every component touched.
- **SpanID / ParentSpanID**: per hop, OpenTelemetry-compatible.
- **SessionID**: cookie-equivalent; same `SessionID` → same `UserID`, same `ClientIP`,
  same `UserAgent` (mostly), traversing a sequence of related endpoints over minutes.
- **ConnectionID**: 5-tuple `(src_ip, dst_ip, src_port, dst_port, proto)` stable across
  all flow records and all queries on it.

### 3.4 Clock model

Single global clock (the one the engine drives) is the ground truth. All DAG events
have a global timestamp. Observers project this through per-host clock skew to produce
the timestamps that appear on log lines. Two log lines from the same request can carry
slightly different timestamps because they were observed by different hosts; the DAG
keeps the truth.

### 3.5 Determinism contract

- Same scenario + same seed → same DAG, byte-identical.
- Same DAG + same seed → same log corpus, byte-identical.
- The two seeds (DAG seed and observer seed) are separable so observers can be
  perturbed without changing the underlying physics.

---

## 4. Layer 2 — Component models

Each component is a state machine that consumes events, mutates internal state, and
emits caused events.

### 4.1 Per-component state

```go
type Component interface {
    Tick(ctx Context) []Event              // emits events from internal timers
    Receive(ev Event, ctx Context) []Event // emits events caused by an arrival
    State() ComponentState                 // for inspection / invariants
}
```

Generic state primitives the substrate provides (used by multiple component types):

- **`Queue`** — bounded FIFO with drop policy. Arrival fills, service drains at μ.
- **`Concurrency`** — c parallel servers. Latency for an arriving request depends on
  current occupancy.
- **`ConnectionPool`** — finite pool with checkout/checkin and wait queue. Exhaustion
  produces backpressure.
- **`Cache`** — fixed size with LRU/TTL eviction. `Get(k)` returns hit/miss; `Set(k)`
  has cost.
- **`Heap`** — allocation rate, GC pause distribution that depends on heap pressure.

### 4.2 Concrete components (replacing the current generators' implicit state)

| Component | Wraps state | Service rate basis |
|---|---|---|
| `LoadBalancer` | active upstreams, health check state, retry policy | bounded by upstream availability |
| `HTTPServer` (nodejs/golang/etc.) | Concurrency, optional Heap | `μ` from instance type + endpoint cost |
| `Database` (mysql/postgres) | ConnectionPool, BufferPool/Cache, LockTable | `μ` per query class (point lookup, range scan, write) |
| `KVStore` (redis) | Concurrency, Cache | `μ` from network roundtrip + memory access |
| `Network` (per-connection) | RTT, jitter, loss | bandwidth-delay product |

### 4.3 Dependency graph

Endpoints declare their downstream calls. Schema:

```yaml
services:
  - type: nodejs
    name: User Directory Service
    host: App Server 1
    generator:
      port: 3000
      endpoints:
        - method: GET
          path: /api/users
          # NEW:
          calls:
            - { service: User Cache, op: "GET user_list", probability: 1.0 }
            - { service: App Database, op: "SELECT * FROM users WHERE active=1", probability: 0.2, when: cache_miss }
        - method: POST
          path: /api/users
          calls:
            - { service: App Database, op: "INSERT INTO users", n: 1 }
            - { service: App Database, op: "INSERT INTO audit_log", n: 1 }
            - { service: User Cache, op: "DEL user_list", n: 1 }
```

When a request arrives at the endpoint, the simulator walks the call list. Each call
produces a `ChildCall` event in the DAG, the dependency component processes it,
latency composes, failures bubble up.

### 4.4 Latency derivation

For an arrival at component `C` with current queue depth `q` and service rate `μ`:

```
latency = service_time(C, request) + queue_wait(q, μ)
```

`service_time` is component-specific (a point lookup vs a range scan have different
distributions). `queue_wait` is `q/μ` for FIFO + the in-flight tail. Latency for the
parent request is the sum of: own `service_time`, every `ChildCall` it issued, plus
network RTT for each.

This is enough to produce M/M/1-shaped utilization curves without claiming we're
literally simulating M/M/1 — the queueing math falls out of explicit queue + service
time as long as service time has the right distribution shape.

### 4.5 Failure derivation

Failures emerge, they aren't sprinkled:

- **Saturation**: queue exceeds bound → 503/connection refused
- **Timeout**: latency exceeds caller's deadline → 504 at caller, request abandoned at
  callee (or completes orphaned, depending on protocol semantics)
- **Pool exhaustion**: ConnectionPool blocks → caller deadline exceeded → 502/504
- **Dependency failure**: `ChildCall` returns error → parent decides retry/fail-fast
  per its policy
- **Crash**: lifecycle event makes a component unavailable for a window
- **Network**: blip drops or delays packets on a connection

A configured `error_rate` per endpoint stays as a **residual** independent failure rate
(deserialization errors, validation rejects, intermittent bugs) layered on top of
capacity-derived errors. We don't pretend the world has zero baseline noise.

---

## 5. Layer 3 — Observer models

This is the layer most distinctively missing today. Observers sit between the DAG and
the sinks. Each (component, sourcetype) pair is an observer with its own profile.

### 5.1 Observer profile

```go
type ObserverProfile struct {
    HostID         string

    // Clock — drifts slowly; jumps on NTP correction events
    ClockSkewMs    Distribution   // e.g., normal(mean=0, stddev=15)
    ClockDriftPpm  float64        // ppm drift between NTP corrections
    NTPCorrectInterval time.Duration

    // Buffer
    BufferSize     int            // events held before flush
    FlushInterval  time.Duration
    FlushOnShutdown bool

    // Loss + reorder
    DropProb       float64        // independent per event
    ReorderWindowMs int           // events within this window can swap order

    // Format quirks
    MaxLineLen     int            // truncation point
    MultilineSplitProb float64    // probability of splitting a multiline event across two lines
}
```

### 5.2 Default profiles

We ship a few canned profiles representative of real environments:

- `well_tuned_production` — mean skew 5ms, drop 0.001%, reorder 50ms window
- `noisy_network` — mean skew 50ms, drop 0.5%, reorder 500ms window, occasional outages
- `local_dev` — zero skew, zero drop, zero reorder (matches today's behavior)

Per-scenario default is `well_tuned_production`; scenarios can override per-host or
globally.

### 5.3 Multi-source-type implications

The same physical event (a request hitting a load balancer) can be observed by
multiple loggers on the same host: nginx access log, syslog, a packet capture, an audit
log. Each has its own observer profile. They produce different formats from the same
underlying event, with their own independent skew/loss/reorder.

This is what makes the corpus look real: the same event correlated across sourcetypes
shows the slight inconsistencies a real correlation would.

---

## 6. Cause language

The single biggest semantic change: scenarios specify **causes**, the simulator
produces the **symptoms**.

### 6.1 Schema

```yaml
causes:
  - id: db-pool-exhaustion-2026-01-15
    at: tick 300                    # or absolute timestamp
    duration: 200 ticks             # or duration string
    type: connection_pool_drain
    target: App Database
    parameters:
      available_connections: 0
      ramp_up_ticks: 5

  - id: deploy-userdir-v2
    at: tick 100
    type: deploy
    target: User Directory Service
    parameters:
      restart_duration_ms: 8000
      post_deploy_latency_mul: 1.4   # warmup
      warmup_ticks: 30

  - id: traffic-burst
    at: tick 500
    duration: 50 ticks
    type: traffic_spike
    target: User Clients
    parameters:
      multiplier: 8
      shape: sharp
```

### 6.2 Cause taxonomy (V1)

| Cause type | What it does | Expected symptoms |
|---|---|---|
| `capacity_loss` | reduce target's μ for a window | latency rises, then 5xx |
| `connection_pool_drain` | drop available connections | callers block, then 502/504 |
| `cache_cold` | force cache hit rate to 0 for a window | downstream load multiplies |
| `disk_full` | writes start failing on target | write 5xx; reads still ok |
| `memory_pressure` | increase GC pause frequency/length | sawtooth latency spikes |
| `deploy` | restart target with brief unavail + warmup | gap in logs, then degraded mode |
| `network_partition` | drop packets between two segments | timeout errors on crossing flows |
| `network_latency_inject` | add latency to a connection | timing shift; possibly cascading timeouts |
| `rate_limit` | enforce a low cap at target | 429s appear; retry storms possible |
| `traffic_spike` | scale arrival rate at user_clients | load test shape |
| `bot_traffic` | inject high-volume requests from a UA pattern | identifiable agent in logs |

### 6.3 Composition

Multiple causes can be active simultaneously. They compose by ordinary state mutation:
`memory_pressure` + `traffic_spike` produces *worse* latency than either alone, because
the GC pauses fall on a longer queue. No special composition logic; the components
just have multiple mutators acting on them.

### 6.4 Ground truth output

Every cause emits a `cause_injection` event at the moment it activates. These events
are **not** projected through observers (they're not real-world observable). They are
captured in a separate `ground_truth.jsonl` output channel that pairs with the log
output. For each cause, we also tag every event in its causal closure (events for which
this cause is an ancestor) with the cause's `id`. This is the ground-truth label for
training/eval.

### 6.5 Relationship to existing Timeline overrides

The current `pkg/scenario.Override` (LatencyMul, LogVolMul, ErrorRate) stays as a
**kinematic mode** for users who want fast plausible output without a cause story —
it's a useful escape hatch for demos and bring-your-own-shape scenarios. The cause
language is the truthful mode and is the one used to generate training data.

---

## 7. Invariant suite

These are the equivalent of physics debug overlays. They run as Go tests against any
emitted log batch (and as a CI check on a fixed reference scenario). A failing
invariant is a bug in the engine, not a bug in the test.

### 7.1 Structural invariants (hard — must always hold)

- **TraceClosure**: every TraceID present in any LB log has a matching log line in
  every downstream service its request visited, within Δt.
- **CausalOrdering** (up to skew envelope): for any TraceID, hop timestamps are
  monotonic in the order required by the call graph. The check uses each observer's
  modeled max-skew as the slack; inversions beyond that envelope are bugs.
- **StatusPairing**: every 5xx at the LB has either (a) a 5xx with the same TraceID at
  the backend, or (b) a gap exceeding the configured timeout (modeled missing
  response).
- **ByteConservation**: ∑ VPC flow bytes for a connection ≈ ∑ HTTP body bytes for that
  connection within configured TCP/TLS/HTTP overhead bounds.
- **ConnectionIdentity**: for each (TraceID, hop-pair), the (src_ip, dst_ip, src_port,
  dst_port, proto) recorded in VPC flow logs is constant.
- **NoOrphanChildren**: every MySQL/Redis log has a `parent_span` whose corresponding
  app log exists with the same TraceID.

### 7.2 Dynamical invariants (statistical — match expected shapes)

- **UtilizationLatency**: p50/p95/p99 latency at a service is monotone-non-decreasing
  in offered load up to capacity, and matches `1/(μ-λ)` shape within a tolerance
  envelope.
- **ErrorOnsetAtCapacity**: error rate stays near residual rate while ρ < 0.85, rises
  steeply once ρ → 1.
- **CauseSymptomCorrespondence**: for each scripted incident type, the symptom chain
  appears in the expected order with the expected amplitudes (e.g., DB pool exhaustion
  → app latency rise within 2s → LB 504s within 5s → user retries within 10s).

### 7.3 Observational invariants (distributional)

- **InterArrival**: at the user_clients aggregate, inter-arrival distribution is
  heavy-tailed at small scales (per-user) and self-similar at the macro scale
  (Hurst > 0.6).
- **ClockSkewBounds**: difference between same-event observed timestamps across
  observer pairs is within the configured skew envelope ≥99% of the time.
- **DropRate**: emitted log count vs DAG event count matches configured drop
  probability within 2σ over a sample of N=10k.

---

## 8. Validation rig

`cmd/logsim-validate` — a separate program that takes an emitted log batch (and
optionally a real-corpus baseline) and runs:

- All invariants from §7
- KS tests on inter-arrival, latency, body-size distributions vs a real corpus
- Per-endpoint status-code distribution vs baseline
- Hurst exponent on aggregate request rate
- Cross-source-type correlation: same TraceID in nginx + nodejs + mysql, count and
  timing of matched triples

Output: a single per-axis pass/fail report with effect sizes. This is the "truthfulness
CI." Without it, "more truthful" is an aesthetic claim. With it, we have a falsification
test for every change.

A reference real corpus (or anonymized snapshot from a willing source) becomes a
checked-in artifact; if we don't have one, we use a hand-crafted golden corpus
generated from a stable engine version and treat regressions as alarms (with the usual
caveat that we can drift away from real production this way — see Open Questions).

---

## 9. Migration from current code

### 9.1 Stays as-is

- `pkg/scenario` parsing/validation (with additive schema changes — `calls`, `causes`,
  `observability`)
- `pkg/sinks` (stdout, file, Cribl HEC)
- `pkg/encoders` (OCSF/UDM mapping is orthogonal to physics)
- The CLI shape (`logsim run`, `logsim serve`, `logsim validate`)
- The tick model and `Engine.Run` outer loop
- The browser editor wire format (logs are still `LogEntry` JSON over SSE)

### 9.2 Changes in place

- `pkg/engine/traffic.go` — keeps producing flows for VPC log compatibility, but as a
  *derived view* over the new event DAG, not the source of truth.
- `pkg/engine/patterns.go` — patterns become input to user_clients arrival processes,
  not output multipliers on aggregate counts.
- `pkg/event/types.go` — `LogEntry` stays; `Flow` becomes an internal derived type;
  `TickContext` carries DAG and observer references in addition to today's fields.
- Generators move from "render this many lines from a count" to "render the lines for
  these specific events that touched me" — same files, gutted bodies.

### 9.3 New packages

- `pkg/event/dag.go` — event types, edges, IDs
- `pkg/components/` — one file per component type
- `pkg/observers/` — observer profile, projection logic
- `pkg/causes/` — cause types, parameter validation, application to component state
- `pkg/invariants/` — assertions usable from tests + CLI
- `cmd/logsim-validate/` — discriminator program

### 9.4 Deletes

Nothing yet. The current engine stays runnable behind a `--legacy-engine` flag through
Stage 4 of the rollout (§10), then deprecated, then removed. This avoids a cliff.

---

## 10. Staged rollout

Each stage is a merge unit. Each stage is gated on the listed validation. Estimates are
rough; real time will depend on what falls out of design as we go.

### Stage 1 — Causal request graph (replace per-tick rendering)

**Goal**: every log line carries a `trace_id`. LB and backend agree on
method/path/status. Bytes reconcile across layers within an envelope.

**Tasks**:
- New `pkg/event/dag.go` with the minimal event subset: `RequestStarted`,
  `RequestCompleted`, `ChildCall`.
- Traffic simulator emits requests (one event per arrival) instead of per-tick flow
  aggregates. Path/method/user picked once at entry.
- Each generator changes from `for i := 0; i < totalReqs; i++` to `for _, req := range
  myRequests`.
- VPC flow generator becomes a derived view: aggregate same-connection requests within
  the tick, emit one flow record per (connection, tick) with correct totals.
- Add the structural invariants from §7.1 as Go tests. Wire one of them
  (TraceClosure) into the existing test suite as a smoke test.

**Validation**:
- TraceClosure passes on the reference scenario.
- StatusPairing passes.
- ByteConservation passes within envelope.
- Determinism property: same seed → byte-identical output.

**Estimate**: ~1 week.

### Stage 2 — Component models with capacity + queueing

**Goal**: latency rises with load. Errors emerge from saturation. The configured
`avg_latency_ms` becomes the *minimum* (uncongested) service time, not the constant.

**Tasks**:
- `pkg/components/` with `HTTPServer`, `LoadBalancer`, `Database`. Each carries a
  `Queue` and a `Concurrency`.
- Service rate `μ` derives from `instance_type` (with a default table) plus per-endpoint
  cost.
- Latency at a hop = `service_time + queue_wait`.
- Errors derived from queue overflow and timeout.
- Residual error rate from current `error_rate` config still applied additively.

**Validation**:
- UtilizationLatency invariant passes.
- ErrorOnsetAtCapacity invariant passes.
- A scenario with `traffic_spike` cause shows a knee in the latency curve at expected
  ρ.

**Estimate**: ~1.5 weeks.

### Stage 3 — Dependency call graph + sessions

**Goal**: realistic incident shapes emerge from injected causes. SQL queries are
caused by HTTP requests, not random.

**Tasks**:
- Endpoint `calls:` schema in YAML (§4.3).
- `Database` and `KVStore` components handle `ChildCall` events; query strings come
  from the call's `op` field.
- Sessions: `user_clients` clients carry session state. `SessionID` propagates.
  Subsequent requests in a session use the same `UserAgent` and `ClientIP`.
- Implement `connection_pool_drain` and `cache_cold` causes. Verify cascade: pool
  exhaustion → app latency rise → LB 504s.

**Validation**:
- CauseSymptomCorrespondence passes for `connection_pool_drain` and `cache_cold`.
- Every MySQL log has an existing parent span (NoOrphanChildren).
- Session continuity: within a `SessionID`, `UserAgent` is constant.

**Estimate**: ~2 weeks.

### Stage 4 — Observer layer

**Goal**: emitted logs have realistic skew, loss, reorder. The `local_dev` profile
preserves today's clean output for tests; production-shaped scenarios opt into
`well_tuned_production`.

**Tasks**:
- `pkg/observers/` with profile types and projection.
- Each component's emit path goes through its observer.
- Per-host clock state with drift + NTP correction.
- Observer seed separate from DAG seed; switching observers doesn't change physics.

**Validation**:
- Distributional invariants from §7.3 pass.
- Determinism: same DAG-seed + same observer-seed → byte-identical output.
- Determinism: same DAG-seed + different observer-seed → identical event causality,
  different log line ordering / drops within tolerance.

**Estimate**: ~1.5 weeks.

### Stage 5 — Validation rig + reference corpus

**Goal**: `logsim validate-corpus` runs against any emitted batch and reports per-axis
pass/fail with effect sizes. CI runs this on the reference scenario every PR.

**Tasks**:
- `cmd/logsim-validate/` with the invariant + distributional checks.
- Reference golden corpus checked in (initially generated by the engine; later, ideally
  cross-validated with anonymized real data).
- CI gating: any PR that regresses a structural invariant fails. Distributional drift
  warns but doesn't fail (until baselines stabilize).

**Validation**:
- The rig itself: a canonical "broken" scenario triggers each invariant.
- A canonical "good" scenario passes everything.

**Estimate**: ~1 week.

### Stage 6 — Lifecycle and infrastructure events

**Goal**: deploys, GC pauses, autoscaling events, certificate renewals, scheduled jobs
appear in logs. Investigator agents can use them as triangulation signals.

**Tasks**:
- Lifecycle event types and their generators (process start banner, deploy marker,
  GC pause line, autoscale decision).
- `deploy`, `memory_pressure` causes wired to corresponding lifecycle events.
- Health probe traffic on a configurable cadence per service.

**Validation**:
- A scenario with a `deploy` cause shows: brief log gap, restart banner, then warmup
  latency.
- A `memory_pressure` cause shows GC pause sawtooth correlating with request latency
  spikes.

**Estimate**: ~1 week.

---

## 11. Open questions / decisions to make

These are explicit so we can pin them down before committing to schemas or types.

1. **Dependency declaration depth.** Should `endpoints[].calls` be the only mechanism,
   or should we support inferred call graphs from connection topology + heuristics
   ("any service connected to a DB probably calls it on every endpoint")? Inferred
   defaults make small scenarios easy; declared specifics make big ones precise.

2. **Session model.** Cookie-equivalent (an opaque ID) vs source-IP-equivalent vs
   both? Real systems have both; cookie is the typical session boundary, IP is what
   VPC flow logs see. Probably both, but the schema needs to make this clean.

3. **Cause composition rules.** Two simultaneous causes on the same target: do
   parameters combine multiplicatively, additively, max, or component-defined? Best
   guess: each cause is a state mutation, and natural composition emerges from
   ordering. Worth a worked example before deciding.

4. **Real-corpus baselines.** Where do we get them? Options: (a) anonymized real
   production telemetry from a willing partner (best, hard to source); (b) public
   datasets like LANL or HDFS logs (limited domains); (c) golden corpus from a stable
   engine version (incestuous but tractable). Likely a phased mix.

5. **Determinism boundary.** If observer seeds are separable, do we expose them in
   the YAML, in flags, or both? And how do we make "deterministic with realistic
   noise" the default in the editor (so users don't see different outputs each run for
   no reason)?

6. **Retries.** Caller-side retry with backoff is a major source of incident
   amplification. Modeled in the LB component? In a generic `RetryPolicy` per
   connection? Tied to per-endpoint config?

7. **Multi-tick events.** A request that takes longer than a tick interval needs to
   span ticks cleanly. The current per-tick generator model assumes everything fits
   inside one tick. Sub-tick scheduling vs per-event simulation?

8. **Heap/GC fidelity.** A faithful GC pause model (gen-G1-shaped sawtooth, full GC
   spikes) is rich. A binary "GC paused for X ms with probability P" is cheap. How
   detailed do we want this to be in V1?

9. **Browser editor implications.** The editor today shows a "scenario as graph."
   Causes, observability profiles, dependencies are *invisible* in that graph. New UI
   surface is needed: a timeline view for causes, a per-component panel for
   observability, an endpoint-edit panel for `calls`. Are we OK building that, or do
   we keep advanced physics YAML-only for V1?

10. **Performance.** A request-level simulation at 1k RPS for a 60s run is 60k
    requests, each walking a depth-3 dependency. That's 60k–500k events, manageable
    in Go. At 10k RPS for 1 hour: 36M requests, possibly 200M events. Likely OK but
    needs an early benchmark before we commit.

---

## 12. Out of scope (V1)

To keep the scope honest:

- **Full Linux/process-level simulation** (gem5 / Linux kernel scheduler). We're not
  modeling syscalls; we're modeling the externally visible behavior of services.
- **Real cryptographic events** (TLS handshakes, key rotation contents). We model the
  *occurrence* of cert renewals, not their payloads.
- **Realistic packet captures.** VPC flow logs are aggregates; per-packet PCAPs are
  out of scope.
- **Multi-region / multi-AZ failover dynamics.** A future extension; V1 is single
  topology.
- **Adversarial / attacker-shaped traffic.** Bot traffic is included as a cause;
  full red-team scenarios (kill chain, lateral movement) belong in a separate plan.
- **Live-tuning a corpus to match a target real distribution.** Adaptive calibration
  is a research project; V1 uses hand-calibrated profiles plus the validation rig.

---

## 13. Glossary

- **DAG** — directed acyclic graph of events with causal edges. The simulator's
  ground-truth model of the world.
- **Event** — a typed, identified, timestamped occurrence in the world (request
  start, GC pause, deploy, etc.).
- **Component** — a state machine modeling a piece of infrastructure (LB, app, DB).
  Consumes events, mutates state, emits events.
- **Observer** — a per-logger projection that turns DAG events into log lines with
  realistic imperfection (skew, loss, reorder, truncation).
- **Cause** — a scripted intervention on the world (deploy, pool drain, traffic
  spike) that produces emergent symptoms by perturbing component state.
- **Symptom** — observable consequence of a cause (latency rise, 5xx, retry storm),
  produced by simulation rather than scripted.
- **Invariant** — a property the emitted log corpus must satisfy if the physics is
  working. Checkable in tests.
- **Validation rig** — a separate program that runs invariants and distributional
  comparisons against an emitted corpus. The "truthfulness CI."
- **Truthfulness axes** — structural (relations are right), dynamical (laws of motion
  are right), observational (imperfections are right). Three orthogonal kinds of
  faithful-to-reality.

---

## 14. What this gets us

If all of this lands, LogSim has these properties no current synthetic-log tool
combines:

1. **Trace correlation works.** Every log has a `trace_id`; pivots resolve;
   investigator agents can do real work.
2. **Incidents are causally honest.** A scripted DB outage produces the same chain of
   symptoms a real one would, at the same timing. Training data has labels matching
   real causes.
3. **Logs look operational, not synthetic.** Skew, loss, reorder, truncation, and
   multi-source-type disagreement match real production telemetry within
   distributional tolerance.
4. **Composability for free.** Adding a new component or scenario topology produces
   correct cross-traffic without writing custom interaction code.
5. **Falsifiable truthfulness.** Every claim about the data is checkable. Regressions
   are caught in CI rather than discovered by users.

That last point is the deepest one. Today, "is this log realistic?" is answered by
squinting. After this plan, it's answered by a CI run.
