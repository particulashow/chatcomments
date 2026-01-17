const params = new URLSearchParams(window.location.search);
const domain = params.get("domain") || "http://localhost:3900";

const statusEl = document.getElementById("status");
const messagesEl = document.getElementById("messages");

let lastWords = [];

// Normalizar texto
function norm(s){
  return (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

// Adicionar mensagem à barra lateral
function addMessage(text){
  const div = document.createElement("div");
  div.className = "msg";
  div.textContent = text;

  messagesEl.appendChild(div);

  // Limitar a 12 mensagens
  if (messagesEl.children.length > 12){
    messagesEl.removeChild(messagesEl.firstChild);
  }
}

// Ler wordcloud
async function fetchData(){
  try{
    const res = await fetch(`${domain}/wordcloud`, { cache: "no-store" });
    const data = await res.json();

    const arr = (data.wordcloud || "")
      .split(",")
      .map(norm)
      .filter(Boolean);

    // Encontrar novas palavras
    const newWords = arr.filter(w => !lastWords.includes(w));

    newWords.forEach(addMessage);

    lastWords = arr;

    if (statusEl.textContent.startsWith("A ligar")){
      statusEl.textContent = "A ler comentários…";
    }

  } catch(e){
    statusEl.textContent = "Sem ligação ao servidor";
  }
}

setInterval(fetchData, 1000);
