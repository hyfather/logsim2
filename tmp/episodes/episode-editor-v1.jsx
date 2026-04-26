/* global React */
// Episode Editor app — top-level

const { useState, useRef, useEffect, useCallback } = React;

const NARRATIVE_SUGGESTIONS = [
  'Normal traffic, then volumetric DDoS, then WAF mitigation',
  'Database deadlock cascade during peak load',
  'Phishing → C2 beacon → lateral movement → containment',
  'Memory leak in api service over 30 minutes',
  'Ransomware: file encryption spike across fileserver',
  'Slow read replica causing query timeouts',
];

function AIModal({ open, onClose, onCreate }) {
  const [prompt, setPrompt] = useState('');
  const [stage, setStage] = useState('input'); // input | generating | done
  const [activeStep, setActiveStep] = useState(0);
  const STEPS = ['Parsing intent', 'Designing topology', 'Generating segments', 'Seeding events & anomalies'];

  useEffect(() => {
    if (stage !== 'generating') return;
    let i = 0;
    const id = setInterval(() => {
      i++;
      setActiveStep(i);
      if (i >= STEPS.length) {
        clearInterval(id);
        setTimeout(() => onCreate(prompt), 400);
      }
    }, 700);
    return () => clearInterval(id);
  }, [stage, prompt, onCreate]);

  if (!open) return null;
  return (
    <div className="le-ai-overlay" onClick={onClose}>
      <div className="le-ai-modal" onClick={(e) => e.stopPropagation()}>
        <div className="le-ai-head">
          <div className="le-ai-icon">✦</div>
          <div>
            <h2>Generate episode with AI</h2>
            <p>Describe the narrative arc and we'll scaffold segments, events, and a topology.</p>
          </div>
        </div>
        <div className="le-ai-body">
          {stage === 'input' && (
            <>
              <textarea className="le-ai-prompt" placeholder="e.g. A microservice gets DDoS'd at peak hours, on-call deploys WAF rules, services recover after 5 minutes…"
                        value={prompt} onChange={(e) => setPrompt(e.target.value)} autoFocus />
              <div className="le-ai-suggestions">
                {NARRATIVE_SUGGESTIONS.map(s => (
                  <button key={s} className="le-ai-suggestion" onClick={() => setPrompt(s)}>{s}</button>
                ))}
              </div>
            </>
          )}
          {stage === 'generating' && (
            <div className="le-ai-progress">
              {STEPS.map((s, i) => (
                <div key={i} className={`le-ai-step ${i < activeStep ? 'is-done' : i === activeStep ? 'is-active' : ''}`}>
                  <div className="le-ai-step-dot">{i < activeStep ? '✓' : ''}</div>
                  {s}
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="le-ai-foot">
          <button className="ln-btn" onClick={onClose}>Cancel</button>
          <button className="ln-btn ln-btn-primary" disabled={!prompt.trim() || stage !== 'input'}
                  onClick={() => setStage('generating')}>
            Generate episode
          </button>
        </div>
      </div>
    </div>
  );
}

function EpisodeEditor() {
  const [episode, setEpisode] = useState(window.EPISODE_LIBRARY[0]);
  const [selectedSegmentId, setSelectedSegmentId] = useState(episode.segments[0].id);
  const [tick, setTick] = useState(0);
  const [running, setRunning] = useState(false);
  const [pxPerTick, setPxPerTick] = useState(0.85);
  const [aiOpen, setAiOpen] = useState(false);
  const [view, setView] = useState('edit'); // edit | run
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

  // Auto-update selected segment based on playhead during run
  useEffect(() => {
    if (view !== 'run') return;
    const seg = window.segmentAt(episode, tick);
    if (seg && seg.id !== selectedSegmentId) setSelectedSegmentId(seg.id);
  }, [tick, view, episode, selectedSegmentId]);

  // Scrub on timeline body click
  const tlBodyRef = useRef(null);
  const onTlClick = useCallback((e) => {
    if (e.target.closest('.le-segment')) return;
    if (e.target.closest('.le-event')) return;
    if (e.target.closest('.le-playhead-handle')) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left + e.currentTarget.scrollLeft - 90; // 90 = label col
    const t = Math.max(0, Math.min(episode.duration, x / pxPerTick));
    setTick(t);
  }, [pxPerTick, episode.duration]);

  const selectedSegment = episode.segments.find(s => s.id === selectedSegmentId);
  const intensity = window.logIntensity(episode, tick);
  const widthPx = episode.duration * pxPerTick;

  const onAICreate = (prompt) => {
    // Pick the closest match in our library, or default to ddos
    const lower = prompt.toLowerCase();
    const match = lower.includes('phish') || lower.includes('c2') || lower.includes('lateral') || lower.includes('ransom') || lower.includes('ioc')
      ? 'ioc-investigation' : 'ddos-mitigation';
    const ep = window.EPISODE_LIBRARY.find(e => e.id === match);
    setEpisode({ ...ep, name: 'AI: ' + prompt.slice(0, 40) + (prompt.length > 40 ? '…' : '') });
    setSelectedSegmentId(ep.segments[0].id);
    setTick(0);
    setAiOpen(false);
  };

  return (
    <div className="le-app">
      {/* Topbar — reuses ln- styles */}
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
          <button className="ln-btn" onClick={() => setAiOpen(true)}>
            <span style={{ marginRight: 4 }}>✦</span> New with AI
          </button>
          <select className="ln-btn" value={episode.id} onChange={(e) => {
            const ep = window.EPISODE_LIBRARY.find(x => x.id === e.target.value);
            setEpisode(ep); setSelectedSegmentId(ep.segments[0].id); setTick(0);
          }}>
            {window.EPISODE_LIBRARY.map(ep => <option key={ep.id} value={ep.id}>{ep.name}</option>)}
          </select>
          <button className={`ln-btn ${view === 'run' ? 'ln-btn-primary' : ''}`} onClick={() => setView(v => v === 'edit' ? 'run' : 'edit')}>
            {view === 'edit' ? '▶ Run Episode' : '◀ Back to edit'}
          </button>
        </div>
      </header>

      <div className="le-shell">
        <div className="le-main">
          {/* Episode header */}
          <div className="le-ep-head">
            <input className="le-ep-name" value={episode.name}
                   onChange={(e) => setEpisode({ ...episode, name: e.target.value })} />
            <div className="le-ep-meta">
              <span>{episode.segments.length} segments</span>
              <span className="le-dot-sep" />
              <span>{episode.duration} ticks</span>
              <span className="le-dot-sep" />
              <span>~{window.fmtTime(episode.duration)}</span>
              <span className="le-dot-sep" />
              <span style={{ color: episode.domain === 'security' ? '#dc2626' : '#2563eb' }}>
                {episode.domain.toUpperCase()}
              </span>
            </div>
            <div className="le-ep-actions">
              <button className="ln-btn">⎘ Copy link</button>
              <button className="ln-btn">↻ Reset</button>
            </div>
          </div>

          {/* Timeline */}
          <div className="le-tl">
            <div className="le-tl-head">
              <div className="le-tl-title">
                <span>◐ Episode timeline</span>
              </div>
              <div className="le-tl-stats">
                {episode.segments.length} segments · {episode.events.length} events · {episode.anomalies.length} anomaly windows
              </div>
              <div className="le-tl-controls">
                <div className="le-tl-zoom">
                  <button onClick={() => setPxPerTick(p => Math.max(0.2, p / 1.4))}>−</button>
                  <span className="le-tl-zoom-val">{(pxPerTick * 100).toFixed(0)}%</span>
                  <button onClick={() => setPxPerTick(p => Math.min(3, p * 1.4))}>+</button>
                </div>
                <button className="ln-btn">+ Add segment</button>
              </div>
            </div>
            <div className="le-tl-body ls-scroll" ref={tlBodyRef} onClick={onTlClick}>
              <div style={{ position: 'relative', minWidth: widthPx + 90 }}>
                <div style={{ display: 'grid', gridTemplateColumns: '90px 1fr' }}>
                  <div /> <Ruler totalTicks={episode.duration} pxPerTick={pxPerTick} />
                </div>
                <div className="le-tl-tracks">
                  <div className="le-tl-track">
                    <div className="le-tl-track-label"><span className="le-tl-track-label-icon">◫</span> Services</div>
                    <window.ServicesTrack episode={episode} pxPerTick={pxPerTick}
                                          selectedId={selectedSegmentId} onSelect={(id) => { setSelectedSegmentId(id); const seg = episode.segments.find(s => s.id === id); if (seg) setTick(seg.start); }} />
                  </div>
                  <div className="le-tl-track">
                    <div className="le-tl-track-label"><span className="le-tl-track-label-icon">◆</span> Events</div>
                    <window.EventsTrack episode={episode} pxPerTick={pxPerTick} onSeek={setTick} />
                  </div>
                  <div className="le-tl-track">
                    <div className="le-tl-track-label"><span className="le-tl-track-label-icon">∿</span> Anomalies</div>
                    <window.AnomalyTrack episode={episode} pxPerTick={pxPerTick} />
                  </div>
                </div>
                <div style={{ position: 'absolute', top: 0, bottom: 0, left: 90, pointerEvents: 'none' }}>
                  <div style={{ position: 'absolute', top: 0, bottom: 0, pointerEvents: 'auto' }}>
                    <window.Playhead tick={tick} pxPerTick={pxPerTick} onScrub={(t) => setTick(Math.max(0, Math.min(episode.duration, t)))} />
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Selected segment info */}
          {selectedSegment && (
            <div className="le-seg-info">
              <div className="le-seg-label-row">
                <span className="le-seg-label-h">Selected segment</span>
                <div className="le-seg-name-row">
                  <span style={{ width: 10, height: 10, borderRadius: 2, background: selectedSegment.color, display: 'inline-block' }} />
                  <strong>{selectedSegment.name}</strong>
                </div>
              </div>
              <div className="le-seg-narrative">{selectedSegment.narrative}</div>
              <div className="le-seg-actions">
                <button className="ln-btn ln-btn-primary">⌗ Edit canvas</button>
                <button className="ln-btn">{ '{ }' } YAML</button>
                <button className="ln-btn">⑂ Fork</button>
              </div>
            </div>
          )}

          {/* Canvas */}
          <window.EpisodeCanvas episode={episode} segment={selectedSegment} intensity={intensity} running={running} />

          {/* Transport */}
          <div className="le-transport">
            <div className="le-transport-buttons">
              <button className="le-tt-btn" title="Jump to start" onClick={() => setTick(0)}>⏮</button>
              <button className="le-tt-btn" title="Step back" onClick={() => setTick(t => Math.max(0, t - 30))}>◀◀</button>
              <button className="le-tt-btn is-play" title={running ? 'Pause' : 'Play'} onClick={() => setRunning(r => !r)}>
                {running ? '❚❚' : '▶'}
              </button>
              <button className="le-tt-btn" title="Step forward" onClick={() => setTick(t => Math.min(episode.duration, t + 30))}>▶▶</button>
              <button className="le-tt-btn" title="Jump to end" onClick={() => setTick(episode.duration)}>⏭</button>
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
          <window.ScrubbedLogs episode={episode} tick={tick} running={running} />
        </div>
      </div>

      <AIModal open={aiOpen} onClose={() => setAiOpen(false)} onCreate={onAICreate} />
    </div>
  );
}

window.EpisodeEditor = EpisodeEditor;
