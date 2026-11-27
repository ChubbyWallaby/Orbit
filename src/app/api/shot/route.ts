import { shoot } from '@/server/game';
import { body, ensurePid, handle } from '@/server/http';

export async function POST(req: Request) {
  return handle(async () => {
    const { placement, day, moves, slow } = await body(req);
    // no pilot name is needed to play: a new visitor gets a player id (and today, a generated name)
    const pid = await ensurePid();
    return { ...(await shoot(pid, placement, day, { moves, slow })), pid };
  });
}
