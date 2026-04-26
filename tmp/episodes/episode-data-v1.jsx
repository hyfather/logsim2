/* global React */
// Episode data — segments, events, anomalies, seeded narratives

const EPISODE_LIBRARY = [
  {
    id: 'ddos-mitigation',
    name: 'DDoS → Mitigation',
    domain: 'observability',
    duration: 1200, // ticks
    description: 'Normal traffic, then a volumetric DDoS, then WAF rules deployed.',
    services: [
      { id: 'lb-1',     kind: 'nginx',   label: 'lb-1',     address: '10.0.0.10',     channel: 'tcp:443',  x: 80,  y: 80,  width: 200 },
      { id: 'api-1',    kind: 'nodejs',  label: 'api-1',    address: '10.183.164.21', channel: 'tcp:8080', x: 320, y: 80,  width: 200 },
      { id: 'api-2',    kind: 'nodejs',  label: 'api-2',    address: '10.183.164.22', channel: 'tcp:8080', x: 320, y: 200, width: 200 },
      { id: 'cache-1',  kind: 'redis',   label: 'cache-1',  address: '10.133.78.11',  channel: 'tcp:6379', x: 560, y: 80,  width: 200 },
      { id: 'db-1',     kind: 'postgres',label: 'db-1',     address: '10.133.78.20',  channel: 'tcp:5432', x: 560, y: 200, width: 200 },
    ],
    edges: [
      { id: 'e1', from: 'lb-1', to: 'api-1', label: 'TCP:8080' },
      { id: 'e2', from: 'lb-1', to: 'api-2', label: 'TCP:8080' },
      { id: 'e3', from: 'api-1', to: 'cache-1', label: 'TCP:6379' },
      { id: 'e4', from: 'api-1', to: 'db-1', label: 'TCP:5432' },
      { id: 'e5', from: 'api-2', to: 'db-1', label: 'TCP:5432' },
    ],
    segments: [
      { id: 's1', name: 'Baseline',         start: 0,   duration: 300, color: '#86efac', narrative: 'Normal traffic, ~120 RPS, healthy responses.' },
      { id: 's2', name: 'Recon scan',       start: 300, duration: 120, color: '#fcd34d', narrative: 'Slow port scans hit the LB from a small set of IPs.' },
      { id: 's3', name: 'DDoS escalates',   start: 420, duration: 300, color: '#fca5a5', narrative: 'Traffic 40× normal. api-1 starts dropping connections.' },
      { id: 's4', name: 'api-1 fails',      start: 720, duration: 180, color: '#dc2626', narrative: 'api-1 returns 5xx. Cache hit ratio collapses.' },
      { id: 's5', name: 'WAF deployed',     start: 900, duration: 180, color: '#93c5fd', narrative: 'Rate-limit + IP block applied at edge. Traffic settles.' },
      { id: 's6', name: 'Recovery',         start: 1080, duration: 120, color: '#86efac', narrative: 'Latencies return to baseline. api-1 healthy.' },
    ],
    events: [
      { tick: 300,  label: 'Recon detected',     icon: '🔍', severity: 'warn' },
      { tick: 420,  label: 'DDoS START',         icon: '⚡', severity: 'crit' },
      { tick: 720,  label: 'api-1 503',          icon: '✕',  severity: 'crit' },
      { tick: 900,  label: 'WAF rule applied',   icon: '🛡', severity: 'info' },
      { tick: 1080, label: 'Recovery',           icon: '✓',  severity: 'good' },
    ],
    anomalies: [ // intervals where log volume / errors spike
      { start: 300, end: 420, level: 0.35 },
      { start: 420, end: 720, level: 0.8 },
      { start: 720, end: 900, level: 1.0 },
      { start: 900, end: 1080, level: 0.4 },
    ],
  },
  {
    id: 'ioc-investigation',
    name: 'IOC Investigation',
    domain: 'security',
    duration: 1500,
    description: 'Suspicious DNS queries lead to a compromised host and lateral movement.',
    services: [
      { id: 'edr-1',   kind: 'custom',   label: 'edr-1',   address: '10.0.0.5',     channel: 'tcp:8443', x: 60,  y: 60,  width: 200 },
      { id: 'workstation-7', kind: 'virtual_server', label: 'ws-7', address: '10.50.10.7', channel: 'tcp:445', x: 320, y: 60,  width: 200 },
      { id: 'fileserver-1', kind: 'virtual_server', label: 'fs-1', address: '10.50.20.4', channel: 'tcp:445', x: 320, y: 200, width: 200 },
      { id: 'dc-1',    kind: 'virtual_server', label: 'dc-1',  address: '10.50.1.2',  channel: 'tcp:88',   x: 580, y: 130, width: 200 },
    ],
    edges: [
      { id: 'e1', from: 'workstation-7', to: 'fileserver-1', label: 'SMB:445' },
      { id: 'e2', from: 'workstation-7', to: 'dc-1',         label: 'KRB:88' },
      { id: 'e3', from: 'edr-1',         to: 'workstation-7', label: 'TLS:8443' },
    ],
    segments: [
      { id: 's1', name: 'Baseline',           start: 0,    duration: 400, color: '#86efac', narrative: 'Quiet office traffic. Normal Kerberos + SMB chatter.' },
      { id: 's2', name: 'Phishing click',     start: 400,  duration: 100, color: '#fcd34d', narrative: 'ws-7 user opens malicious doc. C2 beacon to 185.220.x.x.' },
      { id: 's3', name: 'Persistence',        start: 500,  duration: 200, color: '#fca5a5', narrative: 'Scheduled task created. Process injection observed.' },
      { id: 's4', name: 'Lateral movement',   start: 700,  duration: 300, color: '#dc2626', narrative: 'PsExec from ws-7 → fs-1. Cred dumping on dc-1.' },
      { id: 's5', name: 'Containment',        start: 1000, duration: 200, color: '#93c5fd', narrative: 'EDR isolates ws-7. Affected creds rotated.' },
      { id: 's6', name: 'Forensics',          start: 1200, duration: 300, color: '#a5b4fc', narrative: 'Disk image taken. Timeline reconstructed.' },
    ],
    events: [
      { tick: 400,  label: 'IOC: C2 beacon',     icon: '⚑', severity: 'warn' },
      { tick: 500,  label: 'Persistence',        icon: '⚓', severity: 'crit' },
      { tick: 700,  label: 'Lateral PsExec',     icon: '↪', severity: 'crit' },
      { tick: 850,  label: 'Cred dump',          icon: '🔑', severity: 'crit' },
      { tick: 1000, label: 'Host isolated',      icon: '🛡', severity: 'info' },
      { tick: 1200, label: 'Forensics begin',    icon: '🔬', severity: 'info' },
    ],
    anomalies: [
      { start: 400, end: 500, level: 0.3 },
      { start: 500, end: 700, level: 0.5 },
      { start: 700, end: 1000, level: 0.95 },
      { start: 1000, end: 1200, level: 0.4 },
    ],
  },
];

