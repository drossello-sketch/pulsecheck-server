'use strict';
// Pulsecheck: no dependencies, Node 18+. Run: node server.js
// Data sources: (1) each service's own public status feed (Atlassian Statuspage JSON),
// (2) problem reports submitted by visitors to this server. Nothing from downdetector.com.
const http = require('http');
const dns = require('dns').promises;
const net = require('net');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 3000;
const POLL_MS = Number(process.env.POLL_MS) || 60_000;
const SPIKE_15MIN = Number(process.env.SPIKE_15MIN) || 10;   // user reports in 15 min that flag a service
const SERVICES = JSON.parse(fs.readFileSync(process.env.SERVICES_FILE || path.join(__dirname, 'services.json'), 'utf8'));
const PUBLIC = path.join(__dirname, 'public');
const DATA_FILE = path.join(__dirname, 'data', 'state.json');
const DAY = 24 * 3600 * 1000;
const LEVEL = { none: 0, minor: 1, major: 2, critical: 3 };
const ISSUES = ['Website', 'App', 'Sign-in', 'Connection'];

const CUSTOM_FILE = path.join(__dirname, 'data', 'custom-services.json');
const ALLOW_ADD = process.env.ALLOW_ADD !== '0';          // ALLOW_ADD=0 turns off adding services from the app
let custom = [];
try { custom = JSON.parse(fs.readFileSync(CUSTOM_FILE, 'utf8')); } catch { /* none yet */ }
const byId = new Map();
for (const s of SERVICES) byId.set(s.id, { ...s, official: null, error: 'Not checked yet', checkedAt: null, history: [] });
for (const s of custom) if (!byId.has(s.id)) byId.set(s.id, { ...s, custom: true, official: null, error: s.url ? 'Not checked yet' : null, checkedAt: null, history: [] });

// Services added through the app may point the server at any web address, so only public https hosts are allowed.
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const x = ip.toLowerCase();
  if (x === '::1' || x === '::') return true;
  if (x.startsWith('::ffff:')) return x.includes('.') ? isPrivateIp(x.slice(7)) : true;
  return /^(fc|fd|fe[89ab])/.test(x);
}
async function assertPublicHost(urlStr) {
  const u = new URL(urlStr);
  if (u.protocol !== 'https:') throw new Error('The feed address must start with https://');
  if (u.port && u.port !== '443') throw new Error('The feed address must use the standard https port.');
  if (u.username || u.password) throw new Error('The feed address cannot contain a username or password.');
  if (net.isIP(u.hostname) || u.hostname.startsWith('[')) throw new Error('Use a domain name, not an IP address.');
  let addrs; try { addrs = await dns.lookup(u.hostname, { all: true }); } catch { throw new Error('That address could not be found.'); }
  if (!addrs.length || addrs.some(a => isPrivateIp(a.address))) throw new Error('That address is not a public website.');
}

let reports = [];   // {id, t, type, city}
try {
  const saved = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  reports = (saved.reports || []).filter(r => Date.now() - r.t < DAY && byId.has(r.id));
  for (const [id, h] of Object.entries(saved.history || {})) if (byId.has(id)) byId.get(id).history = h.filter(p => Date.now() - p.t < DAY);
} catch { /* first run */ }

let dirty = false;
function persist() {
  if (!dirty || process.env.DEMO === '1') return;
  dirty = false;
  const history = {};
  for (const [id, s] of byId) history[id] = s.history;
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFile(DATA_FILE, JSON.stringify({ reports, history }), () => {});
}
setInterval(persist, 15_000).unref();

