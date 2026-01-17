// Floating Comments Overlay
// Uso: ?ws=ws://host:PORT&channel=nome  ou  ?domain=http://localhost:3900
// Parâmetros: lifetime (ms), warmup (ms)

const params = new URLSearchParams(window.location.search);
const wsUrl = params.get("ws") || null;
const channel = params.get("channel") || "default";
const domain = params.get("domain") || "http://localhost:3900";
const commentLifetime = parseInt(params.get("lifetime") || "8000", 10); // ms visible
const warmupMs = parseInt(params.get("warmup") || "800", 10);

const stage = document.getElementById("stage");
const statusEl = document.getElementById("status");

let ws = null;
let reconnectTimer = null;
let pollingTimer = null;
let seen = new Set();
let warmup = true;
let warmupTimer = null;

// Util: escape HTML
function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// Parser flexível (JSON, pipe, "name: text", plain)
function parseIncoming(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "object" && raw !== null) {
    const name = raw.username || raw.user || raw.name || raw.displayName || null;
    const avatar = raw.avatar || raw.avatarUrl || raw.picture || null;
    const text = raw.text || raw.message || raw.msg || raw.body || raw.content || null;
    const id = raw.id || raw.messageId || null;
    if (text) return { name, avatar, text, id };
  }
  if (typeof raw === "string") {
    try {
      const obj = JSON.parse(raw);
      return parseIncoming(obj);
    } catch (e) {
      const pipe = raw.split("|").map(s => s.trim());
      if (pipe.length >= 3) return { name: pipe[0], avatar: pipe[1], text: pipe.slice(2).join("|") };
      const colon = raw.indexOf(":");
      if (colon > 0) return { name: raw.slice(0, colon).trim(), avatar: null, text: raw.slice(colon + 1).trim() };
      return { name: null, avatar: null, text: raw.trim() };
    }
  }
  return null;
}

// Gera posição aleatória dentro do stage, evitando bordas
function randomPosition(elWidth, elHeight) {
  const pad = 24;
  const rect = stage.getBoundingClientRect();
  const maxX = Math.max(0, rect.width - elWidth - pad);
  const maxY = Math.max(0, rect.height - elHeight - pad);
  const x = pad + Math.random() * maxX;
  const y = pad + Math.random() * maxY;
  return { x, y };
}

// Cria e anima comentário flutuante
function spawnFloating(parsed) {
  const key = messageKey(parsed);
  if (!key || seen.has(key)) return;
  if (warmup) { seen.add(key); return; } // during warmup mark as seen but don't show

  seen.add(key);

  const el = document.createElement("div");
  el.className = "float";

  // decide rich or simple
  if (parsed.name || parsed.avatar) {
    el.innerHTML = `
      <div class="avatar"><img src="${escapeHtml(parsed.avatar || '')}" onerror="this.src='https://ui-avatars.com/api/?name=${encodeURIComponent(parsed.name||'Anon')}&background=444&color=fff'"></div>
      <div class="meta">
        <div class="name">${escapeHtml(parsed.name || 'Anónimo')}</div>
        <div class="text">${escapeHtml(parsed.text)}</div>
      </div>
    `;
  } else {
    el.classList.add("simple");
    el.textContent = parsed.text;
  }

  // small random rotation class
  el.classList.add(Math.random() > 0.5 ? "rotateA" : "rotateB");

  // append hidden to measure
  el.style.left = "-9999px";
  el.style.top = "-9999px";
  stage.appendChild(el);

  // measure and position
  const rect = el.getBoundingClientRect();
  const pos = randomPosition(rect.width, rect.height);
  el.style.left = `${pos.x}px`;
  el.style.top = `${pos.y}px`;

  // entrance animation
  el.style.animation = `floatIn 520ms cubic-bezier(.2,.9,.2,1) forwards`;

  // schedule exit
  setTimeout(() => {
    el.style.animation = "floatOut 420ms ease forwards";
    setTimeout(() => el.remove(), 420);
  }, commentLifetime);
}

// Unique key for message
function messageKey(parsed) {
  if (!parsed) return null;
  if (parsed.id) return String(parsed.id);
  return `${(parsed.name||"")}|${(parsed.text||"")}`.slice(0, 300);
}

// Handle raw incoming (string or object)
function handleRaw(raw) {
  const parsed = parseIncoming(raw);
  if (!parsed || !parsed.text) return;

  // if contains multiple lines, split
  if (parsed.text.includes("\n")) {
    parsed.text.split("\n").map(t => t.trim()).filter(Boolean).forEach(t => {
      spawnFloating({ ...parsed, text: t });
    });
    return;
  }

  spawnFloating(parsed);
}

// WebSocket with warmup to ignore backlog
function connectWS() {
  if (!wsUrl) { startPolling(); return; }

  try {
    ws = new WebSocket(wsUrl);
  } catch (err) {
    console.error("WS create error", err);
    startPolling();
    scheduleReconnect();
    return;
  }

  statusEl.textContent = "A ligar (WebSocket)…";
  warmup = true;
  if (warmupTimer) clearTimeout(warmupTimer);
  warmupTimer = setTimeout(() => {
    warmup = false;
    statusEl.textContent = "A ler comentários…";
  }, warmupMs);

  ws.onopen = () => {
    console.log("WS open", wsUrl);
    statusEl.textContent = "Ligado (WebSocket)";
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

  ws.onerror = (e) => console.error("WS error", e);

  ws.onclose = () => {
    console.warn("WS closed");
    statusEl.textContent = "WebSocket fechado — a tentar reconectar…";
    scheduleReconnect();
    startPolling();
  };
}

let reconnectTimer = null;
function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectWS();
  }, 2000 + Math.random() * 2000);
}

// Polling fallback: seed seen on first poll, then show only new
let pollingTimer = null;
let firstPollDone = false;
async function pollOnce() {
  try {
    const res = await fetch(`${domain}/wordcloud`, { cache: "no-store" });
    const data = await res.json();
    const arr = (data.wordcloud || "").split(",").map(s => s.trim()).filter(Boolean);
    for (const entry of arr) {
      const parsed = parseIncoming(entry);
      if (!parsed) continue;
      const key = messageKey(parsed);
      if (!key) continue;
      if (!firstPollDone) { seen.add(key); continue; }
      if (!seen.has(key)) handleRaw(parsed);
    }
    if (!firstPollDone) { firstPollDone = true; statusEl.textContent = "A ler comentários…"; }
  } catch (e) {
    console.error("Polling error", e);
    statusEl.textContent = "Sem ligação ao servidor";
  }
}

function startPolling() {
  if (pollingTimer) return;
  firstPollDone = false;
  pollOnce();
  pollingTimer = setInterval(pollOnce, 1000);
}

function stopPolling() {
  if (!pollingTimer) return;
  clearInterval(pollingTimer);
  pollingTimer = null;
}

// Init
(function init() {
  seen = new Set();
  if (wsUrl) connectWS();
  else startPolling();

  // keep seen bounded
  setInterval(() => {
    if (seen.size > 1000) {
      const keep = Array.from(seen).slice(-300);
      seen = new Set(keep);
    }
  }, 60_000);
})();
