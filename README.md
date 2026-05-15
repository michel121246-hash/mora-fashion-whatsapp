# 🌸 Mora Fashion — Painel WhatsApp

Painel para conectar o Gestão Click com o WhatsApp Business via Z-API.

---

## 🚀 Deploy no Replit (gratuito)

### Passo 1 — Criar conta no Replit
Acesse **replit.com** e crie uma conta gratuita (pode entrar com Google).

### Passo 2 — Criar o projeto
1. Clique em **"+ Create Repl"**
2. Escolha **"Import from GitHub"** ou **"Upload folder"**
3. Selecione esta pasta (`mora-fashion-whatsapp`)
4. Linguagem: **Node.js**
5. Clique em **"Create Repl"**

### Passo 3 — Configurar as variáveis secretas
No painel do Replit, clique no **cadeado 🔒 "Secrets"** no menu lateral e adicione:

| Chave              | Valor                                  |
|--------------------|----------------------------------------|
| `GC_ACCESS_TOKEN`  | Seu access token do Gestão Click       |
| `GC_SECRET_TOKEN`  | Seu secret access token do Gestão Click|
| `ZAPI_INSTANCE`    | O Instance ID da sua Z-API             |
| `ZAPI_TOKEN`       | O Token da sua instância Z-API         |

> ⚠️ **NUNCA coloque as credenciais no código.** Use sempre os Secrets do Replit.

### Passo 4 — Rodar
Clique no botão verde **▶ Run**. O painel vai aparecer na janela ao lado com uma URL pública como:
```
https://mora-fashion-whatsapp.seuusuario.repl.co
```
Essa URL funciona em qualquer computador ou celular!

### Passo 5 — Manter online sempre (opcional)
O Replit gratuito hiberna após inatividade. Para manter sempre ligado:
- **Opção A:** Assine o **Replit Core** (~R$ 25/mês)
- **Opção B:** Use o serviço gratuito **UptimeRobot** (uptimerobot.com) para fazer um ping a cada 5 minutos na URL do painel

---

## 🔧 Como pegar os tokens

### Gestão Click
1. No sistema, vá em **Configurações → Aplicativos**
2. Procure por **API** e clique em "Acessar Aplicativo"
3. Clique em **"Gerar Token"**
4. Copie o **Access Token** e o **Secret Access Token**

### Z-API
1. Acesse **z-api.io** e crie uma conta
2. Crie uma nova **instância**
3. Escaneie o **QR Code** com seu WhatsApp Business
4. Copie o **Instance ID** e o **Token**

---

## 📦 Funcionalidades

- **Pedidos:** Carrega últimos 40 pedidos do Gestão Click. Clique para enviar mensagem de agradecimento direto no WhatsApp do cliente.
- **Clientes:** Busca por nome, mostra histórico de compras e total gasto. Envia mensagem personalizada.
- **Campanhas:** Cole uma lista de números (um por linha), escolha um template e dispare para todos com intervalo automático.

---

## 🛡️ Segurança
- As credenciais ficam apenas no servidor (Replit Secrets), nunca no browser.
- O painel pode ser acessado por múltiplos usuários simultâneos.
- Não há banco de dados — os dados vêm sempre do Gestão Click em tempo real.
