// Cliente da API do NextDNS (https://nextdns.github.io/api/). A chave fica só no Worker.
const API = "https://api.nextdns.io";

export class NextDNSError extends Error {}

export function makeClient(key) {
  async function req(method, path, { json, params } = {}) {
    const url = new URL(API + path);
    for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, v);
    let r;
    try {
      r = await globalThis.fetch(url, {
        method,
        headers: { "X-Api-Key": key, ...(json ? { "Content-Type": "application/json" } : {}) },
        body: json ? JSON.stringify(json) : undefined,
        signal: AbortSignal.timeout(20000),
      });
    } catch {
      throw new NextDNSError("Falha de conexão com o NextDNS.");
    }
    let body = {};
    const text = await r.text();
    if (text) { try { body = JSON.parse(text); } catch { body = {}; } }
    if (r.status >= 400 || (body && body.errors)) {
      const detail = (body.errors || []).map((e) => e.detail || e.code).join("; ");
      throw new NextDNSError(detail || `Erro ${r.status} do NextDNS`);
    }
    return body;
  }
  const enc = (s) => encodeURIComponent(s);

  return {
    async listEntries(pid, kind) {
      return (await req("GET", `/profiles/${pid}/${kind}`)).data || [];
    },
    async addEntry(pid, kind, domain) {
      await req("POST", `/profiles/${pid}/${kind}`, { json: { id: domain, active: true } });
    },
    async removeEntry(pid, kind, domain) {
      await req("DELETE", `/profiles/${pid}/${kind}/${enc(domain)}`);
    },
    async getParental(pid) {
      const d = (await req("GET", `/profiles/${pid}/parentalControl`)).data || {};
      return { categories: d.categories || [], services: d.services || [] };
    },
    async setToggle(pid, kind, itemId, active) {
      const current = (await this.getParental(pid))[kind];
      const base = `/profiles/${pid}/parentalControl/${kind}`;
      if (current.some((i) => i.id === itemId)) {
        await req("PATCH", `${base}/${enc(itemId)}`, { json: { active } });
      } else if (active) {
        await req("POST", base, { json: { id: itemId, active: true } });
      } // se não existe e active=false, já está desligado
    },
    /** Somente consultas bloqueadas. Retorna { entries, truncated }. */
    async blockedLogs(pid, since = "-24h", maxPages = 5) {
      const entries = [];
      let cursor = null, truncated = false;
      for (let page = 0; page < maxPages; page++) {
        const params = { status: "blocked", from: since, limit: "1000" };
        if (cursor) params.cursor = cursor;
        const body = await req("GET", `/profiles/${pid}/logs`, { params });
        for (const e of body.data || []) entries.push(normalize(e));
        cursor = ((body.meta || {}).pagination || {}).cursor;
        if (!cursor) break;
        if (page === maxPages - 1) truncated = true;
      }
      return { entries, truncated };
    },
  };
}

function normalize(e) {
  const dev = e.device || {};
  const reasons = e.reasons || [];
  return {
    timestamp: e.timestamp || "",
    domain: e.domain || "",
    // IP do cliente propositalmente NÃO é repassado (minimização, LGPD)
    device: dev.name || "Dispositivo não identificado",
    reason: (reasons[0] && reasons[0].name) || "Bloqueado",
  };
}
