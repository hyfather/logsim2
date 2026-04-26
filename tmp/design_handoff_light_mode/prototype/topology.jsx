/* global React */
// Topology — node cards modeled on src/components/nodes/ServiceNode.tsx
// Repo conventions: white bg, 1.5px green border (default) / blue (selected),
// slate text scale, soft tinted shadow, 8px title bar with emoji + label + service-type badge + Settings gear.

const { useState, useRef, useEffect, useCallback, useMemo } = React;

// ---------- Settings (gear) icon — copied lucide-react Settings outline ----------
function GearIcon({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/>
      <circle cx="12" cy="12" r="3"/>
    </svg>
  );
}

// ---------- Service node card (matches repo ServiceNode.tsx) ----------
function ServiceNodeCard({ node, selected, onSelect, onMouseDown, onPortDown }) {
  const r = window.RESOURCE_BY_KIND[node.kind];
  const borderColor = selected ? '#3b82f6' : '#86efac';
  return (
    <div className="ln-node"
         style={{
           left: node.x, top: node.y, width: node.width || 220,
           border: `1.5px solid ${borderColor}`,
           boxShadow: selected
             ? '0 18px 40px -24px rgba(37,99,235,0.30)'
             : '0 14px 32px -28px rgba(15,23,42,0.30)',
         }}
         onMouseDown={(e) => onMouseDown(e, node)}
         onClick={(e) => { e.stopPropagation(); onSelect(node.id); }}>
      <div className="ln-node-title">
        <span className="ln-node-emoji">{r.emoji}</span>
        <span className="ln-node-label">{node.label}</span>
        {r.group === 'Services' && r.kind !== 'custom' && (
          <span className="ln-node-badge">{r.kind}</span>
        )}
        <button className="ln-node-gear" onClick={(e) => { e.stopPropagation(); onSelect(node.id); }}
                title="Edit node settings">
          <GearIcon size={14} />
        </button>
      </div>
      <div className="ln-node-body">
        <div className="ln-node-addr">{node.address}</div>
        <div className="ln-node-channel">{node.channel}</div>
      </div>
      <div className="ln-port ln-port-in"  data-port="in"  onMouseDown={(e) => onPortDown(e, node, 'in')} />
      <div className="ln-port ln-port-out" data-port="out" onMouseDown={(e) => onPortDown(e, node, 'out')} />
    </div>
  );
}

// ---------- Edge (uses repo's connection-flow animation) ----------
function Edge({ from, to, label, style = 'curved', highlight, animate }) {
  if (!from || !to) return null;
  const w1 = from.width || 220, w2 = to.width || 220;
  const x1 = from.x + w1 / 2, y1 = from.y + 64;
  const x2 = to.x + w2 / 2, y2 = to.y;
  let d;
  if (style === 'orthogonal') {
    const midY = (y1 + y2) / 2;
    d = `M ${x1} ${y1} L ${x1} ${midY} L ${x2} ${midY} L ${x2} ${y2 - 8}`;
  } else if (style === 'curved') {
    const dy = Math.abs(y2 - y1);
    d = `M ${x1} ${y1} C ${x1} ${y1 + dy * 0.4}, ${x2} ${y2 - dy * 0.4}, ${x2} ${y2 - 8}`;
  } else {
    d = `M ${x1} ${y1} L ${x2} ${y2 - 8}`;
  }
  const baseColor = highlight ? '#3b82f6' : '#94a3b8';
  return (
    <g>
      <path d={d} stroke={baseColor} strokeWidth="1.5" fill="none" opacity={highlight ? 1 : 0.6} />
      {animate && (
        <path d={d} stroke={highlight ? '#3b82f6' : '#22c55e'} strokeWidth="2" fill="none"
              strokeDasharray="4 6" strokeOpacity="0.85"
              className="connection-flow-path" />
      )}
      <polygon points={`${x2 - 5},${y2 - 8} ${x2 + 5},${y2 - 8} ${x2},${y2 - 1}`} fill={baseColor} />
      {label && (
        <g transform={`translate(${(x1 + x2) / 2 - 32}, ${(y1 + y2) / 2 - 10})`}>
          <rect width="64" height="20" rx="4" fill="#ffffff" stroke="#cbd5e1" strokeWidth="1" />
          <text x="32" y="14" textAnchor="middle" fontSize="10.5"
                fontFamily="ui-monospace, SF Mono, monospace" fill="#475569" fontWeight="500">{label}</text>
        </g>
      )}
    </g>
  );
}

