/* global React */
// Episode editor — multi-track timeline + embedded canvas + scrubbed logs

const { useState, useRef, useEffect, useCallback, useMemo } = React;

// ---------- Track layout ----------
const TRACK_HEIGHTS = { services: 56, events: 36, anomalies: 32 };

// Convert tick → x in pixels
function tickToX(tick, totalTicks, widthPx) { return (tick / totalTicks) * widthPx; }
function xToTick(x, totalTicks, widthPx) { return Math.max(0, Math.min(totalTicks, Math.round((x / widthPx) * totalTicks))); }

// Format ticks as m:ss assuming 1 tick = 1 second
function fmtTime(ticks) {
  const m = Math.floor(ticks / 60);
  const s = ticks % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

// ---------- Ruler ----------
function Ruler({ totalTicks, pxPerTick }) {
  const widthPx = totalTicks * pxPerTick;
  const stepTicks = pxPerTick > 1.2 ? 30 : pxPerTick > 0.6 ? 60 : 120;
  const ticks = [];
  for (let t = 0; t <= totalTicks; t += stepTicks) {
    ticks.push(t);
  }
  return (
    <div className="le-tl-ruler" style={{ width: widthPx }}>
      {ticks.map(t => (
        <div key={t} className="le-tl-tick is-major" style={{ left: t * pxPerTick }}>
          {fmtTime(t)}
        </div>
      ))}
    </div>
  );
}

// ---------- Anomaly heatmap with sparkline ----------
function AnomalyTrack({ episode, pxPerTick }) {
  // Build a mini sparkline of intensity over time
  const widthPx = episode.duration * pxPerTick;
  const points = useMemo(() => {
    const samples = Math.min(400, Math.max(80, Math.floor(widthPx / 4)));
    const arr = [];
    for (let i = 0; i < samples; i++) {
      const tick = (i / (samples - 1)) * episode.duration;
      arr.push(window.logIntensity(episode, tick));
    }
    return arr;
  }, [episode, widthPx]);
  const h = TRACK_HEIGHTS.anomalies;
  const path = points.map((v, i) => {
    const x = (i / (points.length - 1)) * widthPx;
    const y = h - 4 - v * (h - 8);
    return `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`;
  }).join(' ');
  const fillPath = path + ` L ${widthPx} ${h} L 0 ${h} Z`;
  return (
    <div className="le-tl-track-area" style={{ '--track-h': `${h}px`, width: widthPx }}>
      {episode.anomalies.map((a, i) => (
        <div key={i} className="le-anom" style={{
          left: a.start * pxPerTick,
          width: (a.end - a.start) * pxPerTick,
          '--anom-color': a.level > 0.7 ? 'rgba(220,38,38,0.18)' : a.level > 0.4 ? 'rgba(217,119,6,0.18)' : 'rgba(252,211,77,0.16)',
        }} />
      ))}
      <svg className="le-anom-spark" width={widthPx} height={h}>
        <path d={fillPath} fill="rgba(220,38,38,0.18)" />
        <path d={path} stroke="#dc2626" strokeWidth="1.2" fill="none" opacity="0.6" />
      </svg>
    </div>
  );
}

// ---------- Events track ----------
function EventsTrack({ episode, pxPerTick, onSeek }) {
  const widthPx = episode.duration * pxPerTick;
  const h = TRACK_HEIGHTS.events;
  return (
    <div className="le-tl-track-area" style={{ '--track-h': `${h}px`, width: widthPx }}>
      {episode.events.map((ev, i) => (
        <div key={i} className="le-event"
             style={{ left: ev.tick * pxPerTick, height: h }}
             onClick={(e) => { e.stopPropagation(); onSeek(ev.tick); }}
             title={`${ev.label} @ ${fmtTime(ev.tick)}`}>
          <div className={`le-event-pin sev-${ev.severity}`}>{ev.icon}</div>
          {pxPerTick > 0.5 && (
            <div className="le-event-label">{ev.label}</div>
          )}
        </div>
      ))}
    </div>
  );
}

// ---------- Services track (segments) ----------
function ServicesTrack({ episode, pxPerTick, selectedId, onSelect }) {
  const widthPx = episode.duration * pxPerTick;
  const h = TRACK_HEIGHTS.services;
  return (
    <div className="le-tl-track-area" style={{ '--track-h': `${h}px`, width: widthPx }}>
      {episode.segments.map(s => (
        <div key={s.id}
             className={`le-segment ${selectedId === s.id ? 'is-selected' : ''}`}
             style={{
               left: s.start * pxPerTick,
               width: s.duration * pxPerTick - 2,
               '--seg-color': s.color,
             }}
             onClick={() => onSelect(s.id)}>
          <div className="le-segment-stripe" style={{ background: s.color }} />
          <div className="le-segment-name">{s.name}</div>
          <div className="le-segment-meta">{s.duration}t · {fmtTime(s.duration)}</div>
        </div>
      ))}
    </div>
  );
}

// ---------- Playhead ----------
function Playhead({ tick, pxPerTick, onScrub }) {
  const ref = useRef(null);
  const onMouseDown = (e) => {
    e.preventDefault();
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
    <div className="le-playhead" style={{ left: tick * pxPerTick }}>
      <div className="le-playhead-time">{fmtTime(Math.round(tick))}</div>
      <div className="le-playhead-handle" ref={ref} onMouseDown={onMouseDown} />
    </div>
  );
}

// ---------- Read-only canvas embed ----------
function EpisodeCanvas({ episode, segment, intensity, running }) {
  const nodeMap = Object.fromEntries(episode.services.map(n => [n.id, n]));
  return (
    <div className="le-canvas-host">
      <div className="le-canvas-bg" />
      <div className="le-canvas-inner">
        <svg className="le-canvas-edges" width="3000" height="2000">
          {episode.edges.map(e => (
            <window.Edge key={e.id} from={nodeMap[e.from]} to={nodeMap[e.to]}
                         label={e.label} style="curved"
                         highlight={intensity > 0.6}
                         animate={running} />
          ))}
        </svg>
        {episode.services.map(n => (
          <window.ServiceNodeCard key={n.id} node={n}
            selected={false}
            onSelect={() => {}}
            onMouseDown={() => {}}
            onPortDown={() => {}}
          />
        ))}
      </div>
      <div className="le-canvas-readonly-badge">
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
          <rect x="3" y="7" width="10" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.4"/>
          <path d="M5 7V5a3 3 0 0 1 6 0v2" stroke="currentColor" strokeWidth="1.4"/>
        </svg>
        Viewing — click "Edit canvas" to modify topology
      </div>
    </div>
  );
}

// ---------- Logs that follow the playhead ----------
function ScrubbedLogs({ episode, tick, running }) {
  const [logs, setLogs] = useState([]);
  const lastTickRef = useRef(0);

  useEffect(() => {
    // when scrubbing back, regenerate. when forward, append.
    if (Math.abs(tick - lastTickRef.current) > 5 || tick < lastTickRef.current) {
      const fromT = Math.max(0, tick - 30);
      const fresh = window.generateLogsForRange(episode, Math.floor(fromT), Math.floor(tick), 6);
      setLogs(fresh.slice(-200));
    } else if (tick > lastTickRef.current) {
      const fresh = window.generateLogsForRange(episode, Math.floor(lastTickRef.current), Math.floor(tick), 6);
      if (fresh.length) {
        setLogs(prev => prev.concat(fresh).slice(-200));
      }
    }
    lastTickRef.current = tick;
  }, [tick, episode]);

  const [filter, setFilter] = useState('');
  const [levelFilter, setLevelFilter] = useState('ALL');
  const [follow, setFollow] = useState(true);
  const ref = useRef(null);
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
          <span className={`ln-dot ${running ? 'ln-dot-live' : ''}`} /> Logs at {fmtTime(Math.round(tick))}
        </div>
        <div className="ln-logs-counts">
          <span className="ln-pill ln-pill-info">{counts.INFO}</span>
          <span className="ln-pill ln-pill-warn">{counts.WARN}</span>
          <span className="ln-pill ln-pill-err">{counts.ERROR}</span>
        </div>
      </div>
      <div className="ln-logs-toolbar">
        <input className="ln-input" placeholder="Filter logs…"
               value={filter} onChange={(e) => setFilter(e.target.value)} />
        <div className="ln-seg">
          {['ALL', 'INFO', 'WARN', 'ERROR'].map(l => (
            <button key={l} className={levelFilter === l ? 'is-on' : ''}
                    onClick={() => setLevelFilter(l)}>{l}</button>
          ))}
        </div>
        <button className={`ln-follow ${follow ? 'is-on' : ''}`} onClick={() => setFollow(f => !f)}>
          <span className="ln-dot" /> Tail
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

Object.assign(window, { Ruler, AnomalyTrack, EventsTrack, ServicesTrack, Playhead, EpisodeCanvas, ScrubbedLogs, fmtTime, tickToX, xToTick, TRACK_HEIGHTS });
