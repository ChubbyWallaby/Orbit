import { cookies } from 'next/headers';
import type { NextRequest } from 'next/server';
import { GameError } from './game';

export const PID_COOKIE = 'orbit_pid';

/** Reads the player id from the request's cookie (using the request keeps GET handlers out of prerendering). */
export async function readPid(req?: NextRequest): Promise<string | null> {
  const v = req ? req.cookies.get(PID_COOKIE)?.value : (await cookies()).get(PID_COOKIE)?.value;
  return v && /^[0-9a-f-]{36}$/.test(v) ? v : null;
}

export async function ensurePid(): Promise<string> {
  const existing = await readPid();
  if (existing) return existing;
  const pid = crypto.randomUUID();
  (await cookies()).set(PID_COOKIE, pid, {
    httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', path: '/', maxAge: 60 * 60 * 24 * 400,
  });
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
  try {
    const b = await req.json();
    return b && typeof b === 'object' ? b : {};
  } catch {
    throw new GameError('Invalid request.');
  }
}
