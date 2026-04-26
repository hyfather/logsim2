/* global React */
// Episode v2 — per-service lanes with behavior blocks + narrative markers
// State model:
//   episode = {
//     id, name, domain, duration,
//     services: [{ id, kind, label, address, channel, x, y, width }],
//     edges: [{ id, from, to, label }],
//     lanes: { [serviceId]: [{ id, start, duration, state, errorRate, latencyMul, logVolMul, customLog?, note? }] },
//     narrative: [{ id, tick, text }],
//   }

// ---------- Behavior states ----------
const BEHAVIOR_STATES = {
  healthy:      { label: 'Healthy',       color: '#86efac', text: '#166534', bg: '#f0fdf4', glyph: '●' },
  degraded:     { label: 'Degraded',      color: '#fcd34d', text: '#854d0e', bg: '#fffbeb', glyph: '◐' },
  down:         { label: 'Down',          color: '#dc2626', text: '#991b1b', bg: '#fef2f2', glyph: '✕' },
  recovering:   { label: 'Recovering',    color: '#93c5fd', text: '#1e40af', bg: '#eff6ff', glyph: '↻' },
  under_attack: { label: 'Under attack',  color: '#fb923c', text: '#9a3412', bg: '#fff7ed', glyph: '⚡' },
  throttled:    { label: 'Throttled',     color: '#a78bfa', text: '#5b21b6', bg: '#f5f3ff', glyph: '▤' },
  compromised:  { label: 'Compromised',   color: '#be185d', text: '#831843', bg: '#fdf2f8', glyph: '⚑' },
};

// ---------- Helper: make a default block ----------
function makeBlock(state, start, duration, opts = {}) {
  const defaults = {
    healthy:      { errorRate: 0.005, latencyMul: 1.0, logVolMul: 1.0 },
    degraded:     { errorRate: 0.05,  latencyMul: 2.0, logVolMul: 1.4 },
    down:         { errorRate: 0.85,  latencyMul: 6.0, logVolMul: 0.5 },
    recovering:   { errorRate: 0.02,  latencyMul: 1.4, logVolMul: 1.2 },
    under_attack: { errorRate: 0.25,  latencyMul: 3.0, logVolMul: 4.0 },
    throttled:    { errorRate: 0.10,  latencyMul: 2.5, logVolMul: 0.7 },
    compromised:  { errorRate: 0.02,  latencyMul: 1.0, logVolMul: 1.5, customLog: 'unusual outbound connection 185.220.x.x:443' },
  };
  return {
    id: `b-${Math.random().toString(36).slice(2, 8)}`,
    start, duration, state,
    ...defaults[state],
    ...opts,
  };
}

