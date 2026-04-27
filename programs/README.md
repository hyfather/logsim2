# programs/ — agent instructions, autoresearch-style

This directory holds the markdown files that drive the autonomous loops described in [TRAINING_PLAN.md](../TRAINING_PLAN.md). Each file is a self-contained instruction set for one job (author scenarios, investigate, grade, etc.).

The pattern, borrowed from [Karpathy's autoresearch](https://github.com/karpathy/autoresearch): humans edit the markdown, agents edit the code and produce artifacts. The harness wires them together and commits successful results to git.

## Files

- **scenario_author.md** — authors new scenarios for under-represented taxonomy cells.
- **investigator.md** — investigates a scenario using the seven tools, emits a structured RCA.
- **grader.md** — scores an investigation against the scenario's ground truth.
- **toolset_tuner.md** — *(later)* watches investigation failures, proposes IR/tool additions.
- **trainer.md** — *(later)* runs SFT/RL experiments, commits training-script changes that improve eval.

## How they get run

The harness (Go binary, see `cmd/loops/`) reads a program file, fills in concrete inputs, calls an LLM with tool access, validates the output against schema, and commits to git if the output passes checks.

Failures are logged but not committed — the human reads the failure log, edits the markdown, runs again. **Editing the markdown is the only knob.** Resist the urge to edit the harness or the agents directly.

## Editing rules

- Be specific. Vague instructions produce vague work at scale.
- Constrain the output format precisely. Free-form output can't be programmatically validated.
- State the failure cases explicitly ("if you can't find a triggering event, do not commit a guess — fail loudly").
- Version your edits via git commits with clear messages. Each commit to a program.md is a hypothesis about what improves the loop.