const DEMO = process.env.DEMO === '1';   // DEMO=1 node server.js  -> fake data, no network
async function poll(s) {
  if (DEMO || !s.url) return;
  try {
    if (s.custom) await assertPublicHost(s.url);
    const res = await fetch(s.url, { redirect: s.custom ? 'error' : 'follow', signal: AbortSignal.timeout(10_000), headers: { accept: 'application/json', 'user-agent': 'pulsecheck/1.0' } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const j = await res.json();
    const level = LEVEL[j.status && j.status.indicator];
    if (level === undefined) throw new Error('Unexpected response format');
    s.official = {
      level,
      description: String(j.status.description || ''),
      components: (j.components || []).filter(c => !c.group).slice(0, 30).map(c => ({ name: c.name, status: c.status })),
      incidents: (j.incidents || []).slice(0, 5).map(i => ({
        name: i.name, status: i.status, impact: i.impact, startedAt: i.created_at,
        latest: i.incident_updates && i.incident_updates[0] ? i.incident_updates[0].body : ''
      })),
      sourceUpdatedAt: j.page && j.page.updated_at
    };
    s.error = null;
    s.history.push({ t: Date.now(), level });
  } catch (e) {
    s.error = String(e.message || e);
  }
  s.checkedAt = Date.now();
  s.history = s.history.filter(p => Date.now() - p.t < DAY);
  dirty = true;
}
function demoSet(s, lvl) {   // DEMO mode only: set a service's official status (0 ok, 1 minor, 3 outage)
  const COMP = ['API', 'Website', 'Sign-in', 'Mobile app'], ago = m => new Date(Date.now() - m * 60000).toISOString();
  s.error = null; s.checkedAt = Date.now();
  s.official = { level: lvl, description: ['All Systems Operational', 'Minor Service Outage', '', 'Partial System Outage'][lvl],
    components: COMP.map((n, k) => ({ name: n, status: lvl && k < 2 ? (lvl === 3 ? 'major_outage' : 'degraded_performance') : 'operational' })),
    incidents: lvl ? [{ name: lvl === 3 ? 'Elevated error rates' : 'Increased latency', status: 'investigating', impact: lvl === 3 ? 'major' : 'minor', startedAt: ago(1),
      latest: 'We are investigating reports of problems and will post an update soon.' }] : [], sourceUpdatedAt: ago(0) };
  s.history.push({ t: Date.now(), level: lvl });
}
if (DEMO) {
  // Test data: every 4th service has an outage, every 4th+2 is degraded, the rest are healthy.
  const COMP = ['API', 'Website', 'Sign-in', 'Mobile app'], ago = m => new Date(Date.now() - m * 60000).toISOString();
  [...byId.values()].forEach((s, i) => {
    const lvl = i % 4 === 1 ? 3 : i % 4 === 3 ? 1 : 0;
    demoSet(s, lvl);
    s.history = [];
    for (let m = 1430; m >= 0; m -= 10) s.history.push({ t: Date.now() - m * 60000, level: lvl && m < 120 ? lvl : 0 });
    const cities = ['New York', 'Chicago', 'Austin', 'Seattle', 'Miami', 'Denver', 'Toronto', 'London'];
    for (let k = 0; k < 40 + (i * 7) % 30; k++) reports.push({ id: s.id, t: Date.now() - Math.random() * 864e5, type: ISSUES[k % 4], city: cities[k % 8], comment: k % 5 === 0 ? ['Keeps timing out for me.', 'Works on wifi, fails on mobile data.', 'Same issue since this morning.'][k % 3] : '' });
    if (lvl) for (let k = 0; k < (lvl === 3 ? 28 : 12); k++) reports.push({ id: s.id, t: Date.now() - Math.random() * 800_000, type: ISSUES[(k + i) % 4], city: cities[(k + i) % 8] });
  });
  reports.sort((a, b) => a.t - b.t);
  dirty = false;
}
async function pollAll() { await Promise.all([...byId.values()].map(poll)); }
if (!DEMO) pollAll();
setInterval(pollAll, POLL_MS).unref();

function reportStats(id) {
  const now = Date.now();
  const mine = reports.filter(r => r.id === id);
  const buckets = new Array(24).fill(0);          // hourly, oldest first
  for (const r of mine) { const h = Math.floor((now - r.t) / 3600000); if (h < 24) buckets[23 - h]++; }
  const types = Object.fromEntries(ISSUES.map(t => [t, 0]));
  for (const r of mine) types[r.type]++;
  return {
    last15: mine.filter(r => now - r.t < 900_000).length,
    last24h: mine.length, hourly: buckets, types,
    recent: mine.slice(-8).reverse().map(r => ({ t: r.t, type: r.type, city: r.city, comment: r.comment || '' }))
  };
}
function view(s) {
  const rep = reportStats(s.id);
  const officialLevel = s.official ? s.official.level : null;
  let state = 'unknown';
  if (officialLevel !== null) state = officialLevel >= 2 ? 'outage' : officialLevel === 1 ? 'degraded' : 'ok';
  const spike = rep.last15 >= SPIKE_15MIN;
  if (spike && state === 'ok') state = 'degraded';
  const reportsOnly = !s.url;   // no status feed: judge by user reports alone
  if (reportsOnly) state = rep.last15 >= SPIKE_15MIN * 3 ? 'outage' : spike ? 'degraded' : 'ok';
  return { reportsOnly, id: s.id, name: s.name, category: s.category, state, userSpike: spike, spikeThreshold: SPIKE_15MIN,
    official: s.official, error: s.error, checkedAt: s.checkedAt, history: s.history, reports: rep };
}

const lastReportByIp = new Map();
const addLog = new Map();
function clientIp(req) {
  // Behind a host's proxy every request arrives from the proxy, so read the real address from X-Forwarded-For.
  if (process.env.TRUST_PROXY === '1') { const f = req.headers['x-forwarded-for']; if (f) return String(f).split(',')[0].trim(); }
  return req.socket.remoteAddress || 'x';
}

function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'GET' && url.pathname === '/api/config') return send(res, 200, { demo: DEMO, addServices: ALLOW_ADD });
  if (DEMO && req.method === 'POST' && url.pathname.startsWith('/api/demo/toggle/')) {
    const t = byId.get(decodeURIComponent(url.pathname.slice(17)));
    if (!t) return send(res, 404, { error: 'Unknown service' });
    demoSet(t, t.official && t.official.level >= 2 ? 0 : 3);
    return send(res, 200, view(t));
  }
  if (req.method === 'POST' && url.pathname === '/api/services') {
    if (!ALLOW_ADD) return send(res, 403, { error: 'Adding services is turned off on this server.' });
    let body = '';
    req.on('data', c => { body += c; if (body.length > 2048) req.destroy(); });
    req.on('end', async () => {
      try {
        let j; try { j = JSON.parse(body || '{}'); } catch { return send(res, 400, { error: 'Invalid JSON' }); }
        const name = String(j.name || '').trim().replace(/\s+/g, ' ');
        if (name.length < 2 || name.length > 40) return send(res, 400, { error: 'Enter a name between 2 and 40 characters.' });
        const category = String(j.category || '').trim().replace(/\s+/g, ' ').slice(0, 24) || 'Other';
        const feed = String(j.url || '').trim();
        if ([...byId.values()].some(x => x.name.toLowerCase() === name.toLowerCase())) return send(res, 409, { error: 'That service is already on the list.' });
        if (custom.length >= 60) return send(res, 400, { error: 'This server has reached its limit of added services.' });
        const ip = clientIp(req), now = Date.now();
        const recent = (addLog.get(ip) || []).filter(t => now - t < 3600_000);
        if (recent.length >= 3) return send(res, 429, { error: 'You can add 3 services per hour. Try again later.' });
        let id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'service';
        if (id === 'home') id = 'home-service';
        const base = id; let n = 2; while (byId.has(id)) id = base + '-' + n++;
        const s = { id, name, category, url: feed || null, custom: true, official: null, error: feed ? 'Not checked yet' : null, checkedAt: null, history: [] };
        if (feed) {
          try { new URL(feed); await assertPublicHost(feed); } catch (e) { return send(res, 422, { error: e.message === 'Invalid URL' ? 'Enter a full address that starts with https://' : e.message }); }
          if (DEMO) demoSet(s, 0); else {
            await poll(s);
            if (s.error) return send(res, 422, { error: 'Could not read a status feed at that address (' + s.error + '). Use an address that ends in /api/v2/summary.json, or leave it empty.' });
          }
        }
        recent.push(now); addLog.set(ip, recent);
        byId.set(id, s);
        custom.push({ id, name, category, url: feed || null });
        if (!DEMO) { fs.mkdirSync(path.dirname(CUSTOM_FILE), { recursive: true }); fs.writeFileSync(CUSTOM_FILE, JSON.stringify(custom)); }
        dirty = true;
        send(res, 201, view(s));
      } catch (e) { send(res, 500, { error: 'Something went wrong. Try again.' }); }
    });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/services') return send(res, 200, [...byId.values()].map(view));
  if (req.method === 'POST' && url.pathname.startsWith('/api/report/')) {
    const s = byId.get(decodeURIComponent(url.pathname.slice(12)));
    if (!s) return send(res, 404, { error: 'Unknown service' });
    let body = '';
    req.on('data', c => { body += c; if (body.length > 2048) req.destroy(); });
    req.on('end', () => {
      let j; try { j = JSON.parse(body || '{}'); } catch { return send(res, 400, { error: 'Invalid JSON' }); }
      if (!ISSUES.includes(j.type)) return send(res, 400, { error: 'Choose a problem type' });
      const key = clientIp(req) + '|' + s.id, last = lastReportByIp.get(key) || 0;
      if (Date.now() - last < 10 * 60_000) return send(res, 429, { error: 'You already reported this service in the last 10 minutes.' });
      lastReportByIp.set(key, Date.now());
      reports.push({ id: s.id, t: Date.now(), type: j.type, city: String(j.city || '').slice(0, 40), comment: String(j.comment || '').slice(0, 200) });
      reports = reports.filter(r => Date.now() - r.t < DAY);
      dirty = true;
      send(res, 201, view(s));
    });
    return;
  }
  if (req.method === 'GET') {
    const file = path.normalize(path.join(PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname));
    if (!file.startsWith(PUBLIC + path.sep)) return send(res, 403, 'Forbidden', 'text/plain');
    return fs.readFile(file, (err, buf) => err ? send(res, 404, 'Not found', 'text/plain') : send(res, 200, buf, MIME[path.extname(file)] || 'application/octet-stream'));
  }
  send(res, 405, { error: 'Method not allowed' });
});
setInterval(() => { const c = Date.now() - 600_000; for (const [k, t] of lastReportByIp) if (t < c) lastReportByIp.delete(k); }, 60_000).unref();
server.listen(PORT, () => console.log(`Pulsecheck on http://localhost:${PORT}  (${SERVICES.length} services, polling every ${POLL_MS / 1000}s)`));
process.on('SIGINT', () => { dirty = true; persist(); process.exit(0); });
