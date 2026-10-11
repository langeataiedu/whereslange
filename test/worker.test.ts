import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import worker, { type Env } from '../worker/src/index';

const require = createRequire(import.meta.url);
const viewersExample = require('../viewers.example.json');
const status = require('./fixtures/status-2026-10-07.json');

const TEAM = 'https://example.cloudflareaccess.com';
const AUD = 'test-aud';
const SECRET = 'test-secret';

// A signing key standing in for Cloudflare Access, plus a stranger's key for forged tokens.
const sig = { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' };
const access = await crypto.subtle.generateKey(sig, true, ['sign', 'verify']);
const stranger = await crypto.subtle.generateKey(sig, true, ['sign', 'verify']);
const jwk = { ...(await crypto.subtle.exportKey('jwk', access.publicKey)), kid: 'k1', alg: 'RS256' };
vi.stubGlobal('fetch', async (url: string) =>
  url === `${TEAM}/cdn-cgi/access/certs` ? Response.json({ keys: [jwk] }) : new Response('not found', { status: 404 }));

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const enc = (o: object) => b64url(new TextEncoder().encode(JSON.stringify(o)));

async function token(claims: object, key = access.privateKey): Promise<string> {
  const body = `${enc({ alg: 'RS256', kid: 'k1', typ: 'JWT' })}.${enc({ aud: [AUD], iss: TEAM, exp: Math.floor(Date.now() / 1000) + 3600, ...claims })}`;
  const s = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(body)));
  return `${body}.${b64url(s)}`;
}

let kv: Map<string, string>;
let env: Env;
beforeEach(() => {
  kv = new Map();
  env = {
    ASSETS: { fetch: async () => new Response('<!doctype html><title>page</title>', { headers: { 'Content-Type': 'text/html' } }) },
    STATUS: { get: async (k: string) => kv.get(k) ?? null, put: async (k: string, v: string) => void kv.set(k, v) },
    VIEWERS: JSON.stringify(viewersExample),
    UPDATE_SECRET: SECRET,
    ACCESS_TEAM_DOMAIN: TEAM,
    ACCESS_AUD: AUD,
  } as unknown as Env;
});

const call = (path: string, init: RequestInit & { jwt?: string } = {}, host = 'wheres-lange.example.workers.dev') => {
  const headers = new Headers(init.headers);
  if (init.jwt) headers.set('Cf-Access-Jwt-Assertion', init.jwt);
  return worker.fetch(new Request(`https://${host}${path}`, { ...init, headers }), env);
};
const asViewer = async (email: string, path: string) => call(path, { jwt: await token({ email }) });
const postStatus = async (body: unknown, opts: { secret?: string; jwt?: string } = {}) => call('/api/update', {
  method: 'POST',
  body: JSON.stringify(body),
  jwt: opts.jwt ?? (await token({ common_name: 'apps-script.access' })),
  headers: opts.secret === undefined ? { Authorization: `Bearer ${SECRET}` } : opts.secret ? { Authorization: `Bearer ${opts.secret}` } : {},
});

describe('who can see the page', () => {
  it.each(['/', '/api/status'])('%s: no login → 403', async (path) => {
    expect((await call(path)).status).toBe(403);
  });

  it.each(['/', '/api/status'])('%s: signed in but not on the viewer list → 403', async (path) => {
    expect((await asViewer('stranger@example.com', path)).status).toBe(403);
  });

  it('forged, expired or wrong-app tokens → 403', async () => {
    const email = 'mom@example.com';
    for (const jwt of [
      await token({ email }, stranger.privateKey),
      await token({ email, exp: Math.floor(Date.now() / 1000) - 60 }),
      await token({ email, aud: ['some-other-app'] }),
      await token({ email, iss: 'https://evil.cloudflareaccess.com' }),
      'not.a.token',
    ]) {
      expect((await call('/', { jwt })).status).toBe(403);
    }
  });

  it('a viewer gets the page, with noindex and a content security policy', async () => {
    const res = await asViewer('Mom@Example.com', '/');
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Robots-Tag')).toBe('noindex, nofollow');
    expect(res.headers.get('Content-Security-Policy')).toContain("default-src 'self'");
  });

  it('before secrets are set, a request with no login is refused cleanly (not a crash)', async () => {
    env.VIEWERS = undefined as unknown as string;
    expect((await call('/')).status).toBe(403);
  });

  it('robots.txt disallows everything, no login needed', async () => {
    const res = await call('/robots.txt');
    expect(await res.text()).toBe('User-agent: *\nDisallow: /\n');
  });

  it('the local-dev login shortcut only works on localhost', async () => {
    env.DEV_USER_EMAIL = 'mom@example.com';
    expect((await call('/', {}, 'localhost:8787')).status).toBe(200);
    expect((await call('/', {}, 'wheres-lange.example.workers.dev')).status).toBe(403);
  });
});

