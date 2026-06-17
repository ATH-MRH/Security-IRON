/**
 * Client HTTP pour l'API SécuriSite
 * Gère JWT + erreurs + helpers CRUD
 */
const API = (() => {
  const TOKEN_KEY = 'securisite_token';
  const USER_KEY = 'securisite_user';

  function getToken() { return localStorage.getItem(TOKEN_KEY); }
  function setToken(t) { localStorage.setItem(TOKEN_KEY, t); }
  function clearToken() { localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(USER_KEY); }
  function getUser() { try { return JSON.parse(localStorage.getItem(USER_KEY)); } catch { return null; } }
  function setUser(u) { localStorage.setItem(USER_KEY, JSON.stringify(u)); }

  async function request(method, path, body) {
    const token = getToken();
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = 'Bearer ' + token;
    const res = await fetch('/api' + path, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined
    });
    if (res.status === 401) {
      clearToken();
      location.reload();
      throw new Error('Session expirée');
    }
    if (!res.ok) {
      let err = { error: 'Erreur ' + res.status };
      try { err = await res.json(); } catch {}
      throw new Error(err.error || 'Erreur réseau');
    }
    return res.status === 204 ? null : res.json();
  }

  return {
    get: (p) => request('GET', p),
    post: (p, b) => request('POST', p, b),
    put: (p, b) => request('PUT', p, b),
    del: (p) => request('DELETE', p),
    getToken, setToken, clearToken, getUser, setUser,

    login: (username, password) => request('POST', '/auth/login', { username, password }),
    me: () => request('GET', '/auth/me')
  };
})();
