# Painel de Internet Escolar — SEE-PB (PWA + Google Apps Script)

Site (PWA instalável) no **GitHub Pages** + API em **Google Apps Script** + banco de dados numa **planilha do Google**.
A chave do NextDNS fica só nas *Propriedades do script* (nunca no navegador, no GitHub nem na planilha).

```
web/          -> o site (PWA)                         => GitHub Pages (deploy automático a cada push)
apps-script/  -> Code.gs = a API (login, escolas, NextDNS, auditoria)
tools/        -> gerar_planilha.py (cria a planilha-banco a partir da lista de servidores)
```

## Instalação (uma vez)

### 1. Planilha-banco
1. `python tools/gerar_planilha.py --servidores SERVIDORES_SETEMBRO.xlsx --escolas schools.json` gera `PainelBanco.xlsx`.
2. Google Drive → **Novo → Upload de arquivo** → abra o arquivo → **Arquivo → Salvar como Planilha Google**.
   Apague o `.xlsx` do computador (tem nomes e matrículas).
3. Mantenha a planilha **privada** (compartilhe só com a TI da Sede — veja "Segurança").

### 2. Script
1. Na planilha: **Extensões → Apps Script**. Apague o conteúdo e cole o `apps-script/Code.gs`. **Salvar**.
2. **Configurações do projeto (engrenagem) → Propriedades do script → Adicionar**:
   - `NEXTDNS_API_KEY` = chave **nova** do NextDNS (Conta → Chave da API)
   - `ADMIN_MATRICULA` = sua matrícula; `ADMIN_NOME` = seu nome
3. No editor, escolha a função **`instalar`** → **Executar** → autorize (Avançado → Acessar… → Permitir).
4. Execute **`criarAdmin`**. Abra **Execuções/Registro**: aparece a **senha provisória** (troca obrigatória no 1º acesso).
5. (opcional) Execute `verificarConfiguracao` (confere chave e planilha) e `medirLogin` (tempo do login).

### 3. Publicar a API
**Implantar → Nova implantação → Tipo: App da Web** → *Executar como:* **Eu** · *Quem pode acessar:* **Qualquer pessoa** → Implantar.
Copie a URL que termina em **`/exec`** e coloque em `web/config.js` (`window.PAINEL_API`) — ou na variável `PAINEL_API` do repositório (Settings → Secrets and variables → Actions → Variables), que o deploy grava no `config.js`.

## Atualizações
- **Site** (`web/`): `git push` → Pages publica → o PWA avisa e atualiza em todos os aparelhos.
- **API** (`Code.gs`): cole o novo código no editor → **Implantar → Gerenciar implantações → ✏️ → Versão: Nova versão → Implantar** (a URL continua a mesma).

## Operação
- **Editar dados pela planilha**: aba `usuarios` (nome, telefone, papel, escolas separadas por `;`), `escolas` (perfis em JSON), `diretorio`. O painel enxerga a mudança na hora.
- **Cadastrar em massa**: use a aba *Cadastro de gestores* do painel (lista as matrículas e preenche o formulário).
- **Auditoria**: aba `auditoria`; registros com mais de 400 dias são apagados sozinhos 1x por dia.
- Em caso de problema: *Execuções* no editor do Apps Script mostra os erros.

## Segurança e LGPD
- Senhas: PBKDF2-SHA256 (50 mil iterações, em JavaScript puro) com sal individual; a planilha guarda só o hash. Sessão: token assinado (HMAC) que expira em 2 h e é invalidado ao trocar/redefinir a senha. Bloqueio de 10 min após 5 erros **por matrícula** (o Apps Script não informa o IP do usuário).
- **Quem edita a planilha enxerga os hashes e os dados pessoais.** Compartilhe a planilha só com a TI da Sede e dê "Editor" a poucas pessoas. Não compartilhe a planilha com os gestores.
- O script roda com a **conta de quem o implantou** (Executar como: Eu): quem controla a conta controla o sistema. Use verificação em duas etapas.
- O painel só mostra **nome do computador**, nunca o IP (minimização).
- A planilha e o script passam a hospedar dados de servidores no Google: confirme com o encarregado de dados da SEE-PB.
- Limites do Apps Script (conta gratuita): ~20 mil chamadas externas/dia ao NextDNS e 6 min por execução — sobra para uso escolar. Cada ação leva ~1–3 s.
