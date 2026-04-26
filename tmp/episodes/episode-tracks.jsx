/* global React */
// Episode editor v2 — per-service swim lanes, behavior blocks, narrative track, AI surfaces

const { useState, useRef, useEffect, useCallback, useMemo } = React;

const LANE_HEIGHT = 44;
const LABEL_COL = 140;
const NARR_TRACK_H = 48;

// ---------- Sparkle / AI icon ----------
function SparkleIcon({ size = 12 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <path d="M8 1.5L9.2 5.5L13.2 6.7L9.2 7.9L8 11.9L6.8 7.9L2.8 6.7L6.8 5.5L8 1.5Z"
            fill="currentColor"/>
      <path d="M13 11L13.6 12.6L15.2 13.2L13.6 13.8L13 15.4L12.4 13.8L10.8 13.2L12.4 12.6L13 11Z"
            fill="currentColor" opacity="0.7"/>
    </svg>
  );
}

// ---------- Ruler ----------
function Ruler({ totalTicks, pxPerTick }) {
  const widthPx = totalTicks * pxPerTick;
  const stepTicks = pxPerTick > 1.2 ? 30 : pxPerTick > 0.6 ? 60 : 120;
  const ticks = [];
  for (let t = 0; t <= totalTicks; t += stepTicks) ticks.push(t);
  return (
    <div className="le-tl-ruler" style={{ width: widthPx }}>
      {ticks.map(t => (
        <div key={t} className="le-tl-tick is-major" style={{ left: t * pxPerTick }}>
          {window.fmtTime(t)}
        </div>
      ))}
    </div>
  );
}

// ---------- Narrative track (vertical text labels with thin guide lines) ----------
function NarrativeTrack({ episode, pxPerTick, onSeek, onUpdate, onDelete, onAIExpand }) {
  const [editing, setEditing] = useState(null); // marker id
  const [editText, setEditText] = useState('');
  const [adding, setAdding] = useState(null); // {tick}
  const widthPx = episode.duration * pxPerTick;

  const onTrackClick = (e) => {
    if (e.target.closest('.le-narr-marker')) return;
    if (e.target.closest('.le-narr-edit')) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const tick = Math.max(0, Math.min(episode.duration, x / pxPerTick));
    setAdding({ tick: Math.round(tick) });
    setEditText('');
  };

  const commit = () => {
    if (adding) {
      if (editText.trim()) {
        onUpdate({ id: 'n-' + Math.random().toString(36).slice(2, 8), tick: adding.tick, text: editText.trim() });
      }
      setAdding(null); setEditText('');
    } else if (editing) {
      onUpdate({ id: editing, text: editText.trim() });
      setEditing(null); setEditText('');
    }
  };

  return (
    <div className="le-narr-track" style={{ width: widthPx, height: NARR_TRACK_H }} onClick={onTrackClick}>
      {episode.narrative.map(m => (
        <div key={m.id} className="le-narr-marker" style={{ left: m.tick * pxPerTick }}>
          {editing === m.id ? (
            <input className="le-narr-edit" autoFocus
                   value={editText}
                   onChange={(e) => setEditText(e.target.value)}
                   onBlur={commit}
                   onKeyDown={(e) => {
                     if (e.key === 'Enter') commit();
                     if (e.key === 'Escape') { setEditing(null); setEditText(''); }
                   }}
                   onClick={(e) => e.stopPropagation()} />
          ) : (
            <div className="le-narr-text"
                 onDoubleClick={(e) => { e.stopPropagation(); setEditing(m.id); setEditText(m.text); }}
                 onClick={(e) => { e.stopPropagation(); onSeek(m.tick); }}
                 title={`${m.text} @ ${window.fmtTime(m.tick)} — double-click to edit`}>
              {m.text}
            </div>
          )}
          <button className="le-narr-ai" title="AI: propose lane changes from this marker"
                  onClick={(e) => { e.stopPropagation(); onAIExpand(m); }}>
            <SparkleIcon size={11}/>
          </button>
          <button className="le-narr-x" title="Delete"
                  onClick={(e) => { e.stopPropagation(); onDelete(m.id); }}>×</button>
          <div className="le-narr-tick">{window.fmtTime(m.tick)}</div>
        </div>
      ))}
      {adding && (
        <div className="le-narr-marker is-adding" style={{ left: adding.tick * pxPerTick }}>
          <input className="le-narr-edit" autoFocus
                 placeholder="Type a narrative beat…"
                 value={editText}
                 onChange={(e) => setEditText(e.target.value)}
                 onBlur={commit}
                 onKeyDown={(e) => {
                   if (e.key === 'Enter') commit();
                   if (e.key === 'Escape') { setAdding(null); setEditText(''); }
                 }}
                 onClick={(e) => e.stopPropagation()} />
          <div className="le-narr-tick">{window.fmtTime(adding.tick)}</div>
        </div>
      )}
      {episode.narrative.length === 0 && !adding && (
        <div className="le-narr-hint">Click anywhere to drop a narrative beat (e.g. "DDoS starts")</div>
      )}
    </div>
  );
}

