// المتغيرات العامة
let currentChatId = null;
let replyToMsgId = null;
let unreadChats = new Set();
const socket = io();
const notifSound = new Audio("https://assets.mixkit.co/active_storage/sfx/2869/2869-preview.mp3");

// --- Theme Logic ---
function toggleTheme() {
  const body = document.body;
  const current = body.getAttribute("data-theme");
  const next = current === "dark" ? "light" : "dark";
  body.setAttribute("data-theme", next);
  localStorage.setItem("theme", next);

  document.getElementById("theme-btn").textContent = next === "dark" ? "☀️" : "🌙";

  const picker = document.querySelector("emoji-picker");
  if (picker) {
    picker.classList.toggle("dark", next === "dark");
    picker.classList.toggle("light", next === "light");
  }
}

const savedTheme = localStorage.getItem("theme") || "light";
document.body.setAttribute("data-theme", savedTheme);
document.getElementById("theme-btn").textContent = savedTheme === "dark" ? "☀️" : "🌙";

// --- Emoji Logic ---
const emojiBtn = document.getElementById("emoji-btn");
const emojiPicker = document.querySelector("emoji-picker");
const textArea = document.getElementById("text");

if (emojiBtn) {
  emojiBtn.onclick = (e) => {
    e.stopPropagation();
    const isVisible = emojiPicker.style.display === "block";
    emojiPicker.style.display = isVisible ? "none" : "block";
  };

  emojiPicker.addEventListener("emoji-click", (event) => {
    textArea.value += event.detail.unicode;
    textArea.focus();
    // Trigger auto-resize logic manually if needed
    textArea.dispatchEvent(new Event('input'));
  });

  document.body.addEventListener("click", () => {
    emojiPicker.style.display = "none";
  });

  emojiPicker.addEventListener("click", (e) => e.stopPropagation());
}

// --- Search Logic ---
const searchInput = document.getElementById("search-input");
if (searchInput) {
  searchInput.addEventListener("input", function(e) {
    const val = e.target.value.toLowerCase();
    const items = document.querySelectorAll(".chatItem");
    items.forEach((item) => {
      const name = item.querySelector(".chatName").innerText.toLowerCase();
      const msg = item.querySelector(".chatMsg").innerText.toLowerCase();
      item.style.display = name.includes(val) || msg.includes(val) ? "flex" : "none";
    });
  });
}

// --- Login System ---
async function checkAuth() {
  try {
    const r = await fetch("/api/checkAuth");
    const d = await r.json();
    if (d.authenticated) {
      document.getElementById("login-overlay").style.display = "none";
      loadChats();
    }
  } catch (e) { console.log(e); }
}

async function doLogin() {
  const p = document.getElementById("pass-input").value;
  const r = await fetch("/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: p }),
  });
  const d = await r.json();
  if (d.success) {
    document.getElementById("login-overlay").style.display = "none";
    loadChats();
  } else {
    alert("Wrong password!");
  }
}

// Allow Enter key to login
const passInput = document.getElementById("pass-input");
if (passInput) {
  passInput.addEventListener("keypress", (e) => {
    if (e.key === "Enter") {
      doLogin();
    }
  });
}

checkAuth();

// --- Chat Logic ---
async function loadChats() {
  try {
    const r = await fetch("/api/chats");
    if (r.status === 401) return location.reload();
    const chats = await r.json();
    const list = document.getElementById("chat-list");
    list.innerHTML = "";
    const sortedIds = Object.keys(chats).sort((a, b) => chats[b].ts - chats[a].ts);

    for (let id of sortedIds) {
      const c = chats[id];
      const div = document.createElement("div");
      div.className = "chatItem";
      if (id === currentChatId) div.classList.add("active");
      if (unreadChats.has(id) && id !== currentChatId) div.classList.add("has-unread");

      let fullName = (c.first_name + " " + (c.last_name || "")).trim() || (c.username ? "@" + c.username : `User ${id}`);

      div.innerHTML = `
              <div class="chatInfo" onclick="openChat('${id}')">
                <div class="chatName">${fullName} <div class="unread-dot"></div></div>
                <div class="chatMsg">${c.last_message || ""}</div>
              </div>
              <div class="actions">
                <div class="actionBtn" onclick="showUserInfo('${id}')" title="User Info">ℹ️</div>
                <div class="actionBtn deleteBtn" onclick="deleteChat('${id}', event)" title="Delete Chat">🗑️</div>
              </div>
            `;
      list.appendChild(div);
    }
  } catch (e) {
    console.log(e);
  }
}

