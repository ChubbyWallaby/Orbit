'use client';
import { PID_HEADER } from '@/server/pid';

// A copy of the player id in page storage, sent as a header. Inside an iframe (itch.io,
// CrazyGames) some browsers block our cookie even when it is partitioned; storage still works.
const KEY = 'orbit:pid';

export function savePid(pid: unknown) {
  if (typeof pid !== 'string') return;
  try { localStorage.setItem(KEY, pid); } catch { /* storage unavailable */ }
}

export function pidHeaders(): Record<string, string> {
  try {
    const pid = localStorage.getItem(KEY);
    return pid ? { [PID_HEADER]: pid } : {};
  } catch {
    return {};
  }
}
