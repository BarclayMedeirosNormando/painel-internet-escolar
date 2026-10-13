import { test, before } from "node:test";
import assert from "node:assert/strict";
import { handle } from "../src/index.js";
import { hashPassword } from "../src/crypto.js";
import { MemKV, installFakeNextDNS } from "./helpers.js";

const ORIGIN = "https://painel.github.io";
const env = {
  PAINEL: new MemKV(), SECRET_KEY: "x".repeat(40), NEXTDNS_API_KEY: "chave-teste",
  ALLOWED_ORIGIN: ORIGIN, DIRECTOR_CAN_ALLOW: "1", SESSION_MINUTES: "120",
};
const fake = installFakeNextDNS();

async function call(method, path, { token, json, ip = "1.1.1.1", origin } = {}) {
  const headers = { "CF-Connecting-IP": ip };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (json !== undefined) headers["Content-Type"] = "application/json";
  if (origin) headers.Origin = origin;
  const r = await handle(new Request("https://api.test" + path, { method, headers, body: json !== undefined ? JSON.stringify(json) : undefined }), env);
  let data = null;
  try { data = await r.clone().json(); } catch {}
  return { status: r.status, data, headers: r.headers };
}
const login = async (mat, pwd, ip) => call("POST", "/api/login", { json: { matricula: mat, senha: pwd }, ip });
const tokenOf = async (mat, pwd) => (await login(mat, pwd)).data.token;

const putSchool = async (code, name, profiles) => {
  await env.PAINEL.put(`school:${code}`, JSON.stringify({ name, profiles }), { metadata: { name, profiles } });
  for (const [label, pid] of Object.entries(profiles)) await env.PAINEL.put(`pid:${pid}`, JSON.stringify({ school: code, label }));
};
const putUser = async (mat, u) => {
  const rec = { phone: "", must_change: false, schools: [], ...u, hash: await hashPassword(u.pw) };
  delete rec.pw;
  await env.PAINEL.put(`user:${mat}`, JSON.stringify(rec), { metadata: { name: rec.name, phone: rec.phone, role: rec.role, schools: rec.schools, must_change: rec.must_change, created_at: "" } });
};

before(async () => {
  await putSchool("A", "Escola A", { Alunos: "aaa111", Administrativo: "aaa222" });
  await putSchool("B", "Escola B", { Alunos: "bbb111" });
  await putUser("111", { name: "Dir A", role: "diretor", schools: ["A"], pw: "senhaA123" });
  await putUser("222", { name: "Dir B", role: "diretor", schools: ["B"], pw: "senhaB123" });
  await putUser("999", { name: "TI Sede", role: "admin", pw: "senhaTI123" });
});

// ------------------------------------------------------------ login e sessão
test("sem token: 401", async () => {
  assert.equal((await call("GET", "/api/me")).status, 401);
  assert.equal((await call("GET", "/api/profile/aaa111/listas")).status, 401);
  assert.equal((await call("GET", "/api/admin/dados")).status, 401);
});
test("token adulterado: 401", async () => {
  const t = await tokenOf("111", "senhaA123");
  assert.equal((await call("GET", "/api/me", { token: t.slice(0, -3) + "abc" })).status, 401);
});
test("login errado: 401 genérico; usuário inexistente igual", async () => {
  const a = await login("111", "errada!!!", "9.9.9.1");
  const b = await login("000", "errada!!!", "9.9.9.2");
  assert.equal(a.status, 401); assert.equal(b.status, 401);
  assert.equal(a.data.error, b.data.error);
});
test("bloqueio após 5 erros (por matrícula+IP) e outro IP não é afetado", async () => {
  for (let i = 0; i < 5; i++) await login("222", "errada!!!", "8.8.8.8");
  assert.equal((await login("222", "senhaB123", "8.8.8.8")).status, 429);
  assert.equal((await login("222", "senhaB123", "7.7.7.7")).status, 200);
});
test("/api/me devolve só as escolas do usuário", async () => {
  const me = (await call("GET", "/api/me", { token: await tokenOf("111", "senhaA123") })).data;
  assert.deepEqual(me.profiles.map((p) => p.pid).sort(), ["aaa111", "aaa222"]);
  assert.equal(me.user.role, "diretor");
  assert.ok(me.categories.length && me.services.length);
  assert.ok(!JSON.stringify(me).includes("hash"));
});
test("admin vê todas as escolas", async () => {
  const me = (await call("GET", "/api/me", { token: await tokenOf("999", "senhaTI123") })).data;
  assert.equal(me.profiles.length, 3);
});

