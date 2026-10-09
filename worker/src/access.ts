// Verifies the Cloudflare Access login token (Cf-Access-Jwt-Assertion) on every request.
// Access already blocks anyone not on the allowlist; checking the signed token here as well means
// the Worker never trusts a request that somehow reached it without going through Access.

export interface AccessConfig {
  ACCESS_TEAM_DOMAIN: string; // e.g. https://aiedu.cloudflareaccess.com
  ACCESS_AUD: string; // the Access application's audience (AUD) tag
}

export interface AccessClaims {
  email?: string; // present for people; absent for service tokens (Apps Script)
  common_name?: string; // service token client ID
}

type Jwk = JsonWebKey & { kid: string };

const KEY_CACHE_MS = 60 * 60e3;
let keyCache: { team: string; keys: Jwk[]; at: number } | null = null;

async function signingKeys(team: string): Promise<Jwk[]> {
  if (keyCache && keyCache.team === team && Date.now() - keyCache.at < KEY_CACHE_MS) return keyCache.keys;
  const res = await fetch(`${team}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`Access certs: HTTP ${res.status}`);
  const { keys } = (await res.json()) as { keys: Jwk[] };
  keyCache = { team, keys, at: Date.now() };
  return keys;
}

function base64url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)), (c) => c.charCodeAt(0));
}

const decodeJson = (s: string) => JSON.parse(new TextDecoder().decode(base64url(s)));

/** The token's claims if it is signed by this Access team, for this application, and unexpired; else null. */
export async function verifyAccessJwt(token: string, cfg: AccessConfig, now = Date.now()): Promise<AccessClaims | null> {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  let header: { alg?: string; kid?: string };
  let claims: { aud?: string | string[]; iss?: string; exp?: number } & AccessClaims;
  try {
    header = decodeJson(parts[0]);
    claims = decodeJson(parts[1]);
  } catch {
    return null;
  }
  if (header.alg !== 'RS256') return null;

  const jwk = (await signingKeys(cfg.ACCESS_TEAM_DOMAIN)).find((k) => k.kid === header.kid);
  if (!jwk) return null;
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  if (!(await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, base64url(parts[2]), signed))) return null;

  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(cfg.ACCESS_AUD) || claims.iss !== cfg.ACCESS_TEAM_DOMAIN) return null;
  if (typeof claims.exp !== 'number' || claims.exp * 1000 <= now) return null;
  return { email: claims.email, common_name: claims.common_name };
}
