require("dotenv").config();
const express = require("express");
const axios   = require("axios");
const path    = require("path");
const fs      = require("fs");

const app = express();
app.use(express.json());
app.use(express.static(__dirname));

const GC_ACCESS  = process.env.GC_ACCESS_TOKEN;
const GC_SECRET  = process.env.GC_SECRET_TOKEN;
const ZAPI_INST  = process.env.ZAPI_INSTANCE;
const ZAPI_TOKEN = process.env.ZAPI_TOKEN;
const GC_BASE    = "https://api.gestaoclick.com";
const ZAPI_BASE  = `https://api.z-api.io/instances/${ZAPI_INST}/token/${ZAPI_TOKEN}`;

const gcHeaders = () => ({
  "access-token": GC_ACCESS,
  "secret-access-token": GC_SECRET,
  "Content-Type": "application/json",
});

function formatPhone(raw = "") {
  const digits = String(raw).replace(/\D/g, "");
  if (!digits) return null;
  if (digits.startsWith("55") && digits.length >= 12) return digits;
  return "55" + digits;
}

function hoje() { return new Date().toISOString().slice(0, 10); }
function agora() { return new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }); }

// ════════════════════════════════════════════════════════════════════
// CONFIGURAÇÕES PERSISTENTES
// ════════════════════════════════════════════════════════════════════
const CONFIG_FILE = "/tmp/mora_config.json";
let config = {
  posVenda: {
    ativo: true,
    mensagem: "Olá, {nome}! 🌸 Sua compra de {valor} na Mora Fashion foi registrada com sucesso! Obrigada pela preferência. Te esperamos de volta! 💕",
    intervalo: 3000,
  },
  aniversario: {
    ativo: true,
    mensagem: "Feliz aniversário, {nome}! 🎂🎁 A Mora Fashion tem um presente especial para você hoje! Venha buscar seu desconto de aniversário. Com carinho! 💕",
    horario: "09:00",
    disparadoHoje: null,
  },
  templates: [
    { id: 1, nome: "Agradecimento", texto: "Olá, {nome}! 🌸 Obrigada pela sua compra na Mora Fashion! Qualquer dúvida, é só chamar. Te esperamos de volta! 💕" },
    { id: 2, nome: "Promoção",      texto: "Oi, {nome}! 🎉 Temos novidades incríveis na Mora Fashion! Novas peças com condições especiais. Venha conferir! 🛍️" },
    { id: 3, nome: "Aniversário",   texto: "Feliz aniversário, {nome}! 🎂 A Mora Fashion tem um presentinho especial pra você! 💕" },
    { id: 4, nome: "Pós-venda",     texto: "Olá, {nome}! 😊 Tudo certo com sua compra? Adoraríamos saber o que achou. Qualquer coisa, estamos aqui! 🌸" },
  ],
};

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const saved = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
      config = { ...config, ...saved };
    }
  } catch (e) { console.error("[CONFIG] Erro ao carregar:", e.message); }
}

function saveConfig() {
  try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(config), "utf8"); }
  catch (e) { console.error("[CONFIG] Erro ao salvar:", e.message); }
}

// ════════════════════════════════════════════════════════════════════
// CACHE DE CLIENTES
// ════════════════════════════════════════════════════════════════════
const CACHE_FILE = "/tmp/mora_clientes.json";
let cache = { data: [], syncedAt: null, syncing: false, novos: [] };

function loadCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
      if (Array.isArray(parsed.data)) { cache = { ...cache, ...parsed }; cache.syncing = false; }
    }
  } catch (e) { console.error("[CACHE] Erro:", e.message); }
}

function saveCache() {
  try { fs.writeFileSync(CACHE_FILE, JSON.stringify({ data: cache.data, syncedAt: cache.syncedAt }), "utf8"); }
  catch (e) { console.error("[CACHE] Erro ao salvar:", e.message); }
}

async function syncClientes() {
  if (cache.syncing) return;
  cache.syncing = true;
  console.log("[SYNC] Sincronizando todos os clientes...");
  try {
    const idsAntigos = new Set(cache.data.map(c => String(c.id)));
    let todos = [], pagina = 1;
    while (true) {
      const r = await axios.get(`${GC_BASE}/clientes`, {
        headers: gcHeaders(), params: { limite: 100, pagina }, timeout: 20000,
      });
      const lista = Array.isArray(r.data?.data) ? r.data.data : Array.isArray(r.data) ? r.data : [];
      todos = todos.concat(lista);
      console.log(`[SYNC] Página ${pagina}: ${lista.length} | Total: ${todos.length}`);
      if (lista.length < 100) break;
      pagina++;
      await new Promise(r => setTimeout(r, 500));
    }
    const novos = todos.filter(c => !idsAntigos.has(String(c.id)));
    cache.data = todos; cache.novos = novos;
    cache.syncedAt = new Date().toISOString(); cache.syncing = false;
    saveCache();
    console.log(`[SYNC] ✓ ${todos.length} clientes | ${novos.length} novos`);
  } catch (e) { cache.syncing = false; console.error("[SYNC]", e.message); }
}

