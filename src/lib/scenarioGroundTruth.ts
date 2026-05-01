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

const SYSTEM_PROMPT = `You compile a LogSim scenario YAML into a "ground truth" plain-text summary used as the supervised target for SFT and the reward target for RL on incident-investigation agents.

Your output IS the ground truth. An RL agent receives the scenario logs and must reach this summary — most importantly, the ROOT CAUSE section. Be precise, deterministic, and concise. Do not invent details that aren't in the YAML.

Output the following sections in this exact order, with the exact headers shown. Use plain text only — no Markdown bold, no fenced code blocks, no JSON.

═══════════════════════════════════════════════════════════════════════════
SCENARIO: <name>
Description: <one short line describing the architecture>
Duration: <N> ticks (<wall-clock>) at <tick_interval_ms>ms/tick

================================================================
INFRASTRUCTURE
================================================================
Counts: <N VPCs, M subnets, K virtual servers, S services>.

VPCs:
  - <name> (provider, region, cidr)

Subnets:
  - <name> (in <vpc>, cidr, public/private)

Virtual servers:
  - <name> (in <subnet>, instance_type, os, ip)

================================================================
SERVICES
================================================================
<for each service, in alphabetical order by name:>
<name> (<friendly type label, e.g. Node.js / PostgreSQL / Redis>)
  Host: <virtual server name or "-">
  Port: <port>
  <one line summarising key generator config — log format/level for app servers, slow query threshold for databases, eviction policy for caches, etc.>
  <if endpoints exist, list them as "- METHOD path (avg <ms>ms, error_rate=<x>)">

================================================================
CONNECTIONS
================================================================
  - <source> -> <target> (<protocol>:<port>)
<sorted alphabetically by source then target>

================================================================
TIMELINE
================================================================
Narrative beats:
  [tick <N>, <mm:ss>] <text>

Service behavior:

<for each service that has timeline blocks, in alphabetical order by service name:>
<name>:
  [tick <start>..<end> (<mm:ss>..<mm:ss>)] <state> — error_rate=X, latency_mul=Y, log_vol_mul=Z
      note: <note text if present>

================================================================
ROOT CAUSE
================================================================
<This section is the salient takeaway — what an investigator must conclude. It is the single most important section for RL.>

Primary cause: <one short sentence naming the failing component and the failure mode, e.g. "session-cache (Redis) ran out of memory and was OOM-killed at tick 240 (04:00)">.

Trigger: <what initiated the failure — a deploy, a traffic spike, an upstream outage, a config change, an attack — referenced by the relevant tick if known>.

Propagation: <how the failure spread through the topology — name the affected services in the order they degraded, with tick references>.

Symptoms an investigator would see in logs:
  - <symptom 1, e.g. "Redis: out-of-memory errors and connection refused around tick 240">
  - <symptom 2, e.g. "user-db: slow query log exceeds threshold from tick 300">
  - <symptom 3, e.g. "api-1/api-2: HTTP 5xx rate climbs to ~85% from tick 360">
  Aim for 3-6 specific symptoms tied to ticks and services.

Resolution: <one sentence on how/when the system recovered, e.g. "Redis restarted at tick 660; cache warmed by tick 780; APIs healthy by tick 900">.

═══════════════════════════════════════════════════════════════════════════

RULES

1. Use the YAML as the sole source of truth. Do not invent infrastructure, services, or events that aren't in it.
2. Convert ticks to mm:ss using the supplied tick_interval_ms (default 1000). For totals over an hour, use h:mm:ss.
3. Sort all lists alphabetically by name unless the YAML imposes a different order (timeline blocks sort by start tick).
4. The root cause MUST be derived from the timeline + states + narrative beats, not generic platitudes. If a service goes "down" with note "OOM kill", that's the root cause. If a service is "under_attack", say so.
5. If the YAML has no timeline / no behavior changes, the ROOT CAUSE section should say: "Primary cause: none — this scenario depicts a steady-state baseline with no incident."
6. Keep service/host/connection names verbatim from the YAML.
7. Keep numeric formatting tidy: integers when whole; up to 4 decimals otherwise.
8. Output plain text only. No prose intro, no markdown fences, no commentary outside the sections above.`

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
