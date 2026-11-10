import { setName } from '@/server/game';
import { body, ensurePid, handle } from '@/server/http';

export async function POST(req: Request) {
  return handle(async () => {
    const { name } = await body(req);
    const pid = await ensurePid();
    return { name: await setName(pid, name) };
  });
}