// ---------- Narrative guide lines (rendered separately so they overlay all lanes) ----------
function NarrativeGuides({ episode, pxPerTick, height }) {
  return (
    <div className="le-narr-guides" style={{ width: episode.duration * pxPerTick, height }}>
      {episode.narrative.map(m => (
        <div key={m.id} className="le-narr-guide" style={{ left: m.tick * pxPerTick }} />
      ))}
    </div>
  );
}

// ---------- Behavior block ----------
function BehaviorBlock({ block, pxPerTick, selected, onSelect, onResize, onMove, onDelete, episodeDuration, otherBlocks }) {
  const meta = window.BEHAVIOR_STATES[block.state] || window.BEHAVIOR_STATES.healthy;
  const left = block.start * pxPerTick;
  const width = Math.max(8, block.duration * pxPerTick);
  const showLabel = width > 60;
  const showMeta = width > 110;

  const onBlockMouseDown = (e) => {
    if (e.button !== 0) return;
    if (e.target.closest('.le-block-resize')) return;
    e.stopPropagation();
    onSelect();
    const startX = e.clientX;
    const startVal = block.start;
    const onMove2 = (ev) => {
      const dx = (ev.clientX - startX) / pxPerTick;
      const newStart = Math.max(0, Math.min(episodeDuration - block.duration, Math.round(startVal + dx)));
      onMove(newStart);
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove2);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove2);
    window.addEventListener('mouseup', onUp);
  };

  const onResizeMouseDown = (side) => (e) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    const startX = e.clientX;
    const startStart = block.start;
    const startDur = block.duration;
    const onMove2 = (ev) => {
      const dx = (ev.clientX - startX) / pxPerTick;
      if (side === 'right') {
        const newDur = Math.max(10, Math.round(startDur + dx));
        onResize({ start: startStart, duration: Math.min(newDur, episodeDuration - startStart) });
      } else {
        const newStart = Math.max(0, Math.min(startStart + startDur - 10, Math.round(startStart + dx)));
        const newDur = startDur + (startStart - newStart);
        onResize({ start: newStart, duration: newDur });
      }
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove2);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove2);
    window.addEventListener('mouseup', onUp);
  };

  return (
    <div
      className={`le-block ${selected ? 'is-selected' : ''} le-block-${block.state}`}
      style={{
        left, width,
        background: meta.bg,
        borderColor: meta.color,
        color: meta.text,
      }}
      onMouseDown={onBlockMouseDown}
      title={`${meta.label} • ${block.duration}t • err ${(block.errorRate*100).toFixed(1)}% • lat ${block.latencyMul}× • log ${block.logVolMul}×`}
    >
      <div className="le-block-stripe" style={{ background: meta.color }}/>
      {showLabel && (
        <div className="le-block-content">
          <span className="le-block-glyph" style={{ color: meta.color }}>{meta.glyph}</span>
          <span className="le-block-name">{meta.label}</span>
          {showMeta && block.errorRate > 0.01 && (
            <span className="le-block-meta">{(block.errorRate*100).toFixed(0)}%</span>
          )}
        </div>
      )}
      <div className="le-block-resize is-left" onMouseDown={onResizeMouseDown('left')}/>
      <div className="le-block-resize is-right" onMouseDown={onResizeMouseDown('right')}/>
    </div>
  );
}

