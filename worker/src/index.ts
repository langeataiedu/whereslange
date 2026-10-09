// Where's Lange? Worker: serves the page and its status to signed-in viewers, and accepts
// status updates from the Apps Script. KV holds the current status only (one key, overwritten).
//
//   GET  /             the page (static files in public/)
//   GET  /api/status   status + this viewer's your-city highlight, phone number and home city
//   POST /api/update   new status from Apps Script (Access service token + shared secret)

import { verifyAccessJwt, type AccessConfig } from './access';
import { validateStatus } from './schema';

export interface Env extends AccessConfig {
  ASSETS: Fetcher;
  STATUS: KVNamespace;
  VIEWERS: string; // JSON, see viewers.example.json (Worker secret, never committed)
  UPDATE_SECRET: string; // shared with the Apps Script (Worker secret)
  DEV_USER_EMAIL?: string; // `wrangler dev` only: who you are locally. Ignored except on localhost.
}

interface ViewerConfig {
  home: { city: string; region: string };
  phone: string;
  viewers: Record<string, { name: string; metro: string | null }>;
  metros: Record<string, { label: string }>;
}

const MAX_UPDATE_BYTES = 32 * 1024;
const BASE_HEADERS: Record<string, string> = {
  'X-Robots-Tag': 'noindex, nofollow',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
};
const PAGE_CSP = [
  "default-src 'self'",
  "style-src 'self' https://fonts.googleapis.com",
  'font-src https://fonts.gstatic.com',
  "img-src 'self'",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...BASE_HEADERS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

const forbidden = () => json({ error: 'forbidden' }, 403);

/** Who is asking: a person's email, a service token, or nobody. */
async function identify(request: Request, env: Env): Promise<{ email?: string } | null> {
  const host = new URL(request.url).hostname;
  if (env.DEV_USER_EMAIL && (host === 'localhost' || host === '127.0.0.1')) return { email: env.DEV_USER_EMAIL.toLowerCase() };
  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!token || !env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return null;
  const claims = await verifyAccessJwt(token, env);
  if (!claims) return null;
  return { email: claims.email?.toLowerCase() };
}

/** Constant-time comparison of "Bearer <secret>" against UPDATE_SECRET. */
async function secretMatches(header: string | null, secret: string): Promise<boolean> {
  if (!secret || !header?.startsWith('Bearer ')) return false;
  const digest = async (s: string) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
  const [a, b] = await Promise.all([digest(header.slice(7)), digest(secret)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function handleUpdate(request: Request, env: Env, who: { email?: string } | null): Promise<Response> {
  if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405);
  if (!who || !(await secretMatches(request.headers.get('Authorization'), env.UPDATE_SECRET))) return forbidden();
  const text = await request.text();
  if (text.length > MAX_UPDATE_BYTES) return json({ error: 'too large' }, 413);
  let status: unknown;
  try {
    status = JSON.parse(text);
  } catch {
    return json({ error: 'not JSON' }, 400);
  }
  const problem = validateStatus(status);
  if (problem) return json({ error: `invalid status: ${problem}` }, 400);
  await env.STATUS.put('status', text);
  return json({ ok: true });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === '/robots.txt') {
      return new Response('User-agent: *\nDisallow: /\n', { headers: { ...BASE_HEADERS, 'Content-Type': 'text/plain' } });
    }

    const who = await identify(request, env);
    if (path === '/api/update') return handleUpdate(request, env, who);

    // Everything else is for people on the viewer list only.
    const config = JSON.parse(env.VIEWERS) as ViewerConfig;
    const viewers = Object.fromEntries(Object.entries(config.viewers).map(([email, v]) => [email.toLowerCase(), v]));
    const viewer = who?.email ? viewers[who.email] : undefined;
    if (!viewer) return forbidden();

    if (path === '/api/status') {
      if (request.method !== 'GET') return json({ error: 'method not allowed' }, 405);
      const raw = await env.STATUS.get('status');
      if (!raw) return json({ error: 'no status yet' }, 503);
      const metro = viewer.metro ? config.metros[viewer.metro] : undefined;
      return json({
        status: JSON.parse(raw),
        highlight: metro ? { metro: viewer.metro, label: metro.label } : null,
        home: config.home,
        phone: config.phone,
      });
    }

    const asset = await env.ASSETS.fetch(request);
    const res = new Response(asset.body, asset);
    for (const [k, v] of Object.entries(BASE_HEADERS)) res.headers.set(k, v);
    if ((res.headers.get('Content-Type') || '').includes('text/html')) {
      res.headers.set('Content-Security-Policy', PAGE_CSP);
      res.headers.set('Cache-Control', 'no-store');
    }
    return res;
  },
} satisfies ExportedHandler<Env>;
