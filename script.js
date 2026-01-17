// Comments Overlay (WebSocket first, fallback polling)
// Uso: ?ws=ws://host:PORT&channel=nome  ou  ?domain=http://localhost:3900
// Parâmetro opcional: lifetime (ms) para duração do comentário, ex: ?lifetime=10000

const params = new URLSearchParams(window.location.search);
const wsUrl = params.get("ws") || null;           // ex: ws://localhost:PORT ou wss://host:PORT
const channel = params.get("channel") || "default";
const domain = params.get("domain") || "http://localhost:3900"; // fallback polling
const commentLifetime = parseInt(params.get("lifetime") || "10000", 10); // ms

const container = document.getElementById("comments-container");
const statusEl = document.getElementById("status");

// === Função simples (texto) ===
function addComment(text) {
  const commentElement = document.createElement("div");
  commentElement.textContent = text;
  commentElement.className = "comment";

  container.appendChild(commentElement);

  // Remove após a duração com animação de saída
  setTimeout(() => {
    commentElement.style.animation = "slideOut 420ms ease forwards";
    setTimeout(() => commentElement.remove(), 420);
  }, commentLifetime);
}

// === Versão rica com avatar + nome + texto ===
function addCommentRich({ name, avatar, text }) {
  const el = document.createElement("div");
  el.className = "comment-rich";

  const safeAvatar = avatar || `https://ui-avatars.com/api/?name=${encodeURIComponent(name||"Anon")}&background=444&color=fff`;

  el.innerHTML = `
    <div class="avatar"><img src="${safeAvatar}" onerror="this.src='https://ui-avatars.com/api/?name=${encodeURIComponent(name||'Anon')}&background=444&color=fff'"></div>
    <div class="meta">
      <div class="name">${escapeHtml(name || "Anónimo")}</div>
      <div class="text">${escapeHtml(text || "")}</div>
    </div>
  `;

  container.appendChild(el);

  setTimeout(() => {
    el.style.animation = "slideOut 420ms ease forwards";
    setTimeout(() => el.remove(), 420);
  }, commentLifetime);
}

// Escapar HTML
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// Parser flexível: aceita object {username, avatar, text} OR JSON string OR "name|avatar|text" OR "name: message" OR plain text
function parseIncoming(raw) {
  if (raw === null || raw === undefined) return null;

  // object
  if (typeof raw === "object" && raw !== null) {
    const name = raw.username || raw.user || raw.name || raw.displayName || raw.nick || null;
    const avatar = raw.avatar || raw.avatarUrl || raw.picture || null;
    const text = raw.text || raw.message || raw.msg || raw.body || raw.content || null;
    if (text) return { name, avatar, text };
  }

  // string
  if (typeof raw === "string") {
    // tenta JSON
    try {
      const obj = JSON.parse(raw);
      return parseIncoming(obj);
    } catch (e) {
      // pipe format
      const pipe = raw.split("|").map(s => s.trim());
      if (pipe.length >= 3) {
        return { name: pipe[0], avatar: pipe[1], text: pipe.slice(2).join("|") };
      }
      // name: message
      const colon = raw.indexOf(":");
      if (colon > 0) {
        return { name: raw.slice(0, colon).trim(), avatar: null, text: raw.slice(colon + 1).trim() };
      }
      // fallback plain text
      return { name: null, avatar: null, text: raw.trim() };
    }
  }

  return null;
}

// === WebSocket first, fallback polling ===
let ws = null;
let reconnectTimer = null;
let pollingTimer = null;
let seen = new Set();

function connectWS() {
  if (!wsUrl) {
    startPolling();
    return;
  }

  try {
    ws = new WebSocket(wsUrl);
  } catch (err) {
    console.error("WS create error", err);
    startPolling();
    scheduleReconnect();
    return;
  }

  statusEl.textContent = "A ligar (WebSocket)…";

  ws.onopen = () => {
    console.log("WS open", wsUrl);
    statusEl.textContent = "Ligado (WebSocket)";
    // subscreve canal se a API suportar (adapta conforme necessário)
    try { ws.send(JSON.stringify({ action: "subscribe", channel })); } catch (e) {}
  };

  ws.onmessage = (evt) => {
    const data = evt.data;
    if (data instanceof Blob) {
      const reader = new FileReader();
      reader.onload = () => handleRaw(reader.result);
      reader.readAsText(data);
    } else {
      handleRaw(data);
    }
  };

  ws.onerror = (e) => {
    console.error("WS error", e);
  };

  ws.onclose = () => {
    console.warn("WS closed");
    statusEl.textContent = "WebSocket fechado — a tentar reconectar…";
    scheduleReconnect();
    startPolling(); // fallback
  };
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectWS();
  }, 2000 + Math.random() * 2000);
}

function handleRaw(raw) {
  const parsed = parseIncoming(raw);
  if (!parsed) return;

  // se o texto contiver múltiplas linhas, cria vários comentários
  if (parsed.text && parsed.text.includes("\n")) {
    parsed.text.split("\n").map(t => t.trim()).filter(Boolean).forEach(t => {
      addFromParsed({ ...parsed, text: t });
    });
    return;
  }

  addFromParsed(parsed);
}

function addFromParsed(parsed) {
  // evita duplicados simples por texto+nome
  const key = (parsed.text || "") + "|" + (parsed.name || "");
  if (seen.has(key)) return;
  seen.add(key);

  // mantém set pequeno
  if (seen.size > 500) {
    const arr = Array.from(seen).slice(-200);
    seen = new Set(arr);
  }

  if (parsed.name || parsed.avatar) addCommentRich(parsed);
  else addComment(parsed.text);
}

// === Polling fallback (usa /wordcloud) ===
async function pollOnce() {
  try {
    const res = await fetch(`${domain}/wordcloud`, { cache: "no-store" });
    const data = await res.json();
    const arr = (data.wordcloud || "").split(",").map(s => s.trim()).filter(Boolean);
    for (const entry of arr) {
      const parsed = parseIncoming(entry);
      if (parsed) addFromParsed(parsed);
    }

    if (statusEl.textContent.startsWith("A ligar") || statusEl.textContent.startsWith("Sem ligação")) {
      statusEl.textContent = "A ler comentários…";
    }
  } catch (e) {
    console.error("Polling error", e);
    statusEl.textContent = "Sem ligação ao servidor";
  }
}

function startPolling() {
  if (pollingTimer) return;
  pollOnce();
  pollingTimer = setInterval(pollOnce, 1000);
}

function stopPolling() {
  if (!pollingTimer) return;
  clearInterval(pollingTimer);
  pollingTimer = null;
}

// === Simulação para testes (descomenta para usar) ===
function simulateComments() {
  const sample = [
    "João|https://i.pravatar.cc/60?img=3|Olá, pessoal!",
    "Maria|https://i.pravatar.cc/60?img=5|Adorei esta ideia!",
    "Pedro: Excelente apresentação!",
    "Isto é só um teste",
    JSON.stringify({ username: "Ana", avatar: "https://i.pravatar.cc/60?img=8", text: "Onde posso saber mais?" })
  ];

  let i = 0;
  setInterval(() => {
    const item = sample[i % sample.length];
    handleRaw(item);
    i++;
  }, 2000);
}

// === Inicialização ===
(function init() {
  if (wsUrl) connectWS();
  else startPolling();

  // limpeza periódica de IDs antigos
  setInterval(() => {
    if (seen.size > 500) {
      const keep = Array.from(seen).slice(-200);
      seen = new Set(keep);
    }
  }, 60_000);

  // descomenta para simular localmente
  // simulateComments();
})();
