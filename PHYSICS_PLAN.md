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

## 9. Testing strategy: how we know the physics is faithful

The invariant suite (§7) is the *catalog* of properties we expect to hold. The
validation rig (§8) is the *runner*. This section is the *strategy* — the testing
pyramid that says which test type catches which class of failure, and where the
gaps would otherwise be.

The hard thing about testing a physics simulator is that most claims are about
*emergent* behavior, not function inputs and outputs. "Latency rises with load" is
not a unit test; it's a property over a population of scenarios. "Trace correlation
works" is not a function call; it's a relation across thousands of log lines. Each
level below catches a different class of failure, and we need all of them.

### 9.1 The eleven levels

#### Level 1 — Unit tests
Standard Go unit tests on each component, observer, and cause type.
- **Catches**: implementation bugs in one place. `Queue.Enqueue` past capacity
  drops oldest. `ConnectionPool.Checkout` blocks on exhaustion. `ClockSkew.Project`
  produces a sample within envelope.
- **Lives in**: `pkg/*/*_test.go`.
- **CI**: per-PR, blocks merge.
- **Lands in**: every stage; trivially.

#### Level 2 — Invariant tests on emitted batches
The catalog from §7 run on a fixed set of scenario fixtures.
- **Catches**: components individually correct but their composition violates
  structural laws. (Trace closure, byte conservation, status pairing, etc.)
- **Lives in**: `pkg/invariants/`.
- **CI**: per-PR, blocks.
- **Lands in**: Stage 1 (initial structural set), expanded each stage.

#### Level 3 — Closed-form oracle tests
Compare simulator output to textbook predictions:

| Claim | Oracle | Test |
|---|---|---|
| M/M/1 utilization-latency | `W = 1/(μ-λ)` for ρ < 1 | Sweep ρ from 0.1→0.95, assert measured `W` matches within 10% |
| Little's Law | `L = λW` in steady state | Measure all three independently; ratio within 5% |
| Cache hit rate (LRU + Zipf) | classical formula given working set, cache size | Generate Zipf request stream; compare measured to predicted |
| Cascade amplification (retries) | `A = 1/(1-p)` for stable retry policy | Inject failure; measure load multiplication |
| Drop rate at saturation | M/M/1/K formula | Bound queue; measure overflow rate vs prediction |

- **Catches**: dynamical claims that are wrong by amounts a queueing theorist would
  notice. The strongest test of dynamical correctness because the oracle is
  external.
- **Lives in**: `pkg/invariants/oracles_test.go`.
- **CI**: per-PR, blocks.
- **Lands in**: Stage 2 (when the capacity model exists).

#### Level 4 — Cause-symptom tests (parameterized)
For each cause type in §6.2, a fixture asserts the expected symptom chain appears
in the right observable, in the right order, with the right amplitude:

```go
{
  Name: "connection_pool_drain produces cascade",
  Scenario: "fixtures/userdir-with-db.yaml",
  Cause: causes.ConnectionPoolDrain{Target: "App Database", AvailableConns: 0},
  CauseAt: 300,
  Expected: []SymptomCheck{
    {Where: "App Database", Metric: "checkout_wait_p99",
     Window: tickRange(300, 320), Min: 1000, Max: 30000},
    {Where: "User Directory Service", Metric: "request_latency_p99",
     Window: tickRange(305, 325), Min: 1000, Max: 30000},
    {Where: "Load Balancer", Metric: "5xx_rate",
     Window: tickRange(310, 330), Min: 0.10, Max: 1.0},
    {Order: []string{"App Database lat ↑", "App lat ↑", "LB 5xx ↑"}},
  },
}
```

- **Catches**: causes that don't produce their advertised symptom chain. The deepest
  training-data integrity issue and the test the existing override mechanism
  *cannot* pass — because there's no causal layer between the configured symptom
  and the emitted log.
- **Lives in**: `pkg/causes/symptom_test.go`.
- **CI**: per-PR, blocks.
- **Lands in**: Stage 3 (one cause type), expanded through Stage 6.

#### Level 5 — Distributional tests against a baseline
KS, Hurst, autocorrelation, KL/χ² divergence on inter-arrival, latency, body-size,
status codes — per-endpoint where applicable. Cross-source-type correlation
distributions (same TraceID timing across nginx + nodejs + mysql).

- **Catches**: surface texture that doesn't match real telemetry — the kind of
  failure a discriminator would catch first.
- **Lives in**: `cmd/logsim-validate/`.
- **CI**: per-PR, warns until baselines stabilize, then blocks.
- **Lands in**: Stage 5 (rig + initial baselines), tightened over time.

#### Level 6 — Discriminator / adversarial tests
Build classifiers trained to distinguish synthetic from real corpora; track AUC
release-over-release.

Three flavors, in order of sophistication:
1. **Hand-crafted feature classifier** — logistic regression on a small set of
   obvious features (status code entropy, inter-event gap distribution, byte-count
   modular signatures). AUC ≫ 0.5 means we're easy to spot.
