// A stand-in PostHog host for the browser checks: records every request (path, query, headers
// and decoded body) as one JSON line in the file given as the first argument.
//
//   node scripts/verify/mock-posthog.mjs /tmp/events.jsonl 3999
import http from 'node:http';
import zlib from 'node:zlib';
import fs from 'node:fs';
const OUT = process.argv[2];
const PORT = Number(process.argv[3] || 3999);
fs.writeFileSync(OUT, '');
http.createServer((req, res) => {
  const cors = { 'Access-Control-Allow-Origin': req.headers.origin || '*', 'Access-Control-Allow-Credentials': 'true', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const u = new URL(req.url, 'http://x');
    const buf = Buffer.concat(chunks);
    let txt;
    try { txt = zlib.gunzipSync(buf).toString(); } catch { txt = buf.toString(); }
    if (txt.startsWith('data=')) txt = Buffer.from(decodeURIComponent(txt.slice(5)), 'base64').toString();
    fs.appendFileSync(OUT, JSON.stringify({ path: u.pathname, search: u.search, headers: req.headers, raw: buf.toString('latin1'), body: txt }) + '\n');
    if (u.pathname.endsWith('.js')) { res.writeHead(200, { ...cors, 'Content-Type': 'application/javascript' }); return res.end(''); }
    res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
    res.end(u.pathname.startsWith('/flags') ? '{"featureFlags":{},"sessionRecording":false}' : '{"status":1}');
  });
}).listen(PORT, '127.0.0.1', () => console.log(`mock posthog on 127.0.0.1:${PORT}`));
