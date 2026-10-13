// Painel de Internet Escolar — API (Cloudflare Worker). SEE-PB.
// Dados no KV "PAINEL":
//   user:<matricula>   -> {name, phone, role, schools[], hash, must_change, ...}   (metadata = campos públicos)
//   school:<codigo>    -> {name, profiles{rótulo: id}}                              (metadata = o mesmo)
//   pid:<id>           -> {school, label}   índice reverso para checar escopo sem listar
//   fail:<mat>:<ip>    -> contagem de erros de login (expira em 10 min)
//   audit:<ts invertido>:<rand> -> "1" com metadata do evento (expira em 400 dias)
import { CATEGORIES, SERVICES, CATEGORY_IDS, SERVICE_IDS, PROTECTED_SUFFIXES } from "./catalog.js";
import * as acc from "./accounts.js";
import { hashPassword, verifyPassword, signToken, verifyToken, pwFingerprint, setIterations } from "./crypto.js";
import { makeClient, NextDNSError } from "./nextdns.js";

class HttpError extends Error {
  constructor(status, msg, extra = {}) { super(msg); this.status = status; this.extra = extra; }
}

const ROLES = ["diretor", "coordenador", "admin"];
const CODE_RE = /^[A-Za-z0-9_-]{2,20}$/;
const PID_RE = /^[A-Za-z0-9]{4,12}$/;
const MAT_RE = /^\d{3,15}$/;
const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+([a-z]{2,63}|xn--[a-z0-9-]{2,59})$/;
const MAX_FAILS = 5, LOCK_SECONDS = 600, AUDIT_TTL = 400 * 86400, MAX_SCHOOLS_PER_USER = 25;

const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
const canAllow = (env) => (env.DIRECTOR_CAN_ALLOW ?? "1") === "1";

// ------------------------------------------------------------------ KV
const kvGet = (env, key) => env.PAINEL.get(key, "json");

async function listAll(env, prefix) {
  const out = [];
  let cursor;
  do {
    const r = await env.PAINEL.list({ prefix, cursor, limit: 1000 });
    out.push(...r.keys);
    cursor = r.list_complete ? undefined : r.cursor;
  } while (cursor && out.length < 5000);
  return out;
}

const userMeta = (u) => ({
  name: u.name, phone: u.phone || "", role: u.role, schools: u.schools || [],
  must_change: !!u.must_change, created_at: u.created_at || "",
});
const putUser = (env, mat, u) =>
  env.PAINEL.put(`user:${mat}`, JSON.stringify(u), { metadata: userMeta(u) });
const putSchool = (env, code, s) =>
  env.PAINEL.put(`school:${code}`, JSON.stringify(s), { metadata: s });

async function allSchools(env) {
  const out = {};
  for (const k of await listAll(env, "school:")) {
    const v = k.metadata && k.metadata.profiles ? k.metadata : await kvGet(env, k.name);
    if (v) out[k.name.slice(7)] = { name: v.name, profiles: v.profiles };
  }
  return out;
}

async function allUsers(env) {
  const out = {};
  for (const k of await listAll(env, "user:")) {
    const v = k.metadata && k.metadata.role ? k.metadata : await kvGet(env, k.name);
    if (v) out[k.name.slice(5)] = userMeta(v);
  }
  return out;
}

async function audit(env, mat, school, profile, action, target) {
  const inv = String(9999999999999 - Date.now()).padStart(13, "0");
  const rand = crypto.getRandomValues(new Uint8Array(3)).reduce((s, b) => s + b.toString(16).padStart(2, "0"), "");
  // metadata do KV tem limite de 1 KB: trunca campos longos
  const meta = { ts: nowIso(), matricula: mat, school: String(school).slice(0, 100), profile: String(profile).slice(0, 100), action, target: String(target).slice(0, 200) };
  await env.PAINEL.put(`audit:${inv}:${rand}`, "1", { metadata: meta, expirationTtl: AUDIT_TTL });
}

// ------------------------------------------------------------------ HTTP
function corsHeaders(env, req) {
  const origin = req.headers.get("Origin");
  const allowed = String(env.ALLOWED_ORIGIN || "").split(",").map((s) => s.trim()).filter(Boolean);
  const h = {
    "Vary": "Origin",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
  };
  if (origin && allowed.includes(origin)) {
    h["Access-Control-Allow-Origin"] = origin;
    h["Access-Control-Allow-Headers"] = "Authorization, Content-Type";
    h["Access-Control-Allow-Methods"] = "GET, POST, PUT, DELETE, OPTIONS";
    h["Access-Control-Max-Age"] = "600";
  }
  return h;
}

