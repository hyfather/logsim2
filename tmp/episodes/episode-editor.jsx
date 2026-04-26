/* global React */
// Episode Editor v2 — top-level shell

const { useState, useEffect, useRef, useCallback, useMemo } = React;

// ---------- AI: deterministic mock responses keyed off intent ----------
function aiProposeOutline(prompt) {
  const lower = (prompt || '').toLowerCase();
  if (lower.includes('phish') || lower.includes('c2') || lower.includes('lateral') || lower.includes('ransom')) {
    return [
      { tick: 0,    text: 'Baseline office traffic' },
      { tick: 400,  text: 'Phishing click' },
      { tick: 500,  text: 'Persistence established' },
      { tick: 700,  text: 'Lateral PsExec' },
      { tick: 850,  text: 'Cred dump' },
      { tick: 1000, text: 'Host isolated' },
      { tick: 1200, text: 'Forensics begin' },
    ];
  }
  if (lower.includes('database') || lower.includes('deadlock') || lower.includes('query')) {
    return [
      { tick: 0,    text: 'Normal load' },
      { tick: 300,  text: 'Long-running query' },
      { tick: 480,  text: 'Lock contention spreads' },
      { tick: 660,  text: 'Connection pool exhausted' },
      { tick: 900,  text: 'Failover begins' },
      { tick: 1080, text: 'Pool drained, recovery' },
    ];
  }
  // default: ddos-shaped arc
  return [
    { tick: 0,    text: 'Baseline traffic' },
    { tick: 300,  text: 'Recon scan' },
    { tick: 420,  text: 'DDoS starts' },
    { tick: 720,  text: 'api-1 fails' },
    { tick: 900,  text: 'WAF deployed' },
    { tick: 1080, text: 'Recovery' },
  ];
}

function aiProposeMarkerExpansion(episode, marker) {
  const text = marker.text.toLowerCase();
  const proposals = []; // [{ serviceId, block }]

  const findKind = (kinds) => episode.services.filter(s => kinds.includes(s.kind));
  const findId = (substr) => episode.services.filter(s => s.id.includes(substr) || s.label.includes(substr));

  if (text.includes('ddos') && text.includes('start')) {
    findKind(['nginx']).forEach(s => proposals.push({
      serviceId: s.id,
      block: window.makeBlock('under_attack', marker.tick, 480, { note: 'Volumetric flood from edge' }),
    }));
    findKind(['nodejs']).forEach((s, i) => proposals.push({
      serviceId: s.id,
      block: window.makeBlock('degraded', marker.tick + i * 80, 300, { note: 'Connection pool saturating' }),
    }));
  } else if (text.includes('fail') || text.includes('down') || text.includes('outage')) {
    const targets = findId(text.match(/[a-z]+-?\d*/)?.[0] || '');
    (targets.length ? targets : findKind(['nodejs'])).slice(0, 1).forEach(s => proposals.push({
      serviceId: s.id,
      block: window.makeBlock('down', marker.tick, 200, { customLog: 'health check failed (5xx)' }),
    }));
  } else if (text.includes('waf') || text.includes('mitigat') || text.includes('recover')) {
    episode.services.forEach(s => {
      const lanes = (episode.lanes && episode.lanes[s.id]) || [];
      const isUnhealthy = lanes.some(b => b.start <= marker.tick && b.start + b.duration > marker.tick && b.state !== 'healthy');
      if (isUnhealthy || s.kind === 'nginx') {
        proposals.push({
          serviceId: s.id,
          block: window.makeBlock('recovering', marker.tick, 200),
        });
      }
    });
  } else if (text.includes('phish') || text.includes('click')) {
    findKind(['virtual_server']).slice(0, 1).forEach(s => proposals.push({
      serviceId: s.id,
      block: window.makeBlock('compromised', marker.tick, 600, { customLog: 'C2 beacon → 185.220.101.42:443' }),
    }));
  } else if (text.includes('lateral') || text.includes('psexec')) {
    findKind(['virtual_server']).slice(1, 3).forEach(s => proposals.push({
      serviceId: s.id,
      block: window.makeBlock('under_attack', marker.tick, 200, { customLog: 'PsExec service install detected' }),
    }));
  } else if (text.includes('isolat') || text.includes('contain')) {
    findKind(['virtual_server']).slice(0, 1).forEach(s => proposals.push({
      serviceId: s.id,
      block: window.makeBlock('recovering', marker.tick, 300, { note: 'Host quarantined' }),
    }));
  } else if (text.includes('recon') || text.includes('scan')) {
    findKind(['nginx']).forEach(s => proposals.push({
      serviceId: s.id,
      block: window.makeBlock('degraded', marker.tick, 120, { errorRate: 0.02, logVolMul: 1.8, note: 'Scan probes' }),
    }));
  } else {
    // Generic: degrade the busiest-looking service for 180t
    const target = episode.services[0];
    if (target) proposals.push({
      serviceId: target.id,
      block: window.makeBlock('degraded', marker.tick, 180, { note: `Effect of: ${marker.text}` }),
    });
  }
  return proposals;
}