// ------------------------------------------------------------ isolamento
test("diretor não acessa perfil de outra escola (nem escreve)", async () => {
  const t = await tokenOf("111", "senhaA123");
  assert.equal((await call("GET", "/api/profile/bbb111/listas", { token: t })).status, 403);
  assert.equal((await call("POST", "/api/profile/bbb111/sites/bloqueados", { token: t, json: { domain: "x.com" } })).status, 403);
  assert.equal((await call("GET", "/api/profile/../../x/listas", { token: t })).status, 404);
  assert.equal((await call("GET", "/api/profile/zzz999/listas", { token: t })).status, 403);
});
test("admin acessa qualquer perfil", async () => {
  assert.equal((await call("GET", "/api/profile/bbb111/listas", { token: await tokenOf("999", "senhaTI123") })).status, 200);
});

// ------------------------------------------------------------ sites e temas
test("bloquear/desbloquear site chega ao NextDNS e é auditado", async () => {
  const t = await tokenOf("111", "senhaA123");
  let r = await call("POST", "/api/profile/aaa111/sites/bloqueados", { token: t, json: { domain: "HTTPS://www.ApostasOnline.example/x?y=1" } });
  assert.equal(r.status, 200); assert.equal(r.data.domain, "apostasonline.example");
  assert.deepEqual((await call("GET", "/api/profile/aaa111/listas", { token: t })).data.deny, ["apostasonline.example"]);
  assert.equal(fake.calls.at(-1).key, "chave-teste");
  r = await call("DELETE", "/api/profile/aaa111/sites/bloqueados/apostasonline.example", { token: t });
  assert.equal(r.status, 200);
  assert.deepEqual((await call("GET", "/api/profile/aaa111/listas", { token: t })).data.deny, []);
  const rows = (await call("GET", "/api/auditoria", { token: t })).data.rows;
  assert.ok(rows.some((x) => x.action === "adicionou em bloqueados" && x.target === "apostasonline.example"));
});
test("domínio inválido, protegido e lista inexistente", async () => {
  const t = await tokenOf("111", "senhaA123");
  assert.equal((await call("POST", "/api/profile/aaa111/sites/bloqueados", { token: t, json: { domain: "nao é domínio" } })).status, 400);
  assert.equal((await call("POST", "/api/profile/aaa111/sites/bloqueados", { token: t, json: { domain: "api.nextdns.io" } })).status, 400);
  assert.equal((await call("POST", "/api/profile/aaa111/sites/bloqueados", { token: t, json: { domain: "seduc.pb.gov.br" } })).status, 400);
  assert.equal((await call("POST", "/api/profile/aaa111/sites/outra", { token: t, json: { domain: "x.com" } })).status, 404);
});
test("liberados respeita DIRECTOR_CAN_ALLOW", async () => {
  const t = await tokenOf("111", "senhaA123");
  assert.equal((await call("POST", "/api/profile/aaa111/sites/liberados", { token: t, json: { domain: "ok.com" } })).status, 200);
  env.DIRECTOR_CAN_ALLOW = "0";
  assert.equal((await call("POST", "/api/profile/aaa111/sites/liberados", { token: t, json: { domain: "ok2.com" } })).status, 404);
  assert.deepEqual((await call("GET", "/api/profile/aaa111/listas", { token: t })).data.allow, []);
  env.DIRECTOR_CAN_ALLOW = "1";
});
test("temas: liga/desliga e rejeita itens fora da lista", async () => {
  const t = await tokenOf("111", "senhaA123");
  assert.equal((await call("POST", "/api/profile/aaa111/temas", { token: t, json: { kind: "category", id: "porn", active: true } })).status, 200);
  assert.equal((await call("POST", "/api/profile/aaa111/temas", { token: t, json: { kind: "service", id: "tiktok", active: true } })).status, 200);
  let temas = (await call("GET", "/api/profile/aaa111/temas", { token: t })).data;
  assert.equal(temas.categories.find((c) => c.id === "porn").active, true);
  assert.equal(temas.services.find((c) => c.id === "tiktok").active, true);
  await call("POST", "/api/profile/aaa111/temas", { token: t, json: { kind: "category", id: "porn", active: false } });
  temas = (await call("GET", "/api/profile/aaa111/temas", { token: t })).data;
  assert.equal(temas.categories.find((c) => c.id === "porn").active, false);
  assert.equal((await call("POST", "/api/profile/aaa111/temas", { token: t, json: { kind: "category", id: "malware", active: false } })).status, 400);
  assert.equal((await call("POST", "/api/profile/aaa111/temas", { token: t, json: { kind: "security", id: "x", active: true } })).status, 400);
});
test("uso da rede agrega por computador e não vaza IP", async () => {
  const t = await tokenOf("111", "senhaA123");
  const r = await call("GET", "/api/profile/aaa111/uso?horas=24", { token: t });
  assert.equal(r.data.total, 4);
  assert.equal(r.data.devices[0].name, "LAB-01-PC01"); assert.equal(r.data.devices[0].count, 2);
  assert.ok(r.data.devices.some((d) => d.name === "Dispositivo não identificado"));
  assert.equal(r.data.domains[0].domain, "bet365.com");
  assert.ok(!JSON.stringify(r.data).includes("10.0.0.5"));
  assert.ok(fake.calls.some((c) => c.path.includes("status=blocked") && c.path.includes("from=-24h")));
  assert.equal((await call("GET", "/api/profile/aaa111/uso?horas=abc", { token: t })).data.horas, 24);
  assert.equal((await call("GET", "/api/profile/aaa111/uso?horas=9999", { token: t })).data.horas, 168);
});
test("falha do NextDNS vira 502; sem chave vira 503", async () => {
  // perfil no índice mas inexistente no NextDNS
  await env.PAINEL.put("pid:zzz999", JSON.stringify({ school: "A", label: "X" }));
  const t = await tokenOf("111", "senhaA123");
  assert.equal((await call("GET", "/api/profile/zzz999/listas", { token: t })).status, 502);
  const k = env.NEXTDNS_API_KEY; env.NEXTDNS_API_KEY = "";
  assert.equal((await call("GET", "/api/profile/aaa111/listas", { token: t })).status, 503);
  env.NEXTDNS_API_KEY = k;
});

