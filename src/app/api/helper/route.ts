import { applyHelper } from '@/server/game';
import { body, handle, readPid } from '@/server/http';

export async function POST(req: Request) {
  return handle(async () => {
    const { helper } = await body(req);
    return applyHelper(await readPid(), helper);
  });
}