describe('status updates (Apps Script → Worker)', () => {
  it('stores a valid status; viewers then get it', async () => {
    expect((await asViewer('mom@example.com', '/api/status')).status).toBe(503); // nothing yet
    expect((await postStatus(status)).status).toBe(200);
    expect(JSON.parse(kv.get('status')!)).toEqual(status);
    expect((await asViewer('mom@example.com', '/api/status')).status).toBe(200);
  });

  it('accepts a status for a place it could not recognize (tz null)', async () => {
    expect((await postStatus({ ...status, today: { ...status.today, tz: null } })).status).toBe(200);
  });

  it('needs the shared secret and an Access token', async () => {
    expect((await postStatus(status, { secret: '' })).status).toBe(403);
    expect((await postStatus(status, { secret: 'wrong' })).status).toBe(403);
    expect((await postStatus(status, { jwt: 'not.a.token' })).status).toBe(403);
    expect(kv.size).toBe(0);
  });

  it('rejects anything outside the schema', async () => {
    const bad = [
      { ...status, hotel: 'The Morrow' },
      { ...status, today: { ...status.today, confirmation: 'ABC123' } },
      { ...status, today: { ...status.today, transit: { ...status.today.transit, flight: 'UA1234' } } },
      { ...status, today: { ...status.today, tz: 'Not/AZone' } },
      { ...status, today: { ...status.today, tz: 42 } },
      { ...status, trips: [{ ...status.trips[0], notes: 'Hotel Adlon' }] },
      { ...status, trips: [{ ...status.trips[0], start: 'Oct 15' }] },
      { ...status, homeOn: 'tomorrow' },
      { today: status.today, trips: status.trips },
    ];
    for (const body of bad) expect((await postStatus(body)).status).toBe(400);
    expect(kv.size).toBe(0);
  });

  it('each update replaces the last (a canceled trip drops off)', async () => {
    await postStatus(status);
    await postStatus({ ...status, trips: status.trips.slice(1) });
    expect(JSON.parse(kv.get('status')!).trips).toHaveLength(status.trips.length - 1);
    expect([...kv.keys()]).toEqual(['status']);
  });
});

describe('your-city highlight', () => {
  beforeEach(async () => { await postStatus(status); });

  it.each(['mom@example.com', 'dad@example.com'])('%s gets "Near Mom & Dad" (Nov 28 Sacramento trip)', async (email) => {
    const body = (await (await asViewer(email, '/api/status')).json()) as { highlight: { metro: string; label: string }; status: typeof status };
    expect(body.highlight).toEqual({ metro: 'stockton', label: 'Near Mom & Dad' });
    expect(body.status.trips.find((t: { place: string }) => t.place === 'Sacramento, CA').metros).toContain('stockton');
  });

  it("each viewer gets their own name for the greeting (and nobody else's)", async () => {
    const mom = (await (await asViewer('mom@example.com', '/api/status')).json()) as { viewer: { name: string } };
    const friend = (await (await asViewer('friend@example.com', '/api/status')).json()) as { viewer: object };
    expect(mom.viewer).toEqual({ name: 'Mary' });
    expect(friend.viewer).toEqual({ name: 'Jason' });
  });

  it('an SF friend gets no highlight', async () => {
    const body = (await (await asViewer('friend@example.com', '/api/status')).json()) as { highlight: unknown };
    expect(body.highlight).toBeNull();
  });

  it('the response also carries the phone number and home city from config', async () => {
    const body = (await (await asViewer('friend@example.com', '/api/status')).json()) as { phone: string; home: object };
    expect(body.phone).toBe(viewersExample.phone);
    expect(body.home).toEqual(viewersExample.home);
  });
});
