import type { NextRequest } from 'next/server';
import { today } from '@/server/game';
import { handle, readPid } from '@/server/http';

// ?day=YYYY-MM-DD opens a past day from the archive
export async function GET(req: NextRequest) {
  const pid = await readPid(req); // outside handle() so Next.js can see the request is dynamic
  return handle(async () => today(pid, req.nextUrl.searchParams.get('day')));
}
