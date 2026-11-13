import { setName } from '@/server/game';
import { body, ensurePid, handle } from '@/server/http';

export async function POST(req: Request) {
  return handle(async () => {
    const { name } = await body(req);
    const pid = await ensurePid();
    // the page keeps the id too, for browsers that block cookies inside an iframe
    return { name: await setName(pid, name), pid };
  });
}
