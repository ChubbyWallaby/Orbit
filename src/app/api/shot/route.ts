import { shoot } from '@/server/game';
import { body, handle, readPid } from '@/server/http';

export async function POST(req: Request) {
  return handle(async () => {
    const { placement } = await body(req);
    return shoot(await readPid(), placement);
  });
}