async function openChat(chatId) {
  currentChatId = chatId;
  unreadChats.delete(chatId);
  closeReply();
  loadChats();
  const r = await fetch("/api/messages/" + chatId);
  const msgs = await r.json();
  renderMessages(msgs);

  // Auto-close sidebar on mobile after selecting chat
  if (window.innerWidth < 768) {
    document.getElementById("sidebar").classList.add("closed");
    // Ensure button resets position
    document.getElementById("menu-toggle").classList.remove("shifted");
  }
}

function renderMessages(msgsObj) {
  const panel = document.getElementById("chat-area");
  panel.innerHTML = "";
  if (!msgsObj) return;
  const ids = Object.keys(msgsObj).sort((a, b) => a - b);
  for (let mid of ids) {
    const mWrapper = msgsObj[mid];
    const m = mWrapper.message || mWrapper;
    appendMessageToUI(m);
  }
  panel.scrollTop = panel.scrollHeight;
}

function formatTime(timestamp) {
  if (!timestamp) return "";
  const date = new Date(timestamp < 10000000000 ? timestamp * 1000 : timestamp);
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function appendMessageToUI(msg) {
  const panel = document.getElementById("chat-area");
  let div = document.getElementById(`msg-${msg.message_id}`);
  if (!div) {
    div = document.createElement("div");
    div.id = `msg-${msg.message_id}`;
    panel.appendChild(div);
  }

  const isSelf = msg.from?.is_site === true;
  div.className = isSelf ? "msg self" : "msg user";
  div.ondblclick = () => startReply(msg.message_id, isSelf ? "You" : "User");

  let contentHtml = "";

  let actionsHtml = `<div class="msg-actions">`;
  if (isSelf && msg.text) {
    actionsHtml += `<div class="act-btn" onclick="editMsg(${msg.message_id}, '${(msg.text || "").replace(/'/g, "\\'")}')">✏️</div>`;
  }
  actionsHtml += `<div class="act-btn del" onclick="deleteMsg(${msg.message_id})">🗑️</div>`;
  actionsHtml += `</div>`;
  contentHtml += actionsHtml;

  if (msg.reply_to_message) {
    const rply = msg.reply_to_message;
    const rText = rply.text || "[Media]";
    const rName = rply.from.is_site ? "You" : rply.from.first_name;
    contentHtml += `<div class="reply-info">Replying to ${rName}: ${rText.substring(0, 20)}...</div>`;
  }

  if (msg.text) contentHtml += `<div id="txt-${msg.message_id}">${msg.text}</div>`;
  else if (msg.caption) contentHtml += `<div style="margin-bottom:5px">${msg.caption}</div>`;

  if (msg.photo) {
    const photo = msg.photo[msg.photo.length - 1];
    contentHtml += `<img src="/api/proxyFile/${photo.file_id}" onclick="window.open(this.src)" alt="Image">`;
  }

  if (msg.voice || msg.audio) {
    const fid = msg.voice ? msg.voice.file_id : msg.audio.file_id;
    contentHtml += `<audio controls src="/api/proxyFile/${fid}"></audio>`;
  }

  if (msg.document) {
    const fileName = encodeURIComponent(msg.document.file_name || "document.pdf");
    const fileUrl = `/api/proxyFile/${msg.document.file_id}?name=${fileName}`;
    contentHtml += `
            <div class="document-preview">
              <span class="document-icon">📄</span>
              <div class="document-info">
                <div class="document-name">${msg.document.file_name || "Document"}</div>
                <a href="${fileUrl}" target="_blank" class="document-link">Download / View</a>
              </div>
            </div>`;
  }

  contentHtml += `<div class="msg-time">${formatTime(msg.date)}</div>`;
  div.innerHTML = `<div class="msg-content">${contentHtml}</div>`;

  if (!document.getElementById(`msg-${msg.message_id}`)) {
    panel.scrollTop = panel.scrollHeight;
  }
}

function startReply(msgId, name) {
  replyToMsgId = msgId;
  document.getElementById("reply-bar").style.display = "flex";
  document.getElementById("reply-to-name").innerText = name;
  document.getElementById("text").focus();
}

function closeReply() {
  replyToMsgId = null;
  document.getElementById("reply-bar").style.display = "none";
}

document.getElementById("close-reply").onclick = closeReply;

let typingTimer;
document.getElementById("text").addEventListener("input", () => {
  if (!currentChatId) return;
  socket.emit("typing", currentChatId);
  clearTimeout(typingTimer);

  // Auto-resize textarea
  textArea.style.height = "auto";
  textArea.style.height = Math.min(textArea.scrollHeight, 120) + "px";
});

document.getElementById("send").onclick = async () => {
  if (!currentChatId) return alert("Select chat first");
  const text = document.getElementById("text").value.trim();
  if (!text) return;
  document.getElementById("text").value = "";
  textArea.style.height = "auto";

  const payload = { chat_id: currentChatId, text };
  if (replyToMsgId) payload.reply_to_message_id = replyToMsgId;
  closeReply();
  await fetch("/api/sendText", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
};

document.getElementById("file-input").onchange = async function() {
  if (!currentChatId) return;
  const formData = new FormData();
  formData.append("chat_id", currentChatId);
  formData.append("file", this.files[0]);
  if (replyToMsgId) formData.append("reply_to_message_id", replyToMsgId);
  closeReply();
  try {
    await fetch("/api/sendFile", { method: "POST", body: formData });
  } catch (e) {
    alert("Error");
  }
  this.value = "";
};

// --- Socket Events ---
socket.on("update", (data) => {
  if (data.chatId == currentChatId) {
    appendMessageToUI(data.message.message);
  } else {
    unreadChats.add(data.chatId);
    notifSound.play().catch((e) => console.log("Sound blocked"));
    loadChats();
  }
});

socket.on("message_deleted", (data) => {
  if (data.chat_id == currentChatId) {
    const el = document.getElementById(`msg-${data.message_id}`);
    if (el) el.remove();
  }
});

socket.on("message_edited", (data) => {
  if (data.chat_id == currentChatId) {
    const txtEl = document.getElementById(`txt-${data.message_id}`);
    if (txtEl) {
      txtEl.innerText = data.text;
      const btn = txtEl.closest(".msg").querySelector(".act-btn");
      if (btn)
        btn.setAttribute(
          "onclick",
          `editMsg(${data.message_id}, '${data.text.replace(/'/g, "\\'")}')`,
        );
    }
  }
});

socket.on("delete_chat", (data) => {
  if (data.chatId == currentChatId) {
    document.getElementById("chat-area").innerHTML = "";
    currentChatId = null;
  }
  loadChats();
});

// --- Action Functions ---
async function deleteMsg(msgId) {
  if (!confirm("Delete this message?")) return;
  await fetch("/api/deleteMessage", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: currentChatId, message_id: msgId }),
  });
  const el = document.getElementById(`msg-${msgId}`);
  if (el) el.remove();
}