// ---------- Seeded episodes ----------
const EPISODE_LIBRARY = [
  {
    id: 'ddos-mitigation',
    name: 'DDoS → Mitigation',
    domain: 'observability',
    duration: 1200,
    description: 'Volumetric DDoS hits the load balancer, api-1 fails, WAF rules deployed.',
    services: [
      { id: 'lb-1',     kind: 'nginx',    label: 'lb-1',     address: '10.0.0.10',     channel: 'tcp:443',  x: 80,  y: 80,  width: 200 },
      { id: 'api-1',    kind: 'nodejs',   label: 'api-1',    address: '10.183.164.21', channel: 'tcp:8080', x: 320, y: 80,  width: 200 },
      { id: 'api-2',    kind: 'nodejs',   label: 'api-2',    address: '10.183.164.22', channel: 'tcp:8080', x: 320, y: 200, width: 200 },
      { id: 'cache-1',  kind: 'redis',    label: 'cache-1',  address: '10.133.78.11',  channel: 'tcp:6379', x: 560, y: 80,  width: 200 },
      { id: 'db-1',     kind: 'postgres', label: 'db-1',     address: '10.133.78.20',  channel: 'tcp:5432', x: 560, y: 200, width: 200 },
    ],
    edges: [
      { id: 'e1', from: 'lb-1',  to: 'api-1',   label: 'TCP:8080' },
      { id: 'e2', from: 'lb-1',  to: 'api-2',   label: 'TCP:8080' },
      { id: 'e3', from: 'api-1', to: 'cache-1', label: 'TCP:6379' },
      { id: 'e4', from: 'api-1', to: 'db-1',    label: 'TCP:5432' },
      { id: 'e5', from: 'api-2', to: 'db-1',    label: 'TCP:5432' },
    ],
    lanes: {
      'lb-1': [
        makeBlock('under_attack', 420, 480, { note: 'Absorbing 40× normal traffic' }),
        makeBlock('recovering',   900, 180),
      ],
      'api-1': [
        makeBlock('degraded',     420, 300, { note: 'Connection pool saturating' }),
        makeBlock('down',         720, 180, { customLog: 'ECONNRESET upstream timeout' }),
        makeBlock('recovering',   900, 200),
      ],
      'api-2': [
        makeBlock('degraded',     500, 400, { note: 'Spillover from api-1' }),
        makeBlock('recovering',   900, 200),
      ],
      'cache-1': [
        makeBlock('degraded',     720, 200, { note: 'Hit ratio collapsed', customLog: 'evicted key user:session:* (LRU)' }),
      ],
      'db-1': [
        makeBlock('throttled',    720, 200, { note: 'Connection limit reached' }),
      ],
    },
    narrative: [
      { id: 'n1', tick: 300,  text: 'Recon scan begins' },
      { id: 'n2', tick: 420,  text: 'DDoS starts' },
      { id: 'n3', tick: 720,  text: 'api-1 fails' },
      { id: 'n4', tick: 900,  text: 'WAF deployed' },
      { id: 'n5', tick: 1080, text: 'Recovery' },
    ],
  },
  {
    id: 'ioc-investigation',
    name: 'IOC Investigation',
    domain: 'security',
    duration: 1500,
    description: 'Phishing → C2 beacon → lateral movement → containment.',
    services: [
      { id: 'edr-1',         kind: 'custom',         label: 'edr-1', address: '10.0.0.5',    channel: 'tcp:8443', x: 60,  y: 60,  width: 200 },
      { id: 'workstation-7', kind: 'virtual_server', label: 'ws-7',  address: '10.50.10.7',  channel: 'tcp:445',  x: 320, y: 60,  width: 200 },
      { id: 'fileserver-1',  kind: 'virtual_server', label: 'fs-1',  address: '10.50.20.4',  channel: 'tcp:445',  x: 320, y: 200, width: 200 },
      { id: 'dc-1',          kind: 'virtual_server', label: 'dc-1',  address: '10.50.1.2',   channel: 'tcp:88',   x: 580, y: 130, width: 200 },
    ],
    edges: [
      { id: 'e1', from: 'workstation-7', to: 'fileserver-1', label: 'SMB:445' },
      { id: 'e2', from: 'workstation-7', to: 'dc-1',         label: 'KRB:88' },
      { id: 'e3', from: 'edr-1',         to: 'workstation-7', label: 'TLS:8443' },
    ],
    lanes: {
      'workstation-7': [
        makeBlock('compromised',  400, 600, { customLog: 'C2 beacon → 185.220.101.42:443' }),
        makeBlock('recovering',   1000, 500, { note: 'Quarantined by EDR' }),
      ],
      'fileserver-1': [
        makeBlock('under_attack', 700, 300, { customLog: 'PsExec service install from 10.50.10.7' }),
      ],
      'dc-1': [
        makeBlock('under_attack', 850, 150, { note: 'Cred dump detected', customLog: 'NTDS.dit access from anomalous account' }),
      ],
      'edr-1': [
        // edr stays healthy throughout
      ],
    },
    narrative: [
      { id: 'n1', tick: 400,  text: 'Phishing click' },
      { id: 'n2', tick: 500,  text: 'Persistence established' },
      { id: 'n3', tick: 700,  text: 'Lateral PsExec' },
      { id: 'n4', tick: 850,  text: 'Cred dump' },
      { id: 'n5', tick: 1000, text: 'Host isolated' },
      { id: 'n6', tick: 1200, text: 'Forensics begin' },
    ],
  },
];

