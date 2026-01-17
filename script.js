// script.js (WebSocket first, fallback polling)

// Config
const params = new URLSearchParams(window.location.search);
const wsUrl = params.get("ws") || null; // ex: ws://localhost:PORT ou wss://host:PORT
const channel = params.get("channel") || "default";
const domain = params.get("domain") || "http://localhost:3900"; // fallback polling endpoint

const statusEl = document.getElementById("status");
const messagesEl = document.getElementById("messages");

let ws = null;
let reconnectTimer = null;
let lastIds = new Set(); // evita duplicados
let pollingEnabled = !wsUrl; // se não houver ws param, usa polling

// Util: cria elemento de mensagem com avatar + nome + texto
function addMessage({ name, avatar, text, id }) {
  if (id && lastIds.has(id)) return;
  if (id) lastIds.add(id);

  const div = document.createElement("div");
  div.className = "msg";

  // avatar fallback: ui-avatars
  const safeAvatar = avatar || `https://ui-avatars.com/api/?name=${encodeURIComponent(name || "Anon")}&background=444&color=fff`;

  div.innerHTML = `
    <div class="avatar">
      <img src="${safeAvatar}" onerror="this.src='https://ui-avatars.com/api/?name=${encodeURIComponent(name || 'Anon')}&background=444&color=fff';">
    </div>
    <div class="content">
      <div class="name">${escapeHtml(name || "Anónimo")}</div>
      <div class="text">${escapeHtml(text || "")}</div>
    </div>
  `;

  messagesEl.appendChild(div);

  // scroll / limitar
  if (messagesEl.children.length > 14) {
    messagesEl.removeChild(messagesEl.firstChild);
  }
}

// Pequena função para escapar HTML
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// Parser flexível: aceita JSON object or "name|avatar|text" or "name: text"
function parseIncoming(raw) {
  // Se já for object
  if (typeof raw === "object" && raw !== null) {
    // tenta vários campos comuns
    const name = raw.username || raw.user || raw.name || raw.displayName || raw.nick;
    const avatar = raw.avatar || raw.avatarUrl || raw.avatar_url || raw.picture;
    const text = raw.text || raw.message || raw.msg || raw.body || raw.content;
    const id = raw.id || raw.messageId || raw.msgId || null;
    if (text) return { name, avatar, text, id };
  }

  // Se for string, tenta JSON parse
  if (typeof raw === "string") {
    // tenta JSON
    try {
      const obj = JSON.parse(raw);
      return parseIncoming(obj);
    } catch (e) {
      // não JSON: tenta formato pipe
      const pipeParts = raw.split("|").map(s => s.trim());
      if (pipeParts.length >= 3) {
        return { name: pipeParts[0], avatar: pipeParts[1], text: pipeParts.slice(2).join("|") };
      }
      // tenta formato "name: message"
      const colonIndex = raw.indexOf(":");
      if (colonIndex > 0) {
        const name = raw.slice(0, colonIndex).trim();
        const text = raw.slice(colonIndex + 1).trim();
        return { name, avatar: null, text };
      }
      // fallback: treat as message only
      return { name: null, avatar: null, text: raw };
    }
  }

  return null;
}

// WS handlers
function connectWebSocket() {
  if (!wsUrl) {
    console.warn("WebSocket URL não fornecido; a usar polling.");
    pollingEnabled = true;
    startPolling();
    return;
  }

  try {
    ws = new WebSocket(wsUrl);
  } catch (err) {
    console.error("Erro ao criar WebSocket:", err);
    scheduleReconnect();
    return;
  }

  statusEl.textContent = "A ligar (WebSocket)…";

  ws.onopen = () => {
    console.log("WS aberto:", wsUrl);
    statusEl.textContent = "Ligado (WebSocket)";
    pollingEnabled = false;
    // subscreve canal se a API suportar (ajusta conforme Social Stream Ninja)
    try {
      // Exemplo genérico de subscribe; adapta se a API exigir outro formato
      ws.send(JSON.stringify({ action: "subscribe", channel }));
    } catch (e) { /* ignore */ }
  };

  ws.onmessage = (evt) => {
    // evt.data pode ser string ou blob
    let payload = evt.data;
    // se for Blob, tenta ler como text
    if (payload instanceof Blob) {
      const reader = new FileReader();
      reader.onload = () => {
        handleRawMessage(reader.result);
      };
      reader.readAsText(payload);
    } else {
      handleRawMessage(payload);
    }
  };

  ws.onerror = (err) => {
    console.error("WS erro:", err);
  };

  ws.onclose = (ev) => {
    console.warn("WS fechado:", ev);
    statusEl.textContent = "WebSocket fechado — a tentar reconectar…";
    scheduleReconnect();
    // fallback para polling se preferires
    pollingEnabled = true;
    startPolling();
  };
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectWebSocket();
  }, 2500 + Math.random() * 2000);
}

// Trata a mensagem bruta recebida do WS
function handleRawMessage(raw) {
  // tenta parse flexível
  const parsed = parseIncoming(raw);
  if (!parsed) return;

  // se a mensagem vier com um campo que contenha várias mensagens, tenta separar por newline
  if (parsed.text && typeof parsed.text === "string" && parsed.text.includes("\n")) {
    parsed.text.split("\n").map(t => t.trim()).filter(Boolean).forEach(t => {
      addMessage({ name: parsed.name, avatar: parsed.avatar, text: t });
    });
    return;
  }

  addMessage(parsed);
}

// Polling fallback (usa o endpoint /wordcloud do teu servidor)
let pollInterval = null;
async function fetchPolling() {
  try {
    const res = await fetch(`${domain}/wordcloud`, { cache: "no-store" });
    const data = await res.json();
    const raw = (data.wordcloud || "").split(",").map(s => s.trim()).filter(Boolean);

    // tenta interpretar cada entrada como possível "name|avatar|text" ou JSON string
    for (const entry of raw) {
      const parsed = parseIncoming(entry);
      if (!parsed) continue;
      // evita duplicados por texto simples
      if (parsed.text && ![...lastIds].includes(parsed.text)) {
        addMessage(parsed);
      }
    }

    if (statusEl.textContent.startsWith("A ligar") || statusEl.textContent.startsWith("Sem ligação")) {
      statusEl.textContent = "A ler comentários…";
    }
  } catch (e) {
    console.error("Polling erro:", e);
    statusEl.textContent = "Sem ligação ao servidor";
  }
}

function startPolling() {
  if (pollInterval) return;
  fetchPolling();
  pollInterval = setInterval(fetchPolling, 1000);
}

function stopPolling() {
  if (!pollInterval) return;
  clearInterval(pollInterval);
  pollInterval = null;
}

// Inicialização
(function init() {
  // Se wsUrl fornecido, tenta WS; caso contrário, polling
  if (wsUrl) {
    connectWebSocket();
  } else {
    startPolling();
  }

  // limpeza periódica de IDs antigos para evitar memória infinita
  setInterval(() => {
    if (lastIds.size > 500) {
      // mantém apenas os últimos 200
      const keep = Array.from(lastIds).slice(-200);
      lastIds = new Set(keep);
    }
  }, 60_000);
})();
