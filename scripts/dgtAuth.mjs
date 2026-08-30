import https from 'node:https';

/**
 * Signing in to DGT's data centre from a script, the way the QGIS plugin does.
 *
 * The download endpoint mints a presigned object-store URL, but only for a
 * logged-in session, and it sends no `Access-Control-Allow-Origin` — so a web
 * page can never do this, and that is the point. Credentials belong on the
 * machine of the person they belong to, never in a bundle every visitor loads.
 *
 * This reads them from the environment (see .env.example) and holds them only
 * for the life of the process. Nothing here writes a credential anywhere.
 */

const AUTH_BASE = 'https://auth.cdd.dgterritorio.gov.pt/realms/dgterritorio/protocol/openid-connect';
const SITE = 'https://cdd.dgterritorio.gov.pt';
const CLIENT_ID = 'aai-oidc-dgt';
const REDIRECT_URI = `${SITE}/auth/callback`;

/**
 * A cookie jar just large enough for this flow.
 *
 * Both hosts in the flow set cookies that the other steps need, and the session
 * cookie is HttpOnly, so there is no shortcut around keeping them properly.
 */
export class CookieJar {
  constructor() {
    this.cookies = new Map();
  }

  absorb(response) {
    const raw = typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : [response.headers.get('set-cookie')].filter(Boolean);
    for (const line of raw) {
      const [pair] = String(line).split(';');
      const eq = pair.indexOf('=');
      if (eq > 0) this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }

  header() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  has(name) {
    return this.cookies.has(name);
  }
}

/** Pull the Keycloak login form's action out of the page, with its hidden fields. */
export function parseLoginForm(html) {
  const form = html.match(/<form[^>]*id="kc-form-login"[^>]*>/i);
  if (!form) return null;
  const action = (form[0].match(/action="([^"]+)"/i) || [])[1];
  if (!action) return null;

  const fields = {};
  const body = html.slice(html.indexOf(form[0]));
  const end = body.search(/<\/form>/i);
  for (const m of body.slice(0, end === -1 ? undefined : end).matchAll(/<input[^>]+>/gi)) {
    const tag = m[0];
    const name = (tag.match(/name="([^"]+)"/i) || [])[1];
    const type = (tag.match(/type="([^"]+)"/i) || [])[1] || 'text';
    const value = (tag.match(/value="([^"]*)"/i) || [])[1] || '';
    // Hidden fields carry the flow's state and must be echoed back verbatim.
    if (name && type.toLowerCase() === 'hidden') fields[name] = value;
  }
  return { action: action.replace(/&amp;/g, '&'), fields };
}

/**
 * Complete the authorisation-code flow and return a jar holding the session.
 *
 * The flow starts at the site's own login entry point (`/auth/login`), which
 * generates the PKCE challenge and sets the initial session state before
 * redirecting to Keycloak. Keycloak then redirects back to the site's callback,
 * which completes the code exchange and issues the authenticated session cookie.
 */
export async function login({ username, password, fetchImpl = fetch, jar = new CookieJar() }) {
  if (!username || !password) {
    throw new Error('Set DGT_USERNAME and DGT_PASSWORD (see .env.example); never commit them.');
  }

  let currentUrl = `${SITE}/auth/login`;

  const step = async (url, init = {}) => {
    const res = await fetchImpl(url, {
      redirect: 'manual',
      ...init,
      headers: { cookie: jar.header(), ...(init.headers || {}) },
    });
    jar.absorb(res);
    currentUrl = url;
    return res;
  };

  // Step 1: Start at site's login entry point to initialize OAuth session
  let res = await step(currentUrl);

  // If redirected, follow to Keycloak login page
  for (let hop = 0; hop < 5 && res.status >= 300 && res.status < 400; ++hop) {
    const next = res.headers.get('location');
    if (!next) break;
    res = await step(new URL(next, currentUrl).toString());
  }

  const html = await res.text();
  const form = parseLoginForm(html);
  if (!form) {
    // Already signed in: Keycloak skips the form and redirects straight back.
    if (res.status >= 300 && res.status < 400) return jar;
    throw new Error('Could not find the Keycloak login form; the flow may have changed.');
  }

  // Step 2: Post credentials to Keycloak
  res = await step(form.action, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ...form.fields, username, password }).toString(),
  });

  // Step 3: Follow the chain back to the site's callback, which sets the session cookie.
  for (let hop = 0; hop < 10 && res.status >= 300 && res.status < 400; ++hop) {
    const next = res.headers.get('location');
    if (!next) break;
    res = await step(new URL(next, currentUrl).toString());
  }

  if (!jar.has('connect.sid')) {
    throw new Error('Login did not yield a session. Check the credentials in .env.');
  }
  return jar;
}

/**
 * Redeem a download link for the presigned URL behind it.
 *
 * The 302 *is* the mint: the location it names is signed server-side with a
 * static object-store key and lasts an hour.
 */
/**
 * A `fetch`-shaped GET that does not follow redirects.
 *
 * `fetch` follows them, and the redirect *is* the answer here, so it cannot be
 * used: following it would spend the presigned URL on a request this function
 * is not making. It also sends every cookie in the jar, and the endpoint
 * answers 502 when handed the Keycloak ones, so the jar is filtered down to the
 * four cookies the site's own session is made of.
 */
function getWithoutFollowing(url, headers) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            headers: {
              get: (k) => res.headers[String(k).toLowerCase()] ?? null,
              getSetCookie: () => res.headers['set-cookie'] || [],
            },
            text: async () => Buffer.concat(chunks).toString('utf8'),
          })
        );
      })
      .on('error', reject);
  });
}

/**
 * Turn a download URL into the presigned object-store URL it mints.
 *
 * The redirect is the mint: logged out the endpoint answers `302 -> /auth/login`,
 * logged in it answers `302 -> <presigned URL>`. Both are redirects, so the
 * location has to be read rather than merely counted — following the first one
 * blindly writes an HTML login page to disk under a `.tif` name.
 */
export async function resolvePresigned(url, jar, fetchImpl = getWithoutFollowing) {
  const allowed = ['connect.sid', 'auth_session', 'auth_user', 'auth_email'];
  const cookie = allowed
    .map((k) => (jar.cookies.get(k) ? `${k}=${jar.cookies.get(k)}` : null))
    .filter(Boolean)
    .join('; ');

  const response = await fetchImpl(url, {
    Cookie: cookie,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
  });

  if (![302, 303, 307].includes(response.status)) {
    const body = await response.text();
    throw new Error(
      `Expected a redirect from the download endpoint, got ${response.status}: ${body.slice(0, 200)}`
    );
  }

  const location = response.headers.get('location');
  if (!location) throw new Error('The download endpoint redirected without saying where');
  if (/\/auth\/login/.test(location)) {
    throw new Error('The DGT session has expired or was never signed in');
  }
  return location;
}
