require("dotenv").config();
const express = require("express");
const axios = require("axios");
const path = require("path");

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

// CRM em memória: phone -> { phone, name, messages[], unread, lastTime }
const crm = new Map();
function getOrCreateChat(phone, name) {
  if (!crm.has(phone)) crm.set(phone, { phone, name: name || phone, messages: [], unread: 0, lastTime: Date.now() });
  return crm.get(phone);
}

// ── Status ────────────────────────────────────────────────────────────────────
app.get("/api/status", (req, res) => {
  res.json({ gc: !!(GC_ACCESS && GC_SECRET), zapi: !!(ZAPI_INST && ZAPI_TOKEN) });
});

// ── Gestão Click ──────────────────────────────────────────────────────────────
app.get("/api/pedidos", async (req, res) => {
  try {
    const r = await axios.get(`${GC_BASE}/vendas`, {
      headers: gcHeaders(),
      params: { limite: 40, ordenar_por: "data", ordem: "desc", ...req.query },
    });
    res.json(r.data);
  } catch (e) {
    res.status(e.response?.status || 500).json({ error: e.response?.data?.message || e.message });
  }
});

app.get("/api/clientes", async (req, res) => {
  try {
    const r = await axios.get(`${GC_BASE}/clientes`, { headers: gcHeaders(), params: req.query });
    res.json(r.data);
  } catch (e) {
    res.status(e.response?.status || 500).json({ error: e.response?.data?.message || e.message });
  }
});

