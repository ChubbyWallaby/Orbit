'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { constrainMoon, previewLimit, trace, SATELLITE_RADIUS, type Level, type Placement, type TraceResult, type Vec } from '@/game/engine';
import { HELPER_ORDER, HELPERS, MAX_SHOTS, msUntilNextPuzzle, scoreFor, shareText, type HelperId } from '@/game/rules';
import type { OrbitScene } from '@/game/scene';
import type { GhostHint, TodayPayload } from '@/server/game';
import type { Play, Streak } from '@/server/store';
import Leaderboard from './Leaderboard';

type Status = { text: string; kind?: 'good' | 'bad' };

async function api<T>(url: string, body?: unknown): Promise<T> {
  const r = await fetch(url, body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error || 'Could not reach the server. Check your connection and try again.'), { status: r.status });
  return j as T;
}

const placementKey = (day: string) => `orbit:placement:${day}`;
function loadPlacement(level: Level): Placement {
  try {
    const raw = localStorage.getItem(placementKey(level.day));
    if (raw) {
      const p = JSON.parse(raw) as Placement;
      if (p?.moon && Number.isFinite(p.moon.x) && Number.isFinite(p.angle)) return p;
    }
  } catch { /* storage unavailable */ }
  return { moon: { ...level.moon.start }, angle: level.moon.startAngle, satellite: null };
}

const START_TEXT = 'Drag the moon into the beam. Turn its mirror. Light the beacon.';

/** What is special about today's level, if anything. */
function todaysPiece(level: Level): { label: string; intro: string } | null {
  const bh = level.bodies.find((b) => b.kind === 'blackhole');
  if (bh) return { label: `Black hole · ${bh.name}`, intro: `Today: black hole ${bh.name}. It bends light hard, and light that gets too close never comes back.` };
  if (level.splitters?.length) return { label: 'Beam splitter', intro: 'Today: a beam splitter. It splits the laser in two. Either beam can light the beacon.' };
  if (level.wormholes?.length) return { label: 'Wormhole pair', intro: 'Today: a wormhole pair. Light that enters one mouth leaves the other, still heading the same way.' };
  return null;
}

