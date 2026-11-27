import { applyHelper } from '@/server/game';
import { body, ensurePid, handle } from '@/server/http';

export async function POST(req: Request) {
  return handle(async () => {
    const { helper, day } = await body(req);
    const pid = await ensurePid();
    return { ...(await applyHelper(pid, helper, day)), pid };
  });
}
