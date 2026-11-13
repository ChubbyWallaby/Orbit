import { cookies, headers } from 'next/headers';
import type { NextRequest } from 'next/server';
import { GameError } from './game';
import { PID_COOKIE, PID_HEADER, isJsonRequest, pickPid, pidCookieOptions } from './pid';

/** Reads the player id from the cookie, or the header when cookies are blocked (using the request keeps GET handlers out of prerendering). */
export async function readPid(req?: NextRequest): Promise<string | null> {
  if (req) return pickPid(req.cookies.get(PID_COOKIE)?.value, req.headers.get(PID_HEADER));
  return pickPid((await cookies()).get(PID_COOKIE)?.value, (await headers()).get(PID_HEADER));
}

export async function ensurePid(): Promise<string> {
  const jar = await cookies();
  const pid = (await readPid()) ?? crypto.randomUUID();
  // (re)set the cookie when it is missing, e.g. for a player who only had the header
  if (jar.get(PID_COOKIE)?.value !== pid) jar.set(PID_COOKIE, pid, pidCookieOptions(process.env.NODE_ENV === 'production'));
  return pid;
}

export async function handle(fn: () => Promise<unknown>) {
  try {
    return Response.json(await fn(), { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    if (e instanceof GameError) return Response.json({ error: e.message }, { status: e.status });
    console.error(e);
    return Response.json({ error: 'Something went wrong on our side. Try again in a moment.' }, { status: 500 });
  }
}

export async function body(req: Request): Promise<Record<string, unknown>> {
  if (!isJsonRequest(req.headers.get('content-type'))) throw new GameError('Invalid request.', 415);
  try {
    const b = await req.json();
    return b && typeof b === 'object' ? b : {};
  } catch {
    throw new GameError('Invalid request.');
  }
}