// ════════════════════════════════════════════════════════════════════
// LOG DE DISPAROS
// ════════════════════════════════════════════════════════════════════
const LOG_FILE = "/tmp/mora_disparos.json";
let disparosLog = [];

function loadLog() {
  try {
    if (fs.existsSync(LOG_FILE)) disparosLog = JSON.parse(fs.readFileSync(LOG_FILE, "utf8"));
  } catch (e) {}
}

function saveLog() {
  try {
    // mantém últimos 500 registros
    if (disparosLog.length > 500) disparosLog = disparosLog.slice(-500);
    fs.writeFileSync(LOG_FILE, JSON.stringify(disparosLog), "utf8");
  } catch (e) {}
}

function addLog(tipo, nome, phone, mensagem, ok, erro = null) {
  disparosLog.push({ tipo, nome, phone, mensagem, ok, erro, data: new Date().toISOString() });
  saveLog();
}

// ════════════════════════════════════════════════════════════════════
// ENVIO DE WHATSAPP
// ════════════════════════════════════════════════════════════════════
async function sendWhatsApp(phone, message) {
  const formatted = formatPhone(phone);
  if (!formatted) return { ok: false, error: "Telefone inválido" };
  try {
    const r = await axios.post(`${ZAPI_BASE}/send-text`, { phone: formatted, message }, { timeout: 10000 });
    return { ok: true, data: r.data };
  } catch (e) {
    return { ok: false, error: e.response?.data?.message || e.message };
  }
}

// ════════════════════════════════════════════════════════════════════
// DISPARO PÓS-VENDA AUTOMÁTICO
// ════════════════════════════════════════════════════════════════════
const vendasDisparadas = new Set(); // IDs de vendas que já receberam mensagem
let ultimaVendaChecada = null;

async function getClienteById(id) {
  // tenta cache primeiro
  const local = cache.data.find(c => String(c.id) === String(id));
  if (local) return local;
  // busca em tempo real no Gestão Click (cliente novo)
  try {
    const r = await axios.get(`${GC_BASE}/clientes/${id}`, { headers: gcHeaders(), timeout: 10000 });
    const cliente = r.data?.data || r.data;
    if (cliente?.id) {
      cache.data.push(cliente); // salva no cache
      saveCache();
    }
    return cliente;
  } catch (e) { return null; }
}

async function checkNovasVendas() {
  if (!config.posVenda.ativo) return;
  try {
    const r = await axios.get(`${GC_BASE}/vendas`, {
      headers: gcHeaders(),
      params: { limite: 10, ordenar_por: "data", ordem: "desc", tipo: "vendas_balcao" },
      timeout: 15000,
    });
    const vendas = Array.isArray(r.data?.data) ? r.data.data : Array.isArray(r.data) ? r.data : [];

    for (const venda of vendas) {
      if (vendasDisparadas.has(String(venda.id))) continue;
      vendasDisparadas.add(String(venda.id));

      // Pula vendas antigas (só processa as de hoje)
      if (venda.data && !venda.data.startsWith(hoje())) continue;

      const clienteId = venda.cliente_id;
      if (!clienteId) continue;

      const cliente = await getClienteById(clienteId);
      const phone = cliente?.celular || cliente?.fone || cliente?.telefone;
      const nome  = cliente?.nome || venda.nome_cliente || "cliente";
      const valor = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(venda.valor_total || 0);

      if (!phone) {
        console.log(`[POS-VENDA] Cliente sem telefone: ${nome} (venda #${venda.id})`);
        addLog("pos-venda", nome, "-", "-", false, "Sem telefone");
        continue;
      }

      const msg = config.posVenda.mensagem.replace(/\{nome\}/gi, nome.split(" ")[0]).replace(/\{valor\}/gi, valor);

      await new Promise(r => setTimeout(r, config.posVenda.intervalo || 3000));
      const resultado = await sendWhatsApp(phone, msg);
      addLog("pos-venda", nome, phone, msg, resultado.ok, resultado.error);
      console.log(`[POS-VENDA] Venda #${venda.id} → ${nome} (${phone}): ${resultado.ok ? "✓ Enviado" : "✗ " + resultado.error}`);
    }
  } catch (e) { console.error("[POS-VENDA]", e.message); }
}

