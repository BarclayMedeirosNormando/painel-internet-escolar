// KV em memória e NextDNS falso para os testes.
export class MemKV {
  constructor() { this.m = new Map(); }
  async get(k, type) {
    const e = this.m.get(k);
    if (!e || (e.exp && e.exp < Date.now())) return null;
    return type === "json" ? JSON.parse(e.v) : e.v;
  }
  async put(k, v, o = {}) {
    if (o.metadata && JSON.stringify(o.metadata).length > 1024) throw new Error("KV metadata > 1024 bytes");
    this.m.set(k, { v: String(v), meta: o.metadata, exp: o.expirationTtl ? Date.now() + o.expirationTtl * 1000 : 0 });
  }
  async delete(k) { this.m.delete(k); }
  async list({ prefix = "", limit = 1000 } = {}) {
    const keys = [...this.m.entries()].filter(([k, e]) => k.startsWith(prefix) && !(e.exp && e.exp < Date.now()))
      .sort(([a], [b]) => (a < b ? -1 : 1)).slice(0, limit).map(([name, e]) => ({ name, metadata: e.meta }));
    return { keys, list_complete: true };
  }
}

export const KNOWN = new Set(["aaa111", "aaa222", "bbb111", "ccc111", "ccc222"]);

/** NextDNS falso: guarda listas/temas por perfil; perfil desconhecido => 404. */
export function installFakeNextDNS() {
  const state = {};
  const calls = [];
  const S = (pid) => (state[pid] ??= { denylist: [], allowlist: [], categories: [], services: [] });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opt = {}) => {
    const u = new URL(url);
    if (u.host !== "api.nextdns.io") return realFetch(url, opt);
    calls.push({ method: opt.method, path: u.pathname + u.search, key: opt.headers["X-Api-Key"] });
    const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s });
    const m = /^\/profiles\/([^/]+)\/(.+)$/.exec(u.pathname);
    if (!m || !KNOWN.has(m[1])) return json({ errors: [{ code: "notFound", detail: "profile not found" }] }, 404);
    const [, pid, rest] = m;
    const st = S(pid);
    const body = opt.body ? JSON.parse(opt.body) : null;
    let mm;
    if ((mm = /^(denylist|allowlist)$/.exec(rest))) {
      if (opt.method === "GET") return json({ data: st[mm[1]] });
      if (!st[mm[1]].some((i) => i.id === body.id)) st[mm[1]].push(body);
      return json({});
    }
    if ((mm = /^(denylist|allowlist)\/(.+)$/.exec(rest)) && opt.method === "DELETE") {
      st[mm[1]] = st[mm[1]].filter((i) => i.id !== decodeURIComponent(mm[2]));
      return json({});
    }
    if (rest === "parentalControl") return json({ data: { categories: st.categories, services: st.services } });
    if ((mm = /^parentalControl\/(categories|services)$/.exec(rest)) && opt.method === "POST") { st[mm[1]].push(body); return json({}); }
    if ((mm = /^parentalControl\/(categories|services)\/(.+)$/.exec(rest)) && opt.method === "PATCH") {
      const it = st[mm[1]].find((i) => i.id === decodeURIComponent(mm[2]));
      if (it) it.active = body.active;
      return json({});
    }
    if (rest === "logs") {
      const data = [
        { timestamp: "2026-10-13T12:00:00Z", domain: "bet365.com", device: { name: "LAB-01-PC01", localIp: "10.0.0.5" }, reasons: [{ name: "Apostas" }] },
        { timestamp: "2026-10-13T12:05:00Z", domain: "bet365.com", device: { name: "LAB-01-PC01" }, reasons: [{ name: "Apostas" }] },
        { timestamp: "2026-10-13T12:10:00Z", domain: "tiktok.com", device: { name: "LAB-02-PC04" }, reasons: [{ name: "TikTok" }] },
        { timestamp: "2026-10-13T12:11:00Z", domain: "x.com", reasons: [] },
      ];
      return json({ data, meta: { pagination: { cursor: null } } });
    }
    return json({ errors: [{ code: "unknown" }] }, 400);
  };
  return { state, calls, restore: () => (globalThis.fetch = realFetch) };
}