// ---------- Lookup: what's the state of a service at a given tick? ----------
function blockAt(episode, serviceId, tick) {
  const blocks = (episode.lanes && episode.lanes[serviceId]) || [];
  return blocks.find(b => tick >= b.start && tick < b.start + b.duration);
}

function stateAt(episode, serviceId, tick) {
  const b = blockAt(episode, serviceId, tick);
  return b ? b.state : 'healthy';
}

// ---------- Health summary across all services at a given tick ----------
function healthSummary(episode, tick) {
  const counts = { healthy: 0, degraded: 0, down: 0, other: 0 };
  for (const svc of episode.services) {
    const s = stateAt(episode, svc.id, tick);
    if (s === 'healthy')    counts.healthy++;
    else if (s === 'down')  counts.down++;
    else if (s === 'degraded' || s === 'recovering' || s === 'throttled') counts.degraded++;
    else counts.other++;
  }
  return counts;
}

// ---------- Aggregate intensity for a tick (used by edge animation, etc) ----------
function intensityAt(episode, tick) {
  let max = 0;
  for (const svc of episode.services) {
    const b = blockAt(episode, svc.id, tick);
    if (!b) continue;
    const v = (b.errorRate || 0) + Math.max(0, (b.logVolMul - 1) * 0.2);
    if (v > max) max = v;
  }
  return Math.min(1, max);
}

// ---------- Generate logs for a tick range, weighted by per-service blocks ----------
function generateLogsForRange(episode, fromTick, toTick) {
  const out = [];
  for (let t = fromTick; t < toTick; t++) {
    for (const svc of episode.services) {
      const b = blockAt(episode, svc.id, t);
      const errorRate = b ? b.errorRate : 0.005;
      const logVolMul = b ? b.logVolMul : 1.0;
      const latencyMul = b ? b.latencyMul : 1.0;
      // baseline ~1 line per service per tick, scaled
      const lines = Math.random() < (logVolMul * 0.6) ? 1 : 0;
      if (!lines) continue;
      let lvl;
      const r = Math.random();
      if (r < errorRate) lvl = 'ERROR';
      else if (r < errorRate + 0.15) lvl = 'WARN';
      else lvl = 'INFO';

      let msg;
      if (b && b.customLog && Math.random() < 0.5) {
        msg = b.customLog;
      } else {
        const tpls = (window.LOG_TEMPLATES && window.LOG_TEMPLATES[svc.kind]) || [{ lvl: 'INFO', tpl: 'event seq={cid}' }];
        const matches = tpls.filter(x => x.lvl === lvl);
        const tpl = (matches.length ? window.pick(matches) : window.pick(tpls));
        msg = window.fillTemplate ? window.fillTemplate(tpl.tpl) : tpl.tpl;
        // boost latency in message if degraded/etc
        if (latencyMul > 1.5) msg = msg.replace(/\d+ms/, () => `${Math.round(latencyMul * window.rand(40, 200))}ms`);
        lvl = tpl.lvl;
      }
      out.push({
        tick: t,
        ts: new Date(Date.now() - (toTick - t) * 200),
        source: svc.id,
        kind: svc.kind,
        lvl,
        msg,
      });
    }
  }
  return out;
}

// ---------- Format ticks as m:ss assuming 1 tick = 1 second ----------
function fmtTime(ticks) {
  const m = Math.floor(ticks / 60);
  const s = Math.round(ticks % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

Object.assign(window, {
  EPISODE_LIBRARY, BEHAVIOR_STATES,
  makeBlock, blockAt, stateAt, healthSummary, intensityAt,
  generateLogsForRange, fmtTime,
});

// expose rand if not already
if (!window.rand) window.rand = (min, max) => Math.floor(min + Math.random() * (max - min));