2. **ML classifier** — small transformer or LSTM trained on labeled real/synthetic
   batches. Lower AUC means harder to distinguish; the *trend* matters more than
   any absolute number.
3. **Causal-consistency probe** — discriminator specifically designed to look at
   trace correlation, byte reconciliation, timing relations. If only this catches
   us, surface looks fine but causality is leaking.

- **Catches**: aggregate "smell" of synthetic data that no single distributional
  test catches. Collapses many implicit checks into one tracked number.
- **Lives in**: separate eval pipeline.
- **CI**: per-release, tracked (not gating).
- **Lands in**: post Stage 5, ongoing.

#### Level 7 — Layered ablation tests
Run with each physics layer disabled or replaced with identity, assert what
should still hold:
- **Components off**: substrate-level invariants must still pass.
- **Observers off** (`local_dev` profile): structural and dynamical invariants
  must pass; observational ones trivially pass. This is the deterministic CI mode.
- **Causes off**: produces baseline traffic; used as discriminator-training input.
- **Single-cause only**: cause-symptom test for that cause must pass without
  confounding from other causes.

- **Catches**: a layer silently broken but compensated for by another layer.
  Without ablation, layers can mask each other's bugs.
- **Lives in**: `pkg/invariants/ablation_test.go`.
- **CI**: per-PR, blocks.
- **Lands in**: Stage 4 (when observer layer creates the layering to ablate).

#### Level 8 — Transfer tests (training-task evaluation)
The ultimate test for the training-data use case:
1. Train a model on synthetic data labeled with §6.4 ground truth (e.g.,
   "given logs, identify the root cause of an incident").
2. Evaluate on a held-out *real* corpus with human-labeled root causes.
3. Compare to: (a) trained-on-real baseline (oracle), (b) zero-shot baseline,
   (c) prior-engine-version baseline.

The synthetic-to-real performance gap is the answer to "is this data truthful
enough for its actual purpose."

- **Catches**: synthetic data that *looks* fine on every other test but fails to
  transfer to real production. The failure mode that matters most for the
  Episodes/Datasets work in `programs/`.
- **Lives in**: separate eval pipeline.
- **CI**: per-release, tracked (expensive).
- **Lands in**: post Stage 6, ongoing.

#### Level 9 — Fuzz / sensitivity tests
Standard Go fuzz on parser, topology generator, parameter ranges. For each
generated scenario the validator accepts, run a short simulation; assert all
structural invariants hold.

- **Catches**: degenerate scenarios that crash, hang, or violate invariants.
  Empty topology, single component, very deep dependency chains, massive fan-out,
  extreme parameter values.
- **Lives in**: Go fuzz targets per package.
- **CI**: nightly, warns.
- **Lands in**: Stage 1 (parser fuzz), expanded each stage.

#### Level 10 — Regression tests (golden corpus)
Pin a set of reference scenarios. Generate "golden" output with fixed seed at a
fixed engine version. Same seed + same version + any platform → byte-identical
output.

- **Catches**: silent drift across changes that should have been neutral.
- **Lives in**: `testdata/golden/`.
- **CI**: per-PR, blocks (golden diffs require explicit reviewer approval — treats
  "the bytes changed" as notable, not sacred, but visible).
- **Lands in**: Stage 1 (initial set), expanded each stage.

#### Level 11 — Performance / scale benchmarks
Events per second of wall clock at 1k / 10k / 100k RPS; memory footprint at
1-hour / 24-hour simulated time; time-to-first-event after `Run()` start
(latency bound for editor responsiveness); determinism across goroutine
scheduling (`GOMAXPROCS=1` and `GOMAXPROCS=8` byte-identical).

- **Catches**: regressions that make the engine unusable at target scale.
- **Lives in**: Go benchmarks.
- **CI**: per-PR, warns on >20% regression without explanation.
- **Lands in**: Stage 1 (baseline numbers), tracked thereafter.

### 9.2 CI matrix

| Level | Frequency | Blocks merge? |
|---|---|---|
| 1 Unit | Per-PR | Yes |
| 2 Invariants | Per-PR | Yes |
| 3 Oracles | Per-PR | Yes |
| 4 Cause-symptom | Per-PR | Yes |
| 5 Distributional | Per-PR | Warn → Yes after stabilization |
| 6 Discriminator | Per-release | Track |
| 7 Ablation | Per-PR | Yes |
| 8 Transfer | Per-release | Track |
| 9 Fuzz | Nightly | Warn |
| 10 Regression | Per-PR | Yes (with diff approval) |
| 11 Performance | Per-PR | Warn (>20%) |

"Track" means we record the metric over time but don't block. "Warn" means we
surface the diff but don't block. "Yes" blocks merge.

### 9.3 Coverage matrix

What each level covers across the physics layers (✓ = covered, blank = gap):

