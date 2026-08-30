import { describe, it, expect } from 'vitest';
import { CookieJar, parseLoginForm, login, resolvePresigned } from './dgtAuth.mjs';

/** A response shaped like the bits of fetch's Response this code touches. */
function reply({ status = 200, headers = {}, body = '' } = {}) {
  const setCookie = [].concat(headers['set-cookie'] || []);
  const map = new Map(Object.entries(headers).filter(([k]) => k !== 'set-cookie'));
  return {
    status,
    headers: {
      get: (k) => map.get(k.toLowerCase()) ?? null,
      getSetCookie: () => setCookie,
    },
    text: async () => body,
  };
}

const LOGIN_PAGE = `
  <html><body>
    <form id="kc-form-login" action="https://auth.cdd.dgterritorio.gov.pt/login?session=abc&amp;tab=1" method="post">
      <input type="hidden" name="execution" value="exec-token">
      <input type="text" name="username">
      <input type="password" name="password">
    </form>
  </body></html>`;

describe('parseLoginForm', () => {
  it('finds the action and unescapes it', () => {
    const f = parseLoginForm(LOGIN_PAGE);
    expect(f.action).toBe('https://auth.cdd.dgterritorio.gov.pt/login?session=abc&tab=1');
  });

  it('carries the hidden flow fields, which must be echoed back', () => {
    expect(parseLoginForm(LOGIN_PAGE).fields).toEqual({ execution: 'exec-token' });
  });

  it('does not treat the visible credential inputs as hidden state', () => {
    const { fields } = parseLoginForm(LOGIN_PAGE);
    expect(fields.username).toBeUndefined();
    expect(fields.password).toBeUndefined();
  });

  it('returns null when there is no login form', () => {
    expect(parseLoginForm('<html><body>signed in</body></html>')).toBeNull();
  });
});

describe('CookieJar', () => {
  it('collects cookies and offers them back as a header', () => {
    const jar = new CookieJar();
    jar.absorb(reply({ headers: { 'set-cookie': ['a=1; Path=/; HttpOnly', 'b=2; Secure'] } }));
    expect(jar.header()).toBe('a=1; b=2');
    expect(jar.has('a')).toBe(true);
  });

  it('lets a later value replace an earlier one', () => {
    const jar = new CookieJar();
    jar.absorb(reply({ headers: { 'set-cookie': ['s=old'] } }));
    jar.absorb(reply({ headers: { 'set-cookie': ['s=new'] } }));
    expect(jar.header()).toBe('s=new');
  });
});

describe('login', () => {
  it('starts at site login, posts the form to Keycloak, follows the callback, and keeps the session', async () => {
    const seen = [];
    const fetchImpl = async (url, init) => {
      seen.push({ url: String(url), method: (init && init.method) || 'GET' });
      if (seen.length === 1) {
        return reply({
          status: 302,
          headers: {
            location: 'https://auth.cdd.dgterritorio.gov.pt/realms/dgterritorio/protocol/openid-connect/auth?client_id=aai-oidc-dgt&response_type=code&redirect_uri=https%3A%2F%2Fcdd.dgterritorio.gov.pt%2Fauth%2Fcallback&scope=openid',
            'set-cookie': ['connect.sid=initial-sid; Path=/'],
          },
        });
      }
      if (seen.length === 2) return reply({ body: LOGIN_PAGE });
      if (seen.length === 3) {
        return reply({ status: 302, headers: { location: 'https://cdd.dgterritorio.gov.pt/auth/callback?code=xyz' } });
      }
      return reply({ status: 200, headers: { 'set-cookie': ['connect.sid=sess-1; HttpOnly'] } });
    };

    const jar = await login({ username: 'u', password: 'p', fetchImpl });
    expect(jar.has('connect.sid')).toBe(true);
    expect(seen[0].url).toBe('https://cdd.dgterritorio.gov.pt/auth/login');
    expect(seen[1].url).toContain('client_id=aai-oidc-dgt');
    expect(seen[1].url).toContain(encodeURIComponent('https://cdd.dgterritorio.gov.pt/auth/callback'));
    expect(seen[2].method).toBe('POST');
  });

  it('refuses to run without credentials rather than sending blanks', async () => {
    await expect(login({ fetchImpl: async () => reply({}) })).rejects.toThrow(/DGT_USERNAME/);
  });

  it('says the credentials are wrong when no session comes back', async () => {
    const fetchImpl = async (url, init) =>
      (init && init.method === 'POST')
        ? reply({ status: 200, body: LOGIN_PAGE })   // Keycloak re-serves the form on failure
        : reply({ body: LOGIN_PAGE });
    await expect(login({ username: 'u', password: 'bad', fetchImpl })).rejects.toThrow(/session/i);
  });
});

describe('resolvePresigned', () => {
  const jar = new CookieJar();

  it('returns the signed URL the redirect names', async () => {
    const signed = 'https://stor-002.a.acnca.pt:9000/lidar/MDT50cm/x.tif?X-Amz-Signature=abc';
    const fetchImpl = async () => reply({ status: 302, headers: { location: signed } });
    expect(await resolvePresigned('https://cdd/dgt-be/v1/download/h', jar, fetchImpl)).toBe(signed);
  });

  it('recognises being bounced to the login page as an expired session', async () => {
    const fetchImpl = async () =>
      reply({ status: 302, headers: { location: 'https://cdd.dgterritorio.gov.pt/auth/login' } });
    await expect(resolvePresigned('https://cdd/dgt-be/v1/download/h', jar, fetchImpl))
      .rejects.toThrow(/session/i);
  });

  it('complains when the endpoint does not redirect at all', async () => {
    const fetchImpl = async () => reply({ status: 200 });
    await expect(resolvePresigned('https://cdd/dgt-be/v1/download/h', jar, fetchImpl))
      .rejects.toThrow(/redirect/i);
  });
});
