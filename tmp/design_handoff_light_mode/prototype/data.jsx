/* global React */
// logsim2 — simulated data sources, log templates, and helper hooks.
// Resource catalog matches src/components/palette/Palette.tsx from the repo.

const { useState, useEffect, useRef, useMemo, useCallback } = React;

// ---------- Resource catalog (matches repo Palette) ----------
const RESOURCES = [
  // Network
  { kind: 'vpc',      label: 'VPC',           group: 'Network',  emoji: '🌐', color: '#94a3b8',
    description: 'Virtual Private Cloud' },
  { kind: 'subnet',   label: 'Subnet',        group: 'Network',  emoji: '🔲', color: '#94a3b8',
    description: 'Network subnet' },
  // Compute
  { kind: 'virtual_server', label: 'Virtual Server', group: 'Compute', emoji: '💻', color: '#86efac',
    description: 'EC2 / VM instance' },
  // Services
  { kind: 'nodejs',   label: 'Node.js',       group: 'Services', emoji: '🟩', color: '#86efac',
    description: 'Node.js/Express service' },
  { kind: 'golang',   label: 'Go',            group: 'Services', emoji: '🐹', color: '#86efac',
    description: 'Go service (Gin/Echo)' },
  { kind: 'postgres', label: 'PostgreSQL',    group: 'Services', emoji: '🐘', color: '#86efac',
    description: 'PostgreSQL database' },
  { kind: 'mysql',    label: 'MySQL',         group: 'Services', emoji: '🐬', color: '#86efac',
    description: 'MySQL database' },
  { kind: 'redis',    label: 'Redis',         group: 'Services', emoji: '🔴', color: '#86efac',
    description: 'Redis cache/store' },
  { kind: 'nginx',    label: 'Nginx',         group: 'Services', emoji: '🌿', color: '#86efac',
    description: 'Nginx web server' },
  { kind: 'custom',   label: 'Custom',        group: 'Services', emoji: '⚙️',  color: '#86efac',
    description: 'Custom service' },
];

const RESOURCE_BY_KIND = Object.fromEntries(RESOURCES.map(r => [r.kind, r]));

// ---------- Log templates ----------
const LOG_TEMPLATES = {
  nodejs: [
    { lvl: 'INFO',  tpl: 'GET /api/users/{uid} 200 {ms}ms - 1.4kB' },
    { lvl: 'INFO',  tpl: 'POST /api/orders 201 {ms}ms - 0.8kB' },
    { lvl: 'INFO',  tpl: 'GET /healthz 200 {ms}ms' },
    { lvl: 'WARN',  tpl: 'Slow query detected on sessions ({ms}ms)' },
    { lvl: 'INFO',  tpl: 'Worker pid={pid} processed batch_export#{job}' },
    { lvl: 'ERROR', tpl: 'ECONNREFUSED 10.133.78.9:3306 retry in 250ms' },
  ],
  golang: [
    { lvl: 'INFO',  tpl: '{"level":"info","msg":"request","method":"GET","path":"/v1/orders","status":200,"latency_ms":{ms}}' },
    { lvl: 'INFO',  tpl: '{"level":"info","msg":"goroutine pool","active":{cid},"idle":{rows}}' },
    { lvl: 'WARN',  tpl: '{"level":"warn","msg":"context deadline exceeded","op":"upstream.fetch"}' },
  ],
  mysql: [
    { lvl: 'INFO',  tpl: 'Query OK, {rows} row affected ({ms}ms)' },
    { lvl: 'INFO',  tpl: 'Connection {cid} established from 10.183.164.128' },
    { lvl: 'WARN',  tpl: 'Aborted connection {cid} (timeout reading packets)' },
    { lvl: 'ERROR', tpl: 'Deadlock found; transaction rolled back' },
  ],
  postgres: [
    { lvl: 'INFO',  tpl: 'LOG:  duration: {ms}.{ms2} ms  statement: SELECT id FROM events WHERE ts > $1' },
    { lvl: 'INFO',  tpl: 'LOG:  checkpoint complete: wrote {rows} buffers ({ms}ms)' },
    { lvl: 'WARN',  tpl: 'WARNING:  oldest xmin is far in the past' },
  ],
  nginx: [
    { lvl: 'INFO',  tpl: '10.183.164.{ip} - - [{ts}] "GET /static/app.js HTTP/2" 200 {bytes}' },
    { lvl: 'INFO',  tpl: '10.183.164.{ip} - - [{ts}] "POST /api/login HTTP/2" 200 {bytes}' },
    { lvl: 'WARN',  tpl: '10.0.{ip}.{ip} - - [{ts}] "GET /admin HTTP/1.1" 404 {bytes}' },
  ],
  redis: [
    { lvl: 'INFO',  tpl: '{pid}:M * Background saving started by pid {pid}' },
    { lvl: 'INFO',  tpl: '{pid}:M * DB saved on disk' },
    { lvl: 'WARN',  tpl: '{pid}:M # Client id={cid} closed (idle timeout)' },
  ],
  virtual_server: [
    { lvl: 'INFO',  tpl: 'systemd[1]: Started Daily apt download activities.' },
    { lvl: 'INFO',  tpl: 'kernel: [{ms}.{ms2}] eth0: Link is Up - 10Gbps Full Duplex' },
  ],
  custom: [
    { lvl: 'INFO',  tpl: 'event: heartbeat seq={cid} drift={ms}ms' },
  ],
};
const DEFAULT_LOG = [{ lvl: 'INFO', tpl: 'service started' }];