async function editMsg(msgId, oldText) {
  const newText = prompt("Edit your message:", oldText);
  if (newText === null || newText === oldText) return;
  await fetch("/api/editMessage", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: currentChatId,
      message_id: msgId,
      text: newText,
    }),
  });
}

async function deleteChat(chatId, event) {
  event.stopPropagation();
  if (!confirm("Delete chat?")) return;
  await fetch("/api/deleteChat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chatId }),
  });
}

async function showUserInfo(chatId) {
  const r = await fetch("/api/user/" + chatId);
  const data = await r.json();
  alert(JSON.stringify(data, null, 2));
}

// --- AI Logic ---
async function toggleAI() {
  try {
    const r = await fetch("/api/toggleAI", { method: "POST" });
    const data = await r.json();
    updateAIUI(data.status);
  } catch (e) {
    console.error("Failed to toggle AI");
  }
}

function updateAIUI(isActive) {
  const btn = document.getElementById("ai-btn");
  if (!btn) return;
  const txt = btn.querySelector("span:last-child");
  if (isActive) {
    btn.classList.add("active");
    txt.innerText = "AI Active";
  } else {
    btn.classList.remove("active");
    txt.innerText = "AI Off";
  }
}

(async () => {
  try {
    const r = await fetch("/api/getAIStatus");
    const data = await r.json();
    updateAIUI(data.status);
  } catch (e) {}
})();

