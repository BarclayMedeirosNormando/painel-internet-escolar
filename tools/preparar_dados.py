#!/usr/bin/env python3
"""Gera o arquivo seed.json para carregar no KV do Cloudflare (primeira instalação).

Inclui:
  - o primeiro administrador (TI da Sede), com senha provisória (troca obrigatória no 1º acesso);
  - escolas e seus IDs do NextDNS (opcional: --escolas schools.json);
  - cadastro de gestores (diretores, vice-diretores e coordenadores) a partir da planilha de servidores
    (opcional: --servidores SERVIDORES.xlsx) — usado só para preencher nome/cargo/escola ao cadastrar.

Uso:
  python preparar_dados.py --admin-matricula 123456 --admin-nome "Fulano da TI" \
         --escolas schools.json --servidores SERVIDORES_SETEMBRO.xlsx
  cd ../worker
  npx wrangler kv bulk put ../tools/seed.json --binding PAINEL --remote

ATENÇÃO: seed.json contém hash de senha e dados pessoais. NUNCA envie ao GitHub (já está no .gitignore)
e apague o arquivo depois de carregar.
"""
import argparse
import base64
import hashlib
import json
import re
import secrets
import sys
import unicodedata
from datetime import datetime, timezone
from pathlib import Path

ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
GESTOR = re.compile(r"^(VICE )?DIRETOR|^COORDEN")


def b64u(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).decode().rstrip("=")


def hash_password(pw: str, iterations: int = 100000) -> str:
    salt = secrets.token_bytes(16)
    dk = hashlib.pbkdf2_hmac("sha256", pw.encode(), salt, iterations, 32)
    return f"pbkdf2${iterations}${b64u(salt)}${b64u(dk)}"


def temp_password() -> str:
    raw = "".join(secrets.choice(ALPHABET) for _ in range(10))
    return f"{raw[:5]}-{raw[5:]}"


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--admin-matricula", required=True)
    ap.add_argument("--admin-nome", required=True)
    ap.add_argument("--admin-telefone", default="")
    ap.add_argument("--escolas", help="schools.json do painel antigo: {codigo: {name, profiles}}")
    ap.add_argument("--servidores", help="planilha .xlsx (MATRICULA, NOME, MUNICIPIO, CARGO, SETOR)")
    ap.add_argument("--out", default=str(Path(__file__).with_name("seed.json")))
    a = ap.parse_args()

    mat = re.sub(r"\D", "", a.admin_matricula)
    if not 3 <= len(mat) <= 15:
        sys.exit("Matrícula inválida (3 a 15 dígitos).")
    entries = []

    temp = temp_password()
    user = {"name": " ".join(a.admin_nome.split()), "phone": re.sub(r"\D", "", a.admin_telefone), "role": "admin",
            "schools": [], "hash": hash_password(temp), "must_change": True,
            "created_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "created_by": "seed"}
    entries.append({"key": f"user:{mat}", "value": json.dumps(user, ensure_ascii=False),
                    "metadata": {"name": user["name"], "phone": user["phone"], "role": "admin", "schools": [],
                                 "must_change": True, "created_at": user["created_at"]}})

    n_school = 0
    if a.escolas:
        schools = json.loads(Path(a.escolas).read_text(encoding="utf-8"))
        for code, s in schools.items():
            meta = {"name": s["name"], "profiles": s["profiles"]}
            entries.append({"key": f"school:{code}", "value": json.dumps(meta, ensure_ascii=False), "metadata": meta})
            for label, pid in s["profiles"].items():
                entries.append({"key": f"pid:{pid}", "value": json.dumps({"school": code, "label": label})})
            n_school += 1

    n_dir = 0
    if a.servidores:
        import pandas as pd
        df = pd.read_excel(a.servidores, dtype=str).fillna("")
        df.columns = [c.strip().upper() for c in df.columns]
        falta = {"MATRICULA", "NOME", "CARGO", "SETOR"} - set(df.columns)
        if falta:
            sys.exit(f"Planilha sem as colunas: {', '.join(sorted(falta))}")
        if "MUNICIPIO" not in df.columns:
            df["MUNICIPIO"] = ""
        directory = {}
        for r in df.itertuples():
            cargo = str(r.CARGO).strip().upper()
            if GESTOR.search(cargo):
                m = re.sub(r"\D", "", str(r.MATRICULA))
                if m:
                    directory[m] = [str(r.NOME).strip(), cargo, str(r.SETOR).strip(), str(r.MUNICIPIO).strip()]
        n_dir = len(directory)
        entries.append({"key": "diretorio", "value": json.dumps(directory, ensure_ascii=False, separators=(",", ":"))})

    Path(a.out).write_text(json.dumps(entries, ensure_ascii=False), encoding="utf-8")
    print(f"seed.json gerado: {a.out}")
    print(f"  administrador {mat}, escolas: {n_school}, gestores no cadastro: {n_dir}")
    print("\n" + "=" * 50)
    print(f" Matrícula: {mat}")
    print(f" Senha provisória: {temp}")
    print(" (troca obrigatória no primeiro acesso; esta senha não fica salva em lugar nenhum)")
    print("=" * 50)


if __name__ == "__main__":
    main()