const respond = (env, req, data, status = 200) =>
  new Response(JSON.stringify(data), {
    status, headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders(env, req) },
  });

async function body(req) {
  try { return (await req.json()) || {}; } catch { return {}; }
}

// ------------------------------------------------------------------ auth / escopo
async function authenticate(env, req) {
  const m = /^Bearer (.+)$/.exec(req.headers.get("Authorization") || "");
  const p = m && (await verifyToken(m[1], env.SECRET_KEY));
  if (!p) throw new HttpError(401, "Sessão expirada. Entre novamente.");
  const u = await kvGet(env, `user:${p.m}`);
  if (!u || pwFingerprint(u.hash) !== p.pv) throw new HttpError(401, "Sessão expirada. Entre novamente.");
  return { ...u, matricula: p.m };
}

async function issueToken(env, mat, u) {
  const minutes = Number(env.SESSION_MINUTES || 120);
  return signToken({ m: mat, pv: pwFingerprint(u.hash), exp: Math.floor(Date.now() / 1000) + minutes * 60 }, env.SECRET_KEY);
}

/** Escopo de um perfil: admin vê todos; demais só os das suas escolas. */
async function profileScope(env, user, pid) {
  if (!PID_RE.test(pid)) throw new HttpError(403, "Sem permissão para este perfil.");
  const idx = await kvGet(env, `pid:${pid}`);
  if (!idx || (user.role !== "admin" && !(user.schools || []).includes(idx.school))) {
    throw new HttpError(403, "Sem permissão para este perfil.");
  }
  return { school_code: idx.school, label: idx.label };
}

function getClient(env) {
  if (!env.NEXTDNS_API_KEY) throw new HttpError(503, "O servidor ainda não tem a chave do NextDNS configurada.");
  return makeClient(env.NEXTDNS_API_KEY);
}

// ------------------------------------------------------------------ rotas
const routes = [];
const route = (method, path, opts, fn) => {
  const re = new RegExp("^" + path.replace(/:(\w+)/g, "(?<$1>[^/]+)") + "$");
  routes.push({ method, re, opts, fn });
};