// Generate a log line shaped by anomaly level + segment narrative
function logIntensity(episode, tick) {
  const a = episode.anomalies.find(a => tick >= a.start && tick < a.end);
  return a ? a.level : 0.05;
}

function eventNear(episode, tick, window = 8) {
  return episode.events.find(e => Math.abs(e.tick - tick) <= window);
}

function segmentAt(episode, tick) {
  return episode.segments.find(s => tick >= s.start && tick < s.start + s.duration) || episode.segments[0];
}

// Generate logs for a tick range based on anomaly/segment context
function generateLogsForRange(episode, fromTick, toTick, density = 12) {
  const out = [];
  for (let t = fromTick; t < toTick; t++) {
    const intensity = logIntensity(episode, t);
    const count = Math.max(1, Math.round(density * (0.3 + intensity * 1.5)));
    for (let i = 0; i < count; i++) {
      const node = window.pick(episode.services);
      let entry;
      // boost error rate during high-intensity zones
      const errBoost = intensity * 0.5;
      const r = Math.random();
      let bucket;
      if (r < 0.7 - errBoost * 0.4) bucket = 'INFO';
      else if (r < 0.92 - errBoost * 0.2) bucket = 'WARN';
      else bucket = 'ERROR';
      const tpls = (window.LOG_TEMPLATES && window.LOG_TEMPLATES[node.kind]) || [{ lvl: 'INFO', tpl: 'event seq={cid}' }];
      const matches = tpls.filter(x => x.lvl === bucket);
      const tpl = (matches.length ? window.pick(matches) : window.pick(tpls));
      entry = {
        tick: t,
        ts: new Date(Date.now() - (toTick - t) * 200),
        source: node.id,
        kind: node.kind,
        lvl: tpl.lvl,
        msg: window.fillTemplate(tpl.tpl),
      };
      out.push(entry);
    }
  }
  return out;
}

Object.assign(window, { EPISODE_LIBRARY, logIntensity, eventNear, segmentAt, generateLogsForRange });

// Also expose LOG_TEMPLATES from data.jsx if not already
if (!window.LOG_TEMPLATES) {
  // The data.jsx file has LOG_TEMPLATES local; we'll lift it via duck-typed access
  // (data.jsx exports nextLogLine which uses LOG_TEMPLATES internally — fine for our purposes)
}
