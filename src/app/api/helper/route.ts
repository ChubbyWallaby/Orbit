import { applyHelper } from '@/server/game';
import { body, ensurePid, handle, readPid } from '@/server/http';

export async function POST(req: Request) {
  return handle(async () => {
    const { helper, day } = await body(req);
    const pid = day ? await ensurePid() : await readPid();
    return { ...(await applyHelper(pid, helper, day)), pid };
  });
}