function aiProposeLaneFill(episode, service) {
  // Inspect existing narrative; create blocks aligned to nearby beats
  const sorted = [...episode.narrative].sort((a, b) => a.tick - b.tick);
  const out = [];
  for (let i = 0; i < sorted.length; i++) {
    const m = sorted[i];
    const next = sorted[i + 1];
    const dur = next ? next.tick - m.tick : Math.min(300, episode.duration - m.tick);
    const text = m.text.toLowerCase();
    let state = 'healthy';
    if (text.includes('start') || text.includes('attack') || text.includes('ddos')) state = service.kind === 'nginx' ? 'under_attack' : 'degraded';
    else if (text.includes('fail') || text.includes('down')) state = 'down';
    else if (text.includes('recover') || text.includes('waf') || text.includes('mitigat') || text.includes('isolat')) state = 'recovering';
    else if (text.includes('compromis') || text.includes('phish')) state = service.kind === 'virtual_server' ? 'compromised' : 'healthy';
    else if (text.includes('lateral') || text.includes('cred')) state = service.kind === 'virtual_server' ? 'under_attack' : 'healthy';
    if (state !== 'healthy') out.push(window.makeBlock(state, m.tick, dur, { note: `From: ${m.text}` }));
  }
  return out;
}

// ---------- Top-level Outline AI Modal ----------
function OutlineModal({ open, onClose, onApply }) {
  const [prompt, setPrompt] = useState('');
  const [stage, setStage] = useState('input'); // input | reviewing
  const [proposed, setProposed] = useState([]);

  if (!open) return null;

  const generate = () => {
    const arc = aiProposeOutline(prompt);
    setProposed(arc);
    setStage('reviewing');
  };

  const apply = () => {
    onApply(proposed);
    onClose();
    setStage('input');
    setPrompt('');
    setProposed([]);
  };

  return (
    <div className="le-ai-overlay" onClick={onClose}>
      <div className="le-ai-modal" onClick={(e) => e.stopPropagation()}>
        <div className="le-ai-head">
          <div className="le-ai-icon"><window.SparkleIcon size={18}/></div>
          <div>
            <h2>AI: Propose narrative arc</h2>
            <p>I'll suggest narrative beats only — you review them, then expand each into lane behaviors.</p>
          </div>
        </div>
        <div className="le-ai-body">
          {stage === 'input' && (
            <>
              <textarea className="le-ai-prompt" autoFocus
                placeholder="e.g. A microservice gets DDoS'd at peak hours, on-call deploys WAF rules, services recover after 5 minutes…"
                value={prompt} onChange={(e) => setPrompt(e.target.value)}/>
              <div className="le-ai-suggestions">
                {[
                  'DDoS → mitigation',
                  'Phishing → lateral movement → containment',
                  'Database deadlock during peak load',
                ].map(s => (
                  <button key={s} className="le-ai-suggestion" onClick={() => setPrompt(s)}>{s}</button>
                ))}
              </div>
            </>
          )}
          {stage === 'reviewing' && (
            <div className="le-ai-diff">
              <div className="le-ai-diff-head">Proposed narrative beats — review before applying:</div>
              <ul className="le-ai-diff-list">
                {proposed.map((m, i) => (
                  <li key={i} className="le-ai-diff-item le-ai-diff-add">
                    <span className="le-ai-diff-tick">{window.fmtTime(m.tick)}</span>
                    <input className="le-ai-diff-input" value={m.text}
                           onChange={(e) => {
                             const next = [...proposed];
                             next[i] = { ...next[i], text: e.target.value };
                             setProposed(next);
                           }}/>
                    <button className="le-ai-diff-x" onClick={() => setProposed(proposed.filter((_, j) => j !== i))}>×</button>
                  </li>
                ))}
              </ul>
              <div className="le-ai-diff-foot">{proposed.length} beats will be added. Existing narrative is preserved.</div>
            </div>
          )}
        </div>
        <div className="le-ai-foot">
          <button className="ln-btn" onClick={onClose}>Cancel</button>
          {stage === 'input' ? (
            <button className="ln-btn ln-btn-primary" disabled={!prompt.trim()} onClick={generate}>
              <window.SparkleIcon size={11}/> Propose arc
            </button>
          ) : (
            <>
              <button className="ln-btn" onClick={() => setStage('input')}>← Back</button>
              <button className="ln-btn ln-btn-primary" onClick={apply}>Apply {proposed.length} beats</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------- Marker Expansion AI Modal ----------
function MarkerExpandModal({ open, onClose, episode, marker, onApply }) {
  const [proposed, setProposed] = useState([]);
  useEffect(() => {
    if (open && marker) setProposed(window.aiProposeMarkerExpansion(episode, marker));
  }, [open, marker, episode]);

  if (!open || !marker) return null;
  const apply = () => { onApply(proposed.filter(p => p._enabled !== false)); onClose(); };

  return (
    <div className="le-ai-overlay" onClick={onClose}>
      <div className="le-ai-modal le-ai-modal-md" onClick={(e) => e.stopPropagation()}>
        <div className="le-ai-head">
          <div className="le-ai-icon"><window.SparkleIcon size={18}/></div>
          <div>
            <h2>AI: Expand "{marker.text}"</h2>
            <p>Proposed lane changes at <strong>{window.fmtTime(marker.tick)}</strong>. Review each before applying.</p>
          </div>
        </div>
        <div className="le-ai-body">
          {proposed.length === 0 && (
            <div className="le-ai-empty">No confident proposals for this beat. Try editing the marker text or fill lanes manually.</div>
          )}
          <ul className="le-ai-diff-list">
            {proposed.map((p, i) => {
              const svc = episode.services.find(s => s.id === p.serviceId);
              const meta = window.BEHAVIOR_STATES[p.block.state];
              const enabled = p._enabled !== false;
              return (
                <li key={i} className={`le-ai-diff-item le-ai-diff-add ${enabled ? '' : 'is-disabled'}`}>
                  <input type="checkbox" checked={enabled}
                         onChange={(e) => {
                           const next = [...proposed]; next[i] = { ...p, _enabled: e.target.checked }; setProposed(next);
                         }}/>
                  <span className="le-ai-diff-svc">{svc ? svc.label : p.serviceId}</span>
                  <span className="le-ai-diff-arrow">→</span>
                  <span className="le-ai-diff-state" style={{ background: meta.bg, color: meta.text, borderColor: meta.color }}>
                    <span style={{ color: meta.color }}>{meta.glyph}</span> {meta.label}
                  </span>
                  <span className="le-ai-diff-dur">for {p.block.duration}t</span>
                  {p.block.note && <span className="le-ai-diff-note">{p.block.note}</span>}
                </li>
              );
            })}
          </ul>
        </div>
        <div className="le-ai-foot">
          <button className="ln-btn" onClick={onClose}>Cancel</button>
          <button className="ln-btn ln-btn-primary" disabled={proposed.length === 0} onClick={apply}>
            Apply {proposed.filter(p => p._enabled !== false).length} blocks
          </button>
        </div>
      </div>
    </div>
  );
}

window.aiProposeMarkerExpansion = aiProposeMarkerExpansion;

// ---------- Main app ----------
function EpisodeEditor() {
  const [episode, setEpisode] = useState(() => JSON.parse(JSON.stringify(window.EPISODE_LIBRARY[0])));
  const [tick, setTick] = useState(0);
  const [running, setRunning] = useState(false);
  const [pxPerTick, setPxPerTick] = useState(0.85);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [markerExpand, setMarkerExpand] = useState(null); // marker
  const [selectedBlockId, setSelectedBlockId] = useState(null);
  const [speed, setSpeed] = useState(1);

  // Playback
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => {
      setTick(t => {
        const next = t + speed;
        if (next >= episode.duration) { setRunning(false); return episode.duration; }
        return next;
      });
    }, 100);
    return () => clearInterval(id);
  }, [running, speed, episode.duration]);

  const widthPx = episode.duration * pxPerTick;
  const lanesHeight = episode.services.length * (window.LANE_HEIGHT + 1);
  const totalHeight = window.NARR_TRACK_H + 22 + lanesHeight;

  const findBlock = (id) => {
    for (const sid of Object.keys(episode.lanes)) {
      const b = episode.lanes[sid].find(x => x.id === id);
      if (b) return { block: b, serviceId: sid };
    }
    return null;
  };
  const selected = selectedBlockId ? findBlock(selectedBlockId) : null;
  const selectedService = selected ? episode.services.find(s => s.id === selected.serviceId) : null;

  // Mutations
  const updateLanes = (mut) => setEpisode(prev => ({ ...prev, lanes: mut(prev.lanes) }));

  const updateBlock = (blockId, patch) => updateLanes(lanes => {
    const next = { ...lanes };
    for (const sid of Object.keys(next)) {
      next[sid] = next[sid].map(b => b.id === blockId ? { ...b, ...patch } : b);
    }
    return next;
  });
  const deleteBlock = (blockId) => {
    updateLanes(lanes => {
      const next = {};
      for (const sid of Object.keys(lanes)) next[sid] = lanes[sid].filter(b => b.id !== blockId);
      return next;
    });
    setSelectedBlockId(null);
  };
  const addBlock = (serviceId, tick) => {
    const block = window.makeBlock('degraded', tick, 180);
    updateLanes(lanes => ({ ...lanes, [serviceId]: [...(lanes[serviceId] || []), block] }));
    setSelectedBlockId(block.id);
  };

  const upsertNarrative = (m) => setEpisode(prev => {
    const exists = prev.narrative.find(x => x.id === m.id);
    return {
      ...prev,
      narrative: exists
        ? prev.narrative.map(x => x.id === m.id ? { ...x, ...m } : x)
        : [...prev.narrative, m].sort((a, b) => a.tick - b.tick),
    };
  });
  const deleteNarrative = (id) => setEpisode(prev => ({ ...prev, narrative: prev.narrative.filter(x => x.id !== id) }));

  const onAILaneFill = (service) => {
    const blocks = window.aiProposeLaneFill ? window.aiProposeLaneFill(episode, service) : aiProposeLaneFill(episode, service);
    if (blocks.length === 0) return;
    updateLanes(lanes => ({ ...lanes, [service.id]: [...(lanes[service.id] || []), ...blocks] }));
  };

  const applyOutline = (markers) => {
    setEpisode(prev => ({
      ...prev,
      narrative: [...prev.narrative, ...markers.map(m => ({ ...m, id: 'n-' + Math.random().toString(36).slice(2, 8) }))]
        .sort((a, b) => a.tick - b.tick),
    }));
  };

  const applyMarkerExpansion = (proposals) => {
    updateLanes(lanes => {
      const next = { ...lanes };
      proposals.forEach(p => {
        next[p.serviceId] = [...(next[p.serviceId] || []), p.block];
      });
      return next;
    });
  };

  return (
    <div className="le-app">
      {/* Topbar */}
      <header className="ln-topbar">
        <div className="ln-topbar-left">
          <div className="ln-logo">
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
              <rect x="2" y="2" width="7" height="7" rx="1.5" fill="var(--ls-accent)"/>
              <rect x="11" y="2" width="7" height="7" rx="1.5" fill="var(--ls-accent)" fillOpacity="0.4"/>
              <rect x="2" y="11" width="7" height="7" rx="1.5" fill="var(--ls-accent)" fillOpacity="0.4"/>
              <rect x="11" y="11" width="7" height="7" rx="1.5" fill="var(--ls-accent)"/>
            </svg>
            <span>logsim</span>
            <span className="ln-version">v2</span>
          </div>
          <div className="ln-breadcrumbs">
            <span>Workspace</span>
            <span className="ln-sep">/</span>
            <span>Episodes</span>
            <span className="ln-sep">/</span>
            <span className="ln-cur">{episode.name}</span>
          </div>
        </div>
        <div className="ln-topbar-tabs">
          <button onClick={() => window.open('Scenario Editor.html', '_self')}>Design</button>
          <button className="is-on">Episodes</button>
          <button>Datasets</button>
        </div>
        <div className="ln-topbar-right">
          <select className="ln-btn" value={episode.id} onChange={(e) => {
            const ep = window.EPISODE_LIBRARY.find(x => x.id === e.target.value);
            setEpisode(JSON.parse(JSON.stringify(ep)));
            setTick(0); setSelectedBlockId(null);
          }}>
            {window.EPISODE_LIBRARY.map(ep => <option key={ep.id} value={ep.id}>{ep.name}</option>)}
          </select>
          <button className={`ln-btn ${running ? 'ln-btn-primary' : ''}`} onClick={() => setRunning(r => !r)}>
            {running ? '❚❚ Pause' : '▶ Run'}
          </button>
        </div>
      </header>

      <div className="le-shell">
        <div className="le-main">
          {/* Episode header */}
          <div className="le-ep-head">
            <input className="le-ep-name" value={episode.name}
                   onChange={(e) => setEpisode({ ...episode, name: e.target.value })}/>
            <div className="le-ep-meta">
              <span>{episode.services.length} services</span>
              <span className="le-dot-sep"/>
              <span>{episode.narrative.length} beats</span>
              <span className="le-dot-sep"/>
              <span>{Object.values(episode.lanes).reduce((a, b) => a + b.length, 0)} blocks</span>
              <span className="le-dot-sep"/>
              <span>{episode.duration}t · ~{window.fmtTime(episode.duration)}</span>
            </div>
            <div className="le-ep-actions">
              <button className="ln-btn le-ai-btn" onClick={() => setOutlineOpen(true)}>
                <window.SparkleIcon size={11}/> AI: Propose arc
              </button>
              <button className="ln-btn">↻ Reset</button>
            </div>
          </div>

          {/* Timeline */}
          <div className="le-tl">
            <div className="le-tl-head">
              <div className="le-tl-title"><span>Episode timeline</span></div>
              <div className="le-tl-stats">
                Click a lane to add a behavior block · Click the narrative track to drop a beat
              </div>
              <div className="le-tl-controls">
                <div className="le-tl-zoom">
                  <button onClick={() => setPxPerTick(p => Math.max(0.2, p / 1.4))}>−</button>
                  <span className="le-tl-zoom-val">{(pxPerTick * 100).toFixed(0)}%</span>
                  <button onClick={() => setPxPerTick(p => Math.min(3, p * 1.4))}>+</button>
                </div>
              </div>
            </div>
            <div className="le-tl-body ls-scroll">
              <div style={{ position: 'relative', minWidth: widthPx + window.LABEL_COL }}>
                {/* Header grid: label col + ruler & narrative track */}
                <div style={{ display: 'grid', gridTemplateColumns: `${window.LABEL_COL}px 1fr` }}>
                  <div className="le-tl-corner">Narrative</div>
                  <div className="le-tl-narr-host">
                    <window.NarrativeTrack episode={episode} pxPerTick={pxPerTick}
                      onSeek={setTick}
                      onUpdate={upsertNarrative}
                      onDelete={deleteNarrative}
                      onAIExpand={(m) => setMarkerExpand(m)}/>
                  </div>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: `${window.LABEL_COL}px 1fr` }}>
                  <div/>
                  <window.Ruler totalTicks={episode.duration} pxPerTick={pxPerTick}/>
                </div>

                {/* Lanes */}
                <div className="le-lanes" style={{ position: 'relative' }}>
                  {episode.services.map(svc => (
                    <window.ServiceLane key={svc.id}
                      service={svc}
                      blocks={episode.lanes[svc.id] || []}
                      pxPerTick={pxPerTick}
                      episode={episode}
                      selectedBlock={selectedBlockId}
                      onSelectBlock={setSelectedBlockId}
                      onUpdateBlock={updateBlock}
                      onDeleteBlock={deleteBlock}
                      onAddBlock={(t) => addBlock(svc.id, t)}
                      onAILaneFill={onAILaneFill}/>
                  ))}
                  {/* Narrative guide lines overlay */}
                  <div style={{ position: 'absolute', top: 0, bottom: 0, left: window.LABEL_COL, right: 0, pointerEvents: 'none' }}>
                    <window.NarrativeGuides episode={episode} pxPerTick={pxPerTick} height={lanesHeight}/>
                  </div>
                </div>

                {/* Playhead — spans narrative + ruler + lanes */}
                <div style={{ position: 'absolute', top: 0, bottom: 0, left: window.LABEL_COL, pointerEvents: 'none' }}>
                  <div style={{ position: 'absolute', top: 0, bottom: 0, pointerEvents: 'auto' }}>
                    <window.Playhead tick={tick} pxPerTick={pxPerTick}
                      height={totalHeight}
                      onScrub={(t) => setTick(Math.max(0, Math.min(episode.duration, t)))}/>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Canvas */}
          <window.EpisodeCanvas episode={episode} tick={tick} running={running}/>

          {/* Transport */}
          <div className="le-transport">
            <div className="le-transport-buttons">
              <button className="le-tt-btn" onClick={() => setTick(0)}>⏮</button>
              <button className="le-tt-btn" onClick={() => setTick(t => Math.max(0, t - 30))}>◀◀</button>
              <button className="le-tt-btn is-play" onClick={() => setRunning(r => !r)}>
                {running ? '❚❚' : '▶'}
              </button>
              <button className="le-tt-btn" onClick={() => setTick(t => Math.min(episode.duration, t + 30))}>▶▶</button>
              <button className="le-tt-btn" onClick={() => setTick(episode.duration)}>⏭</button>
            </div>
            <div className="le-transport-time">
              {window.fmtTime(Math.round(tick))}<span className="le-tt-end"> / {window.fmtTime(episode.duration)}</span>
            </div>
            <div className="le-tt-speed">
              Speed
              <div className="ln-seg ln-seg-tight">
                {[1, 2, 4, 8].map(s => (
                  <button key={s} className={speed === s ? 'is-on' : ''} onClick={() => setSpeed(s)}>{s}×</button>
                ))}
              </div>
            </div>
          </div>
        </div>

        <div className="le-right">
          {selected ? (
            <window.BlockInspector
              block={selected.block}
              service={selectedService}
              onChange={(patch) => updateBlock(selected.block.id, patch)}
              onDelete={() => deleteBlock(selected.block.id)}
              onClose={() => setSelectedBlockId(null)}/>
          ) : (
            <window.ScrubbedLogs episode={episode} tick={tick} running={running}/>
          )}
        </div>
      </div>

      <OutlineModal open={outlineOpen} onClose={() => setOutlineOpen(false)} onApply={applyOutline}/>
      <MarkerExpandModal open={!!markerExpand} marker={markerExpand} episode={episode}
        onClose={() => setMarkerExpand(null)} onApply={applyMarkerExpansion}/>
    </div>
  );
}

window.aiProposeLaneFill = aiProposeLaneFill;
window.EpisodeEditor = EpisodeEditor;