| Layer | L1 | L2 | L3 | L4 | L5 | L6 | L7 | L8 | L9 | L10 | L11 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Substrate (events, IDs, edges) | ✓ | ✓ |   |   |   |   | ✓ |   | ✓ | ✓ | ✓ |
| Components (capacity, state) | ✓ | ✓ | ✓ | ✓ |   |   | ✓ |   | ✓ | ✓ | ✓ |
| Observers (skew, loss, reorder) | ✓ |   |   |   | ✓ | ✓ | ✓ |   | ✓ | ✓ |   |
| Causes & symptoms | ✓ |   |   | ✓ |   |   | ✓ | ✓ |   | ✓ |   |
| End-to-end log realism |   |   |   |   | ✓ | ✓ |   | ✓ |   | ✓ |   |

Empty cells are gaps; visible gaps are where bugs hide. The matrix is also a
priority guide: the best test type to add next is the one that fills the worst
gap on the layer changing most.

### 9.4 The continuous calibration loop

Real production data is the ongoing oracle. As we obtain more real-corpus
snapshots, the loop is:

1. Snapshot real telemetry from a willing source (anonymized, scrubbed).
2. Run the validation rig comparing engine output to the snapshot.
3. Identify where the gap is widest (which distribution? which invariant?).
4. Tune component defaults, observer profiles, or cause parameters to close the
   biggest gap first.
5. Re-baseline; record new tolerances.

This is process, not code. It's the equivalent of how real physics simulators are
*calibrated* against experimental data over years. The engine improves over time
not by adding features but by reducing measured divergence from reality.

### 9.5 Phasing — what's free, what's a project, what's a research bet

Honest accounting of cost so the test plan doesn't read as "build all eleven of
these now":

- **Free with implementation** (lands as a side effect of building each stage):
  L1 unit tests, L2 invariants, L7 ablation, L10 regression goldens.
- **Modest setup** (focused sub-task per stage): L3 oracles, L9 fuzz, L11 perf.
- **Project-sized** (dedicated effort, multiple weeks): L4 cause-symptom matrix,
  L5 distributional rig with real-corpus baselines.
- **Research-sized** (ongoing, possibly never "done"): L6 discriminator, L8
  transfer.

Realistic build order: L1, L2, L10 from Stage 1. L3, L7 from Stage 2. L9 from
Stage 1 onward, expanded each stage. L4 starts in Stage 3 (one cause), expanded
through Stage 6. L5 starts in Stage 5 (the validation rig). L6 and L8 are
post-Stage-6 ongoing investments — the heavyweight infrastructure to track
truthfulness as a long-run scalar.

### 9.6 What success looks like

Concrete numbers, with the caveat that all of these need calibration once we have
real-corpus baselines:

- Every structural invariant (§7.1) holds on the reference scenario at all stages.
- Every cause type in §6.2 has a passing cause-symptom fixture (Level 4).
- Closed-form oracles (Level 3) match within 10% across the full parameter sweep.
- Hand-crafted discriminator (Level 6.1) AUC trends downward release-over-release;
  goal AUC < 0.7 by Stage 6 completion.
- Transfer test (Level 8) closes the synthetic-to-real performance gap by 50% vs
  zero-shot baseline by end of Stage 6.

These are not contracts; they are targets that tell us whether we're on track.
Adjust as baselines come in.

---

## 10. Migration from current code

### 10.1 Stays as-is

- `pkg/scenario` parsing/validation (with additive schema changes — `calls`, `causes`,
  `observability`)
- `pkg/sinks` (stdout, file, Cribl HEC)
- `pkg/encoders` (OCSF/UDM mapping is orthogonal to physics)
- The CLI shape (`logsim run`, `logsim serve`, `logsim validate`)
- The tick model and `Engine.Run` outer loop
- The browser editor wire format (logs are still `LogEntry` JSON over SSE)

### 10.2 Changes in place

- `pkg/engine/traffic.go` — keeps producing flows for VPC log compatibility, but as a
  *derived view* over the new event DAG, not the source of truth.
- `pkg/engine/patterns.go` — patterns become input to user_clients arrival processes,
  not output multipliers on aggregate counts.
- `pkg/event/types.go` — `LogEntry` stays; `Flow` becomes an internal derived type;
  `TickContext` carries DAG and observer references in addition to today's fields.
- Generators move from "render this many lines from a count" to "render the lines for
  these specific events that touched me" — same files, gutted bodies.

### 10.3 New packages

- `pkg/event/dag.go` — event types, edges, IDs
- `pkg/components/` — one file per component type
- `pkg/observers/` — observer profile, projection logic
- `pkg/causes/` — cause types, parameter validation, application to component state
- `pkg/invariants/` — assertions usable from tests + CLI
- `cmd/logsim-validate/` — discriminator program

### 10.4 Deletes

Nothing yet. The current engine stays runnable behind a `--legacy-engine` flag through
Stage 4 of the rollout (§11), then deprecated, then removed. This avoids a cliff.

---

## 11. Staged rollout

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

## 12. Open questions / decisions to make

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

## 13. Out of scope (V1)

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

## 14. Glossary

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

## 15. What this gets us

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
