'use client'
import type { FlowNode, FlowEdge } from '@/store/useScenarioStore'
import type { ScenarioMetadata } from '@/types/scenario'
import type { Episode } from '@/types/episode'
import type { AIProviderConfig } from '@/types/aiKeys'
import { canvasToScenarioYaml } from '@/lib/canvasToScenarioYaml'
import { complete } from '@/lib/aiClient'

export interface GenerateGroundTruthOptions {
  episode?: Episode
  /** Default 1000. */
  tickIntervalMs?: number
  signal?: AbortSignal
}

const SYSTEM_PROMPT = `You compile a LogSim scenario YAML into a "ground truth" summary used for SFT and RL on incident-investigation agents.

The agent under evaluation only sees the **logs** the scenario emits. It produces a TIMELINE of what it inferred happened, plus a CONCLUSION naming the root cause. Your output is the target the agent is graded against — so it must be written in the same shape and the same language an investigator would use after reading logs, NOT in language that exposes the simulator's internal state machine or the YAML's structure.

Output exactly these three blocks, in order, plain text only — no Markdown bold, no fenced code blocks, no JSON, no divider lines.

SCENARIO: <name>
Architecture (context, not scored): <one short line listing the major components and how they connect, e.g. "1 VPC; Nginx edge-lb fronts 3 Go APIs which read MySQL and a Redis rate-limiter cache.">

TIMELINE
- <mm:ss>  <one short clause describing an observable event, in the language a human reading logs would use>
- <mm:ss>  <next event>
...

CONCLUSION
Root cause: <one short sentence naming the failing component and the failure mode>.
Mitigation: <what stopped or contained the incident, with timestamp>.
Recovery: <when full health was restored>.

═══════════════════════════════════════════════════════════════════════════

RULES

1. The YAML is the sole source of truth. Do not invent events, services, or causes that aren't in it.
2. Convert ticks to mm:ss using the supplied tick_interval_ms (default 1000). Use h:mm:ss only when totals exceed an hour. Pad to two digits (03:00, not 3:00).
3. The TIMELINE must read like an investigator's notes, not a state-machine dump. Translate simulator-internal terms into observable symptoms:
     - "under_attack" with elevated error_rate → "5xx rate spikes to ~X%" or "request volume jumps; error rate climbs"
     - "degraded"      → "latency climbs / error rate ~X%" / "p95 latency up ~Yx"
     - "down"          → "service unresponsive; ~85% of requests fail"
     - "throttled"     → "rate limiter engaged; 429 responses appear" / "requests drop and 429s appear"
     - "recovering"    → "errors drop but latency still elevated"
     - "compromised"   → "anomalous activity / suspicious egress / lateral movement"
     - "healthy" returning at the end → "service back to baseline"
   Always include concrete numbers when the YAML provides them (error rate %, latency multiplier, throttle).
4. One TIMELINE bullet per **state transition** that matters. Do NOT list every block of every service — collapse "all three APIs degraded together" into one line. Skip the implicit baseline-healthy block at tick 0 (the agent already knows the starting state). Aim for 6-12 bullets total for a typical 10-30 minute scenario.
5. Reference services by their YAML name, lowercase verbatim (edge-lb, user-db). Never use simulator state names ("under_attack", "throttled") as nouns or adjectives in the prose; describe what those states look like in logs instead.
6. Do NOT emit infrastructure dumps, service config tables, endpoint lists, connection lists, multipliers, log_vol_mul, or any YAML field by name. The agent never produced these from logs and they are noise in the diff.
7. CONCLUSION:
   - "Root cause" must name the first/initiating failure (the thing the attack/load/bug hit), not its downstream effects.
   - "Mitigation" is the action that contained the incident (rate limit engaged, rollback deployed, replica failover, restart). If none, say "none — the system did not self-heal".
   - "Recovery" is the timestamp when the affected services returned to healthy. If they never did within the duration, say "incomplete by end of scenario".
8. If the YAML has no timeline / no state changes, output:
     TIMELINE
     - (no incidents — steady-state baseline for the full duration)
     CONCLUSION
     Root cause: none — this scenario depicts a steady-state baseline with no incident.
     Mitigation: n/a.
     Recovery: n/a.
9. Keep numeric formatting tidy: integers when whole; up to 2 decimal places otherwise (write 25% not 0.25; write 4× not latency_mul=4).
10. Output plain text only. No prose intro, no commentary outside the three blocks above.`

function buildUserPrompt(yamlText: string, tickIntervalMs: number): string {
  return `Compile the following LogSim scenario YAML into the ground-truth summary.

tick_interval_ms: ${tickIntervalMs}

scenario.yaml:
${yamlText}`
}

/**
 * Build the scenario YAML the model will consume. Exposed so the modal can
 * show the same YAML it sends to the LLM (one source of truth on screen).
 */
export function buildScenarioYamlForGroundTruth(
  flowNodes: FlowNode[],
  flowEdges: FlowEdge[],
  metadata: ScenarioMetadata,
  options: GenerateGroundTruthOptions = {},
): string {
  return canvasToScenarioYaml(flowNodes, flowEdges, metadata, {
    episode: options.episode,
    tickIntervalMs: options.tickIntervalMs ?? 1000,
  })
}

export async function generateScenarioGroundTruth(
  config: AIProviderConfig,
  flowNodes: FlowNode[],
  flowEdges: FlowEdge[],
  metadata: ScenarioMetadata,
  options: GenerateGroundTruthOptions = {},
): Promise<string> {
  const tickIntervalMs = options.tickIntervalMs ?? 1000
  const yamlText = buildScenarioYamlForGroundTruth(flowNodes, flowEdges, metadata, options)
  const completion = await complete(config, {
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildUserPrompt(yamlText, tickIntervalMs) },
    ],
    maxTokens: 4096,
    signal: options.signal,
  })
  const text = (completion.text ?? '').trim()
  return text ? text + '\n' : ''
}
