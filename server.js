require("dotenv").config();
const express = require("express");
const axios = require("axios");
const path = require("path");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ─── Variáveis de ambiente ────────────────────────────────────────────────────
const GC_ACCESS   = process.env.GC_ACCESS_TOKEN;
const GC_SECRET   = process.env.GC_SECRET_TOKEN;
const ZAPI_INST   = process.env.ZAPI_INSTANCE;
const ZAPI_TOKEN  = process.env.ZAPI_TOKEN;
const GC_BASE     = "https://api.gestaoclick.com";
const ZAPI_BASE   = `https://api.z-api.io/instances/${ZAPI_INST}/token/${ZAPI_TOKEN}`;

const gcHeaders = () => ({
  "access-token": GC_ACCESS,
  "secret-access-token": GC_SECRET,
  "Content-Type": "application/json",
});

// ─── Utilitário: formatar telefone para Z-API ─────────────────────────────────
function formatPhone(raw = "") {
  const digits = String(raw).replace(/\D/g, "");
  if (!digits) return null;
  if (digits.startsWith("55") && digits.length >= 12) return digits;
  return "55" + digits;
}

// ─── Verificação de configuração ──────────────────────────────────────────────
app.get("/api/status", (req, res) => {
  res.json({
    gc: !!(GC_ACCESS && GC_SECRET),
    zapi: !!(ZAPI_INST && ZAPI_TOKEN),
    instancia: ZAPI_INST || null,
  });
});

// ─── Gestão Click: Pedidos ────────────────────────────────────────────────────
app.get("/api/pedidos", async (req, res) => {
  try {
    const params = { limite: 30, ordenar_por: "data_emissao", ordem: "desc", ...req.query };
    const r = await axios.get(`${GC_BASE}/pedidos_venda`, {
      headers: gcHeaders(),
      params,
    });
    res.json(r.data);
  } catch (e) {
    const status = e.response?.status || 500;
    res.status(status).json({ error: e.response?.data?.message || e.message });
  }
});

// ─── Gestão Click: Clientes ───────────────────────────────────────────────────
app.get("/api/clientes", async (req, res) => {
  try {
    const r = await axios.get(`${GC_BASE}/clientes`, {
      headers: gcHeaders(),
      params: req.query,
    });
    res.json(r.data);
  } catch (e) {
    const status = e.response?.status || 500;
    res.status(status).json({ error: e.response?.data?.message || e.message });
  }
});

// ─── Gestão Click: Pedidos de um cliente ─────────────────────────────────────
app.get("/api/clientes/:id/pedidos", async (req, res) => {
  try {
    const r = await axios.get(`${GC_BASE}/pedidos_venda`, {
      headers: gcHeaders(),
      params: { cliente_id: req.params.id, limite: 15, ordenar_por: "data_emissao", ordem: "desc" },
    });
    res.json(r.data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Gestão Click: Dados do cliente ──────────────────────────────────────────
app.get("/api/clientes/:id", async (req, res) => {
  try {
    const r = await axios.get(`${GC_BASE}/clientes/${req.params.id}`, {
      headers: gcHeaders(),
    });
    res.json(r.data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Z-API: Enviar mensagem individual ───────────────────────────────────────
app.post("/api/enviar", async (req, res) => {
  const { phone, message } = req.body;
  const formatted = formatPhone(phone);
  if (!formatted) return res.status(400).json({ ok: false, error: "Telefone inválido ou vazio" });

  try {
    const r = await axios.post(`${ZAPI_BASE}/send-text`, { phone: formatted, message });
    res.json({ ok: true, data: r.data });
  } catch (e) {
    res.status(e.response?.status || 500).json({
      ok: false,
      error: e.response?.data?.message || e.message,
    });
  }
});

// ─── Z-API: Campanha em massa com Server-Sent Events ─────────────────────────
// O servidor executa os envios e transmite o progresso em tempo real para o browser
app.post("/api/campanha", async (req, res) => {
  const { contatos, mensagem, intervalo = 3000 } = req.body;
  // contatos: [{ phone: "11999...", nome: "Maria" }, ...]

  if (!Array.isArray(contatos) || !contatos.length) {
    return res.status(400).json({ error: "Lista de contatos vazia" });
  }

  // Server-Sent Events — o browser recebe updates em tempo real
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const sendEvent = (data) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  sendEvent({ tipo: "inicio", total: contatos.length });

  for (let i = 0; i < contatos.length; i++) {
    const { phone, nome = "cliente" } = contatos[i];
    const formatted = formatPhone(phone);
    const msg = mensagem.replace(/\{nome\}/gi, nome);

    let ok = false;
    let erro = null;

    if (!formatted) {
      erro = "Telefone inválido";
    } else {
      try {
        const r = await axios.post(`${ZAPI_BASE}/send-text`, { phone: formatted, message: msg });
        ok = r.status === 200 || r.status === 201;
      } catch (e) {
        erro = e.response?.data?.message || e.message;
      }
    }

    sendEvent({ tipo: "progresso", i: i + 1, total: contatos.length, phone, nome, ok, erro });

    if (i < contatos.length - 1) {
      await new Promise((r) => setTimeout(r, intervalo));
    }
  }

  sendEvent({ tipo: "fim", total: contatos.length });
  res.end();
});

// ─── Fallback: serve o index.html para todas as rotas não-API ─────────────────
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`\n🌸 Mora Fashion WhatsApp Panel rodando!`);
  console.log(`   → http://localhost:${PORT}`);
  console.log(`   → Gestão Click: ${GC_ACCESS ? "✓ configurado" : "✗ FALTANDO GC_ACCESS_TOKEN"}`);
  console.log(`   → Z-API: ${ZAPI_INST ? "✓ configurado" : "✗ FALTANDO ZAPI_INSTANCE"}\n`);
});