function cleanDomain(raw) {
  let d = String(raw || "").trim().toLowerCase();
  d = d.replace(/^[a-z]+:\/\//, "");
  d = d.split("/")[0].split("?")[0].split(":")[0].replace(/^\.+|\.+$/g, "");
  return d.startsWith("www.") ? d.slice(4) : d;
}

// ---- saúde
route("GET", "/api/health", { auth: false }, async ({ env }) => ({
  ok: true, nextdns_configured: !!env.NEXTDNS_API_KEY, secret_configured: !!env.SECRET_KEY,
}));

// ---- login
let dummyHash;
route("POST", "/api/login", { auth: false }, async ({ env, req }) => {
  const b = await body(req);
  const mat = acc.normMatricula(b.matricula);
  const senha = String(b.senha || "");
  const ip = req.headers.get("CF-Connecting-IP") || "0";
  const failKey = `fail:${mat}:${ip}`;
  const count = Number(await env.PAINEL.get(failKey)) || 0;
  if (count >= MAX_FAILS) throw new HttpError(429, "Muitas tentativas. Aguarde alguns minutos e tente novamente.");

  const u = MAT_RE.test(mat) ? await kvGet(env, `user:${mat}`) : null;
  dummyHash ??= await hashPassword("senha-inexistente");
  const ok = await verifyPassword(senha, u ? u.hash : dummyHash);
  if (!u || !ok) {
    await env.PAINEL.put(failKey, String(count + 1), { expirationTtl: LOCK_SECONDS });
    throw new HttpError(401, "Matrícula ou senha incorretas.");
  }
  if (count) await env.PAINEL.delete(failKey);
  return { token: await issueToken(env, mat, u), must_change: !!u.must_change };
});

// ---- quem sou eu / dados para montar a tela
route("GET", "/api/me", { allowMustChange: true }, async ({ env, user }) => {
  const me = { name: user.name, matricula: user.matricula, role: user.role, must_change: !!user.must_change };
  if (user.must_change) return { user: me, profiles: [] };
  const schools = user.role === "admin"
    ? await allSchools(env)
    : Object.fromEntries((await Promise.all((user.schools || []).map(async (c) => [c, await kvGet(env, `school:${c}`)]))).filter(([, s]) => s));
  const profiles = [];
  for (const [code, s] of Object.entries(schools)) {
    for (const [label, pid] of Object.entries(s.profiles || {})) {
      profiles.push({ pid, school_code: code, school: s.name, label });
    }
  }
  profiles.sort((a, b) => a.school.localeCompare(b.school, "pt-BR") || a.label.localeCompare(b.label, "pt-BR"));
  return { user: me, profiles, categories: CATEGORIES, services: SERVICES, can_allow: canAllow(env) };
});

// ---- troca da própria senha
route("POST", "/api/senha", { allowMustChange: true }, async ({ env, req, user }) => {
  const b = await body(req);
  const atual = String(b.atual || ""), nova = String(b.nova || "");
  if (!(await verifyPassword(atual, user.hash))) throw new HttpError(400, "A senha atual (provisória) está incorreta.");
  const problem = acc.passwordProblem(nova, user.matricula, atual);
  if (problem) throw new HttpError(400, problem);
  const rec = await kvGet(env, `user:${user.matricula}`);
  rec.hash = await hashPassword(nova);
  rec.must_change = false;
  rec.password_changed_at = nowIso();
  await putUser(env, user.matricula, rec);
  await audit(env, user.matricula, "-", "-", "trocou a própria senha", user.matricula);
  return { ok: true, token: await issueToken(env, user.matricula, rec) };
});

// ---- listas de sites
const listKind = (env, name) => {
  if (name === "bloqueados") return "denylist";
  if (name === "liberados" && canAllow(env)) return "allowlist";
  throw new HttpError(404, "Não encontrado.");
};

route("GET", "/api/profile/:pid/listas", { scope: true }, async ({ env, params }) => {
  const c = getClient(env);
  return {
    deny: (await c.listEntries(params.pid, "denylist")).map((e) => e.id),
    allow: canAllow(env) ? (await c.listEntries(params.pid, "allowlist")).map((e) => e.id) : [],
  };
});

route("POST", "/api/profile/:pid/sites/:lista", { scope: true }, async ({ env, req, params, user, prof }) => {
  const kind = listKind(env, params.lista);
  const domain = cleanDomain((await body(req)).domain);
  if (!DOMAIN_RE.test(domain)) throw new HttpError(400, "Endereço inválido. Exemplo: exemplo.com.br");
  if (kind === "denylist" && PROTECTED_SUFFIXES.some((s) => domain === s || domain.endsWith("." + s))) {
    throw new HttpError(400, "Este endereço é protegido e não pode ser bloqueado.");
  }
  await getClient(env).addEntry(params.pid, kind, domain);
  await audit(env, user.matricula, prof.school_code, params.pid, `adicionou em ${params.lista}`, domain);
  return { ok: true, domain };
});

route("DELETE", "/api/profile/:pid/sites/:lista/:domain", { scope: true }, async ({ env, params, user, prof }) => {
  const kind = listKind(env, params.lista);
  const domain = cleanDomain(params.domain);
  if (!DOMAIN_RE.test(domain)) throw new HttpError(400, "Endereço inválido.");
  await getClient(env).removeEntry(params.pid, kind, domain);
  await audit(env, user.matricula, prof.school_code, params.pid, `removeu de ${params.lista}`, domain);
  return { ok: true };
});

// ---- temas
route("GET", "/api/profile/:pid/temas", { scope: true }, async ({ env, params }) => {
  const par = await getClient(env).getParental(params.pid);
  const cat = new Map(par.categories.map((i) => [i.id, !!i.active]));
  const srv = new Map(par.services.map((i) => [i.id, !!i.active]));
  return {
    categories: CATEGORIES.map((c) => ({ ...c, active: cat.get(c.id) || false })),
    services: SERVICES.map((s) => ({ ...s, active: srv.get(s.id) || false })),
  };
});

route("POST", "/api/profile/:pid/temas", { scope: true }, async ({ env, req, params, user, prof }) => {
  const b = await body(req);
  const active = !!b.active;
  const c = getClient(env);
  if (b.kind === "category" && CATEGORY_IDS.has(b.id)) await c.setToggle(params.pid, "categories", b.id, active);
  else if (b.kind === "service" && SERVICE_IDS.has(b.id)) await c.setToggle(params.pid, "services", b.id, active);
  else throw new HttpError(400, "Tema não permitido.");
  await audit(env, user.matricula, prof.school_code, params.pid, active ? "bloqueou tema" : "liberou tema", `${b.kind}:${b.id}`);
  return { ok: true };
});

// ---- uso da rede
route("GET", "/api/profile/:pid/uso", { scope: true }, async ({ env, url, params }) => {
  let horas = parseInt(url.searchParams.get("horas") || "24", 10);
  if (!Number.isFinite(horas)) horas = 24;
  horas = Math.max(1, Math.min(168, horas));
  const { entries, truncated } = await getClient(env).blockedLogs(params.pid, `-${horas}h`);
  const devices = new Map(), domains = new Map(), reasons = new Map();
  for (const e of entries) {
    const d = devices.get(e.device) || { count: 0, last: "", domains: new Map() };
    d.count++;
    if (e.timestamp > d.last) d.last = e.timestamp;
    d.domains.set(e.domain, (d.domains.get(e.domain) || 0) + 1);
    devices.set(e.device, d);
    domains.set(e.domain, (domains.get(e.domain) || 0) + 1);
    if (!reasons.has(e.domain)) reasons.set(e.domain, e.reason);
  }
  const top = (m, n) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
  return {
    total: entries.length, horas, truncated,
    devices: [...devices.entries()]
      .map(([name, v]) => ({ name, count: v.count, last: v.last, top: top(v.domains, 3) }))
      .sort((a, b) => b.count - a.count),
    domains: top(domains, 15).map(([domain, count]) => ({ domain, count, reason: reasons.get(domain) })),
  };
});

// ---- auditoria
route("GET", "/api/auditoria", {}, async ({ env, user }) => {
  const keys = await env.PAINEL.list({ prefix: "audit:", limit: 1000 });
  let rows = keys.keys.map((k) => k.metadata).filter(Boolean);
  if (user.role !== "admin") {
    const own = new Set();
    for (const code of user.schools || []) {
      const s = await kvGet(env, `school:${code}`);
      for (const pid of Object.values((s && s.profiles) || {})) own.add(pid);
    }
    rows = rows.filter((r) => own.has(r.profile));
  }
  return { rows: rows.slice(0, 100) };
});

// ------------------------------------------------------------------ administração (TI da Sede)
const publicUser = (mat, u) => ({
  matricula: mat, name: u.name || "", phone: u.phone || "", role: u.role || "diretor",
  schools: u.schools || [], must_change: !!u.must_change, created_at: u.created_at || "",
});
const adminCount = (users) => Object.values(users).filter((u) => u.role === "admin").length;

async function parseUserBody(b, schools) {
  const name = String(b.nome || "").split(/\s+/).filter(Boolean).join(" ");
  if (name.length < 3 || name.length > 100) throw new HttpError(400, "Informe o nome completo (3 a 100 caracteres).");
  let phone;
  try { phone = acc.normalizePhone(b.telefone); } catch (e) { throw new HttpError(400, e.message); }
  const role = b.papel ?? "diretor";
  if (!ROLES.includes(role)) throw new HttpError(400, "Papel inválido.");
  let codes = b.escolas ?? [];
  if (!Array.isArray(codes)) throw new HttpError(400, "Lista de escolas inválida.");
  codes = [...new Set(codes.map(String))];
  const unknown = codes.filter((c) => !(c in schools));
  if (unknown.length) throw new HttpError(400, `Escola não cadastrada: ${unknown.join(", ")}.`);
  if (role !== "admin" && !codes.length) throw new HttpError(400, "Vincule o servidor a pelo menos uma escola.");
  if (codes.length > MAX_SCHOOLS_PER_USER) throw new HttpError(400, `No máximo ${MAX_SCHOOLS_PER_USER} escolas por servidor.`);
  return { name, phone, role, schools: role === "admin" ? [] : codes };
}

const ADMIN = { admin: true };

route("GET", "/api/admin/dados", ADMIN, async ({ env }) => {
  const [users, schools] = await Promise.all([allUsers(env), allSchools(env)]);
  return {
    users: Object.entries(users).map(([m, u]) => publicUser(m, u)).sort((a, b) => a.name.localeCompare(b.name, "pt-BR")),
    schools: Object.entries(schools).map(([code, s]) => ({ code, name: s.name, profiles: s.profiles }))
      .sort((a, b) => a.name.localeCompare(b.name, "pt-BR")),
  };
});

// Consulta no cadastro de gestores (diretores/coordenadores) carregado pela TI: preenche nome, cargo e setor.
route("GET", "/api/admin/diretorio/:mat", ADMIN, async ({ env, params }) => {
  const dir = await env.PAINEL.get("diretorio", "json");
  const row = dir && MAT_RE.test(params.mat) ? dir[params.mat] : null;
  if (!row) throw new HttpError(404, "Matrícula não encontrada no cadastro de gestores. Preencha o nome manualmente.");
  const [nome, cargo, setor, municipio] = row;
  return { matricula: params.mat, nome, cargo, setor, municipio };
});

route("POST", "/api/admin/usuarios", ADMIN, async ({ env, req, user }) => {
  const b = await body(req);
  const mat = acc.normMatricula(b.matricula);
  if (!acc.validMatricula(mat)) throw new HttpError(400, "Matrícula inválida (somente números, 3 a 15 dígitos).");
  if (await kvGet(env, `user:${mat}`)) throw new HttpError(409, "Esta matrícula já está cadastrada. Use Editar ou Redefinir senha.");
  const fields = await parseUserBody(b, await allSchools(env));
  const temp = acc.tempPassword();
  await putUser(env, mat, {
    ...fields, hash: await hashPassword(temp), must_change: true, created_at: nowIso(), created_by: user.matricula,
  });
  await audit(env, user.matricula, fields.schools.join(",") || "-", "-", `cadastrou servidor (${fields.role})`, mat);
  return { ok: true, matricula: mat, senha_temporaria: temp };
});

route("PUT", "/api/admin/usuarios/:mat", ADMIN, async ({ env, req, params, user }) => {
  const mat = params.mat;
  const rec = MAT_RE.test(mat) && (await kvGet(env, `user:${mat}`));
  if (!rec) throw new HttpError(404, "Matrícula não encontrada.");
  const fields = await parseUserBody(await body(req), await allSchools(env));
  if (mat === user.matricula && fields.role !== "admin") {
    throw new HttpError(400, "Você não pode remover o seu próprio acesso de administrador.");
  }
  if (rec.role === "admin" && fields.role !== "admin" && adminCount(await allUsers(env)) <= 1) {
    throw new HttpError(400, "Deve existir ao menos um administrador.");
  }
  await putUser(env, mat, { ...rec, ...fields });
  await audit(env, user.matricula, fields.schools.join(",") || "-", "-", "alterou cadastro de servidor", mat);
  return { ok: true };
});

route("POST", "/api/admin/usuarios/:mat/reset", ADMIN, async ({ env, params, user }) => {
  const mat = params.mat;
  const rec = MAT_RE.test(mat) && (await kvGet(env, `user:${mat}`));
  if (!rec) throw new HttpError(404, "Matrícula não encontrada.");
  const temp = acc.tempPassword();
  rec.hash = await hashPassword(temp);
  rec.must_change = true;
  rec.password_reset_at = nowIso();
  await putUser(env, mat, rec);
  for (const k of await listAll(env, `fail:${mat}:`)) await env.PAINEL.delete(k.name); // destrava a conta
  await audit(env, user.matricula, "-", "-", "redefiniu senha de servidor", mat);
  return { ok: true, matricula: mat, senha_temporaria: temp };
});

route("DELETE", "/api/admin/usuarios/:mat", ADMIN, async ({ env, params, user }) => {
  const mat = params.mat;
  if (mat === user.matricula) throw new HttpError(400, "Você não pode remover o seu próprio cadastro.");
  const rec = MAT_RE.test(mat) && (await kvGet(env, `user:${mat}`));
  if (!rec) throw new HttpError(404, "Matrícula não encontrada.");
  if (rec.role === "admin" && adminCount(await allUsers(env)) <= 1) {
    throw new HttpError(400, "Deve existir ao menos um administrador.");
  }
  await env.PAINEL.delete(`user:${mat}`);
  await audit(env, user.matricula, "-", "-", "removeu servidor", mat);
  return { ok: true };
});

route("POST", "/api/admin/escolas", ADMIN, async ({ env, req, user }) => {
  const b = await body(req);
  const code = String(b.codigo || "").trim();
  const name = String(b.nome || "").split(/\s+/).filter(Boolean).join(" ");
  const raw = b.perfis || {};
  if (!CODE_RE.test(code)) throw new HttpError(400, "Código da escola inválido (2 a 20 letras, números, - ou _).");
  if (name.length < 3 || name.length > 120) throw new HttpError(400, "Informe o nome da escola.");
  if (typeof raw !== "object" || Array.isArray(raw)) throw new HttpError(400, "Perfis inválidos.");
  const profiles = {};
  for (const [l, p] of Object.entries(raw)) {
    const label = String(l).split(/\s+/).filter(Boolean).join(" "), pid = String(p).trim();
    if (!label && !pid) continue;
    if (!label || !PID_RE.test(pid)) throw new HttpError(400, `ID de configuração inválido: '${pid}'. Copie do NextDNS (ex.: 2fdcb8).`);
    profiles[label] = pid;
  }
  const ids = Object.values(profiles);
  if (!ids.length) throw new HttpError(400, "Informe ao menos um ID de configuração do NextDNS.");
  if (new Set(ids).size !== ids.length) throw new HttpError(400, "O mesmo ID foi informado duas vezes.");

  const existing = await kvGet(env, `school:${code}`);
  const oldIds = existing ? Object.values(existing.profiles || {}) : [];
  const client = getClient(env);
  for (const pid of ids) {
    const idx = await kvGet(env, `pid:${pid}`);
    if (idx && idx.school !== code) {
      const other = await kvGet(env, `school:${idx.school}`);
      throw new HttpError(409, `O ID ${pid} já pertence à escola ${other ? other.name : idx.school}.`);
    }
    if (!oldIds.includes(pid)) { // ID novo: confere se existe na conta do NextDNS
      try { await client.listEntries(pid, "denylist"); }
      catch (e) { if (e instanceof NextDNSError) throw new HttpError(400, `O ID ${pid} não foi encontrado na conta do NextDNS.`); throw e; }
    }
  }
  await putSchool(env, code, { name, profiles });
  for (const [label, pid] of Object.entries(profiles)) await env.PAINEL.put(`pid:${pid}`, JSON.stringify({ school: code, label }));
  for (const pid of oldIds.filter((p) => !ids.includes(p))) await env.PAINEL.delete(`pid:${pid}`);
  await audit(env, user.matricula, code, ids.join(","), existing ? "alterou escola" : "cadastrou escola", name);
  return { ok: true, created: !existing };
});

// ------------------------------------------------------------------ entrada
export async function handle(req, env) {
  const url = new URL(req.url);
  setIterations(env.PBKDF2_ITERATIONS);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(env, req) });
  try {
    if (!env.SECRET_KEY || env.SECRET_KEY.length < 32) {
      throw new HttpError(503, "Servidor sem SECRET_KEY configurada (mínimo 32 caracteres).");
    }
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = r.re.exec(url.pathname);
      if (!m) continue;
      const params = Object.fromEntries(Object.entries(m.groups || {}).map(([k, v]) => {
        try { return [k, decodeURIComponent(v)]; } catch { return [k, v]; }
      }));
      const ctx = { env, req, url, params };
      if (r.opts.auth !== false) {
        ctx.user = await authenticate(env, req);
        if (ctx.user.must_change && !r.opts.allowMustChange) {
          throw new HttpError(403, "Troque a senha provisória antes de continuar.", { must_change: true });
        }
        if (r.opts.admin && ctx.user.role !== "admin") throw new HttpError(403, "Apenas a TI da Sede pode fazer isso.");
        if (r.opts.scope) ctx.prof = await profileScope(env, ctx.user, params.pid);
      }
      return respond(env, req, await r.fn(ctx));
    }
    throw new HttpError(404, "Não encontrado.");
  } catch (e) {
    if (e instanceof HttpError) return respond(env, req, { error: e.message, ...e.extra }, e.status);
    if (e instanceof NextDNSError) return respond(env, req, { error: e.message }, 502);
    console.error("erro interno", e && e.stack ? e.stack : e);
    return respond(env, req, { error: "Erro interno. Tente novamente." }, 500);
  }
}

export default { fetch: (req, env) => handle(req, env) };