// ---------- Service swim lane ----------
function ServiceLane({ service, blocks, pxPerTick, episode, selectedBlock, onSelectBlock, onUpdateBlock, onDeleteBlock, onAddBlock, onAILaneFill }) {
  const widthPx = episode.duration * pxPerTick;
  const r = window.RESOURCE_BY_KIND ? window.RESOURCE_BY_KIND[service.kind] : null;
  const isEmpty = blocks.length === 0;

  const onLaneClick = (e) => {
    if (e.target.closest('.le-block')) return;
    if (e.target.closest('.le-suggest')) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const tick = Math.max(0, Math.min(episode.duration - 60, Math.round(x / pxPerTick)));
    onAddBlock(tick);
  };

  return (
    <div className="le-lane">
      <div className="le-lane-label">
        <span className="le-lane-emoji">{r ? r.emoji : '◫'}</span>
        <div className="le-lane-text">
          <div className="le-lane-name">{service.label}</div>
          <div className="le-lane-kind">{service.kind}</div>
        </div>
      </div>
      <div className="le-lane-area" style={{ width: widthPx, height: LANE_HEIGHT }} onClick={onLaneClick}>
        {/* baseline healthy stripe (subtle) */}
        <div className="le-lane-baseline"/>
        {blocks.map(b => (
          <BehaviorBlock key={b.id} block={b} pxPerTick={pxPerTick}
            selected={selectedBlock === b.id}
            onSelect={() => onSelectBlock(b.id)}
            onMove={(newStart) => onUpdateBlock(b.id, { start: newStart })}
            onResize={(patch) => onUpdateBlock(b.id, patch)}
            onDelete={() => onDeleteBlock(b.id)}
            episodeDuration={episode.duration}
            otherBlocks={blocks.filter(x => x.id !== b.id)}
          />
        ))}
        {isEmpty && (
          <button className="le-suggest" onClick={(e) => { e.stopPropagation(); onAILaneFill(service); }}>
            <SparkleIcon size={11}/> Suggest behaviors for {service.label}
          </button>
        )}
      </div>
    </div>
  );
}

// ---------- Playhead ----------
function Playhead({ tick, pxPerTick, onScrub, height }) {
  const onMouseDown = (e) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startTick = tick;
    const onMove = (ev) => {
      const dx = ev.clientX - startX;
      onScrub(startTick + dx / pxPerTick);
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };
  return (
    <div className="le-playhead" style={{ left: tick * pxPerTick, height }}>
      <div className="le-playhead-time">{window.fmtTime(Math.round(tick))}</div>
      <div className="le-playhead-handle" onMouseDown={onMouseDown}/>
    </div>
  );
}

// ---------- Block inspector (right rail) ----------
function BlockInspector({ block, service, onChange, onDelete, onClose }) {
  if (!block || !service) return null;
  const meta = window.BEHAVIOR_STATES[block.state];
  const states = Object.keys(window.BEHAVIOR_STATES);

  return (
    <div className="le-bi">
      <div className="le-bi-head">
        <div className="le-bi-title">
          <span className="le-bi-glyph" style={{ color: meta.color }}>{meta.glyph}</span>
          <strong>{meta.label}</strong>
          <span className="le-bi-on">on {service.label}</span>
        </div>
        <button className="le-bi-x" onClick={onClose}>×</button>
      </div>
      <div className="le-bi-body">
        <label className="le-bi-row">
          <span>State</span>
          <select value={block.state} onChange={(e) => onChange({ state: e.target.value })}>
            {states.map(s => <option key={s} value={s}>{window.BEHAVIOR_STATES[s].label}</option>)}
          </select>
        </label>
        <div className="le-bi-row-2">
          <label className="le-bi-row">
            <span>Start</span>
            <input type="number" value={block.start} min="0"
                   onChange={(e) => onChange({ start: parseInt(e.target.value) || 0 })}/>
          </label>
          <label className="le-bi-row">
            <span>Duration</span>
            <input type="number" value={block.duration} min="10"
                   onChange={(e) => onChange({ duration: parseInt(e.target.value) || 10 })}/>
          </label>
        </div>
        <label className="le-bi-row">
          <span>Error rate <em>{(block.errorRate * 100).toFixed(1)}%</em></span>
          <input type="range" min="0" max="1" step="0.01" value={block.errorRate}
                 onChange={(e) => onChange({ errorRate: parseFloat(e.target.value) })}/>
        </label>
        <label className="le-bi-row">
          <span>Latency multiplier <em>{block.latencyMul}×</em></span>
          <input type="range" min="0.5" max="10" step="0.1" value={block.latencyMul}
                 onChange={(e) => onChange({ latencyMul: parseFloat(e.target.value) })}/>
        </label>
        <label className="le-bi-row">
          <span>Log volume <em>{block.logVolMul}×</em></span>
          <input type="range" min="0.1" max="6" step="0.1" value={block.logVolMul}
                 onChange={(e) => onChange({ logVolMul: parseFloat(e.target.value) })}/>
        </label>
        <label className="le-bi-row">
          <span>Custom log (overrides templates)</span>
          <textarea rows="2" value={block.customLog || ''} placeholder="e.g. ECONNRESET upstream"
                    onChange={(e) => onChange({ customLog: e.target.value })}/>
        </label>
        <label className="le-bi-row">
          <span>Note (designer)</span>
          <textarea rows="2" value={block.note || ''} placeholder="Why this block exists"
                    onChange={(e) => onChange({ note: e.target.value })}/>
        </label>
      </div>
      <div className="le-bi-foot">
        <button className="ln-btn ln-btn-danger" onClick={onDelete}>Delete block</button>
      </div>
    </div>
  );
}