function pad(n, w) { return String(n).padStart(w, '0'); }
function rand(min, max) { return Math.floor(min + Math.random() * (max - min)); }
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function fillTemplate(tpl) {
  return tpl
    .replace(/\{ms\}/g, () => rand(1, 240))
    .replace(/\{ms2\}/g, () => rand(100, 999))
    .replace(/\{uid\}/g, () => rand(1000, 99999))
    .replace(/\{pid\}/g, () => rand(2000, 32000))
    .replace(/\{cid\}/g, () => rand(1, 999))
    .replace(/\{job\}/g, () => rand(100, 9999))
    .replace(/\{rows\}/g, () => rand(1, 5000))
    .replace(/\{bytes\}/g, () => rand(180, 124000))
    .replace(/\{ip\}/g, () => rand(1, 254))
    .replace(/\{ts\}/g, () => new Date().toISOString().replace('T', ' ').slice(0, 19));
}

function formatTime(d) {
  return pad(d.getHours(), 2) + ':' + pad(d.getMinutes(), 2) + ':' + pad(d.getSeconds(), 2) + '.' + pad(d.getMilliseconds(), 3);
}

function nextLogLine(kind) {
  const tpls = LOG_TEMPLATES[kind] || DEFAULT_LOG;
  const r = Math.random();
  let bucket = r < 0.75 ? 'INFO' : r < 0.93 ? 'WARN' : 'ERROR';
  const matches = tpls.filter(t => t.lvl === bucket);
  const t = (matches.length ? pick(matches) : pick(tpls));
  return { lvl: t.lvl, msg: fillTemplate(t.tpl), ts: new Date() };
}

function useStreamingLogs(nodes, rate = 4, maxLines = 400) {
  const [lines, setLines] = useState([]);
  const ref = useRef(lines); ref.current = lines;
  useEffect(() => {
    if (!nodes.length || rate <= 0) return;
    const id = setInterval(() => {
      const node = pick(nodes);
      const e = nextLogLine(node.kind);
      const next = ref.current.concat([{ ...e, source: node.id, kind: node.kind, channel: node.channel }]);
      if (next.length > maxLines) next.splice(0, next.length - maxLines);
      setLines(next);
    }, 1000 / rate);
    return () => clearInterval(id);
  }, [nodes, rate, maxLines]);
  return [lines, setLines];
}

let _idSeq = 100;
function nextId(prefix) { return `${prefix}-${++_idSeq}`; }
function randIp(prefix = '10.183.164') { return `${prefix}.${rand(2, 254)}`; }

Object.assign(window, {
  RESOURCES, RESOURCE_BY_KIND,
  useStreamingLogs,
  nextLogLine, fillTemplate, formatTime, nextId, randIp, pick, rand,
});
