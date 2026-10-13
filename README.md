# Painel de Internet Escolar — SEE-PB (PWA)

Front em **GitHub Pages** (PWA instalável) + API em **Cloudflare Worker** + dados no **Cloudflare KV**.
A chave do NextDNS fica só no Worker (segredo), nunca no navegador nem no GitHub.

```
web/      -> site (HTML/JS/CSS, manifest, service worker)         => GitHub Pages
worker/   -> API (login, escolas, servidores, NextDNS, auditoria)  => Cloudflare Workers
tools/    -> preparar_dados.py (primeiro administrador, escolas, cadastro de gestores)
```

**Atualizar = `git push`.** Mexeu em `web/` → o Pages publica e todos recebem a versão nova na próxima abertura
(o service worker é rede-primeiro e cada deploy gera um novo; quem está com o app aberto vê "Nova versão instalada").
Mexeu em `worker/` → os testes rodam e o Worker é publicado.

## Instalação (uma vez)

### 1. Repositório
Crie um repositório no GitHub (público: o Pages gratuito exige; o código não tem segredos) e envie esta pasta.

### 2. Cloudflare (no computador, na pasta `worker`)
```
npm install
npx wrangler login
npx wrangler kv namespace create PAINEL
```
Copie o `id` mostrado para `wrangler.toml` (campo `id`) e ajuste `ALLOWED_ORIGIN` para `https://SEUUSUARIO.github.io`.

Segredos (o comando pergunta o valor; não aparecem em arquivo nenhum):
```
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # gera o valor do SECRET_KEY
npx wrangler secret put SECRET_KEY
npx wrangler secret put NEXTDNS_API_KEY
```
Publique: `npx wrangler deploy` — ele mostra o endereço `https://painel-internet-escolar.<conta>.workers.dev`.

### 3. Primeiro administrador, escolas e cadastro de gestores
```
cd ../tools
pip install pandas openpyxl
python preparar_dados.py --admin-matricula SUA_MATRICULA --admin-nome "Seu Nome" ^
       --escolas schools.json --servidores SERVIDORES_SETEMBRO.xlsx
cd ../worker
npx wrangler kv bulk put ../tools/seed.json --binding PAINEL --remote
```
O script imprime a **senha provisória** do administrador (troca obrigatória no 1º acesso). Depois **apague** `tools/seed.json`.
`--escolas` e `--servidores` são opcionais; o `schools.json` é o do painel antigo (`{"codigo": {"name": "...", "profiles": {"Alunos": "id"}}}`).

### 4. Front (GitHub Pages)
1. No GitHub: **Settings → Pages → Source: GitHub Actions**.
2. **Settings → Secrets and variables → Actions → Variables**: crie `PAINEL_API` = endereço do Worker (sem barra no final).
   (Ou edite `web/config.js`.)
3. Faça `git push`. O endereço do painel será `https://SEUUSUARIO.github.io/NOMEDOREPO/`.

### 5. Deploy automático do Worker (opcional)
No GitHub, crie os *secrets* `CLOUDFLARE_API_TOKEN` (modelo “Edit Cloudflare Workers”) e `CLOUDFLARE_ACCOUNT_ID`.
Sem eles, publique a API manualmente com `npx wrangler deploy`.

## Uso
- Diretores/coordenadores abrem o endereço, entram com matrícula + senha e podem **instalar** (Chrome/Edge: ícone na barra; Android: “Adicionar à tela inicial”; iPhone: Compartilhar → Tela de Início).
- O administrador (TI da Sede) usa **Administração**: cadastra escolas e IDs, cadastra servidores (a matrícula consulta o cadastro de gestores e preenche nome, cargo e escola), gera/redefine senha provisória.

## Segurança e LGPD
- Senhas: PBKDF2-SHA256 (100 mil iterações, configurável em `PBKDF2_ITERATIONS`). **Atenção:** cada login gasta algumas dezenas de ms de CPU; o plano gratuito do Workers limita a 10 ms por requisição, então, se o login falhar com erro de CPU, use o plano Workers pago (US$ 5/mês) ou reduza as iterações. Sessão: token assinado (HMAC) que expira em 2 h e é invalidado ao trocar/redefinir a senha.
- Bloqueio de 10 min após 5 erros (por matrícula+IP). Cada escola só enxerga os próprios IDs (validado no servidor). Lista fechada de temas; domínios `nextdns.io`/`pb.gov.br` protegidos.
- Painel mostra o **nome do computador**, nunca IP, e só consultas **bloqueadas**.
- Auditoria no KV por **400 dias** (ajuste `AUDIT_TTL` em `worker/src/index.js`).
- O Cloudflare passa a hospedar dados de contas (nome, telefone, matrícula, hash). Confirme com o encarregado de dados/jurídico da SEE-PB.
- O KV é eventualmente consistente: remover um usuário ou trocar vínculo pode levar até ~1 min para valer em todos os pontos.
- Limites do plano gratuito do KV: 1.000 gravações e 1.000 listagens por dia (suficiente para a operação normal; a carga inicial do seed é de poucas centenas de gravações).
- Um servidor pode ter no máximo 25 escolas vinculadas.

## Desenvolvimento
```
cd worker && npm test      # testes da API (KV e NextDNS simulados)
```
