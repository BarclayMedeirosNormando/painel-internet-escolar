(() => {
  "use strict";
  const API = String(window.PAINEL_API || "").replace(/\/+$/, "");
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const root = $("#root");
  const fmt = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Recife", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  const when = (iso) => (iso ? fmt.format(new Date(iso)) : "—");

  function el(tag, props = {}, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === "class") n.className = v;
      else if (k === "text") n.textContent = v;
      else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v);
    }
    kids.forEach((k) => n.append(k));
    return n;
  }

  /* ------------------------------------------------------------ sessão e API */
  const store = {
    get: () => { try { return sessionStorage.getItem("tk"); } catch { return null; } },
    set: (t) => { try { sessionStorage.setItem("tk", t); } catch { /* sem armazenamento: vale só nesta página */ memToken = t; } },
    clear: () => { memToken = null; try { sessionStorage.removeItem("tk"); } catch {} },
  };
  let memToken = null;
  const token = () => store.get() || memToken;
  let me = null;

  let toastTimer;
  function toast(text, bad = false) {
    const t = $("#msg");
    t.textContent = text;
    t.className = "toast" + (bad ? " bad" : "");
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), 5000);
  }

  class ApiError extends Error { constructor(msg, status, data) { super(msg); this.status = status; this.data = data; } }

  async function api(path, method = "GET", body, { auth = true } = {}) {
    const headers = {};
    if (auth && token()) headers.Authorization = "Bearer " + token();
    const opt = { method, headers };
    if (body !== undefined) { headers["Content-Type"] = "application/json"; opt.body = JSON.stringify(body); }
    let r;
    try { r = await fetch(API + path, opt); }
    catch { throw new ApiError("Sem conexão com o servidor. Verifique a internet e tente de novo.", 0, {}); }
    let data = {};
    try { data = await r.json(); } catch {}
    if (r.status === 401 && auth) { logout(true); throw new ApiError("Sessão expirada. Entre novamente.", 401, data); }
    if (r.status === 403 && data.must_change) { me = null; location.hash = "#/senha"; throw new ApiError(data.error, 403, data); }
    if (!r.ok) throw new ApiError(data.error || "Não foi possível concluir a ação.", r.status, data);
    return data;
  }
  const guard = (fn) => async (...a) => { try { await fn(...a); } catch (e) { if (e.status !== 401) toast(e.message, true); } };

  function logout(expired = false) {
    store.clear(); me = null;
    if (location.hash !== "#/login") location.hash = "#/login";
    else route();
    if (expired) toast("Sessão expirada. Entre novamente.", true);
  }

  /* ------------------------------------------------------------ roteador */
  function mount(tplId) {
    root.replaceChildren($("#" + tplId).content.cloneNode(true));
  }

  async function route() {
    const hash = location.hash || "#/";
    if (!API || API.includes("SEUUSUARIO")) {
      root.replaceChildren(el("p", { class: "alert", text: "Configuração pendente: ajuste PAINEL_API em config.js com o endereço do Worker." }));
      return;
    }
    if (!token()) { if (hash !== "#/login") { location.hash = "#/login"; return; } return viewLogin(); }
    if (hash === "#/login") { location.hash = "#/"; return; }
    if (!me) {
      root.replaceChildren(el("p", { class: "loading", text: "Carregando…" }));
      try { me = await api("/api/me"); }
      catch (e) { if (e.status !== 401 && e.status !== 403) root.replaceChildren(el("p", { class: "alert", text: e.message })); return; }
    }
    if (me.user.must_change) { if (hash !== "#/senha") { location.hash = "#/senha"; return; } return viewSenha(true); }
    if (hash === "#/senha") return viewSenha(false);
    if (hash === "#/admin" && me.user.role === "admin") return viewAdmin();
    if (hash !== "#/painel") { location.hash = "#/painel"; return; }
    return viewPainel();
  }
  window.addEventListener("hashchange", route);

  function header(active, forced = false) {
    const nav = [];
    if (me.user.role === "admin" && !forced) {
      nav.push(el("a", { class: "btn ghost", href: "#/painel", ...(active === "painel" ? { "aria-current": "page" } : {}) , text: "Painel das escolas" }));
      nav.push(el("a", { class: "btn ghost", href: "#/admin", ...(active === "admin" ? { "aria-current": "page" } : {}), text: "Administração" }));
    }
    const who = el("div", { class: "who" }, ...nav,
      el("span", {}, me.user.name + " ", el("span", { class: "muted small", text: "· " + me.user.role })));
    if (!forced) who.append(el("a", { class: "btn ghost", href: "#/senha", text: "Trocar senha" }));
    who.append(el("button", { class: "btn ghost", type: "button", text: "Sair", onclick: () => logout() }));
    return el("header", { class: "top" },
      el("div", { class: "brand" }, el("span", { class: "brand-mark", "aria-hidden": "true", text: "🛡" }),
        el("div", {}, el("strong", { text: "Painel de Internet Escolar" }), el("span", { class: "muted small", text: "SEE-PB" }))),
      who);
  }
  function page(active, tplId, forced) {
    root.replaceChildren(header(active, forced), $("#" + tplId).content.cloneNode(true));
  }

  /* ------------------------------------------------------------ login */
  function viewLogin() {
    mount("tpl-login");
    const err = $("#login-err");
    if (installEvt) { $("#btn-install").hidden = false; $("#btn-install").addEventListener("click", installApp); }
    $("#f-login").addEventListener("submit", async (ev) => {
      ev.preventDefault();
      err.hidden = true;
      try {
        const r = await api("/api/login", "POST", { matricula: $("#matricula").value, senha: $("#senha").value }, { auth: false });
        store.set(r.token); me = null;
        location.hash = r.must_change ? "#/senha" : "#/";
        if (location.hash === "#/login" || !location.hash) route();
      } catch (e) { err.textContent = e.message; err.hidden = false; $("#senha").value = ""; }
    });
  }

  /* ------------------------------------------------------------ trocar senha */
  function viewSenha(forced) {
    page("senha", "tpl-senha", forced);
    $("#senha-title").textContent = forced ? "Crie a sua senha" : "Trocar senha";
    $("#senha-forced").hidden = !forced;
    $("#senha-cancel").hidden = forced;
    $("#lbl-atual").textContent = forced ? "Senha provisória" : "Senha atual";
    const err = $("#senha-err");
    $("#f-senha").addEventListener("submit", async (ev) => {
      ev.preventDefault();
      err.hidden = true;
      if ($("#nova").value !== $("#repete").value) { err.textContent = "A confirmação não confere com a nova senha."; err.hidden = false; return; }
      try {
        const r = await api("/api/senha", "POST", { atual: $("#atual").value, nova: $("#nova").value });
        store.set(r.token); me = null;
        toast("Senha alterada.");
        location.hash = "#/painel";
        if (location.hash === "#/painel") route();
      } catch (e) { if (e.status !== 401) { err.textContent = e.message; err.hidden = false; } }
    });
  }

  /* ------------------------------------------------------------ painel das escolas */
  function viewPainel() {
    page("painel", "tpl-painel");
    const CAN_ALLOW = !!me.can_allow;
    if (!me.profiles.length) { $("#sem-escola").hidden = false; $("#painel-body").hidden = true; return; }
    $("#card-liberados").hidden = !CAN_ALLOW;
    $$(".allow-col").forEach((n) => (n.hidden = !CAN_ALLOW));
    const perfil = $("#perfil");
    me.profiles.forEach((p) => perfil.append(el("option", { value: p.pid, text: `${p.school} — ${p.label}` })));
    const base = () => `/api/profile/${encodeURIComponent(perfil.value)}`;

    const loaders = { uso: loadUso, sites: loadSites, temas: loadTemas, hist: loadHist };
    let tab = "uso";
    $$(".tab").forEach((b) => b.addEventListener("click", () => {
      tab = b.dataset.tab;
      $$(".tab").forEach((x) => x.classList.toggle("active", x === b));
      $$(".panel").forEach((p) => (p.hidden = p.id !== "tab-" + tab));
      guard(loaders[tab])();
    }));
    perfil.addEventListener("change", () => guard(loaders[tab])());
    $("#horas").addEventListener("change", () => guard(loadUso)());

    const kpi = (v, label, small) => el("div", { class: "kpi" }, el("div", { class: "kpi-v" + (small ? " small" : ""), text: String(v) }), el("div", { class: "muted small", text: label }));
    const emptyRow = (n, t) => el("tr", {}, el("td", { colspan: String(n), class: "muted", text: t }));

    async function loadUso() {
      const d = await api(`${base()}/uso?horas=${$("#horas").value}`);
      $("#kpis").replaceChildren(
        kpi(d.total, "acessos bloqueados"), kpi(d.devices.length, "computadores envolvidos"),
        kpi(d.domains.length ? d.domains[0].domain : "—", "site mais bloqueado", true));
      const tb = $("#t-dev tbody");
      tb.replaceChildren();
      if (!d.devices.length) tb.append(emptyRow(4, "Nenhum bloqueio no período. 🎉"));
      d.devices.forEach((x) => tb.append(el("tr", {},
        el("td", { text: x.name }), el("td", { class: "num", text: String(x.count) }),
        el("td", { class: "small", text: x.top.map((t) => `${t[0]} (${t[1]})`).join(", ") }),
        el("td", { class: "small", text: when(x.last) }))));
      const td = $("#t-dom tbody");
      td.replaceChildren();
      if (!d.domains.length) td.append(emptyRow(CAN_ALLOW ? 4 : 3, "Nada a mostrar."));
      d.domains.forEach((x) => {
        const tr = el("tr", {}, el("td", { text: x.domain }), el("td", { class: "num", text: String(x.count) }), el("td", { class: "small", text: x.reason }));
        if (CAN_ALLOW) {
          tr.append(el("td", {}, el("button", {
            class: "btn tiny", type: "button", text: "Liberar",
            onclick: guard(async () => {
              if (!confirm(`Liberar ${x.domain} para esta rede?`)) return;
              await api(`${base()}/sites/liberados`, "POST", { domain: x.domain });
              toast(`${x.domain} liberado.`);
            }),
          })));
        }
        td.append(tr);
      });
      $("#uso-note").textContent = d.truncated
        ? "Mostrando uma amostra dos acessos mais recentes do período."
        : "Mostra apenas acessos que o filtro bloqueou. O nome do computador vem da instalação do NextDNS na máquina.";
    }

    async function loadSites() {
      const d = await api(`${base()}/listas`);
      fillChips("bloqueados", d.deny);
      if (CAN_ALLOW) fillChips("liberados", d.allow);
    }
    function fillChips(lista, items) {
      const ul = $("#l-" + lista);
      ul.replaceChildren();
      if (!items.length) ul.append(el("li", { class: "muted small", text: "Nenhum site na lista." }));
      items.forEach((dom) => ul.append(el("li", { class: "chip" }, el("span", { text: dom }),
        el("button", {
          class: "x", type: "button", title: "Remover", "aria-label": "Remover " + dom, text: "×",
          onclick: guard(async () => {
            await api(`${base()}/sites/${lista}/${encodeURIComponent(dom)}`, "DELETE");
            toast(`${dom} removido.`);
            await loadSites();
          }),
        }))));
    }
    $$("form.add").forEach((f) => f.addEventListener("submit", guard(async (ev) => {
      ev.preventDefault();
      const input = $("input", f);
      const r = await api(`${base()}/sites/${f.dataset.lista}`, "POST", { domain: input.value });
      input.value = "";
      toast(`${r.domain} adicionado.`);
      await loadSites();
    })));

    async function loadTemas() {
      const d = await api(`${base()}/temas`);
      fillToggles("categories", "category", d.categories);
      fillToggles("services", "service", d.services);
    }
    function fillToggles(id, kind, items) {
      const ul = $("#tg-" + id);
      ul.replaceChildren();
      items.forEach((it) => {
        const cb = el("input", { type: "checkbox", id: `${kind}-${it.id}` });
        cb.checked = it.active;
        cb.addEventListener("change", guard(async () => {
          const want = cb.checked;
          try {
            await api(`${base()}/temas`, "POST", { kind, id: it.id, active: want });
            toast(`${it.label}: ${want ? "bloqueado" : "liberado"}.`);
          } catch (e) { cb.checked = !want; throw e; }
        }));
        ul.append(el("li", {}, el("label", { class: "switch", for: cb.id }, cb, el("span", { class: "slider" }), el("span", { class: "lbl", text: it.label }))));
      });
    }

    async function loadHist() {
      const d = await api("/api/auditoria");
      const tb = $("#t-hist tbody");
      tb.replaceChildren();
      if (!d.rows.length) tb.append(emptyRow(4, "Nenhuma alteração registrada ainda."));
      d.rows.forEach((r) => tb.append(el("tr", {}, el("td", { class: "small", text: when(r.ts) }), el("td", { text: r.matricula }), el("td", { text: r.action }), el("td", { text: r.target }))));
    }
    guard(loadUso)();
  }

  /* ------------------------------------------------------------ administração */
  function viewAdmin() {
    page("admin", "tpl-admin");
    const ME = me.user.matricula;
    const fmtPhone = (d) => !d ? "—" : d.length === 11 ? `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}` : `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
    const ROLE = { diretor: "Diretor(a)", coordenador: "Coordenação", admin: "Administrador" };
    const norm = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/\s+/g, " ").trim();
    let data = { users: [], schools: [] };
    let editingUser = null, editingSchool = null;

    $$(".tab").forEach((b) => b.addEventListener("click", () => {
      $$(".tab").forEach((x) => x.classList.toggle("active", x === b));
      $$(".panel").forEach((p) => (p.hidden = p.id !== "tab-" + b.dataset.tab));
      if (b.dataset.tab === "hist") guard(loadHist)();
    }));

    async function reload() {
      data = await api("/api/admin/dados");
      renderUsers(); renderSchools(); renderChecklist();
    }

    /* senha provisória */
    function showTemp(title, mat, nome, senha) {
      $("#temp-title").textContent = title;
      $("#temp-value").textContent = senha;
      $("#temp-who").textContent = `Matrícula ${mat} — ${nome}`;
      $("#temp-box").hidden = false;
      $("#temp-box").scrollIntoView({ block: "start" });
    }
    const hideTemp = () => { $("#temp-box").hidden = true; $("#temp-value").textContent = ""; };
    $("#temp-close").addEventListener("click", hideTemp);
    $("#temp-copy").addEventListener("click", async () => {
      try { await navigator.clipboard.writeText($("#temp-value").textContent); toast("Senha copiada."); }
      catch { toast("Não foi possível copiar; selecione e copie manualmente.", true); }
    });

    /* servidores */
    const schoolName = (code) => (data.schools.find((s) => s.code === code) || {}).name || code;
    function renderUsers() {
      const q = $("#u-filtro").value.trim().toLowerCase();
      const rows = data.users.filter((u) => !q || u.name.toLowerCase().includes(q) || u.matricula.includes(q));
      $("#u-count").textContent = `(${data.users.length})`;
      const tb = $("#t-users tbody");
      tb.replaceChildren();
      if (!rows.length) tb.append(el("tr", {}, el("td", { colspan: "5", class: "muted", text: "Nenhum servidor encontrado." })));
      rows.forEach((u) => {
        const escolas = u.role === "admin" ? "Todas" : u.schools.map(schoolName).join(", ") || "—";
        tb.append(el("tr", {},
          el("td", {}, el("strong", { text: u.name }), el("br"), el("span", { class: "muted small", text: `${u.matricula} · ${ROLE[u.role] || u.role}` })),
          el("td", { text: fmtPhone(u.phone) }), el("td", { text: escolas }),
          el("td", {}, u.must_change ? el("span", { class: "pill", text: "Aguardando 1º acesso" }) : el("span", { class: "pill ok", text: "Ativo" })),
          el("td", {},
            el("button", { class: "btn tiny", type: "button", text: "Editar", onclick: () => startEditUser(u) }),
            el("button", { class: "btn tiny", type: "button", text: "Redefinir senha", onclick: guard(() => resetUser(u)) }),
            u.matricula === ME ? "" : el("button", { class: "btn tiny danger", type: "button", text: "Remover", onclick: guard(() => removeUser(u)) }))));
      });
    }
    $("#u-filtro").addEventListener("input", renderUsers);

    function renderChecklist(selected) {
      const keep = selected || new Set($$("#u-escolas input:checked").map((i) => i.value));
      const q = $("#u-busca").value.trim().toLowerCase();
      const box = $("#u-escolas");
      box.replaceChildren();
      data.schools.filter((s) => !q || s.name.toLowerCase().includes(q) || s.code.toLowerCase().includes(q) || keep.has(s.code)).forEach((s) => {
        const ids = Object.entries(s.profiles).map(([l, p]) => `${l}: ${p}`).join(" · ");
        const cb = el("input", { type: "checkbox", value: s.code });
        cb.checked = keep.has(s.code);
        box.append(el("label", {}, cb, el("span", {}, `${s.name} `, el("span", { class: "muted small", text: `(${ids})` }))));
      });
      if (!data.schools.length) box.append(el("p", { class: "muted small", text: "Nenhuma escola cadastrada ainda — use a aba “Escolas e IDs”." }));
    }
    $("#u-busca").addEventListener("input", () => renderChecklist());
    const syncRole = () => { $("#u-escolas-box").hidden = $("#u-papel").value === "admin"; };
    $("#u-papel").addEventListener("change", syncRole);

    /* consulta no cadastro de gestores pela matrícula */
    $("#u-mat").addEventListener("change", guard(async () => {
      const hint = $("#u-dir");
      hint.hidden = true;
      const mat = $("#u-mat").value.replace(/\D/g, "");
      if (editingUser || mat.length < 3) return;
      try {
        const d = await api(`/api/admin/diretorio/${encodeURIComponent(mat)}`);
        hint.textContent = `Cadastro de gestores: ${d.cargo} — ${d.setor} (${d.municipio}).`;
        hint.hidden = false;
        if (!$("#u-nome").value) $("#u-nome").value = d.nome;
        const cargo = norm(d.cargo);
        if (cargo.includes("COORDEN")) $("#u-papel").value = "coordenador";
        else if (cargo.includes("DIRETOR")) $("#u-papel").value = "diretor";
        const s = data.schools.find((x) => norm(x.name) === norm(d.setor));
        if (s) renderChecklist(new Set([s.code]));
        else hint.textContent += " Escola ainda não cadastrada aqui (ou com outro nome): marque manualmente.";
        syncRole();
      } catch (e) {
        if (e.status === 404) { hint.textContent = "Matrícula fora do cadastro de gestores: preencha o nome manualmente."; hint.hidden = false; }
        else throw e;
      }
    }));

    function resetUserForm() {
      editingUser = null;
      $("#uform").reset();
      $("#u-mat").disabled = false;
      $("#u-dir").hidden = true;
      $("#uform-title").textContent = "Cadastrar servidor";
      $("#u-save").textContent = "Cadastrar e gerar senha provisória";
      $("#u-cancel").hidden = true;
      $("#u-busca").value = "";
      renderChecklist(new Set());
      syncRole();
    }
    function startEditUser(u) {
      editingUser = u.matricula;
      $("#u-nome").value = u.name; $("#u-mat").value = u.matricula; $("#u-mat").disabled = true;
      $("#u-dir").hidden = true;
      $("#u-tel").value = u.phone ? fmtPhone(u.phone) : "";
      $("#u-papel").value = u.role;
      $("#uform-title").textContent = `Editar servidor ${u.matricula}`;
      $("#u-save").textContent = "Salvar alterações";
      $("#u-cancel").hidden = false;
      renderChecklist(new Set(u.schools));
      syncRole();
      $("#uform").scrollIntoView({ block: "center" });
    }
    $("#u-cancel").addEventListener("click", resetUserForm);

    $("#uform").addEventListener("submit", guard(async (ev) => {
      ev.preventDefault();
      const body = { nome: $("#u-nome").value, telefone: $("#u-tel").value, papel: $("#u-papel").value, escolas: $$("#u-escolas input:checked").map((i) => i.value) };
      if (editingUser) {
        await api(`/api/admin/usuarios/${encodeURIComponent(editingUser)}`, "PUT", body);
        toast("Cadastro atualizado.");
      } else {
        body.matricula = $("#u-mat").value;
        const r = await api("/api/admin/usuarios", "POST", body);
        showTemp("Servidor cadastrado — senha provisória", r.matricula, body.nome, r.senha_temporaria);
      }
      resetUserForm();
      await reload();
    }));

    async function resetUser(u) {
      if (!confirm(`Gerar nova senha provisória para ${u.name} (${u.matricula})?\nA senha atual deixa de valer e a sessão aberta dele é encerrada.`)) return;
      const r = await api(`/api/admin/usuarios/${encodeURIComponent(u.matricula)}/reset`, "POST", {});
      showTemp("Senha redefinida — nova senha provisória", r.matricula, u.name, r.senha_temporaria);
      await reload();
    }
    async function removeUser(u) {
      if (!confirm(`Remover ${u.name} (${u.matricula})? O acesso cai em instantes.`)) return;
      await api(`/api/admin/usuarios/${encodeURIComponent(u.matricula)}`, "DELETE");
      toast("Servidor removido.");
      await reload();
    }

    /* escolas */
    function renderSchools() {
      $("#s-count").textContent = `(${data.schools.length})`;
      const tb = $("#t-schools tbody");
      tb.replaceChildren();
      if (!data.schools.length) tb.append(el("tr", {}, el("td", { colspan: "4", class: "muted", text: "Nenhuma escola cadastrada." })));
      data.schools.forEach((s) => {
        const n = data.users.filter((u) => u.schools.includes(s.code)).length;
        tb.append(el("tr", {},
          el("td", {}, el("strong", { text: s.name }), el("br"), el("span", { class: "muted small", text: s.code })),
          el("td", {}, ...Object.entries(s.profiles).map(([l, p]) => el("div", {}, `${l}: `, el("code", { text: p })))),
          el("td", { text: String(n) }),
          el("td", {}, el("button", { class: "btn tiny", type: "button", text: "Editar", onclick: () => startEditSchool(s) }))));
      });
    }
    function resetSchoolForm() {
      editingSchool = null;
      $("#sform").reset();
      $("#s-codigo").disabled = false;
      $("#sform-title").textContent = "Cadastrar escola";
      $("#s-cancel").hidden = true;
    }
    function startEditSchool(s) {
      editingSchool = s.code;
      $("#s-codigo").value = s.code; $("#s-codigo").disabled = true;
      $("#s-nome").value = s.name;
      $("#s-alunos").value = s.profiles["Alunos"] || "";
      $("#s-adm").value = s.profiles["Administrativo"] || "";
      $("#sform-title").textContent = `Editar escola ${s.code}`;
      $("#s-cancel").hidden = false;
      $("#sform").scrollIntoView({ block: "center" });
    }
    $("#s-cancel").addEventListener("click", resetSchoolForm);
    $("#sform").addEventListener("submit", guard(async (ev) => {
      ev.preventDefault();
      const perfis = {};
      if ($("#s-alunos").value.trim()) perfis["Alunos"] = $("#s-alunos").value.trim();
      if ($("#s-adm").value.trim()) perfis["Administrativo"] = $("#s-adm").value.trim();
      if (editingSchool) { // preserva rótulos extras que a escola já tinha
        const atual = (data.schools.find((s) => s.code === editingSchool) || {}).profiles || {};
        for (const [l, p] of Object.entries(atual)) if (l !== "Alunos" && l !== "Administrativo") perfis[l] = p;
      }
      const r = await api("/api/admin/escolas", "POST", { codigo: editingSchool || $("#s-codigo").value, nome: $("#s-nome").value, perfis });
      toast(r.created ? "Escola cadastrada." : "Escola atualizada.");
      resetSchoolForm();
      await reload();
    }));

    async function loadHist() {
      const d = await api("/api/auditoria");
      const tb = $("#t-hist tbody");
      tb.replaceChildren();
      if (!d.rows.length) tb.append(el("tr", {}, el("td", { colspan: "5", class: "muted", text: "Sem registros ainda." })));
      d.rows.forEach((r) => tb.append(el("tr", {}, el("td", { text: when(r.ts) }), el("td", { text: r.matricula }),
        el("td", { text: r.school && r.school !== "-" ? r.school : "—" }), el("td", { text: r.action }), el("td", { text: r.target }))));
    }

    guard(async () => { syncRole(); await reload(); })();
  }

  /* ------------------------------------------------------------ PWA: instalar e atualizar */
  let installEvt = null;
  window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); installEvt = e; const b = $("#btn-install"); if (b) { b.hidden = false; b.onclick = installApp; } });
  async function installApp() { if (!installEvt) return; installEvt.prompt(); await installEvt.userChoice; installEvt = null; const b = $("#btn-install"); if (b) b.hidden = true; }

  if ("serviceWorker" in navigator && window.isSecureContext) {
    let reloaded = false;
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (!hadController || reloaded) return; // primeira instalação não recarrega
      reloaded = true;
      const bar = el("div", { class: "update-bar", role: "status" }, el("span", { text: "Nova versão instalada." }),
        el("button", { class: "btn", type: "button", text: "Atualizar agora", onclick: () => location.reload() }));
      document.body.append(bar);
      setTimeout(() => location.reload(), 4000);
    });
    navigator.serviceWorker.register("sw.js", { updateViaCache: "none" }).then((reg) => {
      const check = () => reg.update().catch(() => {});
      document.addEventListener("visibilitychange", () => { if (!document.hidden) check(); });
      setInterval(check, 30 * 60 * 1000);
    }).catch(() => {});
  }

  route();
})();