// ------------------------------------------------------------ administração
test("diretor não usa rotas de admin", async () => {
  const t = await tokenOf("111", "senhaA123");
  assert.equal((await call("GET", "/api/admin/dados", { token: t })).status, 403);
  assert.equal((await call("POST", "/api/admin/usuarios", { token: t, json: { matricula: "5" } })).status, 403);
  assert.equal((await call("POST", "/api/admin/escolas", { token: t, json: {} })).status, 403);
  assert.equal((await call("POST", "/api/admin/usuarios/111/reset", { token: t, json: {} })).status, 403);
});

test("ciclo completo: cadastrar, 1º acesso, trocar senha, editar, resetar, remover", async () => {
  const ta = await tokenOf("999", "senhaTI123");
  const body = { nome: "Maria da Silva", matricula: "7654321", telefone: "(83) 99999-1234", papel: "diretor", escolas: ["A", "B"] };
  let r = await call("POST", "/api/admin/usuarios", { token: ta, json: body });
  assert.equal(r.status, 200);
  const temp = r.data.senha_temporaria;
  assert.match(temp, /^[A-Z2-9]{5}-[A-Z2-9]{5}$/);
  const stored = JSON.parse(await env.PAINEL.get("user:7654321"));
  assert.equal(stored.phone, "83999991234"); assert.equal(stored.must_change, true);
  assert.ok(!JSON.stringify(stored).includes(temp));

  assert.equal((await call("POST", "/api/admin/usuarios", { token: ta, json: body })).status, 409);
  for (const [extra, name] of [[{ matricula: "8", escolas: ["ZZ"] }, "escola inexistente"], [{ matricula: "88888", escolas: [] }, "sem escola"],
    [{ matricula: "88889", telefone: "123" }, "telefone"], [{ matricula: "ab" }, "matrícula"], [{ matricula: "88890", papel: "root" }, "papel"]]) {
    assert.equal((await call("POST", "/api/admin/usuarios", { token: ta, json: { ...body, ...extra } })).status, 400, name);
  }

  // 1º acesso
  r = await login("7654321", temp);
  assert.equal(r.data.must_change, true);
  const tm = r.data.token;
  assert.equal((await call("GET", "/api/me", { token: tm })).data.user.must_change, true);
  assert.equal((await call("GET", "/api/profile/aaa111/listas", { token: tm })).status, 403);
  assert.equal((await call("GET", "/api/profile/aaa111/listas", { token: tm })).data.must_change, true);
  for (const [nova, atual, nome] of [["abc12", temp, "curta"], ["12345678", temp, "sequência"], ["x7654321x", temp, "matrícula"], [temp, temp, "igual"], ["Nova#senha1", "ERRADA", "atual errada"]]) {
    assert.equal((await call("POST", "/api/senha", { token: tm, json: { atual, nova } })).status, 400, nome);
  }
  r = await call("POST", "/api/senha", { token: tm, json: { atual: temp, nova: "Nova#senha1" } });
  assert.equal(r.status, 200);
  const t2 = r.data.token;
  assert.equal((await call("GET", "/api/profile/aaa111/listas", { token: t2 })).status, 200);
  assert.equal((await call("GET", "/api/profile/bbb111/listas", { token: t2 })).status, 200);
  assert.equal((await call("GET", "/api/me", { token: tm })).status, 401, "token antigo cai após trocar senha");
  assert.equal((await login("7654321", temp, "2.2.2.2")).status, 401);
  assert.equal((await login("7654321", "Nova#senha1", "2.2.2.3")).status, 200);

  // editar vínculo
  r = await call("PUT", "/api/admin/usuarios/7654321", { token: ta, json: { ...body, escolas: ["B"], telefone: "" } });
  assert.equal(r.status, 200);
  assert.equal((await call("GET", "/api/profile/aaa111/listas", { token: t2 })).status, 403);
  assert.equal((await call("GET", "/api/profile/bbb111/listas", { token: t2 })).status, 200);
  assert.equal((await call("PUT", "/api/admin/usuarios/000", { token: ta, json: body })).status, 404);

  // reset destrava e derruba sessão
  for (let i = 0; i < 5; i++) await login("7654321", "errada!!!", "3.3.3.3");
  assert.equal((await login("7654321", "Nova#senha1", "3.3.3.3")).status, 429);
  r = await call("POST", "/api/admin/usuarios/7654321/reset", { token: ta, json: {} });
  const t3 = r.data.senha_temporaria;
  assert.notEqual(t3, temp);
  assert.equal((await call("GET", "/api/me", { token: t2 })).status, 401);
  r = await login("7654321", t3, "3.3.3.3");
  assert.equal(r.status, 200); assert.equal(r.data.must_change, true);
  assert.equal((await call("POST", "/api/admin/usuarios/000/reset", { token: ta, json: {} })).status, 404);

  // remover
  assert.equal((await call("DELETE", "/api/admin/usuarios/7654321", { token: ta })).status, 200);
  assert.equal((await call("GET", "/api/me", { token: r.data.token })).status, 401);
  assert.equal((await call("DELETE", "/api/admin/usuarios/7654321", { token: ta })).status, 404);
});

