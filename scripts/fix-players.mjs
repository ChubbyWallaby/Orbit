// One-off: delete every player named "tiago" and set "tiga"'s all-time score to 500.
// Usage: KV_REST_API_URL=... KV_REST_API_TOKEN=... node scripts/fix-players.mjs [--apply]
// Without --apply it only prints what it would do.
import { Redis } from '@upstash/redis';

const NS = 'orbit';
const APPLY = process.argv.includes('--apply');
const r = new Redis({
  url: process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN,
});
const norm = (s) => String(s).normalize('NFKC').toLowerCase().trim();

async function scan(match) {
  const out = []; let cursor = '0';
  do {
    const [next, keys] = await r.scan(cursor, { match, count: 500 });
    out.push(...keys); cursor = String(next);
  } while (cursor !== '0');
  return out;
}

// Find players by display name (covers duplicates the names hash may miss).
const nameKeys = await scan(`${NS}:player:*:name`);
const values = nameKeys.length ? await r.mget(...nameKeys) : [];
const byName = (n) => nameKeys.filter((_, i) => norm(values[i]) === n).map((key) => key.split(':')[2]);
const tiagos = byName('tiago');
const tigas = byName('tiga');
console.log('tiago pids:', tiagos);
console.log('tiga pids:', tigas);

const dayBoards = await scan(`${NS}:lb:day:*`);
for (const pid of tiagos) {
  const keys = [
    `${NS}:player:${pid}:name`, `${NS}:player:${pid}:streak`,
    ...(await scan(`${NS}:play:*:${pid}`)), ...(await scan(`${NS}:shots:*:${pid}`)), ...(await scan(`${NS}:done:*:${pid}`)),
  ];
  console.log(`delete ${pid}: ${keys.length} keys, remove from ${dayBoards.length} day boards + all-time board`);
  if (!APPLY) continue;
  const p = r.pipeline();
  p.del(...keys);
  p.zrem(`${NS}:lb:all`, pid);
  for (const b of dayBoards) p.zrem(b, pid);
  p.hdel(`${NS}:lb:games`, pid);
  p.hdel(`${NS}:lb:best`, pid);
  await p.exec();
}
if (APPLY && (await r.hget(`${NS}:names`, 'tiago')) !== null && tiagos.includes(await r.hget(`${NS}:names`, 'tiago'))) {
  await r.hdel(`${NS}:names`, 'tiago');
}

if (tigas.length !== 1) {
  console.log(`Expected exactly one "tiga", found ${tigas.length}; not changing the score.`);
} else {
  const pid = tigas[0];
  console.log(`tiga all-time score: ${await r.zscore(`${NS}:lb:all`, pid)} -> 500`);
  if (APPLY) await r.zadd(`${NS}:lb:all`, { score: 500, member: pid });
}
console.log(APPLY ? 'Done.' : 'Dry run only. Re-run with --apply to make the changes.');