// ════════════════════════════════════════════════════════════════════
// ANIVERSARIANTES DO DIA
// ════════════════════════════════════════════════════════════════════
async function checkAniversariantes() {
  if (!config.aniversario.ativo) return;
  const dataHoje = hoje();
  if (config.aniversario.disparadoHoje === dataHoje) return; // já disparou hoje

  const horaAtual = agora();
  if (horaAtual < config.aniversario.horario) return; // ainda não é hora

  console.log("[ANIVERSÁRIO] Verificando aniversariantes do dia...");
  const mesHoje = dataHoje.slice(5, 7); // MM
  const diaHoje = dataHoje.slice(8, 10); // DD

  const aniversariantes = cache.data.filter(c => {
    const nasc = c.data_nascimento || c.nascimento || "";
    if (!nasc) return false;
    const parts = nasc.includes("/") ? nasc.split("/") : nasc.split("-");
    if (parts.length < 2) return false;
    if (nasc.includes("/")) return parts[0] === diaHoje && parts[1] === mesHoje;
    return parts[1] === mesHoje && parts[2] === diaHoje;
  });

  console.log(`[ANIVERSÁRIO] ${aniversariantes.length} aniversariante(s) hoje.`);

  for (const cliente of aniversariantes) {
    const phone = cliente.celular || cliente.fone || cliente.telefone;
    const nome  = cliente.nome || "cliente";
    if (!phone) { addLog("aniversario", nome, "-", "-", false, "Sem telefone"); continue; }

    const msg = config.aniversario.mensagem.replace(/\{nome\}/gi, nome.split(" ")[0]);
    await new Promise(r => setTimeout(r, config.posVenda.intervalo || 3000));
    const resultado = await sendWhatsApp(phone, msg);
    addLog("aniversario", nome, phone, msg, resultado.ok, resultado.error);
    console.log(`[ANIVERSÁRIO] ${nome}: ${resultado.ok ? "✓" : "✗"}`);
  }

  config.aniversario.disparadoHoje = dataHoje;
  saveConfig();
}

// ════════════════════════════════════════════════════════════════════
// CRM EM MEMÓRIA
// ════════════════════════════════════════════════════════════════════
const crm = new Map();
function getOrCreateChat(phone, name) {
  if (!crm.has(phone)) crm.set(phone, { phone, name: name || phone, messages: [], unread: 0, lastTime: Date.now() });
  return crm.get(phone);
}

// ════════════════════════════════════════════════════════════════════
// INICIALIZAÇÃO
// ════════════════════════════════════════════════════════════════════
loadConfig();
loadCache();
loadLog();

if (!cache.data.length) syncClientes();
setInterval(syncClientes, 30 * 60 * 1000);       // sync clientes 30min
setInterval(checkNovasVendas, 30 * 1000);          // check vendas 30s
setInterval(checkAniversariantes, 5 * 60 * 1000);  // check aniversário 5min

// Popula vendas já existentes de hoje para não disparar duplicado
(async () => {
  try {
    const r = await axios.get(`${GC_BASE}/vendas`, {
      headers: gcHeaders(),
      params: { limite: 50, ordenar_por: "data", ordem: "desc", tipo: "vendas_balcao" },
      timeout: 15000,
    });
    const vendas = Array.isArray(r.data?.data) ? r.data.data : Array.isArray(r.data) ? r.data : [];
    vendas.forEach(v => vendasDisparadas.add(String(v.id)));
    console.log(`[INIT] ${vendasDisparadas.size} vendas marcadas como já processadas.`);
  } catch (e) { console.error("[INIT]", e.message); }
})();

// ════════════════════════════════════════════════════════════════════
// API ROTAS
// ════════════════════════════════════════════════════════════════════

app.get("/api/status", (req, res) => {
  res.json({ gc: !!(GC_ACCESS && GC_SECRET), zapi: !!(ZAPI_INST && ZAPI_TOKEN) });
});

// ── Configurações ──────────────────────────────────────────────────
app.get("/api/config", (req, res) => res.json(config));

app.post("/api/config", (req, res) => {
  const { posVenda, aniversario, templates } = req.body;
  if (posVenda)   config.posVenda   = { ...config.posVenda, ...posVenda };
  if (aniversario) config.aniversario = { ...config.aniversario, ...aniversario };
  if (templates)  config.templates  = templates;
  saveConfig();
  res.json({ ok: true, config });
});

