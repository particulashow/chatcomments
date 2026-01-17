// Comments Overlay (WebSocket first, fallback polling)
// Uso: ?ws=ws://host:PORT&channel=nome  ou  ?domain=http://localhost:3900
// Parâmetros opcionais: lifetime (ms), warmup (ms)

const params = new URLSearchParams(window.location.search);
const wsUrl = params.get("ws") || null;           // ex: ws://localhost:PORT ou wss://host:PORT
const channel = params.get("channel") || "default";
const domain = params.get("domain") || "http://localhost:3900"; // fallback polling
const commentLifetime = parseInt(params.get("lifetime") || "10000", 10); // ms
const warmupMs = parseInt(params.get("warmup") || "800", 10); // ms to ignore backlog

const container = document.getElementById("comments-container");
const statusEl = document.getElementById("status");

// --- UI functions (keeps original simple API) ---
function addComment(text) {
  const commentElement = document.createElement("div");
  commentElement.textContent = text;
  commentElement.className = "comment";

  container.appendChild(commentElement);

  setTimeout(() => {
    commentElement.style.animation = "slideOut 420ms ease forwards";
    setTimeout(() => commentElement.remove(), 420);
  }, commentLifetime);
}

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

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// --- Parser flexible ---
function parseIncoming(raw) {
  if (raw === null || raw === undefined) return null;

  // object
  if (typeof raw === "object" && raw !== null) {
    const name = raw.username || raw.user || raw.name || raw.displayName || raw.nick || null;
    const avatar = raw.avatar || raw.avatarUrl || raw.picture || null;
    const text = raw.text || raw.message || raw.msg || raw.body || raw.content || null;
    const id = raw.id || raw.messageId || raw.msgId || null;
    const ts = raw.timestamp || raw.time || raw.created_at || null;
    if (text) return { name, avatar, text, id, ts };
  }

  // string
  if (typeof raw === "string") {
    // try JSON
    try {
      const obj = JSON.parse(raw);
      return parseIncoming(obj);
    } catch (e) {
      const pipe = raw.split("|").map(s => s.trim());
      if (pipe.length >= 3) {
        return { name: pipe[0], avatar: pipe[1], text: pipe.slice(2).join("|") };
      }
      const colon = raw.indexOf(":");
      if (colon > 0) {
        return { name: raw.slice(0, colon).trim(), avatar: null, text: raw.slice(colon + 1).trim() };
      }
      return { name: null, avatar: null, text: raw.trim() };
    }
  }

  return null;
}

// --- State and helpers to show only new messages ---
let ws = null;
let reconnectTimer = null;
let pollingTimer = null;
let seen = new Set();
let warmup = true;
let warmupTimer = null;

function messageKey(parsed) {
  if (!parsed) return null;
  if (parsed.id) return String(parsed.id);
  // limit length to avoid huge keys
  return `${(parsed.name||"")}|${(parsed.text||"")}`.slice(0, 300);
}

function addFromParsed(parsed) {
  if (!parsed || !parsed.text) return;
  const key = messageKey(parsed);
  if (!key) return;

  if (seen.has(key)) return;

  // during warmup we only mark as seen, do not display
  if (warmup) {
    seen.add(key);
    return;
  }

  seen.add(key);
  if (parsed.name || parsed.avatar) addCommentRich(parsed);
  else addComment(parsed.text);
}

// --- WebSocket with warmup to ignore backlog ---
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