test("proteções do administrador", async () => {
  const ta = await tokenOf("999", "senhaTI123");
  assert.equal((await call("DELETE", "/api/admin/usuarios/999", { token: ta })).status, 400);
  assert.equal((await call("PUT", "/api/admin/usuarios/999", { token: ta, json: { nome: "TI Sede", papel: "diretor", escolas: ["A"] } })).status, 400);
  const r = await call("POST", "/api/admin/usuarios", { token: ta, json: { nome: "Outro Admin", matricula: "555", papel: "admin", escolas: ["A"] } });
  assert.equal(r.status, 200);
  assert.deepEqual(JSON.parse(await env.PAINEL.get("user:555")).schools, []);
  await call("DELETE", "/api/admin/usuarios/555", { token: ta });
});

test("lista de servidores não vaza hash", async () => {
  const d = (await call("GET", "/api/admin/dados", { token: await tokenOf("999", "senhaTI123") })).data;
  assert.ok(d.users.length >= 3 && d.schools.length === 2);
  assert.ok(!JSON.stringify(d).includes("pbkdf2"));
});

test("escolas: criar, atualizar, validar, conflito de ID, ID inexistente no NextDNS", async () => {
  const ta = await tokenOf("999", "senhaTI123");
  let r = await call("POST", "/api/admin/escolas", { token: ta, json: { codigo: "C1", nome: "Escola C", perfis: { Alunos: "ccc111", Administrativo: "ccc222" } } });
  assert.equal(r.status, 200); assert.equal(r.data.created, true);
  assert.equal(JSON.parse(await env.PAINEL.get("pid:ccc111")).school, "C1");
  r = await call("POST", "/api/admin/escolas", { token: ta, json: { codigo: "C1", nome: "Escola C Nova", perfis: { Alunos: "ccc111" } } });
  assert.equal(r.status, 200); assert.equal(r.data.created, false);
  assert.equal(await env.PAINEL.get("pid:ccc222"), null, "índice do ID removido ao tirar da escola");
  const post = (j) => call("POST", "/api/admin/escolas", { token: ta, json: j });
  assert.equal((await post({ codigo: "C2", nome: "Escola D", perfis: { Alunos: "aaa111" } })).status, 409);
  assert.equal((await post({ codigo: "C3", nome: "Escola E", perfis: { Alunos: "../x" } })).status, 400);
  assert.equal((await post({ codigo: "C3", nome: "Escola E", perfis: {} })).status, 400);
  assert.equal((await post({ codigo: "a b", nome: "Escola E", perfis: { Alunos: "ddd111" } })).status, 400);
  assert.equal((await post({ codigo: "C4", nome: "Escola F", perfis: { Alunos: "eee111", Adm: "eee111" } })).status, 400);
  assert.equal((await post({ codigo: "C5", nome: "Escola G", perfis: { Alunos: "nao111" } })).status, 400, "ID que não existe no NextDNS");
  // diretor de escola nova acessa só o ID dela
  const u = await call("POST", "/api/admin/usuarios", { token: ta, json: { nome: "Novo Diretor", matricula: "321", papel: "diretor", escolas: ["C1"] } });
  const l = await login("321", u.data.senha_temporaria);
  const s = await call("POST", "/api/senha", { token: l.data.token, json: { atual: u.data.senha_temporaria, nova: "Segura#2026" } });
  assert.equal((await call("GET", "/api/profile/ccc111/listas", { token: s.data.token })).status, 200);
  assert.equal((await call("GET", "/api/profile/aaa111/listas", { token: s.data.token })).status, 403);
});

