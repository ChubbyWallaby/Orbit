'use client';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { constrainMoon, previewLimit, trace, orbitClock, withDestroyed, SATELLITE_RADIUS, type Level, type Placement, type TraceResult, type Vec } from '@/game/engine';
import { HELPER_ORDER, HELPERS, MAX_SHOTS, msUntilNextPuzzle, scoreFor, shareText, voyageShareText, missText, type HelperId } from '@/game/rules';
import type { OrbitScene } from '@/game/scene';
import type { TodayPayload, VoyageInfo, VoyagePayload } from '@/server/game';
import type { Play, Streak } from '@/server/store';
import { track } from '@vercel/analytics';
import Leaderboard from './Leaderboard';
import MorePuzzles, { starText, type Mode } from './MorePuzzles';
import { pidHeaders, savePid } from './pid';
import { pixelFirstPuzzleFinished, pixelPageView } from './pixel';

type Status = { text: string; kind?: 'good' | 'bad' };

async function api<T>(url: string, body?: unknown): Promise<T> {
  const r = await fetch(url, body === undefined
    ? { headers: pidHeaders() }
    : { method: 'POST', headers: { ...pidHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error || 'Could not reach the server. Check your connection and try again.'), { status: r.status });
  return j as T;
}

const placementKey = (day: string) => `orbit:placement:${day}`;
// how many times the pilot has dragged or turned something today; kept across reloads
const movesKey = (day: string) => `orbit:moves:${day}`;
function loadMoves(day: string): number {
  try { return Math.max(0, Number(localStorage.getItem(movesKey(day))) || 0); } catch { return 0; }
}
function loadPlacement(level: Level): Placement {
  try {
    const raw = localStorage.getItem(placementKey(level.day));
    if (raw) {
      const p = JSON.parse(raw) as Placement;
      if (p?.moon && Number.isFinite(p.moon.x) && Number.isFinite(p.angle)) {
        // a spot saved before the level changed (e.g. moons started orbiting) may no longer be allowed
        const off = (q: Vec, r?: number) => { const c = constrainMoon(level, q, r); return Math.hypot(c.x - q.x, c.z - q.z) > 0.01; };
        if (off(p.moon)) p.moon = { ...level.moon.start };
        if (p.satellite && off(p.satellite, SATELLITE_RADIUS)) {
          const c = constrainMoon(level, p.satellite, SATELLITE_RADIUS);
          p.satellite = { ...p.satellite, x: Math.round(c.x * 100) / 100, z: Math.round(c.z * 100) / 100 };
        }
        return p;
      }
    }
  } catch { /* storage unavailable */ }
  return { moon: { ...level.moon.start }, angle: level.moon.startAngle, satellite: null };
}

const START_TEXT = 'Drag the moon into the beam. Turn its mirror. Light the beacon.';

/** The page address says what is being played: today (/), a past day (?day=2026-11-12) or Voyage (?voyage=12). */
function modeFromSearch(search: string): Mode {
  const q = new URLSearchParams(search);
  const day = q.get('day');
  if (day && /^\d{4}-\d{2}-\d{2}$/.test(day)) return { kind: 'archive', day };
  if (q.has('voyage')) {
    const n = Number(q.get('voyage'));
    return { kind: 'voyage', n: Number.isInteger(n) && n >= 1 ? n : undefined };
  }
  return { kind: 'daily' };
}
function urlFor(mode: Mode): string {
  const q = new URLSearchParams(location.search);
  q.delete('day'); q.delete('voyage');
  if (mode.kind === 'archive') q.set('day', mode.day);
  if (mode.kind === 'voyage') q.set('voyage', String(mode.n ?? ''));
  const qs = q.toString();
  return location.pathname + (qs ? `?${qs}` : '') + location.hash;
}
const modeKey = (m: Mode) => (m.kind === 'archive' ? `day:${m.day}` : m.kind === 'voyage' ? `voyage:${m.n ?? ''}` : 'daily');
// the address changes on back/forward (popstate) and when the game moves to another puzzle (NAVIGATE)
const NAVIGATE = 'orbit:navigate';
function subscribeUrl(cb: () => void) {
  addEventListener('popstate', cb); addEventListener(NAVIGATE, cb);
  return () => { removeEventListener('popstate', cb); removeEventListener(NAVIGATE, cb); };
}
const freshPlay = (): Play => ({ shots: [], helpers: [], status: 'playing', score: 0, destroyed: [] });
type VoyageState = { n: number; unlocked: number; stars: Record<number, number>; info: VoyageInfo };
const dateText = (day: string) => new Date(day + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

/** A short description of today's board, e.g. "Ice giant · strong gravity · small mirror". */
function conditions(level: Level): string | null {
  const giant = level.bodies.find((b) => b.kind === 'giant' || b.kind === 'sun');
  if (!giant?.style) return null; // levels from before board variety
  const names: Record<string, string> = { amber: 'Gas giant', ice: 'Ice giant', lava: 'Lava world', toxic: 'Toxic giant', violet: 'Violet giant', sun: `Sun ${giant.name}` };
  const gravity = giant.kind === 'sun' ? 'very strong gravity' : giant.m >= 1 ? 'strong gravity' : giant.m < 0.7 ? 'weak gravity' : 'normal gravity';
  const parts = [names[giant.style] ?? 'Giant', gravity];
  const planets = level.bodies.filter((b) => b.kind === 'planet').length;
  const moons = level.bodies.filter((b) => b.kind === 'moonlet').length;
  const orbiting = level.bodies.some((b) => b.orbit?.laps);
  if (planets) parts.push(`${planets} ${planets === 1 ? 'planet' : 'planets'}`);
  if (moons) parts.push(`${moons} ${orbiting ? 'orbiting ' : ''}${moons === 1 ? 'moon' : 'moons'}`);
  if (level.mirrorHalf < 1.35) parts.push('small mirror');
  else if (level.mirrorHalf > 1.65) parts.push('wide mirror');
  return parts.join(' · ');
}

/** What is special about today's level: one entry per special piece. */
function todaysPieces(level: Level): { label: string; intro: string }[] {
  const out: { label: string; intro: string }[] = [];
  const bh = level.bodies.find((b) => b.kind === 'blackhole');
  if (bh) out.push({ label: `Black hole · ${bh.name}`, intro: `Black hole ${bh.name} bends light hard, and light that gets too close never comes back.` });
  const rp = level.bodies.find((b) => b.kind === 'repulsor');
  if (rp) out.push({ label: `Repulsor · ${rp.name}`, intro: `Repulsor ${rp.name} pushes light away instead of pulling it in.` });
  const extra = level.extraEmitters?.length ?? 0;
  if (extra) out.push({ label: `${extra + 1} laser stations`, intro: `${extra + 1} laser stations fire at once. Any beam that reaches the beacon wins, but not every station may have a way through.` });
  if (level.splitters?.length) out.push({ label: 'Beam splitter', intro: 'A beam splitter splits the laser in two. Either beam can light the beacon.' });
  if (level.wormholes?.length) out.push({ label: 'Wormhole pair', intro: 'Light that enters one wormhole mouth leaves the other, still heading the same way.' });
  if (level.mirrors?.length) {
    const n = level.mirrors.length;
    out.push({ label: n === 1 ? 'Fixed mirror' : `${n} fixed mirrors`, intro: `${n === 1 ? 'A fixed mirror' : `${n} fixed mirrors`} (gold frames) bounce the beam too. Use them for bank shots.` });
  }
  if (level.relays?.length && level.range) {
    out.push({ label: `Fading light · relay`, intro: `The light fades after ${Math.round(level.range)} units. The gold relay ring recharges it for another ${Math.round(level.range)}, so bounce it to the beacon within that reach.` });
  }
  return out;
}

function pieceIntro(level: Level, lead = 'Today:'): string | null {
  const pieces = todaysPieces(level);
  return pieces.length ? `${lead} ${pieces.map((p) => p.intro).join(' ')}` : null;
}

export default function Game() {
  const hostRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<OrbitScene | null>(null);
  const [glError, setGlError] = useState(false);
  const [data, setData] = useState<TodayPayload | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [placement, setPlacement] = useState<Placement | null>(null);
  const [play, setPlay] = useState<Play>({ shots: [], helpers: [], status: 'playing', score: 0, destroyed: [] });
  // asteroids blown up during practice (local only, never sent to the server)
  const [practiceDestroyed, setPracticeDestroyed] = useState<number[]>([]);
  const [streak, setStreak] = useState<Streak>({ current: 0, best: 0 });
  const [name, setName] = useState<string | null>(null);
  const [nameOpen, setNameOpen] = useState(false);
  const [boardOpen, setBoardOpen] = useState(false);
  const [resultOpen, setResultOpen] = useState(false);
  const [helpersOpen, setHelpersOpen] = useState(false);
  const [confirming, setConfirming] = useState<HelperId | null>(null);
  const [busy, setBusy] = useState(false);
  // after the daily game ends, players can keep firing locally; these shots never reach the server
  const [practice, setPractice] = useState(false);
  // the placement the beam on screen was fired from; moving anything clears that beam
  const beamFor = useRef<Placement | null>(null);
  // orbit clock for the aiming line, and the moment the moons are frozen at while a shot's beam shows
  const [orbitT, setOrbitT] = useState(0);
  const [heldT, setHeldT] = useState<number | null>(null);
  const [status, setStatus] = useState<Status>({ text: START_TEXT });
  const moves = useRef(0);
  const dayRef = useRef<string | null>(null);
  const clockOffset = useRef(0);
  const countMove = useCallback(() => {
    moves.current++;
    if (dayRef.current) try { localStorage.setItem(movesKey(dayRef.current), String(moves.current)); } catch { /* ignore */ }
  }, []);
  // what is being played comes from the address (null while the page is rendered on the server)
  const search = useSyncExternalStore(subscribeUrl, () => location.search, () => null);
  const mode = useMemo(() => (search === null ? null : modeFromSearch(search)), [search]);
  const [voy, setVoy] = useState<VoyageState | null>(null);
  const [moreOpen, setMoreOpen] = useState<'voyage' | 'archive' | null>(null);
  // the mode the puzzle on screen was loaded for; anything else means a new one is loading
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const loadedRef = useRef<string | null>(null);
  const loading = !mode || loadedFor !== modeKey(mode);

  const isVoyage = mode?.kind === 'voyage';
  const archiveDay = mode?.kind === 'archive' ? mode.day : undefined;
  const ranked = mode?.kind === 'daily';
  const level = data?.level ?? null;
  const finished = play.status !== 'playing';
  const canAim = !finished || practice;
  const helpers = play.helpers;
  const energized = helpers.includes('energized');
  const scanner = helpers.includes('scanner') || !!(isVoyage && voy?.info.scanner);
  const destroyed = useMemo(() => [...play.destroyed, ...practiceDestroyed], [play.destroyed, practiceDestroyed]);

  // create the 3D scene once
  useEffect(() => {
    let disposed = false;
    import('@/game/scene').then(({ OrbitScene }) => {
      if (disposed || !hostRef.current) return;
      try {
        sceneRef.current = new OrbitScene(hostRef.current, {
          onDrag: (which, pos: Vec) => { countMove(); setPlacement((p) => {
            if (!p) return p;
            return which === 'moon' ? { ...p, moon: pos } : { ...p, satellite: p.satellite ? { ...p.satellite, ...pos } : p.satellite };
          }); },
        });
      } catch { setGlError(true); }
    });
    return () => { disposed = true; sceneRef.current?.dispose(); sceneRef.current = null; };
  }, [countMove]);

  const go = useCallback((m: Mode) => {
    setMoreOpen(null); setResultOpen(false);
    history.pushState(null, '', urlFor(m));
    dispatchEvent(new Event(NAVIGATE));
    pixelPageView();
  }, []);

  // load the puzzle for the current mode
  useEffect(() => {
    if (!mode) return;
    const key = modeKey(mode);
    if (loadedRef.current === key) return; // already on screen (e.g. the address was just tidied up)
    let live = true;
    const show = (lvl: Level, p0: Play, intro: string | null, shownKey = key) => {
      // a new puzzle: nothing carries over from the last one
      setPractice(false); setPracticeDestroyed([]); setResultOpen(false); setConfirming(null); setLoadError(null);
      beamFor.current = null; setHeldT(null);
      sceneRef.current?.clearBeam();
      loadedRef.current = shownKey; setLoadedFor(shownKey);
      // drags and turns are counted per board (the server turns away wins nobody aimed)
      dayRef.current = lvl.day;
      moves.current = loadMoves(lvl.day);
      setData((d) => ({ level: lvl, me: { name: d?.me.name ?? null, play: p0, streak: d?.me.streak ?? { current: 0, best: 0 } }, archive: mode.kind === 'archive', now: d?.now ?? Date.now() }));
      setPlay(p0);
      setStatus({ text: intro ?? START_TEXT });
      const { t, ...p } = loadPlacement(lvl);
      if (!p0.helpers.includes('satellite')) p.satellite = null;
      // keep the moons where the last shot of a finished day found them
      if (p0.status !== 'playing') setHeldT(t ?? 0);
      setPlacement(p);
    };
    if (mode.kind === 'voyage') {
      const load = (n?: number): Promise<void> => api<VoyagePayload>(`/api/voyage${n ? `?n=${n}` : ''}`).then((v) => {
        if (!live) return;
        clockOffset.current = v.now - Date.now();
        setName(v.name);
        setVoy({ n: v.n, unlocked: v.unlocked, stars: v.stars, info: v.info });
        const shown: Mode = { kind: 'voyage', n: v.n };
        show(v.level, { ...freshPlay(), shots: v.shots }, `Level ${v.n} · ${v.info.chapter}. ${pieceIntro(v.level, 'New:') ?? START_TEXT}`, modeKey(shown));
        // the address names the level on screen, so a reload or a shared link opens the same one
        if (v.n !== mode.n) { history.replaceState(null, '', urlFor(shown)); dispatchEvent(new Event(NAVIGATE)); }
      }, (e) => {
        // a level that is not open yet (e.g. an old link): go to the furthest one instead
        if (n && (e as { status?: number }).status === 403) return load();
        throw e;
      });
      load(mode.n).catch((e) => live && setLoadError(e.message));
    } else {
      const day = mode.kind === 'archive' ? mode.day : undefined;
      api<TodayPayload & { pid?: string }>(`/api/today${day ? `?day=${day}` : ''}`).then((d) => {
        if (!live) return;
        savePid(d.pid);
        clockOffset.current = d.now - Date.now();
        setVoy(null);
        setName(d.me.name); setStreak(d.me.streak);
        show(d.level, d.me.play, pieceIntro(d.level, d.archive ? 'This day:' : 'Today:'));
        setData(d);
        if (d.me.play.status !== 'playing') {
          setStatus(d.archive
            ? (d.me.play.status === 'won' ? { text: `You lit this beacon for ${d.me.play.score} points.`, kind: 'good' } : { text: 'The beacon stayed dark on this day.', kind: 'bad' })
            : d.me.play.status === 'won' ? { text: `You lit today’s beacon for ${d.me.play.score} points.`, kind: 'good' } : { text: 'The beacon stayed dark today. A new puzzle unlocks at midnight UTC.', kind: 'bad' });
        }
      }).catch((e) => live && setLoadError(e.message));
    }
    return () => { live = false; };
  }, [mode]);

  // hand the level to the scene once both exist
  const [sceneReady, setSceneReady] = useState(false);
  useEffect(() => {
    const id = setInterval(() => { if (sceneRef.current) { setSceneReady(true); clearInterval(id); } }, 50);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    const s = sceneRef.current;
    if (!s || !level) return;
    s.clockOffset = clockOffset.current;
    s.setLevel(level); s.frame();
  }, [sceneReady, level]);

  const orbitNow = heldT ?? orbitT;
  const preview: TraceResult | null = useMemo(() => (level && placement ? trace(withDestroyed(level, destroyed), { ...placement, t: orbitNow }) : null), [level, placement, destroyed, orbitNow]);

  // orbiting moons: refresh the aiming line as they move, unless they are frozen for a beam on screen
  useEffect(() => {
    if (!level?.orbitPeriod || heldT !== null) return;
    const tick = () => setOrbitT(sceneRef.current?.orbitTime() ?? orbitClock(level, Date.now() + clockOffset.current));
    tick();
    const id = setInterval(tick, 100);
    return () => clearInterval(id);
  }, [level, heldT, sceneReady]);
  useEffect(() => { sceneRef.current?.holdOrbits(heldT); }, [sceneReady, heldT]);
  // moving anything clears the last shot's beam, so the moons can move again
  useEffect(() => {
    if (heldT !== null && canAim && !busy && beamFor.current !== placement) setHeldT(null);
  }, [heldT, canAim, busy, placement]);
  useEffect(() => {
    if (!level || !placement) return;
    try { localStorage.setItem(placementKey(level.day), JSON.stringify({ ...placement, t: heldT ?? undefined })); } catch { /* ignore */ }
  }, [level, placement, heldT]);

  useEffect(() => {
    const s = sceneRef.current;
    if (!s || !level || !placement || !preview) return;
    s.setPlacement(placement);
    s.locked = !canAim || busy;
    s.setWon(play.status === 'won');
    if (!busy) {
      if (!canAim) {
        // daily game over: show where the final shot went
        s.setPreview(null, 0); s.showBeam(preview);
      } else {
        if (beamFor.current !== placement) { s.clearBeam(); beamFor.current = null; }
        // while the last shot's beam is on screen it shows the path; otherwise show the aiming line
        s.setPreview(beamFor.current ? null : preview, previewLimit(preview, scanner));
      }
    }
  }, [sceneReady, level, placement, preview, scanner, canAim, busy, play.status]);

  useEffect(() => { sceneRef.current?.setDestroyed(destroyed); }, [sceneReady, level, destroyed]);

  const fire = useCallback(async () => {
    if (!level || !placement || busy || finished || loading) return;
    setBusy(true);
    setStatus({ text: 'Beam away…' });
    const s = sceneRef.current;
    s?.setPreview(null, 0); s?.clearBeam();
    // the moons freeze where they are when you fire, and the server traces the shot at that moment
    const t = s?.orbitTime() ?? 0;
    const shot: Placement = level.orbitPeriod ? { ...placement, t } : placement;
    setHeldT(t); s?.holdOrbits(t);
    try {
      const res = await api<{ result: TraceResult['result']; hitName: string | null; destroyed: number[]; score: number; status: Play['status']; play: Play; streak: Streak; pid: string; name: string | null }>('/api/shot', { placement: shot, moves: moves.current, slow: s?.slowOrbits ?? false, ...(archiveDay ? { day: archiveDay } : {}) });
      savePid(res.pid);
      // a new pilot gets a generated name with their first shot today; they can change it afterwards
      if (res.name) setName(res.name);
      const traced = trace(withDestroyed(level, destroyed), shot);
      if (s) await s.fire(traced, energized);
      beamFor.current = placement;
      setPlay(res.play);
      setStreak(res.streak);
      const left = MAX_SHOTS - res.play.shots.length;
      const tail = left ? ` ${left} ${left === 1 ? 'shot' : 'shots'} left.` : '';
      if (res.result === 'hit') setStatus({ text: `Beacon lit! +${res.score} points.`, kind: 'good' });
      // with a beam splitter, one beam can destroy an asteroid while the other goes elsewhere
      else if (res.destroyed.length) setStatus({ text: `Asteroid destroyed! The way is clearer for your next shot.${tail}`, kind: 'bad' });
      else setStatus({ text: `${missText(level, { ...res, rays: traced.rays })}${tail}`, kind: 'bad' });
      if (res.status !== 'playing') {
        track(archiveDay ? 'archive_finished' : 'finished', { result: res.status, shots: res.play.shots.length, helpers: res.play.helpers.length, score: res.score });
        pixelFirstPuzzleFinished(archiveDay ? 'archive' : 'daily');
        if (res.status === 'lost') setStatus({ text: archiveDay ? 'Out of shots. The beacon stays dark on this day.' : 'Out of shots. The beacon stays dark today.', kind: 'bad' });
        setTimeout(() => setResultOpen(true), 900);
      }
    } catch (e) {
      const err = e as Error & { status?: number };
      setHeldT(null);
      setStatus({ text: err.message, kind: 'bad' });
    } finally {
      setBusy(false);
    }
  }, [level, placement, busy, finished, loading, energized, destroyed, archiveDay]);

  // Voyage shots are checked on the server, which keeps the stars and opens the next level
  const voyageFire = async () => {
    if (!level || !placement || !voy || busy || finished || loading) return;
    setBusy(true);
    setStatus({ text: 'Beam away…' });
    const s = sceneRef.current;
    s?.setPreview(null, 0); s?.clearBeam();
    const t = s?.orbitTime() ?? 0;
    const shot: Placement = level.orbitPeriod ? { ...placement, t } : placement;
    setHeldT(t); s?.holdOrbits(t);
    try {
      const res = await api<{ result: TraceResult['result']; hitName: string | null; shots: string[]; status: Play['status']; stars: number; best: number; unlocked: number; starsByLevel: Record<number, number>; pid: string }>('/api/voyage', { n: voy.n, placement: shot, moves: moves.current, slow: s?.slowOrbits ?? false });
      savePid(res.pid);
      const traced = trace(level, shot);
      if (s) await s.fire(traced, false);
      beamFor.current = placement;
      setPlay({ ...freshPlay(), shots: res.shots, status: res.status, score: res.stars });
      setVoy({ ...voy, unlocked: res.unlocked, stars: res.starsByLevel });
      const left = MAX_SHOTS - res.shots.length;
      if (res.status === 'won') {
        track('voyage_cleared', { level: voy.n, stars: res.stars });
        pixelFirstPuzzleFinished('voyage');
        setStatus({ text: `Level ${voy.n} cleared! ${starText(res.stars)}`, kind: 'good' });
        setTimeout(() => setResultOpen(true), 900);
      } else if (res.status === 'lost') {
        track('voyage_failed', { level: voy.n });
        setStatus({ text: `${missText(level, { ...res, rays: traced.rays })} Out of shots. Try again: the level stays the same.`, kind: 'bad' });
      } else setStatus({ text: `${missText(level, { ...res, rays: traced.rays })} ${left} ${left === 1 ? 'shot' : 'shots'} left.`, kind: 'bad' });
    } catch (e) {
      setHeldT(null);
      setStatus({ text: (e as Error).message, kind: 'bad' });
    } finally {
      setBusy(false);
    }
  };

  /** A new attempt at the same Voyage level (after a win, to earn more stars, or after running out of shots). */
  const retryVoyage = () => {
    setResultOpen(false);
    setPlay(freshPlay());
    beamFor.current = null; setHeldT(null);
    sceneRef.current?.clearBeam();
    setStatus({ text: voy ? `Level ${voy.n}: three fresh shots.` : START_TEXT });
  };

  // practice shots are traced locally with the same physics and never sent to the server
  const practiceFire = async () => {
    if (!level || !placement || !preview || busy) return;
    setBusy(true);
    setStatus({ text: 'Practice beam away…' });
    const s = sceneRef.current;
    s?.setPreview(null, 0); s?.clearBeam();
    const t = s?.orbitTime() ?? 0;
    setHeldT(t); s?.holdOrbits(t);
    const res = trace(withDestroyed(level, destroyed), { ...placement, t });
    if (s) await s.fire(res, energized);
    if (energized && res.rocksHit.length) setPracticeDestroyed((d) => [...new Set([...d, ...res.rocksHit])]);
    beamFor.current = placement;
    if (res.result === 'hit') setStatus({ text: 'Practice: beacon lit! This one doesn’t count.', kind: 'good' });
    else if (energized && res.rocksHit.length) setStatus({ text: 'Practice: asteroid destroyed!', kind: 'bad' });
    else setStatus({ text: `Practice: ${missText(level, res)}`, kind: 'bad' });
    setBusy(false);
  };

  const startPractice = () => {
    track('practice_started');
    setResultOpen(false);
    setPractice(true);
    setStatus({ text: 'Practice mode: fire as often as you like. These shots don’t count toward the leaderboard.' });
  };

  const resetMoon = () => {
    if (!level || !placement) return;
    setPlacement({ moon: { ...level.moon.start }, angle: level.moon.startAngle, satellite: placement.satellite ? { ...placement.satellite } : null });
    if (!practice) setStatus({ text: START_TEXT });
  };

  const applyHelper = async (id: HelperId) => {
    if (!level || !placement || finished || helpers.includes(id) || isVoyage) return;
    if (confirming !== id) { setConfirming(id); return; }
    setConfirming(null);
    try {
      const r = await api<{ helpers: HelperId[]; pid: string; name: string | null }>('/api/helper', { helper: id, ...(archiveDay ? { day: archiveDay } : {}) });
      savePid(r.pid);
      if (r.name) setName(r.name);
      setPlay((p) => ({ ...p, helpers: r.helpers }));
      track('helper_used', { helper: id });
      setHelpersOpen(false);
      if (id === 'satellite') {
        const pos = constrainMoon(level, { x: placement.moon.x + 6, z: placement.moon.z }, SATELLITE_RADIUS);
        setPlacement({ ...placement, satellite: { x: Math.round(pos.x * 100) / 100, z: Math.round(pos.z * 100) / 100, angle: 0 } });
        setStatus({ text: 'Mirror satellite deployed. Drag it and turn it with its dial.' });
      } else if (id === 'energized') setStatus({ text: 'Laser energized. Any asteroid it hits will explode.' });
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
          {level && todaysPieces(level).length > 0 && <div className="meta piece">{todaysPieces(level).map((p) => p.label).join(' + ')}</div>}
          {level && conditions(level) && <div className="meta wrap">{conditions(level)}</div>}
          <div className={`meta ${isVoyage || archiveDay ? 'mode' : ''}`}>
            {!level || loading ? 'Loading the puzzle…'
              : isVoyage && voy ? `Voyage · Level ${voy.n} · ${voy.info.chapter}${voy.stars[voy.n] ? ` · best ${starText(voy.stars[voy.n])}` : ''}`
              : archiveDay ? `Archive · Daily #${level.number} · ${dateText(level.day)}`
              : `Daily #${level.number} · ${dateText(level.day)}`}
          </div>
        </div>
        <div className="right">
          <div className="pips" aria-label={`${MAX_SHOTS - play.shots.length} shots left`}>
            {Array.from({ length: MAX_SHOTS }, (_, i) => <span key={i} className={`pip ${play.shots[i] === 'hit' ? 'won' : play.shots[i] ? 'used' : ''}`} />)}
          </div>
          <div className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
            {ranked && streak.current > 0 && <span className="chip streak" title={`Best streak: ${streak.best}`}>Streak {streak.current}</span>}
            {mode && !ranked && <button className="chip" onClick={() => go({ kind: 'daily' })}>Today</button>}
            <button className="chip more-chip" onClick={() => setMoreOpen(isVoyage ? 'voyage' : archiveDay ? 'archive' : 'voyage')}>More puzzles</button>
            <button className="chip" onClick={() => setBoardOpen(true)}>Leaderboard</button>
          </div>
        </div>
      </header>

      {level && !isVoyage && (
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
              <input type="range" id="mirror" min={0} max={359} value={placement.angle} disabled={!canAim || busy}
                onChange={(e) => { countMove(); setPlacement({ ...placement, angle: +e.target.value }); }} />
              <output htmlFor="mirror">{placement.angle}°</output>
            </div>
            {placement.satellite && (
              <div className="dial">
                <label htmlFor="sat">Satellite</label>
                <input type="range" id="sat" min={0} max={359} value={placement.satellite.angle} disabled={!canAim || busy}
                  onChange={(e) => { countMove(); setPlacement({ ...placement, satellite: { ...placement.satellite!, angle: +e.target.value } }); }} />
                <output htmlFor="sat">{placement.satellite.angle}°</output>
              </div>
            )}
            <div className="row">
              {isVoyage && voy ? (
                play.status === 'won' ? (
                  <>
                    <div className="potential">Level {voy.n} cleared · <b>{starText(play.score)}</b></div>
                    <button className="btn" disabled={busy} onClick={retryVoyage}>Replay</button>
                    <button className="btn primary" disabled={busy} onClick={() => go({ kind: 'voyage', n: voy.n + 1 })}>Next level</button>
                  </>
                ) : play.status === 'lost' ? (
                  <>
                    <div className="potential">Out of shots on level {voy.n}.</div>
                    <button className="btn" onClick={() => setMoreOpen('voyage')}>Levels</button>
                    <button className="btn primary" onClick={retryVoyage}>Try again</button>
                  </>
                ) : (
                  <>
                    <div className="potential">A hit now earns <b>{starText(Math.max(1, MAX_SHOTS - play.shots.length))}</b>{voy.info.scanner ? ' · long aiming line on this level' : ''}</div>
                    <button className="btn" disabled={busy} onClick={resetMoon}>Reset moon</button>
                    <button className="btn fire" disabled={busy || loading} onClick={voyageFire}>Fire</button>
                  </>
                )
              ) : finished && practice ? (
                <>
                  <div className="potential"><b>Practice</b> · shots don’t count. {archiveDay ? 'This day' : 'Today'}: {play.status === 'won' ? `${play.score} pts` : 'no points'}</div>
                  <button className="btn" disabled={busy} onClick={resetMoon}>Reset moon</button>
                  <button className="btn" disabled={busy} onClick={() => setResultOpen(true)}>Your result</button>
                  <button className="btn fire" disabled={busy} onClick={practiceFire}>Practice shot</button>
                </>
              ) : finished ? (
                <>
                  {archiveDay
                    ? <div className="potential">{play.status === 'won' ? <>This day: <b>{play.score} pts</b></> : 'No points on this day.'} Archive games don’t count for the leaderboard.</div>
                    : <div className="potential">{play.status === 'won' ? <>Today: <b>{play.score} pts</b></> : 'No points today.'} Next puzzle in <Countdown /></div>}
                  <button className="btn" onClick={() => setResultOpen(true)}>Your result</button>
                  <button className="btn" onClick={startPractice}>Practise</button>
                  <button className="btn primary" onClick={() => setMoreOpen(archiveDay ? 'archive' : 'voyage')}>More puzzles</button>
                </>
              ) : (
                <>
                  <div className="potential">A hit now scores <b>{nextScore} pts</b>{helpers.length ? ` (helpers −${helpers.reduce((s, h) => s + HELPERS[h].cost, 0)})` : ''}{archiveDay ? ' · archive, not ranked' : ''}</div>
                  <button className="btn" disabled={busy} onClick={resetMoon}>Reset moon</button>
                  <button className="btn fire" disabled={busy || loading} onClick={fire}>Fire</button>
                </>
              )}
            </div>
          </div>
        )}
      </div>

      {nameOpen && (
        <NameDialog
          voyage={isVoyage}
          initial={name ?? ''}
          onDone={(n) => { setName(n); setNameOpen(false); }}
          onSkip={() => setNameOpen(false)}
        />
      )}
      {resultOpen && level && isVoyage && voy && play.status === 'won' && (
        <VoyageResult n={voy.n} stars={play.score} total={Object.values(voy.stars).reduce((a, b) => a + b, 0)} named={!!name}
          onJoin={() => { setResultOpen(false); setNameOpen(true); }} onBoard={() => { setResultOpen(false); setBoardOpen(true); }} onNext={() => go({ kind: 'voyage', n: voy.n + 1 })} onReplay={retryVoyage} onLevels={() => { setResultOpen(false); setMoreOpen('voyage'); }} onClose={() => setResultOpen(false)} />
      )}
      {resultOpen && level && !isVoyage && <ResultCard level={level} play={play} streak={streak} practice={practice} archive={!!archiveDay} name={name} onRename={() => { setResultOpen(false); setNameOpen(true); }} onPractice={startPractice} onMore={() => { setResultOpen(false); setMoreOpen(archiveDay ? 'archive' : 'voyage'); }} onClose={() => setResultOpen(false)} onBoard={() => { setResultOpen(false); setBoardOpen(true); }} />}
      {boardOpen && <Leaderboard puzzleNumber={ranked ? level?.number ?? 1 : undefined} initial={isVoyage ? 'voyage' : 'all'}
        onJoin={name ? undefined : () => { setBoardOpen(false); setNameOpen(true); }} onClose={() => setBoardOpen(false)} />}
      {moreOpen && mode && <MorePuzzles initial={moreOpen} mode={mode} onGo={go} onClose={() => setMoreOpen(null)} />}
    </>
  );
}

function NameDialog({ initial, voyage, onDone, onSkip }: { initial: string; voyage?: boolean; onDone: (name: string) => void; onSkip: () => void }) {
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true); setError(null);
    try { const r = await api<{ name: string; pid: string }>('/api/player', { name: value }); savePid(r.pid); onDone(r.name); }
    catch (err) { setError((err as Error).message); }
    finally { setSaving(false); }
  };
  return (
    <div className="overlay">
      <form className="card" onSubmit={submit} aria-labelledby="introTitle">
        <h2 id="introTitle">{initial ? 'Your pilot name' : voyage ? 'Join the leaderboard' : 'One puzzle a day'}</h2>
        {initial ? <p>You are on the leaderboard as <b>{initial}</b>. Pick a name of your own; your points and streak stay with you.</p>
          : voyage ? <p>Pick a pilot name to put your Voyage stars on the leaderboard. Stars you already earned count too.</p> : <ol>
          <li><b>Drag the moon</b> and <b>turn its mirror</b> so the laser bounces into the green beacon.</li>
          <li>Light bends near planets. The dashed line only shows the start of the beam.</li>
          <li>You get <b>3 shots</b>: a hit scores 1,000, 700 or 400. Helpers cost points.</li>
          <li>Everyone plays the same puzzle. Points add up on the all-time leaderboard.</li>
          <li>Want more? <b>Voyage</b> is an endless run of levels, and <b>past days</b> stay playable.</li>
        </ol>}
        <div className="field">
          <label htmlFor="pilot">Pilot name for the leaderboard</label>
          <input id="pilot" autoFocus maxLength={16} value={value} onChange={(e) => setValue(e.target.value)} placeholder="e.g. Nova" autoComplete="nickname" />
        </div>
        {error && <p className="err">{error}</p>}
        <div className="row">
          <button type="button" className="btn" onClick={onSkip}>{initial || voyage ? 'Not now' : 'Look around first'}</button>
          <button type="submit" className="btn primary" disabled={saving || value.trim().length < 2}>{saving ? 'Saving…' : initial ? 'Save name' : 'Start playing'}</button>
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

function ResultCard({ level, play, streak, practice, archive, name, onRename, onPractice, onMore, onClose, onBoard }: { level: Level; play: Play; streak: Streak; practice: boolean; archive: boolean; name: string | null; onRename: () => void; onPractice: () => void; onMore: () => void; onClose: () => void; onBoard: () => void }) {
  const text = shareText({ number: level.number, shots: play.shots, score: play.score, helpers: play.helpers, streak: streak.current, archive });
  const [copied, setCopied] = useState('Copy result');
  const shareRef = useRef<HTMLDivElement>(null);
  const [rank, setRank] = useState<{ day: number | null; all: number | null; players: number } | null>(null);
  useEffect(() => {
    if (archive) return; // archive games have no rank
    Promise.all([api<{ me: { rank: number } | null; players: number }>('/api/leaderboard?scope=day'), api<{ me: { rank: number } | null }>('/api/leaderboard?scope=all')])
      .then(([d, a]) => setRank({ day: d.me?.rank ?? null, all: a.me?.rank ?? null, players: d.players }))
      .catch(() => setRank(null));
  }, [archive]);
  const copy = () => {
    track('shared', { result: play.status, archive });
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
        {won ? <div className="big">{play.score}<small>pts</small></div> : <p>{archive
          ? 'All three shots missed. Archive games don’t count for the leaderboard or your streak.'
          : 'All three shots missed, so your streak resets. The game still counts on the leaderboard, and a new puzzle unlocks at midnight UTC.'}</p>}
        <div className="facts">
          <span><b>{play.shots.length}/{MAX_SHOTS}</b>shots</span>
          {archive ? <span><b>#{level.number}</b>{dateText(level.day)}</span> : <>
            <span><b>{streak.current}</b>day streak</span>
            <span><b>{rank?.day ? `#${rank.day}` : '–'}</b>today{rank ? ` of ${rank.players}` : ''}</span>
            <span><b>{rank?.all ? `#${rank.all}` : '–'}</b>all time</span>
          </>}
        </div>
        {!archive && name && (
          <div className="row">
            <p style={{ flex: 1 }}>On the leaderboard as <b>{name}</b>.</p>
            <button className="btn" onClick={onRename}>Change name</button>
          </div>
        )}
        <div className="share" ref={shareRef}>{text}</div>
        <div className="row">
          <button className="btn primary" onClick={copy}>{copied}</button>
          {archive ? <button className="btn" onClick={onMore}>Past days</button> : <button className="btn" onClick={onBoard}>Leaderboard</button>}
        </div>
        {!archive && <button className="btn more-cta" onClick={onMore}>Want more? Play Voyage or past days</button>}
        {!practice && <button className="btn" onClick={onPractice}>Keep practising (doesn’t count)</button>}
        {!archive && <p>Next puzzle in <Countdown /></p>}
      </div>
    </div>
  );
}

function VoyageResult({ n, stars, total, named, onJoin, onBoard, onNext, onReplay, onLevels, onClose }: { n: number; stars: number; total: number; named: boolean; onJoin: () => void; onBoard: () => void; onNext: () => void; onReplay: () => void; onLevels: () => void; onClose: () => void }) {
  const [copied, setCopied] = useState('Copy result');
  const copy = () => {
    track('shared', { result: 'voyage' });
    navigator.clipboard.writeText(voyageShareText(n, stars)).then(() => { setCopied('Copied'); setTimeout(() => setCopied('Copy result'), 1600); }, () => setCopied('Could not copy'));
  };
  return (
    <div className="overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="card win" role="dialog" aria-labelledby="voyTitle">
        <h2 id="voyTitle">Level {n} cleared</h2>
        <div className="big stars" aria-label={`${stars} of 3 stars`}>{starText(stars)}</div>
        <p>{stars === 3 ? 'First shot. Perfect.' : `Clear it on the ${stars === 2 ? 'first shot' : 'first or second shot'} for more stars, or keep going.`} {total} {total === 1 ? 'star' : 'stars'} in all.</p>
        {named
          ? <button className="btn" onClick={onBoard}>Voyage leaderboard</button>
          : <button className="btn more-cta" onClick={onJoin}>Pick a pilot name to join the Voyage leaderboard</button>}
        <button className="btn primary" autoFocus onClick={onNext}>Next level</button>
        <div className="row">
          <button className="btn" onClick={onReplay}>Replay</button>
          <button className="btn" onClick={onLevels}>All levels</button>
          <button className="btn" onClick={copy}>{copied}</button>
        </div>
      </div>
    </div>
  );
}
