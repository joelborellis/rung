// A cookie jar that survives a real proxy.
//
// This exists because the naive version did not. It captured
// `headers.get('set-cookie').split(';')[0]`, which is fine against a bare Node
// server that sets exactly one cookie — and wrong behind Azure App Service,
// which adds ARRAffinity cookies. `get()` comma-joins multiple Set-Cookie
// headers, so splitting on the first `;` grabbed whichever cookie came first
// and threw the session away. Every request after the second was silently
// unauthenticated, and the tests reported it as an app bug.
//
// Keep them all in a real jar, keyed by name. `getSetCookie()` returns the
// headers unjoined, which is what makes that possible.

export function makeClient(base) {
  /** name -> value */
  const jar = new Map();

  return async function request(path, init = {}) {
    const headers = { ...(init.headers ?? {}) };
    if (jar.size > 0) {
      headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    }
    if (init.body) headers['content-type'] = 'application/json';

    const response = await fetch(`${base}${path}`, { ...init, headers });

    // getSetCookie keeps the headers separate; get() would join them with
    // commas and make them impossible to split safely.
    for (const raw of response.headers.getSetCookie?.() ?? []) {
      const [pair] = raw.split(';');
      const eq = pair.indexOf('=');
      if (eq === -1) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      // An expired cookie is a delete instruction, not a value to keep.
      if (/expires=Thu, 01 Jan 1970/i.test(raw) || value === '') jar.delete(name);
      else jar.set(name, value);
    }

    const text = await response.text();
    let json = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
    return { status: response.status, text, json, cookies: new Map(jar) };
  };
}