export default function Game() {
  const hostRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<OrbitScene | null>(null);
  const [glError, setGlError] = useState(false);
  const [data, setData] = useState<TodayPayload | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [placement, setPlacement] = useState<Placement | null>(null);
  const [play, setPlay] = useState<Play>({ shots: [], helpers: [], status: 'playing', score: 0 });
  const [streak, setStreak] = useState<Streak>({ current: 0, best: 0 });
  const [ghost, setGhost] = useState<GhostHint | null>(null);
  const [name, setName] = useState<string | null>(null);
  const [nameOpen, setNameOpen] = useState(false);
  const [boardOpen, setBoardOpen] = useState(false);
  const [resultOpen, setResultOpen] = useState(false);
  const [helpersOpen, setHelpersOpen] = useState(false);
  const [confirming, setConfirming] = useState<HelperId | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Status>({ text: START_TEXT });
  const pendingFire = useRef(false);

  const level = data?.level ?? null;
  const finished = play.status !== 'playing';
  const helpers = play.helpers;

  // create the 3D scene once
  useEffect(() => {
    let disposed = false;
    import('@/game/scene').then(({ OrbitScene }) => {
      if (disposed || !hostRef.current) return;
      try {
        sceneRef.current = new OrbitScene(hostRef.current, {
          onDrag: (which, pos: Vec) => setPlacement((p) => {
            if (!p) return p;
            return which === 'moon' ? { ...p, moon: pos } : { ...p, satellite: p.satellite ? { ...p.satellite, ...pos } : p.satellite };
          }),
        });
      } catch { setGlError(true); }
    });
    return () => { disposed = true; sceneRef.current?.dispose(); sceneRef.current = null; };
  }, []);

  // load today's puzzle
  useEffect(() => {
    api<TodayPayload>('/api/today').then((d) => {
      setData(d); setPlay(d.me.play); setGhost(d.ghost); setName(d.me.name); setStreak(d.me.streak);
      const piece = todaysPiece(d.level);
      if (piece) setStatus({ text: piece.intro });
      const p = loadPlacement(d.level);
      if (!d.me.play.helpers.includes('satellite')) p.satellite = null;
      setPlacement(p);
      if (!d.me.name) setNameOpen(true);
      if (d.me.play.status !== 'playing') {
        setStatus(d.me.play.status === 'won' ? { text: `You lit today’s beacon for ${d.me.play.score} points.`, kind: 'good' } : { text: 'The beacon stayed dark today. A new puzzle unlocks at midnight UTC.', kind: 'bad' });
      }
    }).catch((e) => setLoadError(e.message));
  }, []);

  // hand the level to the scene once both exist
  const [sceneReady, setSceneReady] = useState(false);
  useEffect(() => {
    const id = setInterval(() => { if (sceneRef.current) { setSceneReady(true); clearInterval(id); } }, 50);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    const s = sceneRef.current;
    if (!s || !level) return;
    s.setLevel(level); s.frame();
  }, [sceneReady, level]);

  const preview: TraceResult | null = useMemo(() => (level && placement ? trace(level, placement) : null), [level, placement]);

  useEffect(() => {
    const s = sceneRef.current;
    if (!s || !level || !placement || !preview) return;
    s.setPlacement(placement);
    s.locked = finished || busy;
    s.setWon(play.status === 'won');
    if (!busy) {
      if (finished) { s.setPreview(null, 0); s.showBeam(preview); }
      else { s.setPreview(preview, previewLimit(preview, helpers.includes('scanner'))); }
    }
    try { localStorage.setItem(placementKey(level.day), JSON.stringify(placement)); } catch { /* ignore */ }
  }, [sceneReady, level, placement, preview, helpers, finished, busy, play.status]);

  useEffect(() => { sceneRef.current?.setGhost(ghost); }, [sceneReady, ghost]);

  const fire = useCallback(async () => {
    if (!level || !placement || busy || finished) return;
    if (!name) { pendingFire.current = true; setNameOpen(true); return; }
    setBusy(true);
    setStatus({ text: 'Beam away…' });
    const s = sceneRef.current;
    s?.setPreview(null, 0); s?.clearBeam();
    try {
      const res = await api<{ result: TraceResult['result']; hitName: string | null; score: number; status: Play['status']; play: Play; streak: Streak }>('/api/shot', { placement });
      if (s && preview) await s.fire(preview);
      setPlay(res.play);
      setStreak(res.streak);
      const left = MAX_SHOTS - res.play.shots.length;
      const tail = left ? ` ${left} ${left === 1 ? 'shot' : 'shots'} left.` : '';
      if (res.result === 'hit') setStatus({ text: `Beacon lit! +${res.score} points.`, kind: 'good' });
      else if (res.result === 'absorbed') {
        const isHole = level.bodies.some((b) => b.kind === 'blackhole' && b.name === res.hitName);
        setStatus({ text: `${isHole ? 'Swallowed by black hole' : 'Pulled into'} ${res.hitName}.${tail}`, kind: 'bad' });
      }
      else if (res.result === 'rock') setStatus({ text: `Blocked by the asteroid belt.${tail}`, kind: 'bad' });
      else setStatus({ text: `Lost in deep space.${tail}`, kind: 'bad' });
      if (res.status !== 'playing') {
        if (res.status === 'lost') setStatus({ text: 'Out of shots. The beacon stays dark today.', kind: 'bad' });
        setTimeout(() => setResultOpen(true), 900);
      }
    } catch (e) {
      const err = e as Error & { status?: number };
      if (err.status === 401) { setName(null); pendingFire.current = true; setNameOpen(true); }
      setStatus({ text: err.message, kind: 'bad' });
    } finally {
      setBusy(false);
    }
  }, [level, placement, busy, finished, name, preview]);

  const applyHelper = async (id: HelperId) => {
    if (!level || !placement || finished || helpers.includes(id)) return;
    if (!name) { setNameOpen(true); return; }
    if (confirming !== id) { setConfirming(id); return; }
    setConfirming(null);
    try {
      const r = await api<{ helpers: HelperId[]; ghost: GhostHint | null }>('/api/helper', { helper: id });
      setPlay((p) => ({ ...p, helpers: r.helpers }));
      setHelpersOpen(false);
      setGhost(r.ghost);
      if (id === 'satellite') {
        const pos = constrainMoon(level, { x: placement.moon.x + 6, z: placement.moon.z }, SATELLITE_RADIUS);
        setPlacement({ ...placement, satellite: { x: Math.round(pos.x * 100) / 100, z: Math.round(pos.z * 100) / 100, angle: 0 } });
        setStatus({ text: 'Mirror satellite deployed. Drag it and turn it with its dial.' });
      } else if (id === 'ghost') setStatus({ text: 'The ghost ring marks where the moon can solve it.' });
      else setStatus({ text: 'Scanner on. The aiming line now reaches much further.' });
    } catch (e) { setStatus({ text: (e as Error).message, kind: 'bad' }); }
  };

  const nextScore = scoreFor(Math.min(play.shots.length + 1, MAX_SHOTS), helpers);

  if (loadError) return <div className="nogl">{loadError}</div>;
  return (
    <>
      <div className="scene" ref={hostRef} aria-label="3D view of today’s puzzle" />
      {glError && <div className="nogl">Orbit needs WebGL, which is turned off in this browser.</div>}

      <header className="hud top">
        <div className="brand">
          <h1 className="wordmark">ORB<span>I</span>T</h1>
          {level && todaysPiece(level) && <div className="meta piece">{todaysPiece(level)!.label}</div>}
          <div className="meta">{level ? `Daily #${level.number} · ${new Date(level.day + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })}` : 'Loading today’s puzzle…'}</div>
        </div>
        <div className="right">
          <div className="pips" aria-label={`${MAX_SHOTS - play.shots.length} shots left`}>
            {Array.from({ length: MAX_SHOTS }, (_, i) => <span key={i} className={`pip ${play.shots[i] === 'hit' ? 'won' : play.shots[i] ? 'used' : ''}`} />)}
          </div>
          <div className="row" style={{ gap: 6 }}>
            {streak.current > 0 && <span className="chip streak" title={`Best streak: ${streak.best}`}>Streak {streak.current}</span>}
            <button className="chip" onClick={() => setBoardOpen(true)}>Leaderboard</button>
          </div>
        </div>
      </header>

      {level && (
        <aside className={`hud helpers ${helpersOpen ? '' : 'closed'}`} aria-label="Helpers">
          <button className="chip helpers-toggle" onClick={() => setHelpersOpen((o) => !o)} aria-expanded={helpersOpen}>
            Helpers {helpers.length ? `(${helpers.length})` : ''}
          </button>
          <h2>Helpers · cost points if you win</h2>
          {HELPER_ORDER.map((id) => {
            const on = helpers.includes(id);
            return (
              <button key={id} className={`helper ${on ? 'on' : ''} ${confirming === id ? 'confirm' : ''}`} disabled={on || finished || busy}
                onClick={() => applyHelper(id)} onBlur={() => confirming === id && setConfirming(null)}>
                <span className="hn">{HELPERS[id].name}</span>
                <span className="hc">{on ? 'in use' : `−${HELPERS[id].cost}`}</span>
                <span className="hb">{confirming === id ? `Tap again to use it. Your score drops by ${HELPERS[id].cost}.` : HELPERS[id].blurb}</span>
              </button>
            );
          })}
        </aside>
      )}

      <div className="hud bottom">
        <div className={`status ${status.kind ?? ''}`} role="status">{status.text}</div>
        {level && placement && (
          <div className="console">
            <div className="dial">
              <label htmlFor="mirror">Moon mirror</label>
              <input type="range" id="mirror" min={0} max={359} value={placement.angle} disabled={finished || busy}
                onChange={(e) => setPlacement({ ...placement, angle: +e.target.value })} />
              <output htmlFor="mirror">{placement.angle}°</output>
            </div>
            {placement.satellite && (
              <div className="dial">
                <label htmlFor="sat">Satellite</label>
                <input type="range" id="sat" min={0} max={359} value={placement.satellite.angle} disabled={finished || busy}
                  onChange={(e) => setPlacement({ ...placement, satellite: { ...placement.satellite!, angle: +e.target.value } })} />
                <output htmlFor="sat">{placement.satellite.angle}°</output>
              </div>
            )}
            <div className="row">
              {finished ? (
                <>
                  <div className="potential">{play.status === 'won' ? <>Today: <b>{play.score} pts</b></> : 'No points today.'} Next puzzle in <Countdown /></div>
                  <button className="btn primary" onClick={() => setResultOpen(true)}>Your result</button>
                </>
              ) : (
                <>
                  <div className="potential">A hit now scores <b>{nextScore} pts</b>{helpers.length ? ` (helpers −${helpers.reduce((s, h) => s + HELPERS[h].cost, 0)})` : ''}</div>
                  <button className="btn" disabled={busy} onClick={() => { setPlacement({ moon: { ...level.moon.start }, angle: level.moon.startAngle, satellite: placement.satellite ? { ...placement.satellite } : null }); setStatus({ text: START_TEXT }); }}>Reset moon</button>
                  <button className="btn fire" disabled={busy} onClick={fire}>Fire</button>
                </>
              )}
            </div>
          </div>
        )}
      </div>

      {nameOpen && (
        <NameDialog
          initial={name ?? ''}
          onDone={(n) => { setName(n); setNameOpen(false); if (pendingFire.current) { pendingFire.current = false; setStatus({ text: `Welcome aboard, ${n}. Press Fire when ready.` }); } }}
          onSkip={() => { setNameOpen(false); pendingFire.current = false; }}
        />
      )}
      {resultOpen && level && <ResultCard level={level} play={play} streak={streak} onClose={() => setResultOpen(false)} onBoard={() => { setResultOpen(false); setBoardOpen(true); }} />}
      {boardOpen && <Leaderboard puzzleNumber={level?.number ?? 1} onClose={() => setBoardOpen(false)} />}
    </>
  );
}

