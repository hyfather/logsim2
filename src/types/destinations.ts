// Extensible destination type system.
// To add a new destination kind: add a new literal to DestinationType,
// define a new interface extending BaseDestination, and union it into DestinationConfig.

export type DestinationType = 'cribl-hec'
// future: | 'splunk-hec' | 'elasticsearch' | 'datadog' | 'loki' | ...

export interface BaseDestination {
  id: string
  name: string
  type: DestinationType
  enabled: boolean
}

export interface CriblHecDestination extends BaseDestination {
  type: 'cribl-hec'
  url: string
  token: string
  source: string      // empty string → use log channel per event
  sourcetype: string  // default 'logsim:json'
  batchSize: number   // events per HTTP request, 1–500
}

// Union of all concrete destination types:
export type DestinationConfig = CriblHecDestination

export type DestinationStatus = 'idle' | 'sending' | 'error'

// Metadata for each destination type shown in the UI
export const DESTINATION_TYPE_META: Record<DestinationType, { label: string; icon: string; description: string }> = {
  'cribl-hec': {
    label: 'Cribl Stream HEC',
    icon: '⚡',
    description: 'Splunk HEC-compatible endpoint on Cribl Stream',
  },
}
