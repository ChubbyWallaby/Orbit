'use client';
import { useEffect, useState } from 'react';
import type { BoardEntry } from '@/server/store';

type Board = { scope: 'day' | 'all'; top: BoardEntry[]; me: BoardEntry | null; players: number };

export default function Leaderboard({ onClose, puzzleNumber }: { onClose: () => void; puzzleNumber: number }) {
  const [scope, setScope] = useState<'all' | 'day'>('all');
  const [board, setBoard] = useState<Board | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    fetch(`/api/leaderboard?scope=${scope}`)
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

  const pick = (s: 'all' | 'day') => { if (s !== scope) { setBoard(null); setError(null); setScope(s); } };
  const meOutside = board?.me && !board.top.some((e) => e.you);
  return (
    <div className="overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="card board" role="dialog" aria-labelledby="lbTitle">
        <div className="board-head">
          <h2 id="lbTitle">Leaderboard</h2>
          <button className="btn" onClick={onClose}>Close</button>
        </div>
        <div className="tabs" role="tablist">
          <button role="tab" aria-selected={scope === 'all'} onClick={() => pick('all')}>All time</button>
          <button role="tab" aria-selected={scope === 'day'} onClick={() => pick('day')}>Today · #{puzzleNumber}</button>
        </div>
        <p>
          {scope === 'all' ? 'Points added up over every daily puzzle played.' : 'Scores for today’s puzzle. Resets at midnight UTC.'}
          {board ? ` ${board.players} ${board.players === 1 ? 'pilot' : 'pilots'}.` : ''}
        </p>
        <div className="table-wrap">
          {error ? <p className="err">{error}</p> : !board ? <p className="empty">Loading…</p> : board.top.length === 0 ? (
            <p className="empty">No scores yet. Finish today’s puzzle to be the first.</p>
          ) : (
            <table>
              <thead><tr><th>#</th><th>Pilot</th><th className="num">Games</th><th className="num" title="Longest run of days with the beacon lit">Best streak</th><th className="num">Points</th></tr></thead>
              <tbody>
                {board.top.map((e, i) => <Row key={i} e={e} />)}
                {meOutside && <tr className="gap"><td colSpan={5}>⋯</td></tr>}
                {meOutside && board.me && <Row e={board.me} />}
              </tbody>
            </table>
          )}
        </div>
        {board && !board.me && <p>You are not on this board yet. Finish a puzzle to get a rank.</p>}
      </div>
    </div>
  );
}

function Row({ e }: { e: BoardEntry }) {
  return (
    <tr className={e.you ? 'you' : ''}>
      <td className={`rank ${e.rank === 1 ? 'medal-1' : ''}`}>{e.rank}</td>
      <td>{e.name}{e.you ? ' (you)' : ''}</td>
      <td className="num">{e.games}</td>
      <td className="num">{e.best}</td>
      <td className="num">{e.score.toLocaleString('en')}</td>
    </tr>
  );
}