function NameDialog({ initial, onDone, onSkip }: { initial: string; onDone: (name: string) => void; onSkip: () => void }) {
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true); setError(null);
    try { const r = await api<{ name: string }>('/api/player', { name: value }); onDone(r.name); }
    catch (err) { setError((err as Error).message); }
    finally { setSaving(false); }
  };
  return (
    <div className="overlay">
      <form className="card" onSubmit={submit} aria-labelledby="introTitle">
        <h2 id="introTitle">One puzzle a day</h2>
        <ol>
          <li><b>Drag the moon</b> and <b>turn its mirror</b> so the laser bounces into the green beacon.</li>
          <li>Light bends near planets. The dashed line only shows the start of the beam.</li>
          <li>You get <b>3 shots</b>: a hit scores 1,000, 700 or 400. Helpers cost points.</li>
          <li>Everyone plays the same puzzle. Points add up on the all-time leaderboard.</li>
        </ol>
        <div className="field">
          <label htmlFor="pilot">Pilot name for the leaderboard</label>
          <input id="pilot" autoFocus maxLength={16} value={value} onChange={(e) => setValue(e.target.value)} placeholder="e.g. Nova" autoComplete="nickname" />
        </div>
        {error && <p className="err">{error}</p>}
        <div className="row">
          <button type="button" className="btn" onClick={onSkip}>Look around first</button>
          <button type="submit" className="btn primary" disabled={saving || value.trim().length < 2}>{saving ? 'Saving…' : 'Start playing'}</button>
        </div>
      </form>
    </div>
  );
}

