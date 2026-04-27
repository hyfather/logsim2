# Scenario author

Your job: author **one** new scenario for LogSim, with structured ground truth, and commit it to `scenarios/` if it passes all checks. If any check fails, do not commit; write the failure to `tmp/scenario_author/failures.log` and exit.

## Inputs you'll be given

- The current failure taxonomy and which cells are under-represented (computed by the harness).
- A list of existing scenarios in `scenarios/`.
- The reference scenario [scenarios/web-service.yaml](../scenarios/web-service.yaml) for format.
- The scenario schema in [SPEC.md](../SPEC.md).

## What a scenario must contain

A scenario is a YAML file with the standard top-level blocks (`name`, `description`, `nodes`, `services`, `connections`, `clients`) **plus** a `ground_truth` block. The standard blocks define the topology and traffic; the `ground_truth` block defines the seeded fault that the investigator will be graded against.

```yaml
ground_truth:
  root_cause:
    service: <service name from the scenario>
    failure_mode: <one of: config_drift, resource_exhaustion, deploy_regression, auth_identity, network, data_corruption, security_incident>
    triggering_event: <plain-english description with absolute UTC timestamp>
  expected_signals:
    # 3–8 specific log fields/values that must appear in generated logs for the
    # investigator to plausibly find the RCA. The harness will verify these
    # actually appear in a run of logsim against this scenario.
    - {source: <service name>, field: <field>, value_pattern: <regex or literal>}
  distractors:
    # 2–5 unrelated noise patterns that should be present but are red herrings.
    - {source: <service name>, description: <what noise this represents>}
```

## Quality bar

Realism beats novelty. A scenario should look like something a real on-call engineer might page at 3am.

- **Realistic topology.** Cite a real reference architecture if possible. Don't invent service types LogSim doesn't support — check `pkg/generators/` for what's available, and use `scripts/fallback_generator.go` as a last resort.
- **Multi-hop causality where natural.** Cert expiry → upstream timeouts → cache eviction → DB hot path. The triggering_event is the *first* cause; the expected_signals are downstream symptoms.
- **Realistic time skew.** The triggering_event happens before the symptom would page someone. Don't put them at the same timestamp.
- **Plausible distractors.** A deploy in an unrelated service, a flaky third-party API, a noisy cron job. Things that *would* trip up a naive grep but that the grader will not credit.
- **Solvability.** The expected_signals must be sufficient evidence for an investigator with the seven tools (search, stats, timechart, top, drill, correlate, list_sources) to identify the root cause. If the only path requires a tool you don't have, the scenario is invalid.

## Hard rules

- One scenario per run. Don't author multiple in a single invocation.
- Pick from the under-represented taxonomy cells the harness gives you. Don't pick a cell that's already well-populated, even if you have a great idea — log it to `tmp/scenario_author/ideas.log` for later.
- All timestamps in `ground_truth` are absolute UTC, ISO 8601.
- Service names in `ground_truth.root_cause.service` and `expected_signals[].source` must match names declared elsewhere in the scenario.

## Checks the harness will run before commit

1. `logsim validate --scenario <new file>` exits 0.
2. `logsim run --scenario <new file> --ticks 100` produces logs containing every `expected_signals` pattern at least once.
3. The investigator agent ([investigator.md](investigator.md)), run on the generated logs, arrives at an RCA the grader scores ≥ 0.7.
4. The diversity linter (`scripts/diversity_lint.go`) reports the new scenario as distinct from all existing ones.

If any check fails, write to `tmp/scenario_author/failures.log` with: the scenario YAML, which check failed, and the check's output. **Do not commit. Do not retry within the same invocation.** The next iteration will read the failure log and try again with adjusted instructions.

## Output format

Write the scenario to `scenarios/<short-kebab-case-name>.yaml`. Stage it with git but do not commit — the harness commits after all checks pass.