app.get("/api/clientes/:id", async (req, res) => {
  try {
    const r = await axios.get(`${GC_BASE}/clientes/${req.params.id}`, { headers: gcHeaders() });
    res.json(r.data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/clientes/:id/pedidos", async (req, res) => {
  try {
    const r = await axios.get(`${GC_BASE}/vendas`, {
      headers: gcHeaders(),
      params: { cliente_id: req.params.id, limite: 15, ordenar_por: "data", ordem: "desc" },
    });
    res.json(r.data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Z-API: Conexão & QR Code ──────────────────────────────────────────────────
app.get("/api/zapi/status", async (req, res) => {
  try {
    const r = await axios.get(`${ZAPI_BASE}/status`);
    res.json(r.data);
  } catch (e) {
    res.status(500).json({ error: e.message, connected: false });
  }
});

app.get("/api/zapi/qrcode", async (req, res) => {
  try {
    const r = await axios.get(`${ZAPI_BASE}/qr-code/image`, { responseType: "arraybuffer" });
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "no-cache");
    res.send(r.data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/zapi/disconnect", async (req, res) => {
  try {
    const r = await axios.post(`${ZAPI_BASE}/disconnect`);
    res.json(r.data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Z-API: Chats & Mensagens ──────────────────────────────────────────────────
app.get("/api/chats", async (req, res) => {
  try {
    const r = await axios.get(`${ZAPI_BASE}/chats`, { params: { pageSize: 50 } });
    const zapiChats = Array.isArray(r.data) ? r.data : (r.data?.chats || []);
    const zapiPhones = new Set(zapiChats.map(c => String(c.phone || "").replace(/\D/g, "")));
    const localOnly = [...crm.values()].filter(c => !zapiPhones.has(String(c.phone || "").replace(/\D/g, "")));
    const merged = [
      ...zapiChats,
      ...localOnly.map(c => ({
        phone: c.phone, name: c.name,
        lastMessage: { text: c.messages.at(-1)?.text || "" },
        lastMessageTime: c.lastTime, unread: c.unread,
      })),
    ];
    res.json(merged);
  } catch (e) {
    const local = [...crm.values()].map(c => ({
      phone: c.phone, name: c.name,
      lastMessage: { text: c.messages.at(-1)?.text || "" },
      lastMessageTime: c.lastTime, unread: c.unread,
    }));
    res.json(local);
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

// ── Z-API: Enviar ─────────────────────────────────────────────────────────────
app.post("/api/enviar", async (req, res) => {
  const { phone, message, name } = req.body;
  const formatted = formatPhone(phone);
  if (!formatted) return res.status(400).json({ ok: false, error: "Telefone inválido ou vazio" });
  try {
    const r = await axios.post(`${ZAPI_BASE}/send-text`, { phone: formatted, message });
    const chat = getOrCreateChat(formatted, name);
    chat.messages.push({ text: message, fromMe: true, time: Date.now(), momment: Date.now() });
    chat.lastTime = Date.now();
    res.json({ ok: true, data: r.data });
  } catch (e) {
    res.status(e.response?.status || 500).json({ ok: false, error: e.response?.data?.message || e.message });
  }
});

// ── Webhook: Receber mensagens da Z-API ───────────────────────────────────────
// Configure na Z-API dashboard: On Message Received → https://SEU-DOMINIO/webhook/messages
app.post("/webhook/messages", (req, res) => {
  try {
    const p = req.body;
    const phone = String(p.phone || p.from || "").replace("@s.whatsapp.net", "");
    const name  = p.chatName || p.senderName || phone;
    const text  = p.text?.message || p.body || p.caption || "";
    const time  = p.momment || Date.now();
    const fromMe = p.fromMe === true;
    if (phone && text) {
      const chat = getOrCreateChat(phone, name);
      chat.name = name;
      chat.messages.push({ text, fromMe, time, momment: time });
      chat.lastTime = time;
      if (!fromMe) chat.unread = (chat.unread || 0) + 1;
    }
  } catch (err) {
    console.error("[WEBHOOK ERROR]", err.message);
  }
  res.json({ ok: true });
});

// Polling de atualizações para o frontend
app.get("/api/crm/updates", (req, res) => {
  const since = parseInt(req.query.since || "0");
  const updates = [];
  for (const [phone, chat] of crm.entries()) {
    const newMsgs = chat.messages.filter(m => (m.time || m.momment || 0) > since);
    if (newMsgs.length > 0) {
      updates.push({ phone, name: chat.name, unread: chat.unread, lastTime: chat.lastTime, newMessages: newMsgs });
    }
  }
  res.json({ updates, serverTime: Date.now() });
});

// ── Campanha em massa ─────────────────────────────────────────────────────────
app.post("/api/campanha", async (req, res) => {
  const { contatos, mensagem, intervalo = 3000 } = req.body;
  if (!Array.isArray(contatos) || !contatos.length) return res.status(400).json({ error: "Lista vazia" });
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  const send = (d) => res.write(`data: ${JSON.stringify(d)}\n\n`);
  send({ tipo: "inicio", total: contatos.length });
  for (let i = 0; i < contatos.length; i++) {
    const { phone, nome = "cliente" } = contatos[i];
    const formatted = formatPhone(phone);
    const msg = mensagem.replace(/\{nome\}/gi, nome);
    let ok = false, erro = null;
    if (!formatted) { erro = "Telefone inválido"; }
    else {
      try {
        const r = await axios.post(`${ZAPI_BASE}/send-text`, { phone: formatted, message: msg });
        ok = r.status === 200 || r.status === 201;
        if (ok) { const chat = getOrCreateChat(formatted, nome); chat.messages.push({ text: msg, fromMe: true, time: Date.now(), momment: Date.now() }); chat.lastTime = Date.now(); }
      } catch (e) { erro = e.response?.data?.message || e.message; }
    }
    send({ tipo: "progresso", i: i + 1, total: contatos.length, phone, nome, ok, erro });
    if (i < contatos.length - 1) await new Promise(r => setTimeout(r, intervalo));
  }
  send({ tipo: "fim", total: contatos.length });
  res.end();
});

app.get("*", (req, res) => res.sendFile(path.join(__dirname, "index.html")));

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`\n🌸 Mora Fashion WhatsApp CRM rodando na porta ${PORT}`);
  console.log(`   → Gestão Click: ${GC_ACCESS ? "✓" : "✗"} | Z-API: ${ZAPI_INST ? "✓" : "✗"}`);
  console.log(`   → Webhook: https://SEU-DOMINIO/webhook/messages\n`);
});