// ── Log de disparos ────────────────────────────────────────────────
app.get("/api/disparos", (req, res) => {
  res.json({ logs: disparosLog.slice(-100).reverse(), total: disparosLog.length });
});

// ── Aniversariantes do dia ─────────────────────────────────────────
app.get("/api/aniversariantes", (req, res) => {
  const dataHoje = hoje();
  const mesHoje = dataHoje.slice(5, 7);
  const diaHoje = dataHoje.slice(8, 10);
  const lista = cache.data.filter(c => {
    const nasc = c.data_nascimento || c.nascimento || "";
    if (!nasc) return false;
    const parts = nasc.includes("/") ? nasc.split("/") : nasc.split("-");
    if (parts.length < 2) return false;
    if (nasc.includes("/")) return parts[0] === diaHoje && parts[1] === mesHoje;
    return parts[1] === mesHoje && parts[2] === diaHoje;
  });
  res.json({ data: lista, total: lista.length, data_hoje: dataHoje });
});

// Disparo manual de aniversariantes
app.post("/api/aniversariantes/disparar", async (req, res) => {
  config.aniversario.disparadoHoje = null;
  saveConfig();
  res.json({ ok: true, msg: "Disparo de aniversariantes iniciado!" });
  checkAniversariantes();
});

// ── Clientes ───────────────────────────────────────────────────────
app.get("/api/clientes", (req, res) => {
  res.json({ data: cache.data, syncedAt: cache.syncedAt, total: cache.data.length, syncing: cache.syncing });
});

