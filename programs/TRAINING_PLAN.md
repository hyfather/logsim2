# LogSim — SFT/RL Training Plan (autoresearch frame)

This is the plan to turn LogSim from "synthetic log generator" into a **synthetic data flywheel for fine-tuning an investigation agent** that arrives at the same root cause we used to seed the scenario. The agent's target use case is incident investigation in security and IT data.

The plan is structured as a small **human-written substrate** plus a set of **autonomous loops** in the style of [Karpathy's autoresearch](https://github.com/karpathy/autoresearch). Each loop is driven by a markdown file in [`programs/`](programs/). The human's interface is the markdown — the agents do the actual work and commit results to git when they pass checks.

This plan is independent of [PLAN.md](PLAN.md) (Go backend pivot). It assumes that plan is far enough along that scenarios produce realistic logs and the engine is stable enough to run thousands of times.

---

## Core thesis

A scenario in LogSim isn't just "logs" — it's a structured object: topology, seeded fault, cascading effects, expected observable signals, and red-herring noise. Because we *constructed* the scenario, we know the ground-truth root cause without human labeling.

That gives us **verifiable rewards**: an agent's stated RCA can be programmatically graded against the scenario object. This is the regime where RL works well and where labeled data is otherwise prohibitively expensive.

The autoresearch frame applies because every job in the pipeline — authoring scenarios, investigating them, grading the investigations, evolving the toolset, running training experiments — is the kind of repetitive, evaluable work an AI agent can do overnight while the human sleeps. The human edits markdown; the loops produce artifacts.

---

## Design decisions, pinned up front

These shape everything. Changing them later is expensive.

1. **Action space is portable across backends.** The agent emits a structured query plan (an IR), not raw SPL or KQL. A backend compiler translates IR → Splunk SPL, IR → Cribl Search, IR → ES|QL. The model trains once and ports for free.
2. **Tight, realistic toolset.** Seven tools, modeled on real SOC/SRE workflows. No kitchen-sink escape hatch. Resist adding more until the agent is observably failing for lack of them.
3. **Time is absolute UTC.** All time fields in the IR are absolute UTC ranges. Relative time lives in the compiler, not the agent.
4. **Scenarios are typed objects.** The same YAML that drives log generation carries the structured RCA used for grading. One source of truth.
5. **SFT before RL.** Bootstrap tool-use discipline cheaply with teacher traces. Switch to RL only when the model can investigate competently end-to-end.
6. **Cribl pipeline introspection is feature-flagged.** Tool available on Cribl backends, no-op on Splunk. Scenario authors gate pipeline-fault scenarios on this tool being live.
7. **The human's interface is the markdown.** Once a loop is running, edits to its `program.md` are how you steer it. Edits to the harness or the agents themselves are exceptional and require a re-run of the calibration checks.

---

## Phase 0 — Substrate (human-written, ~1 week)

**Goal**: a small, ugly, working harness that an autonomous loop can stand on. Nothing here is autoresearch-flavored yet — this is the ground floor.

### Deliverables

- **The seven tools**, implemented in Go against logsim's data: `search`, `stats`, `timechart`, `top`, `drill`, `correlate`, `list_sources`/`describe_source`. All take and return IR. Eighth tool `pipeline_inspect` stubbed and feature-flagged.
- **IR types** (`internal/agent/ir/`): `Query`, `Filter` AST, `TimeRange` (absolute UTC), `Agg`, `Sort`.
- **Compilers** (`internal/agent/compile/`): `spl.go` first, `cribl.go` second. ES|QL deferred. A tiny `executor.go` runs compiled queries against a logsim run.
- **Scenario schema extension**: `ground_truth` block parser + validator. Update `logsim validate` to enforce it.
- **Loop harness** (`cmd/loops/`): a binary that takes a program.md path + concrete inputs, calls an LLM with the appropriate tool surface, validates the output against schema, runs the program-specific checks, and commits to git if everything passes. Logs failures to `tmp/<program>/failures.log`.
- **Calibration set scaffolding**: `calibration/` directory with empty placeholder files. Populated as you hand-grade the first ~30 trajectories.

### Done when

- One end-to-end run works: `cmd/loops/loops --program programs/scenario_author.md` authors a scenario, runs the investigator on it, runs the grader, and commits all three artifacts to git if the grader scores ≥ 0.7.
- The same end-to-end run succeeds against both Splunk SPL and Cribl Search compiler outputs (use the same scenario, just different backend).
- `git log` shows the commit was made by the harness, not by you.

This is the only phase that's allowed to be slow. After this, the loops do the work.

---

## Loop 1 — Scenario library

**Driven by**: [programs/scenario_author.md](programs/scenario_author.md)

**Produces**: `scenarios/*.yaml` with `ground_truth` blocks, covering the failure taxonomy.

### Failure taxonomy (the cells the loop fills)

- **Config drift** — bad config push, wrong feature flag, env var typo.
- **Resource exhaustion** — OOM, disk full, FD limit, connection pool.
- **Deploy regression** — bad release, dep upgrade, schema migration.
- **Auth/identity** — cert expiry, token rotation failure, IAM policy change.
- **Network** — DNS, MTU, routing, NAT, partial partition.
- **Data corruption** — bad row, schema mismatch, encoding drift.
- **Security incidents** — credential stuffing, lateral movement, data exfil, supply chain compromise. Often involve active deception.

### Loop mechanics

The harness picks an under-represented taxonomy cell, invokes the scenario author, runs the program-defined checks (logsim validate, signal verification, solvability via the investigator, diversity linter), and commits if all pass. Failures are logged but not retried within the same invocation — the next iteration sees the failure log and adjusts.

### Done when

- ~50 scenarios across the taxonomy, balanced cell counts.
- All scenarios pass the diversity linter.
- All are solvable end-to-end with the v1 toolset.

### How you steer this loop

Edit `programs/scenario_author.md` when you notice quality drift — e.g., scenarios are getting too easy, or all of them route through the same topology, or the triggering events are too obvious. Each markdown edit is a hypothesis about what improves the loop.

---

## Loop 2 — SFT trace corpus

**Driven by**: [programs/investigator.md](programs/investigator.md) + [programs/grader.md](programs/grader.md)

**Produces**: `data/sft/*.jsonl` — investigation trajectories with grades, filtered for SFT inclusion.

### Loop mechanics

Trivially parallel. For each scenario, run the investigator at varied temperatures (3–10 rollouts per scenario × backend), grade each trajectory, append trajectories scoring ≥ 0.7 to the corpus. Cache by `(scenario_id, trajectory_hash)` to avoid duplicates.

Initially fused with Loop 1 (one scenario in → one scenario + one graded trajectory out, all in a single overnight run). Once the scenario library is stable, decouple — Loop 1 runs less often, Loop 2 runs continuously to grow the corpus.

### Done when

- ≥5k filtered traces, distribution roughly balanced across taxonomy cells.
- Spot-check 50 random traces by hand: tool use is sensible, RCA is correct, no teacher-model artifacts.

### How you steer this loop

Two markdown files steer it. Investigator quality issues (skipping `list_sources`, unbounded queries, fabricated citations) → edit `programs/investigator.md`. Grader quality issues (rewarding the wrong thing, inconsistency) → see Loop 3.

---

## Loop 3 — Calibrated grader

**Driven by**: [programs/grader.md](programs/grader.md), governed by `calibration/` (human-graded reference set).

**Produces**: a grader prompt with proven, stable agreement with human judgment.

This is the **load-bearing loop**. If the grader is wrong, every other loop reinforces wrong things. Karpathy's autoresearch has a clean external metric (eval loss); this project's metrics are themselves agent-graded, which means grader calibration is non-negotiable.

### Loop mechanics

- Maintain ~30 trajectories in `calibration/` with human-assigned aggregate scores.
- Any commit to `programs/grader.md` triggers the harness to re-run the grader on the calibration set.
- The commit is rejected if mean absolute error against human scores increases.
- Re-grade the calibration set against any agent that produced its trajectories — if MAE drifts over time without grader changes, that's a signal of judge-policy correlation; investigate.

### Hand-grading is the human's recurring chore

You will hand-grade ~30 trajectories at the start. You'll add ~5 more whenever you spot a failure mode the calibration set doesn't cover. Budget ~1 hour/week for this. **There is no automating this away** — it's the trust anchor for everything else.

### Done when

- Grader↔human MAE on the calibration set < 0.1 (out of 1.0 aggregate).
- MAE is stable across re-runs (≤0.02 standard deviation across 5 grader invocations on the same trajectory).
- Mixing model families (investigator from one provider, grader from another) does not change MAE meaningfully.

---

## Loop 4 — Toolset / IR evolution (gated)

**Driven by**: `programs/toolset_tuner.md` *(to be authored)*

**Produces**: changes to the IR, tool surface, or compilers.

### Loop mechanics (and why it's gated)

Watches Loop 2 failures. Proposes IR ops that, if they existed, would unblock failures. Implements the op, re-runs failed scenarios, commits if multiple now succeed.

**This loop runs only between training rounds**, never during corpus generation or RL. Toolset drift invalidates earlier traces — adding a tool means the SFT corpus has trajectories where the model "didn't know" the tool existed, polluting training. New tools require a corpus version bump.

### Done when

Triggered by need, not by schedule. A model trained on corpus v1 plateaus → run loop 4 → corpus v2 → train v2.

---

## Loop 5 — Trained model

**Driven by**: `programs/trainer.md` *(to be authored)*

**Produces**: SFT and RL checkpoints.

### Loop mechanics

The pure autoresearch loop, exact Karpathy shape. Agent edits the training script (`training/train.py`), runs SFT or RL on a small budget, evaluates against held-out scenarios, commits training-script changes that improve eval.

### Phases within this loop

- **SFT v1**: train on Loop 2's corpus. Baseline.
- **Reward function for RL**: the rubric scores from `programs/grader.md` become the reward components, with efficiency weighted to discourage runaway investigations.
- **RL** (GRPO default; offline DPO from preference pairs as a cheap bootstrap; PPO fallback). Curriculum from single-cause to multi-cause to security incidents.

### Done when

- Within-distribution RCA accuracy on held-out scenarios beats the base model meaningfully.
- Out-of-distribution RCA accuracy (one full taxonomy cell held out) beats the base model.
- Tool-call format validity > 99%.
- Manual review of 50 trajectories: investigations *feel* better — fewer wasted queries, better hypothesis ordering, evidence cited.

---

## Loop 6 — Flywheel (continuous)

**Produces**: the next round of training data, biased toward where the current model fails.

- **Adversarial scenario mining**: run the current model on a large pool of scenarios; weight failures higher in Loop 1's next batch.
- **Real-incident transfer eval**: a small set of anonymized real incident logs with known RCAs. **Never train on this.** Held-out only. If sim-to-real gap is large, this is where you'll see it.
- **Cribl native fluency adapter** (optional, when there's customer demand): SFT a thin adapter that emits raw Cribl Search syntax instead of IR.

---

## Risks and mitigations

- **Sim-to-real gap.** A model that crushes synthetic logs may have learned the simulator's quirks. *Mitigations*: format jitter, deliberate noise injection, the Loop 6 real-incident eval, periodic human review.
- **Reward hacking.** The model finds a way to score well without investigating. *Mitigations*: judge prompt versioning, calibration set, manual trajectory review at each phase boundary, mixing model families between investigator and grader.
- **Garbage-in-at-scale.** A blind spot in the scenario author becomes 10k scenarios with the same blind spot. *Mitigations*: diversity linter, sample-review committed artifacts daily.
- **Grader drift.** Changing the judge prompt invalidates earlier reward scores. *Mitigations*: calibration set rejects regressions; if grader changes are accepted, re-grade the corpus before resuming Loop 5.
- **Toolset drift mid-training.** Adding tools invalidates earlier traces. *Mitigations*: Loop 4 is gated to between-training only; corpus version bump on tool changes.
- **Overnight runaway cost.** Karpathy's loop is single-GPU; this one calls hosted LLMs and can rack up bills overnight. *Mitigations*: per-loop daily budget caps in the harness, cost dashboards, model-family mix to keep judge cost cheap.

---

## Open questions

These are real decisions, not rhetorical. Each should be resolved before the loop that depends on it.

- **Base model for SFT.** Open-weight 7B for fast iteration vs 70B for ceiling. Decision needed before Loop 5 starts.
- **RL algorithm.** GRPO vs PPO vs offline DPO. Decision needed before Loop 5 RL phase. Run offline DPO first — it's cheap and informative.
- **Tool result format.** How is `search` output sampled and summarized? Returning 100 events vs 10 changes trace length distribution dramatically. Locked in Phase 0 — changes invalidate corpus.
- **Cribl `pipeline_inspect` in v1.** Including it adds a class of scenarios but breaks Splunk-only deployments unless the scenario author is aware. Recommend including it but feature-flagged from day one.
- **Multi-turn / human-in-the-loop investigation.** Real investigations involve asking colleagues. Defer to Loop 6 — start single-agent.
- **Remediation actions.** Out of scope (investigation only), but the IR will eventually need write-side primitives. Don't design them in now; don't paint into a corner either.
