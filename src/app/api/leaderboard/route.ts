import type { NextRequest } from 'next/server';
import { leaderboard } from '@/server/game';
import { handle, readPid } from '@/server/http';

export async function GET(req: NextRequest) {
  const pid = await readPid(req); // outside handle() so Next.js can see the request is dynamic
  return handle(async () => leaderboard(pid, req.nextUrl.searchParams.get('scope')));
}
