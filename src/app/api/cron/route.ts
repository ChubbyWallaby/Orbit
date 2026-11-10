import type { NextRequest } from 'next/server';
import { levelFor } from '@/server/game';
import { utcDay } from '@/game/rules';

// Called by Vercel Cron shortly after midnight UTC so the first player of the day
// does not wait for the level generator. Also prepares tomorrow's level.
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.get('authorization') !== `Bearer ${secret}`) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const today = utcDay();
  const tomorrow = utcDay(new Date(Date.now() + 86400000));
  await Promise.all([levelFor(today), levelFor(tomorrow)]);
  return Response.json({ warmed: [today, tomorrow] });
}