// ---------- Read-only canvas embed ----------
function EpisodeCanvas({ episode, tick, running }) {
  const nodeMap = Object.fromEntries(episode.services.map(n => [n.id, n]));
  const intensity = window.intensityAt(episode, tick);
  // tint each node card with its current state color
  return (
    <div className="le-canvas-host">
      <div className="le-canvas-bg"/>
      <div className="le-canvas-inner">
        <svg className="le-canvas-edges" width="3000" height="2000">
          {episode.edges.map(e => (
            <window.Edge key={e.id} from={nodeMap[e.from]} to={nodeMap[e.to]}
                         label={e.label} style="curved"
                         highlight={intensity > 0.5}
                         animate={running && intensity > 0.2}/>
          ))}
        </svg>
        {episode.services.map(n => {
          const state = window.stateAt(episode, n.id, tick);
          const meta = window.BEHAVIOR_STATES[state];
          return (
            <div key={n.id} className="le-canvas-node-wrap" style={{
              left: n.x, top: n.y,
              '--state-color': meta.color,
            }}>
              <window.ServiceNodeCard node={n} selected={false}
                onSelect={() => {}}
                onMouseDown={() => {}}
                onPortDown={() => {}}/>
              <div className="le-canvas-state-pill" style={{ background: meta.bg, color: meta.text, borderColor: meta.color }}>
                <span style={{ color: meta.color }}>{meta.glyph}</span> {meta.label}
              </div>
            </div>
          );
        })}
      </div>
      <div className="le-canvas-readonly-badge">
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
          <rect x="3" y="7" width="10" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.4"/>
          <path d="M5 7V5a3 3 0 0 1 6 0v2" stroke="currentColor" strokeWidth="1.4"/>
        </svg>
        Topology preview at {window.fmtTime(Math.round(tick))} — click "Edit canvas" to modify
      </div>
    </div>
  );
}

// ---------- Scrubbed logs (per-service block aware) ----------
function ScrubbedLogs({ episode, tick, running }) {
  const [logs, setLogs] = useState([]);
  const lastTickRef = useRef(0);
  const [filter, setFilter] = useState('');
  const [levelFilter, setLevelFilter] = useState('ALL');
  const [follow, setFollow] = useState(true);
  const ref = useRef(null);

  useEffect(() => {
    if (Math.abs(tick - lastTickRef.current) > 5 || tick < lastTickRef.current) {
      const fromT = Math.max(0, tick - 30);
      const fresh = window.generateLogsForRange(episode, Math.floor(fromT), Math.floor(tick));
      setLogs(fresh.slice(-200));
    } else if (tick > lastTickRef.current) {
      const fresh = window.generateLogsForRange(episode, Math.floor(lastTickRef.current), Math.floor(tick));
      if (fresh.length) setLogs(prev => prev.concat(fresh).slice(-200));
    }
    lastTickRef.current = tick;
  }, [tick, episode]);

  useEffect(() => { if (follow && ref.current) ref.current.scrollTop = ref.current.scrollHeight; }, [logs, follow]);

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
          <span className={`ln-dot ${running ? 'ln-dot-live' : ''}`}/> Logs at {window.fmtTime(Math.round(tick))}
        </div>
        <div className="ln-logs-counts">
          <span className="ln-pill ln-pill-info">{counts.INFO}</span>
          <span className="ln-pill ln-pill-warn">{counts.WARN}</span>
          <span className="ln-pill ln-pill-err">{counts.ERROR}</span>
        </div>
      </div>
      <div className="ln-logs-toolbar">
        <input className="ln-input" placeholder="Filter logs…"
               value={filter} onChange={(e) => setFilter(e.target.value)}/>
        <div className="ln-seg">
          {['ALL', 'INFO', 'WARN', 'ERROR'].map(l => (
            <button key={l} className={levelFilter === l ? 'is-on' : ''}
                    onClick={() => setLevelFilter(l)}>{l}</button>
          ))}
        </div>
        <button className={`ln-follow ${follow ? 'is-on' : ''}`} onClick={() => setFollow(f => !f)}>
          <span className="ln-dot"/> Tail
        </button>
      </div>
      <div className="ln-logs-body ls-scroll" ref={ref}>
        {filtered.length === 0 && (
          <div className="ln-logs-empty">Scrub the timeline or press play to generate logs.</div>
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

Object.assign(window, {
  Ruler, NarrativeTrack, NarrativeGuides, BehaviorBlock, ServiceLane, Playhead,
  BlockInspector, EpisodeCanvas, ScrubbedLogs, SparkleIcon,
  LANE_HEIGHT, LABEL_COL, NARR_TRACK_H,
});