// ---------- Palette (matches repo Palette.tsx) ----------
function Palette({ onDragStart, onAdd }) {
  const groups = {};
  window.RESOURCES.forEach(r => { (groups[r.group] = groups[r.group] || []).push(r); });
  return (
    <aside className="ln-palette ls-scroll">
      <div className="ln-palette-head">
        <span>Add Node</span>
      </div>
      <div className="ln-palette-body">
        {Object.entries(groups).map(([g, items]) => (
          <div key={g} className="ln-palette-group">
            <div className="ln-palette-group-h">{g}</div>
            <div className="ln-palette-items">
              {items.map(r => (
                <div key={r.kind} className="ln-palette-item"
                     draggable
                     onClick={() => onAdd && onAdd(r.kind)}
                     onDragStart={(e) => onDragStart(e, r.kind)}
                     title={r.description}>
                  <span className="ln-palette-emoji">{r.emoji}</span>
                  <span className="ln-palette-label">{r.label}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className="ln-palette-foot">Click to add · Drag to position</div>
    </aside>
  );
}

// ---------- Log panel ----------
function LogPanel({ nodes, rate = 4 }) {
  const [logs] = window.useStreamingLogs(nodes, rate, 600);
  const [filter, setFilter] = useState('');
  const [levelFilter, setLevelFilter] = useState('ALL');
  const [follow, setFollow] = useState(true);
  const ref = useRef(null);

  useEffect(() => {
    if (follow && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [logs, follow]);

  const filtered = useMemo(() => logs.filter(l => {
    if (levelFilter !== 'ALL' && l.lvl !== levelFilter) return false;
    if (filter && !l.msg.toLowerCase().includes(filter.toLowerCase()) && !l.source.includes(filter)) return false;
    return true;
  }), [logs, filter, levelFilter]);

  const counts = useMemo(() => {
    const c = { INFO: 0, WARN: 0, ERROR: 0 };
    for (const l of logs) c[l.lvl] = (c[l.lvl] || 0) + 1;
    return c;
  }, [logs]);

  return (
    <div className="ln-logs">
      <div className="ln-logs-head">
        <div className="ln-logs-title">
          <span className="ln-dot ln-dot-live" /> Live logs
          <span className="ln-logs-rate">{rate}/s</span>
        </div>
        <div className="ln-logs-counts">
          <span className="ln-pill ln-pill-info">{counts.INFO}</span>
          <span className="ln-pill ln-pill-warn">{counts.WARN}</span>
          <span className="ln-pill ln-pill-err">{counts.ERROR}</span>
        </div>
      </div>
      <div className="ln-logs-toolbar">
        <input className="ln-input" placeholder="Filter logs… (try 'ERROR' or 'mysql')"
               value={filter} onChange={(e) => setFilter(e.target.value)} />
        <div className="ln-seg">
          {['ALL', 'INFO', 'WARN', 'ERROR'].map(l => (
            <button key={l} className={levelFilter === l ? 'is-on' : ''}
                    onClick={() => setLevelFilter(l)}>{l}</button>
          ))}
        </div>
        <button className={`ln-follow ${follow ? 'is-on' : ''}`} onClick={() => setFollow(f => !f)}>
          <span className="ln-dot" /> Follow
        </button>
      </div>
      <div className="ln-logs-body ls-scroll" ref={ref}>
        {filtered.length === 0 && (
          <div className="ln-logs-empty">
            {nodes.length === 0
              ? 'Add a node from the palette to start emitting logs.'
              : 'No logs match this filter.'}
          </div>
        )}
        {filtered.map((l, i) => (
          <div key={i} className={`ln-logline ln-lvl-${l.lvl.toLowerCase()}`}>
            <span className="ln-logline-ts">{window.formatTime(l.ts)}</span>
            <span className="ln-logline-src">{l.source}</span>
            <span className="ln-logline-lvl">{l.lvl}</span>
            <span className="ln-logline-msg">{l.msg}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------- Inspector ----------
function Inspector({ node, edges, onChange, onDelete, onClose }) {
  if (!node) return null;
  const r = window.RESOURCE_BY_KIND[node.kind];
  const conns = edges.filter(e => e.from === node.id || e.to === node.id);
  return (
    <div className="ln-inspector ls-scroll">
      <div className="ln-inspector-head">
        <span className="ln-node-emoji" style={{ fontSize: 18 }}>{r.emoji}</span>
        <div className="ln-inspector-title">{node.label}</div>
        <button className="ln-icon-btn" onClick={onClose} title="Close">✕</button>
      </div>
      <div className="ln-inspector-section">
        <div className="ln-field">
          <label>Label</label>
          <input className="ln-input" value={node.label}
                 onChange={(e) => onChange({ ...node, label: e.target.value })} />
        </div>
        <div className="ln-field">
          <label>Address</label>
          <input className="ln-input ln-mono" value={node.address}
                 onChange={(e) => onChange({ ...node, address: e.target.value })} />
        </div>
        <div className="ln-field">
          <label>Channel</label>
          <input className="ln-input ln-mono" value={node.channel}
                 onChange={(e) => onChange({ ...node, channel: e.target.value })} />
        </div>
        <div className="ln-field">
          <label>Resource</label>
          <div className="ln-readonly">{r.label}</div>
        </div>
      </div>
      <div className="ln-inspector-section">
        <div className="ln-inspector-h">Log generation</div>
        <div className="ln-field">
          <label>Volume <span className="ln-text-3">{node.volume ?? 50} EPS</span></label>
          <input type="range" min="0" max="100" value={node.volume ?? 50}
                 onChange={(e) => onChange({ ...node, volume: +e.target.value })} />
        </div>
        <div className="ln-field">
          <label>Anomaly rate <span className="ln-text-3">{node.anomaly ?? 5}%</span></label>
          <input type="range" min="0" max="30" value={node.anomaly ?? 5}
                 onChange={(e) => onChange({ ...node, anomaly: +e.target.value })} />
        </div>
      </div>
      <div className="ln-inspector-section">
        <div className="ln-inspector-h">Connections ({conns.length})</div>
        {conns.length === 0 && <div className="ln-text-3">None. Drag from the bottom port to connect.</div>}
        {conns.map(e => {
          const other = e.from === node.id ? e.to : e.from;
          const dir = e.from === node.id ? '→' : '←';
          return (
            <div key={e.id} className="ln-conn-row">
              <span className="ln-mono ln-text-3">{dir}</span>
              <span className="ln-mono">{other}</span>
              <span className="ln-mono ln-text-3">{e.label}</span>
            </div>
          );
        })}
      </div>
      <div className="ln-inspector-foot">
        <button className="ln-btn ln-btn-danger" onClick={() => onDelete(node.id)}>Delete node</button>
      </div>
    </div>
  );
}

Object.assign(window, { ServiceNodeCard, Edge, Palette, LogPanel, Inspector });
