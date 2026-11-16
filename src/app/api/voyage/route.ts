import { after, type NextRequest } from 'next/server';
import { voyage, voyageLevelFor, voyageShot, voyageToWarm } from '@/server/game';
import { body, ensurePid, handle, readPid } from '@/server/http';

// GET ?n=12 opens a Voyage level (default: the furthest one open). POST fires a shot at one.
export async function GET(req: NextRequest) {
  const pid = await readPid(req); // outside handle() so Next.js can see the request is dynamic
  return handle(async () => {
    const res = await voyage(pid, req.nextUrl.searchParams.get('n'));
    // past the prebuilt levels, make the next one now so the player does not wait for it
    after(async () => { for (const n of voyageToWarm(res.n)) await voyageLevelFor(n).catch(() => {}); });
    return res;
  });
}

export async function POST(req: Request) {
  return handle(async () => {
    const { n, placement } = await body(req);
    const pid = await ensurePid();
    return { ...(await voyageShot(pid, n, placement)), pid };
  });
}
