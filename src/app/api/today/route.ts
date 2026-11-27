import type { NextRequest } from 'next/server';
import { today } from '@/server/game';
import { ensurePid, handle, readPid } from '@/server/http';

// ?day=YYYY-MM-DD opens a past day from the archive
export async function GET(req: NextRequest) {
  const known = await readPid(req); // outside handle() so Next.js can see the request is dynamic
  return handle(async () => {
    // a new visitor gets a player id now, so the server knows when they first saw the board
    // (a win sooner than MIN_SOLVE_MS after that is turned away as a script)
    const pid = known ?? (await ensurePid());
    return { ...(await today(pid, req.nextUrl.searchParams.get('day'))), pid };
  });
}
