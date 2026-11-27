'use client';
import { useEffect, useState } from 'react';
import type { BoardEntry } from '@/server/store';
import { capture } from './analytics';
import { pidHeaders } from './pid';

type Scope = 'all' | 'day' | 'voyage';
type Board = { scope: Scope; top: BoardEntry[]; around: BoardEntry[]; me: BoardEntry | null; players: number };

export default function Leaderboard({ onClose, puzzleNumber, initial = 'all', onJoin }: { onClose: () => void; puzzleNumber?: number; initial?: Scope; onJoin?: () => void }) {
  const [scope, setScope] = useState<Scope>(initial);
  const [board, setBoard] = useState<Board | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    capture('leaderboard_viewed', { scope });
    fetch(`/api/leaderboard?scope=${scope}`, { headers: pidHeaders() })
      .then(async (r) => { const j = await r.json(); if (!r.ok) throw new Error(j.error); return j; })
      .then((j) => live && setBoard(j))
      .catch((e) => live && setError(e.message || 'Could not load the leaderboard.'));
    return () => { live = false; };
  }, [scope]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [onClose]);

  const pick = (s: Scope) => { if (s !== scope) { setBoard(null); setError(null); setScope(s); } };
  // a divider only when the block around you doesn't follow straight on from the top 10
  const around = board?.around ?? [];
  const gap = around.length > 0 && around[0].rank > (board?.top.at(-1)?.rank ?? 0) + 1;
  return (
    <div className="overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="card board" role="dialog" aria-labelledby="lbTitle">
        <div className="board-head">
          <h2 id="lbTitle">Leaderboard</h2>
          <button className="btn" onClick={onClose}>Close</button>
        </div>
        <div className="tabs" role="tablist">
          <button role="tab" aria-selected={scope === 'all'} onClick={() => pick('all')}>All time</button>
          <button role="tab" aria-selected={scope === 'day'} onClick={() => pick('day')}>Today{puzzleNumber ? ` · #${puzzleNumber}` : ''}</button>
          <button role="tab" aria-selected={scope === 'voyage'} onClick={() => pick('voyage')}>Voyage</button>
        </div>
        <p>
          {scope === 'all' ? 'Points added up over every daily puzzle played.' : scope === 'voyage' ? 'Stars earned in Voyage, best run per level. Ties go to more levels cleared.' : 'Scores for today’s puzzle. Resets at midnight UTC.'}
          {board ? ` ${board.players} ${board.players === 1 ? 'pilot' : 'pilots'}.` : ''}
        </p>
        <div className="table-wrap">
          {error ? <p className="err">{error}</p> : !board ? <p className="empty">Loading…</p> : board.top.length === 0 ? (
            <p className="empty">{scope === 'voyage' ? 'No stars yet. Clear a Voyage level to be the first.' : 'No scores yet. Finish today’s puzzle to be the first.'}</p>
          ) : (
            <table>
              <thead>{scope === 'voyage'
                ? <tr><th>#</th><th>Pilot</th><th className="num">Levels</th><th className="num">Stars</th></tr>
                : <tr><th>#</th><th>Pilot</th><th className="num">Games</th><th className="num" title="Longest run of days with the beacon lit">Best streak</th><th className="num">Points</th></tr>}</thead>
              <tbody>
                {board.top.map((e, i) => <Row key={i} e={e} voyage={scope === 'voyage'} />)}
                {gap && <tr className="gap"><td colSpan={5}>⋯</td></tr>}
                {around.map((e) => <Row key={`a${e.rank}`} e={e} voyage={scope === 'voyage'} />)}
              </tbody>
            </table>
          )}
        </div>
        {board && !board.me && (scope === 'voyage'
          ? <div className="row"><p style={{ flex: 1 }}>You are not on this board yet. Clear a Voyage level{onJoin ? ' with a pilot name' : ''} to get a rank.</p>{onJoin && <button className="btn" onClick={onJoin}>Pick a name</button>}</div>
          : <p>You are not on this board yet. Finish a puzzle to get a rank.</p>)}
      </div>
    </div>
  );
}

function Row({ e, voyage }: { e: BoardEntry; voyage: boolean }) {
  return (
    <tr className={e.you ? 'you' : ''}>
      <td className={`rank ${e.rank === 1 ? 'medal-1' : ''}`}>{e.rank}</td>
      <td>{e.name}{e.you ? ' (you)' : ''}</td>
      {voyage ? <>
        <td className="num">{e.games}</td>
        <td className="num">{e.score.toLocaleString('en')}</td>
      </> : <>
      <td className="num">{e.games}</td>
      <td className="num">{e.best}</td>
      <td className="num">{e.score.toLocaleString('en')}</td>
      </>}
    </tr>
  );
}