test("auditoria: admin vê tudo, diretor só o seu, sem senhas", async () => {
  const ta = await tokenOf("999", "senhaTI123");
  const all = (await call("GET", "/api/auditoria", { token: ta })).data.rows;
  const acts = all.map((x) => x.action).join(" | ");
  for (const k of ["cadastrou servidor", "redefiniu senha", "removeu servidor", "cadastrou escola", "trocou a própria senha"]) assert.ok(acts.includes(k), k);
  assert.ok(!JSON.stringify(all).includes("Nova#senha1"));
  const own = (await call("GET", "/api/auditoria", { token: await tokenOf("111", "senhaA123") })).data.rows;
  assert.ok(own.length > 0 && own.every((x) => x.profile !== "-" && ["aaa111", "aaa222"].includes(x.profile)));
  assert.ok(all[0].ts >= all.at(-1).ts, "mais recentes primeiro");
});

// ------------------------------------------------------------ CORS e configuração
test("CORS: só a origem do Pages; preflight ok", async () => {
  let r = await call("OPTIONS", "/api/login", { origin: ORIGIN });
  assert.equal(r.status, 204); assert.equal(r.headers.get("access-control-allow-origin"), ORIGIN);
  r = await call("GET", "/api/health", { origin: "https://malicioso.example" });
  assert.equal(r.headers.get("access-control-allow-origin"), null);
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
});
test("health e rota desconhecida", async () => {
  const r = await call("GET", "/api/health");
  assert.equal(r.data.ok, true); assert.equal(r.data.nextdns_configured, true);
  assert.equal((await call("GET", "/api/nada")).status, 404);
});
test("sem SECRET_KEY o servidor recusa tudo", async () => {
  const k = env.SECRET_KEY; env.SECRET_KEY = "curta";
  assert.equal((await call("GET", "/api/health")).status, 503);
  env.SECRET_KEY = k;
});

test("diretório de gestores: consulta só para admin; 404 se não existe", async () => {
  await env.PAINEL.put("diretorio", JSON.stringify({ "1234567": ["MARIA DA SILVA", "DIRETOR DE ESCOLA REGULAR", "EEEFM EXEMPLO", "SOUSA"] }));
  const ta = await tokenOf("999", "senhaTI123");
  const r = await call("GET", "/api/admin/diretorio/1234567", { token: ta });
  assert.equal(r.status, 200); assert.equal(r.data.nome, "MARIA DA SILVA"); assert.equal(r.data.setor, "EEEFM EXEMPLO");
  assert.equal((await call("GET", "/api/admin/diretorio/7777777", { token: ta })).status, 404);
  assert.equal((await call("GET", "/api/admin/diretorio/1234567", { token: await tokenOf("111", "senhaA123") })).status, 403);
});
