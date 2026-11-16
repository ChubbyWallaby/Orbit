'use client';
import { useEffect, useState } from 'react';
import { chapterOf } from '@/game/voyage-spec';
import type { ArchiveDay, VoyagePayload } from '@/server/game';
import { pidHeaders } from './pid';

export type Mode = { kind: 'daily' } | { kind: 'archive'; day: string } | { kind: 'voyage'; n?: number };
type Tab = 'voyage' | 'archive';

async function get<T>(url: string): Promise<T> {
  const r = await fetch(url, { headers: pidHeaders() });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'Could not reach the server. Check your connection and try again.');
  return j as T;
}

const dateLabel = (day: string) => new Date(day + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
export const starText = (n: number) => '★'.repeat(n) + '☆'.repeat(3 - n);

/** Voyage (an endless run of levels) and the archive of past days, for after today's puzzle. */
export default function MorePuzzles({ initial, mode, onGo, onClose }: { initial: Tab; mode: Mode; onGo: (m: Mode) => void; onClose: () => void }) {
  const [tab, setTab] = useState<Tab>(initial);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="card board more" role="dialog" aria-labelledby="moreTitle">
        <div className="board-head">
          <h2 id="moreTitle">More puzzles</h2>
          <button className="btn" onClick={onClose}>Close</button>
        </div>
        <div className="tabs" role="tablist">
          <button role="tab" aria-selected={tab === 'voyage'} onClick={() => setTab('voyage')}>Voyage</button>
          <button role="tab" aria-selected={tab === 'archive'} onClick={() => setTab('archive')}>Past days</button>
        </div>
        {tab === 'voyage' ? <VoyageMap mode={mode} onGo={onGo} /> : <ArchiveList mode={mode} onGo={onGo} />}
      </div>
    </div>
  );
}

function VoyageMap({ mode, onGo }: { mode: Mode; onGo: (m: Mode) => void }) {
  const [v, setV] = useState<Pick<VoyagePayload, 'unlocked' | 'stars'> | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { get<VoyagePayload>('/api/voyage').then(setV, (e) => setError(e.message)); }, []);
  if (error) return <p className="err">{error}</p>;
  if (!v) return <p className="empty">Loading…</p>;
  const total = Object.values(v.stars).reduce((s, x) => s + x, 0);
  // every level open so far, plus a few locked ones ahead, grouped by chapter
  const shown = Array.from({ length: Math.max(v.unlocked + 3, 9) }, (_, i) => i + 1);
  const groups: { name: string; levels: number[] }[] = [];
  for (const n of shown) {
    const name = chapterOf(n);
    if (groups.at(-1)?.name !== name) groups.push({ name, levels: [] });
    groups.at(-1)!.levels.push(n);
  }
  const here = mode.kind === 'voyage' ? mode.n : undefined;
  return (
    <>
      <p>Levels that get harder as you go. Each one brings in something new. Clear a level to open the next; fewer shots earn more stars. Voyage does not count for the leaderboard.</p>
      <div className="row">
        <div className="potential">Level <b>{v.unlocked}</b> reached · <b>{total}</b> stars</div>
        <button className="btn primary" onClick={() => onGo({ kind: 'voyage', n: v.unlocked })}>{v.unlocked > 1 ? `Continue · level ${v.unlocked}` : 'Start Voyage'}</button>
      </div>
      <div className="table-wrap">
        {groups.map((g, gi) => (
          <section key={gi} className="chapter">
            <h3>{g.name}</h3>
            <div className="levels">
              {g.levels.map((n) => {
                const open = n <= v.unlocked;
                const stars = v.stars[n] ?? 0;
                return (
                  <button key={n} className={`lvl ${stars ? 'done' : ''} ${n === here ? 'here' : ''}`} disabled={!open}
                    onClick={() => onGo({ kind: 'voyage', n })} aria-label={open ? `Level ${n}${stars ? `, ${stars} of 3 stars` : ''}` : `Level ${n}, locked`}>
                    <span className="ln">{n}</span>
                    <span className="ls">{open ? (stars ? starText(stars) : 'new') : 'locked'}</span>
                  </button>
                );
              })}
            </div>
          </section>
        ))}
      </div>
    </>
  );
}

function ArchiveList({ mode, onGo }: { mode: Mode; onGo: (m: Mode) => void }) {
  const [days, setDays] = useState<ArchiveDay[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { get<{ days: ArchiveDay[] }>('/api/archive').then((r) => setDays(r.days), (e) => setError(e.message)); }, []);
  if (error) return <p className="err">{error}</p>;
  if (!days) return <p className="empty">Loading…</p>;
  const open = days.filter((d) => d.status === 'open').length;
  return (
    <>
      <p>Every earlier daily puzzle. Play the ones you missed: they don’t count for the leaderboard or your streak.{days.length ? ` ${open} of ${days.length} not played yet.` : ''}</p>
      <div className="table-wrap">
        {days.length === 0 ? <p className="empty">No past days yet. Come back tomorrow.</p> : (
          <ul className="days">
            <li><button className={mode.kind === 'daily' ? 'here' : ''} onClick={() => onGo({ kind: 'daily' })}><span>Today’s puzzle</span><span className="ds">daily</span></button></li>
            {days.map((d) => (
              <li key={d.day}>
                <button className={mode.kind === 'archive' && mode.day === d.day ? 'here' : ''} onClick={() => onGo({ kind: 'archive', day: d.day })}>
                  <span>#{d.number} · {dateLabel(d.day)}</span>
                  <span className={`ds ${d.status}`}>{d.status === 'won' ? `lit · ${d.score} pts` : d.status === 'lost' ? 'dark' : 'play'}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