// --- Broadcast Logic ---
function openBroadcastModal() {
  document.getElementById("broadcast-modal").style.display = "flex";
  document.getElementById("broadcast-text").focus();
}

function closeBroadcastModal() {
  document.getElementById("broadcast-modal").style.display = "none";
  document.getElementById("broadcast-text").value = "";
}

async function sendBroadcast() {
  const text = document.getElementById("broadcast-text").value.trim();
  if (!text) return alert("Please write a message first!");

  if (!confirm("Are you sure you want to send this to ALL users?"))
    return;

  const btn = document.querySelector(".btn-confirm");
  const originalText = btn.innerText;
  btn.innerText = "Sending...";
  btn.disabled = true;

  try {
    const r = await fetch("/api/broadcast", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    const data = await r.json();
    alert(`Done! Sent to ${data.count} users successfully.`);
    closeBroadcastModal();
  } catch (e) {
    alert("Error sending broadcast");
  } finally {
    btn.innerText = originalText;
    btn.disabled = false;
  }
}

window.onclick = function(event) {
  const modal = document.getElementById("broadcast-modal");
  if (event.target == modal) {
    closeBroadcastModal();
  }
};

// --- Keyboard Shortcuts ---
const txtInput = document.getElementById("text");

if (txtInput) {
  txtInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (txtInput.value.trim().length > 0) {
        document.getElementById("send").click();
      }
    }
  });
}

document.addEventListener("keydown", (e) => {
  const active = document.activeElement;

  if (e.key === "Tab") {
    e.preventDefault();
    if (txtInput) txtInput.focus();
  }

  if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
    if (active.tagName !== "INPUT" && active.tagName !== "TEXTAREA") {
      if (txtInput) txtInput.focus();
    }
  }
});

// --- Sidebar Toggle Logic (Smart Button) ---
function toggleSidebar() {
  const sidebar = document.getElementById("sidebar");
  const btn = document.getElementById("menu-toggle");

  sidebar.classList.toggle("closed");

  // لو السايد بار مش مقفول (يعني مفتوح) -> زحزح الزرار
  if (!sidebar.classList.contains("closed")) {
    btn.classList.add("shifted");
  } else {
    btn.classList.remove("shifted");
  }
}

// تشغيل الكود مرة واحدة عند فتح الموقع لضبط مكان الزرار
document.addEventListener("DOMContentLoaded", () => {
  const sidebar = document.getElementById("sidebar");
  const btn = document.getElementById("menu-toggle");
  // لو الشاشة كبيرة (كمبيوتر) والسايد بار مفتوح، حرك الزرار
  if (window.innerWidth >= 768 && sidebar && !sidebar.classList.contains("closed")) {
    if (btn) btn.classList.add("shifted");
  }
});

// Auto-close sidebar overlay on window resize
window.addEventListener("resize", () => {
  if (window.innerWidth >= 768) {
    document.getElementById("sidebar").classList.remove("closed");
  }
});