// A stand-in PostHog host: records every request body to events.jsonl
import http from 'node:http';
import zlib from 'node:zlib';
import fs from 'node:fs';
const OUT = import.meta.dirname + '/events.jsonl';
fs.writeFileSync(OUT, '');
http.createServer((req, res) => {
  const cors = { 'Access-Control-Allow-Origin': req.headers.origin || '*', 'Access-Control-Allow-Credentials': 'true', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const u = new URL(req.url, 'http://x');
    let buf = Buffer.concat(chunks), txt;
    try { txt = zlib.gunzipSync(buf).toString(); } catch { txt = buf.toString(); }
    if (txt.startsWith('data=')) txt = Buffer.from(decodeURIComponent(txt.slice(5)), 'base64').toString();
    fs.appendFileSync(OUT, JSON.stringify({ path: u.pathname, search: u.search, body: txt }) + '\n');
    if (u.pathname.endsWith('.js')) { res.writeHead(200, { ...cors, 'Content-Type': 'application/javascript' }); return res.end(''); }
    res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
    res.end(u.pathname.startsWith('/flags') ? '{"featureFlags":{},"sessionRecording":false}' : '{"status":1}');
  });
}).listen(3999, () => console.log('mock posthog on 3999'));