function Countdown() {
  const [ms, setMs] = useState(() => msUntilNextPuzzle());
  useEffect(() => { const id = setInterval(() => setMs(msUntilNextPuzzle()), 1000); return () => clearInterval(id); }, []);
  const s = Math.floor(ms / 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return <b>{pad(Math.floor(s / 3600))}:{pad(Math.floor((s % 3600) / 60))}:{pad(s % 60)}</b>;
}

function ResultCard({ level, play, streak, onClose, onBoard }: { level: Level; play: Play; streak: Streak; onClose: () => void; onBoard: () => void }) {
  const text = shareText({ number: level.number, shots: play.shots, score: play.score, helpers: play.helpers, streak: streak.current });
  const [copied, setCopied] = useState('Copy result');
  const shareRef = useRef<HTMLDivElement>(null);
  const [rank, setRank] = useState<{ day: number | null; all: number | null; players: number } | null>(null);
  useEffect(() => {
    Promise.all([api<{ me: { rank: number } | null; players: number }>('/api/leaderboard?scope=day'), api<{ me: { rank: number } | null }>('/api/leaderboard?scope=all')])
      .then(([d, a]) => setRank({ day: d.me?.rank ?? null, all: a.me?.rank ?? null, players: d.players }))
      .catch(() => setRank(null));
  }, []);
  const copy = () => {
    navigator.clipboard.writeText(text).then(() => { setCopied('Copied'); setTimeout(() => setCopied('Copy result'), 1600); }, () => {
      const r = document.createRange(); r.selectNodeContents(shareRef.current!); const s = getSelection()!; s.removeAllRanges(); s.addRange(r);
      setCopied('Press Ctrl+C');
    });
  };
  const won = play.status === 'won';
  return (
    <div className="overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`card ${won ? 'win' : ''}`} role="dialog" aria-labelledby="resTitle">
        <h2 id="resTitle">{won ? 'Beacon lit' : 'Beacon dark'}</h2>
        {won ? <div className="big">{play.score}<small>pts</small></div> : <p>All three shots missed, so your streak resets. The game still counts on the leaderboard, and a new puzzle unlocks at midnight UTC.</p>}
        <div className="facts">
          <span><b>{play.shots.length}/{MAX_SHOTS}</b>shots</span>
          <span><b>{streak.current}</b>day streak</span>
          <span><b>{rank?.day ? `#${rank.day}` : '–'}</b>today{rank ? ` of ${rank.players}` : ''}</span>
          <span><b>{rank?.all ? `#${rank.all}` : '–'}</b>all time</span>
        </div>
        <div className="share" ref={shareRef}>{text}</div>
        <div className="row">
          <button className="btn primary" onClick={copy}>{copied}</button>
          <button className="btn" onClick={onBoard}>Leaderboard</button>
        </div>
        <p>Next puzzle in <Countdown /></p>
      </div>
    </div>
  );
}
