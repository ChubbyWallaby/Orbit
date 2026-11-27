'use client';
import { PID_HEADER } from '@/server/pid';
import { identifyPlayer } from './analytics';

// A copy of the player id in page storage, sent as a header. Inside an iframe (itch.io,
// CrazyGames) some browsers block our cookie even when it is partitioned; storage still works.
const KEY = 'orbit:pid';

export function savePid(pid: unknown) {
  if (typeof pid !== 'string') return;
  try { localStorage.setItem(KEY, pid); } catch { /* storage unavailable */ }
  identifyPlayer(pid);
}

/** The player id this page stored earlier, if any. */
export function storedPid(): string | null {
  try { return localStorage.getItem(KEY); } catch { return null; }
}

export function pidHeaders(): Record<string, string> {
  const pid = storedPid();
  return pid ? { [PID_HEADER]: pid } : {};
}
