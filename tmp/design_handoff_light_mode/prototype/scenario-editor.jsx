/* global React */
// Scenario editor — light mode, repo-aligned (ServiceNode + Palette)

const { useState, useRef, useEffect, useCallback, useMemo } = React;

function ScenarioEditor({ tweaks }) {
  const {
    edgeStyle = 'curved',
    gridStyle = 'lines',
    accent = '#2563eb',
    animate = true,
    logRate = 4,
  } = tweaks || {};

  // Initial seeded scenario (matches repo defaults: 'nodejs-1' -> 'mysql-1' on TCP:3306)
  const [nodes, setNodes] = useState(() => ([
    { id: 'nodejs-1', kind: 'nodejs', label: 'nodejs-1', address: '10.183.164.128', channel: 'tcp:8080',
      x: 220, y: 120, width: 220, volume: 60, anomaly: 4 },
    { id: 'mysql-1',  kind: 'mysql',  label: 'mysql-1',  address: '10.133.78.9',   channel: 'tcp:3306',
      x: 220, y: 320, width: 220, volume: 40, anomaly: 2 },
    { id: 'redis-1',  kind: 'redis',  label: 'redis-1',  address: '10.133.78.42',  channel: 'tcp:6379',
      x: 540, y: 120, width: 220, volume: 70, anomaly: 1 },
    { id: 'nginx-1',  kind: 'nginx',  label: 'nginx-1',  address: '10.183.164.10', channel: 'tcp:443',
      x: 540, y: 320, width: 220, volume: 80, anomaly: 3 },
  ]));
  const [edges, setEdges] = useState(() => ([
    { id: 'e1', from: 'nodejs-1', to: 'mysql-1', label: 'TCP:3306', protocol: 'TCP', port: 3306 },
    { id: 'e2', from: 'nodejs-1', to: 'redis-1', label: 'TCP:6379', protocol: 'TCP', port: 6379 },
    { id: 'e3', from: 'nginx-1',  to: 'nodejs-1', label: 'TCP:8080', protocol: 'TCP', port: 8080 },
  ]));
  const [selected, setSelected] = useState(null);
  const [hoveredEdge, setHoveredEdge] = useState(null);
  const [draggingPort, setDraggingPort] = useState(null);
  const [running, setRunning] = useState(true);
  const [timeMul, setTimeMul] = useState(1);
  const [activeTab, setActiveTab] = useState('build');
  const canvasRef = useRef(null);

  const nodeMap = useMemo(() => Object.fromEntries(nodes.map(n => [n.id, n])), [nodes]);

  // ---------- Drag from palette → drop on canvas ----------
  const onPaletteDragStart = useCallback((e, kind) => {
    e.dataTransfer.setData('application/x-logsim-resource', kind);
    e.dataTransfer.effectAllowed = 'copy';
  }, []);
  const onCanvasDragOver = useCallback((e) => {
    if (e.dataTransfer.types.includes('application/x-logsim-resource')) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    }
  }, []);

  const makeNewNode = useCallback((kind, x, y) => {
    const r = window.RESOURCE_BY_KIND[kind];
    const existing = nodes.filter(n => n.kind === kind).length;
    const id = `${kind}-${existing + 1}`;
    const portMap = { mysql: 3306, postgres: 5432, redis: 6379, nginx: 443, nodejs: 8080, golang: 8080 };
    const port = portMap[kind] || 8080;
    const ipPrefix = (kind === 'mysql' || kind === 'postgres' || kind === 'redis') ? '10.133.78' : '10.183.164';
    return {
      id, kind, label: id,
      address: window.randIp(ipPrefix),
      channel: `tcp:${port}`,
      x: Math.max(0, x), y: Math.max(0, y), width: 220,
      volume: 50, anomaly: 5,
    };
  }, [nodes]);

  const onCanvasDrop = useCallback((e) => {
    const kind = e.dataTransfer.getData('application/x-logsim-resource');
    if (!kind) return;
    e.preventDefault();
    const rect = canvasRef.current.getBoundingClientRect();
    const node = makeNewNode(kind, e.clientX - rect.left - 110 - pan.x, e.clientY - rect.top - 30 - pan.y);
    setNodes(ns => ns.concat([node]));
    setSelected(node.id);
  }, [makeNewNode]); // eslint-disable-line

  const addNodeFromClick = useCallback((kind) => {
    const x = 240 + (nodes.length % 4) * 60;
    const y = 140 + (nodes.length % 4) * 40;
    const node = makeNewNode(kind, x, y);
    setNodes(ns => ns.concat([node]));
    setSelected(node.id);
  }, [makeNewNode, nodes.length]);

  // ---------- Move nodes ----------
  const dragRef = useRef(null);
  const onNodeMouseDown = useCallback((e, node) => {
    if (e.target.classList.contains('ln-port')) return;
    if (e.button !== 0) return;
    const rect = canvasRef.current.getBoundingClientRect();
    dragRef.current = {
      id: node.id,
      offsetX: e.clientX - rect.left - node.x,
      offsetY: e.clientY - rect.top - node.y,
    };
    e.preventDefault();
  }, []);

  // ---------- Pan ----------
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const panRef = useRef(null);
  const onCanvasMouseDown = useCallback((e) => {
    if (!e.target.classList.contains('ln-canvas-bg')) return;
    panRef.current = { startX: e.clientX, startY: e.clientY, baseX: pan.x, baseY: pan.y };
    setSelected(null);
  }, [pan]);

  // ---------- Global mouse move/up ----------
  useEffect(() => {
    const onMove = (e) => {
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return;
      if (dragRef.current) {
        const { id, offsetX, offsetY } = dragRef.current;
        const x = Math.max(0, e.clientX - rect.left - offsetX);
        const y = Math.max(0, e.clientY - rect.top - offsetY);
        setNodes(ns => ns.map(n => n.id === id ? { ...n, x, y } : n));
      }
      if (draggingPort) {
        setDraggingPort(p => p ? { ...p, currentXY: { x: e.clientX - rect.left, y: e.clientY - rect.top } } : null);
      }
      if (panRef.current) {
        setPan({
          x: panRef.current.baseX + (e.clientX - panRef.current.startX),
          y: panRef.current.baseY + (e.clientY - panRef.current.startY),
        });
      }
    };
    const onUp = (e) => {
      dragRef.current = null;
      panRef.current = null;
      if (draggingPort) {
        const rect = canvasRef.current.getBoundingClientRect();
        const px = e.clientX - rect.left - pan.x, py = e.clientY - rect.top - pan.y;
        const hit = nodes.find(n => px >= n.x && px <= n.x + n.width && py >= n.y && py <= n.y + 80);
        if (hit && hit.id !== draggingPort.fromId) {
          const fromNode = nodes.find(n => n.id === draggingPort.fromId);
          const port = parseInt((hit.channel.match(/:(\d+)/) || [])[1]) || 8080;
          setEdges(es => es.concat([{
            id: 'e' + Date.now(),
            from: draggingPort.fromId,
            to: hit.id,
            label: `TCP:${port}`,
            protocol: 'TCP', port,
          }]));
        }
        setDraggingPort(null);
      }
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [draggingPort, nodes, pan]);

  // ---------- Port drag ----------
  const onPortDown = useCallback((e, node, side) => {
    if (side !== 'out') return;
    e.stopPropagation(); e.preventDefault();
    const rect = canvasRef.current.getBoundingClientRect();
    const x = node.x + node.width / 2 + pan.x;
    const y = node.y + 64 + pan.y;
    setDraggingPort({
      fromId: node.id,
      fromXY: { x, y },
      currentXY: { x: e.clientX - rect.left, y: e.clientY - rect.top },
    });
  }, [pan]);

  // ---------- Inspector ----------
  const updateNode = useCallback((next) => {
    setNodes(ns => ns.map(n => n.id === selected ? next : n));
    if (next.id !== selected) setSelected(next.id);
  }, [selected]);
  const deleteNode = useCallback((id) => {
    setNodes(ns => ns.filter(n => n.id !== id));
    setEdges(es => es.filter(e => e.from !== id && e.to !== id));
    setSelected(null);
  }, []);

  const selectedNode = nodes.find(n => n.id === selected);
  const gridBg = gridStyle === 'dots'
    ? `radial-gradient(circle, rgba(15,23,42,0.10) 1px, transparent 1px) 0 0 / 24px 24px`
    : gridStyle === 'lines'
    ? `linear-gradient(rgba(15,23,42,0.06) 1px, transparent 1px) 0 0 / 100% 24px,
       linear-gradient(90deg, rgba(15,23,42,0.06) 1px, transparent 1px) 0 0 / 24px 100%`
    : 'transparent';

  return (
    <div className="ln-app" style={{ '--ls-accent': accent, '--ls-accent-soft': accent + '1a', '--ls-accent-border': accent + '55' }}>
      <header className="ln-topbar">
        <div className="ln-topbar-left">
          <div className="ln-logo">
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
              <rect x="2" y="2" width="7" height="7" rx="1.5" fill="var(--ls-accent)" />
              <rect x="11" y="2" width="7" height="7" rx="1.5" fill="var(--ls-accent)" fillOpacity="0.4" />
              <rect x="2" y="11" width="7" height="7" rx="1.5" fill="var(--ls-accent)" fillOpacity="0.4" />
              <rect x="11" y="11" width="7" height="7" rx="1.5" fill="var(--ls-accent)" />
            </svg>
            <span>logsim</span>
            <span className="ln-version">v2</span>
          </div>
          <div className="ln-breadcrumbs">
            <span>Workspace</span>
            <span className="ln-sep">/</span>
            <span>Scenarios</span>
            <span className="ln-sep">/</span>
            <span className="ln-cur">three-tier-web</span>
          </div>
        </div>
        <div className="ln-topbar-tabs">
          {['build', 'run', 'replay', 'datasets'].map(t => (
            <button key={t} className={activeTab === t ? 'is-on' : ''} onClick={() => setActiveTab(t)}>
              {t[0].toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>
        <div className="ln-topbar-right">
          <div className="ln-status">
            <span className={`ln-dot ${running ? 'ln-dot-live' : 'ln-dot-idle'}`} />
            {running ? 'streaming' : 'paused'}
          </div>
          <div className="ln-seg ln-seg-tight">
            {[1, 2, 4, 8].map(m => (
              <button key={m} className={timeMul === m ? 'is-on' : ''} onClick={() => setTimeMul(m)}>{m}×</button>
            ))}
          </div>
          <button className="ln-btn" onClick={() => setRunning(r => !r)}>{running ? 'Pause' : 'Run'}</button>
          <button className="ln-btn ln-btn-primary">Export dataset</button>
        </div>
      </header>

      <div className="ln-shell">
        <window.Palette onDragStart={onPaletteDragStart} onAdd={addNodeFromClick} />

        <div className="ln-canvas-wrap"
             onDragOver={onCanvasDragOver}
             onDrop={onCanvasDrop}
             onMouseDown={onCanvasMouseDown}
             ref={canvasRef}>
          <div className="ln-canvas-bg" style={{ background: gridBg }} />
          <div className="ln-canvas-inner" style={{ transform: `translate(${pan.x}px, ${pan.y}px)` }}>
            <svg className="ln-edges" width="3000" height="2000">
              {edges.map(e => (
                <g key={e.id}
                   onMouseEnter={() => setHoveredEdge(e.id)}
                   onMouseLeave={() => setHoveredEdge(null)}
                   style={{ cursor: 'pointer' }}>
                  <window.Edge from={nodeMap[e.from]} to={nodeMap[e.to]}
                               label={e.label} style={edgeStyle}
                               highlight={hoveredEdge === e.id}
                               animate={animate && running} />
                </g>
              ))}
              {draggingPort && (
                <g>
                  <line x1={draggingPort.fromXY.x - pan.x} y1={draggingPort.fromXY.y - pan.y}
                        x2={draggingPort.currentXY.x - pan.x} y2={draggingPort.currentXY.y - pan.y}
                        stroke="var(--ls-accent)" strokeWidth="1.6" strokeDasharray="4 4"/>
                  <circle cx={draggingPort.currentXY.x - pan.x} cy={draggingPort.currentXY.y - pan.y} r="4" fill="var(--ls-accent)"/>
                </g>
              )}
            </svg>

            {nodes.map(n => (
              <window.ServiceNodeCard key={n.id} node={n}
                selected={selected === n.id}
                onSelect={setSelected}
                onMouseDown={onNodeMouseDown}
                onPortDown={onPortDown}
              />
            ))}
          </div>

          <div className="ln-canvas-controls">
            <button title="Fit">
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                <path d="M1 4V1h3M11 4V1H8M1 8v3h3M11 8v3H8" stroke="currentColor" strokeWidth="1.4"/>
              </svg>
            </button>
            <button title="Zoom in">+</button>
            <button title="Zoom out">−</button>
          </div>
          <div className="ln-canvas-zoomstatus">{nodes.length} nodes · {edges.length} connections</div>
          {nodes.length === 0 && (
            <div className="ln-canvas-hint">Drag a resource from the left to start</div>
          )}
        </div>

        <div className="ln-right">
          {selectedNode ? (
            <window.Inspector node={selectedNode} edges={edges}
              onChange={updateNode}
              onDelete={deleteNode}
              onClose={() => setSelected(null)}
            />
          ) : (
            <window.LogPanel nodes={running ? nodes : []} rate={logRate * timeMul} />
          )}
        </div>
      </div>
    </div>
  );
}

window.ScenarioEditor = ScenarioEditor;