app.get("/api/clientes/:id", async (req, res) => {
  const local = cache.data.find(c => String(c.id) === String(req.params.id));
  if (local) return res.json(local);
  try {
    const r = await axios.get(`${GC_BASE}/clientes/${req.params.id}`, { headers: gcHeaders() });
    res.json(r.data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/sync/clientes", (req, res) => {
  res.json({ ok: true }); syncClientes();
});

app.get("/api/sync/status", (req, res) => {
  res.json({ total: cache.data.length, syncedAt: cache.syncedAt, syncing: cache.syncing, novos: (cache.novos || []).length });
});

// ── Pedidos ────────────────────────────────────────────────────────
app.get("/api/pedidos", async (req, res) => {
  try {
    const r = await axios.get(`${GC_BASE}/vendas`, {
      headers: gcHeaders(),
      params: { limite: 40, ordenar_por: "data", ordem: "desc", tipo: "vendas_balcao", ...req.query },
      timeout: 15000,
    });
    res.json(r.data);
  } catch (e) { res.status(e.response?.status || 500).json({ error: e.response?.data?.message || e.message }); }
});

app.get("/api/clientes/:id/pedidos", async (req, res) => {
  try {
    const r = await axios.get(`${GC_BASE}/vendas`, {
      headers: gcHeaders(),
      params: { cliente_id: req.params.id, limite: 15, ordenar_por: "data", ordem: "desc", tipo: "vendas_balcao" },
      timeout: 15000,
    });
    res.json(r.data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Z-API ──────────────────────────────────────────────────────────
app.get("/api/zapi/status", async (req, res) => {
  try { const r = await axios.get(`${ZAPI_BASE}/status`); res.json(r.data); }
  catch (e) { res.status(500).json({ error: e.message, connected: false }); }
});

app.get("/api/zapi/qrcode", async (req, res) => {
  try {
    const r = await axios.get(`${ZAPI_BASE}/qr-code/image`, { responseType: "arraybuffer" });
    res.setHeader("Content-Type", "image/png"); res.setHeader("Cache-Control", "no-cache");
    res.send(r.data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/zapi/disconnect", async (req, res) => {
  try { const r = await axios.post(`${ZAPI_BASE}/disconnect`); res.json(r.data); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Chats & Mensagens ──────────────────────────────────────────────
app.get("/api/chats", async (req, res) => {
  try {
    const r = await axios.get(`${ZAPI_BASE}/chats`, { params: { pageSize: 50 } });
    const zapiChats = Array.isArray(r.data) ? r.data : (r.data?.chats || []);
    const zapiPhones = new Set(zapiChats.map(c => String(c.phone || "").replace(/\D/g, "")));
    const localOnly = [...crm.values()].filter(c => !zapiPhones.has(String(c.phone || "").replace(/\D/g, "")));
    res.json([...zapiChats, ...localOnly.map(c => ({
      phone: c.phone, name: c.name,
      lastMessage: { text: c.messages.at(-1)?.text || "" },
      lastMessageTime: c.lastTime, unread: c.unread,
    }))]);
  } catch (e) {
    res.json([...crm.values()].map(c => ({
      phone: c.phone, name: c.name,
      lastMessage: { text: c.messages.at(-1)?.text || "" },
      lastMessageTime: c.lastTime, unread: c.unread,
    })));
  }
});

app.get("/api/messages/:phone", async (req, res) => {
  const { phone } = req.params;
  try {
    const r = await axios.get(`${ZAPI_BASE}/messages/${phone}`, { params: { pageSize: 50 } });
    const zapiMsgs = Array.isArray(r.data) ? r.data : (r.data?.messages || []);
    const local = crm.get(phone)?.messages || [];
    const all = [...zapiMsgs, ...local].sort((a, b) => (a.momment || a.time || 0) - (b.momment || b.time || 0));
    if (crm.has(phone)) crm.get(phone).unread = 0;
    res.json(all);
  } catch (e) {
    const local = crm.get(phone)?.messages || [];
    if (crm.has(phone)) crm.get(phone).unread = 0;
    res.json(local);
  }
});

app.post("/api/enviar", async (req, res) => {
  const { phone, message, name } = req.body;
  const resultado = await sendWhatsApp(phone, message);
  if (resultado.ok) {
    const chat = getOrCreateChat(formatPhone(phone), name);
    chat.messages.push({ text: message, fromMe: true, time: Date.now(), momment: Date.now() });
    chat.lastTime = Date.now();
  }
  res.json(resultado);
});

// ── Webhook ────────────────────────────────────────────────────────
app.post("/webhook/messages", (req, res) => {
  try {
    const p = req.body;
    const phone  = String(p.phone || p.from || "").replace("@s.whatsapp.net", "");
    const name   = p.chatName || p.senderName || phone;
    const text   = p.text?.message || p.body || p.caption || "";
    const time   = p.momment || Date.now();
    const fromMe = p.fromMe === true;
    if (phone && text) {
      const chat = getOrCreateChat(phone, name);
      chat.name = name;
      chat.messages.push({ text, fromMe, time, momment: time });
      chat.lastTime = time;
      if (!fromMe) chat.unread = (chat.unread || 0) + 1;
    }
  } catch (err) { console.error("[WEBHOOK]", err.message); }
  res.json({ ok: true });
});

app.get("/api/crm/updates", (req, res) => {
  const since = parseInt(req.query.since || "0");
  const updates = [];
  for (const [phone, chat] of crm.entries()) {
    const newMsgs = chat.messages.filter(m => (m.time || m.momment || 0) > since);
    if (newMsgs.length > 0) updates.push({ phone, name: chat.name, unread: chat.unread, lastTime: chat.lastTime, newMessages: newMsgs });
  }
  res.json({ updates, serverTime: Date.now() });
});

// ── Campanha ───────────────────────────────────────────────────────
app.post("/api/campanha", async (req, res) => {
  const { contatos, mensagem, intervalo = 3000 } = req.body;
  if (!Array.isArray(contatos) || !contatos.length) return res.status(400).json({ error: "Lista vazia" });
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  const send = d => res.write(`data: ${JSON.stringify(d)}\n\n`);
  send({ tipo: "inicio", total: contatos.length });
  for (let i = 0; i < contatos.length; i++) {
    const { phone, nome = "cliente" } = contatos[i];
    const msg = mensagem.replace(/\{nome\}/gi, nome);
    let ok = false, erro = null;
    await new Promise(r => setTimeout(r, intervalo));
    const resultado = await sendWhatsApp(phone, msg);
    ok = resultado.ok; erro = resultado.error;
    if (ok) { const chat = getOrCreateChat(formatPhone(phone), nome); chat.messages.push({ text: msg, fromMe: true, time: Date.now(), momment: Date.now() }); chat.lastTime = Date.now(); }
    send({ tipo: "progresso", i: i + 1, total: contatos.length, phone, nome, ok, erro });
  }
  send({ tipo: "fim", total: contatos.length });
  res.end();
});

app.get("*", (req, res) => res.sendFile(path.join(__dirname, "index.html")));

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`\n🌸 Mora Fashion WhatsApp CRM — porta ${PORT}`);
  console.log(`   → GC: ${GC_ACCESS ? "✓" : "✗"} | Z-API: ${ZAPI_INST ? "✓" : "✗"}`);
  console.log(`   → Cache: ${cache.data.length} clientes`);
  console.log(`   → Disparo pós-venda: ${config.posVenda.ativo ? "✓ Ativo" : "✗ Inativo"}`);
  console.log(`   → Aniversário: ${config.aniversario.ativo ? "✓ Ativo" : "✗ Inativo"}\n`);
});
