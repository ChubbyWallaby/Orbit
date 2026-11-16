import { shoot } from '@/server/game';
import { body, ensurePid, handle, readPid } from '@/server/http';

export async function POST(req: Request) {
  return handle(async () => {
    const { placement, day, moves, slow } = await body(req);
    // archive days need no pilot name, only a player id, so make one if needed
    const pid = day ? await ensurePid() : await readPid();
    return { ...(await shoot(pid, placement, day, { moves, slow })), pid };
  });
}
