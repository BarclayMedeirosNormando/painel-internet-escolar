// Garante que o seed gerado pelo script Python é aceito pelo Worker (formato do hash, índices, diretório).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { handle } from "../src/index.js";
import { MemKV, installFakeNextDNS } from "./helpers.js";

let hasPandas = true;
try { execFileSync("python3", ["-c", "import pandas, openpyxl"], { stdio: "ignore" }); } catch { hasPandas = false; }

test("seed.json gerado pelo Python carrega e permite login do admin", { skip: !hasPandas && "pandas/openpyxl não instalados" }, async () => {
  installFakeNextDNS();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seed-"));
  const schools = path.join(dir, "schools.json");
  fs.writeFileSync(schools, JSON.stringify({ A: { name: "Escola A", profiles: { Alunos: "aaa111", Administrativo: "aaa222" } } }));
  const xlsx = path.join(dir, "serv.xlsx");
  execFileSync("python3", ["-c", `import pandas as pd; pd.DataFrame([[1234567,'MARIA','SOUSA','DIRETOR DE ESCOLA REGULAR','EEEFM X'],[7654321,'JOAO','SOUSA','PROFESSOR DE EDUCACAO BAS III','EEEFM X'],[111222,'ANA','SOUSA','COORDEN PEDAGOGICO ESC REGULAR','EEEFM X']],columns=['MATRICULA','NOME','MUNICIPIO','CARGO','SETOR']).to_excel(r'${xlsx}',index=False)`]);
  const out = path.join(dir, "seed.json");
  const stdout = execFileSync("python3", [path.resolve("../tools/preparar_dados.py"), "--admin-matricula", "555666", "--admin-nome", "TI Teste",
    "--escolas", schools, "--servidores", xlsx, "--out", out]).toString();
  const temp = /Senha provisória: ([A-Z2-9]{5}-[A-Z2-9]{5})/.exec(stdout)[1];

  const env = { PAINEL: new MemKV(), SECRET_KEY: "s".repeat(40), NEXTDNS_API_KEY: "x", ALLOWED_ORIGIN: "" };
  for (const e of JSON.parse(fs.readFileSync(out, "utf8"))) await env.PAINEL.put(e.key, e.value, { metadata: e.metadata });

  const call = async (method, p, { token, json } = {}) => {
    const r = await handle(new Request("https://api.test" + p, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" }, body: json ? JSON.stringify(json) : undefined }), env);
    return { status: r.status, data: await r.json() };
  };
  const l = await call("POST", "/api/login", { json: { matricula: "555666", senha: temp } });
  assert.equal(l.status, 200); assert.equal(l.data.must_change, true);
  const s = await call("POST", "/api/senha", { token: l.data.token, json: { atual: temp, nova: "Segura#2026" } });
  assert.equal(s.status, 200);
  const t = s.data.token;
  const me = await call("GET", "/api/me", { token: t });
  assert.equal(me.data.profiles.length, 2);
  assert.equal((await call("GET", "/api/profile/aaa111/listas", { token: t })).status, 200);
  const d = await call("GET", "/api/admin/diretorio/1234567", { token: t });
  assert.equal(d.data.nome, "MARIA");
  assert.equal((await call("GET", "/api/admin/diretorio/111222", { token: t })).status, 200, "coordenador entra no diretório");
  assert.equal((await call("GET", "/api/admin/diretorio/7654321", { token: t })).status, 404, "professor fica de fora");
});
