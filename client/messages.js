// === Inject chat panel HTML once and wire up navbar toggle ===
(function ensureChatUI() {
  if (!document.getElementById('chat-panel')) {
    const chatHTML = `
      <div id="chat-panel" class="chat-panel">
        <div class="chat-header">
          <h5>Messages</h5>
          <button id="close-chat" class="btn-close" aria-label="Close"></button>
        </div>
        <div class="chat-body">
          <aside class="chat-sidebar">
            <div class="chat-sidebar-header">
              <h5 id="new-chat-header"></h5>
              <input type="text" id="chat-search" placeholder="Search users..." />
            </div>
            <div class="chat-lists">
              <h6 class="chat-section-title">Managers</h6>
              <ul id="chat-managers" class="chat-list"></ul>
              <h6 class="chat-section-title">Bidders</h6>
              <ul id="chat-bidders" class="chat-list"></ul>
            </div>
          </aside>
          <main class="chat-main">
            <div id="chat-home" class="chat-home">
              <h4>Your Conversations</h4>
              <ul id="chat-home-list"></ul>
            </div>
            <div id="chat-thread" class="chat-thread hidden">
              <div id="chat-thread-header" class="chat-thread-header">
                <button id="chat-back-btn">← Back</button>
                <span id="chat-thread-title">Select a conversation</span>
              </div>
              <div id="messages-container" class="chat-messages"></div>
              <div class="chat-input">
                <input type="text" id="chat-message-input" placeholder="Type a message..." />
                <button id="send-chat-btn" class="btn btn-primary btn-sm">Send</button>
              </div>
            </div>
          </main>
        </div>
      </div>`;
    document.body.insertAdjacentHTML('beforeend', chatHTML);
  }

  // Wire up toggle buttons if present
  const messagesBtn = document.getElementById('messages-btn');
  const chatPanel = document.getElementById('chat-panel');
  const closeChatBtn = document.getElementById('close-chat');
  const sendChatBtn = document.getElementById('send-chat-btn');
  const chatInput = document.getElementById('chat-message-input');

  if (closeChatBtn) {
    closeChatBtn.addEventListener('click', () => chatPanel.classList.remove('open'));
  }

  // Load managers & bidders when panel opens
  async function initChatPanel() {
    const me = await authGet("/users/me");
    window.__me = me; // cache
    await Promise.all([loadManagers(me.id), loadBidders(me.id)]);
  }
})();


// === Global Messaging Setup with Socket.IO and BroadcastChannel ===

// Setup BroadcastChannel for multi-tab sync
const chatChannel = new BroadcastChannel("chat_sync");
chatChannel.onmessage = (e) => {
  if (e.data.type === "new_message") {
    renderMessage(e.data.message);
  }
};

// Ensure a single persistent global socket connection
if (!window.socket) {
  window.socket = io(window.apiBase, {
    auth: { token: localStorage.getItem("token") },
    transports: ["websocket"],
  });

  window.socket.on("connect", () => {
    console.log("✅ Connected to global messaging:", window.socket.id);
  });

  window.socket.on("disconnect", () => {
    console.warn("⚠️ Disconnected from messaging");
  });

  // Listen for incoming messages
  window.socket.on("receive_message", (msg) => {
    console.log("📩 New message received:", msg);
    renderMessage(msg);
    // Sync across tabs
    chatChannel.postMessage({ type: "new_message", message: msg });
  });
}

// === Chat Panel Data Functions ===
async function authGet(url) {
  const res = await fetch(url, { headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }});
  if (!res.ok) throw new Error(`GET ${url} failed`);
  return res.json();
}

// Removed loadRecent()

async function loadManagers(myId) {
  const users = await authGet('/users');
  const ul = document.getElementById('chat-managers');
  if (!ul) return;
  ul.innerHTML = '';
  // Filter managers and remove duplicates by user ID
  const seen = new Set();
  const managers = users.filter(u => u.role === 'manager' && u.id !== myId && !seen.has(u.id) && seen.add(u.id));

  // Fetch latest message timestamps
  const latest = await authGet('/messages/latest');
  const sorted = managers.sort((a, b) => {
    const aTime = latest[a.id] ? new Date(latest[a.id]) : 0;
    const bTime = latest[b.id] ? new Date(latest[b.id]) : 0;
    return bTime - aTime;
  });

  sorted.forEach(u => {
    const li = document.createElement('li');
    li.className = 'chat-list-item';
    li.dataset.userId = u.id;
    li.innerHTML = `<div class="chat-list-name">${(u.first_name||'') + ' ' + (u.last_name||'')}</div><div class="chat-list-sub">${u.email || ''}</div>`;
    li.addEventListener('click', () => openThread(u.id, (u.first_name||'') + ' ' + (u.last_name||'')));
    ul.appendChild(li);
  });
}

async function loadBidders(myId) {
  const users = await authGet('/users');
  const ul = document.getElementById('chat-bidders');
  if (!ul) return;
  ul.innerHTML = '';
  // Filter bidders and remove duplicates by user ID
  const seen = new Set();
  const bidders = users.filter(u => u.role === 'bidder' && u.id !== myId && !seen.has(u.id) && seen.add(u.id));

  const latest = await authGet('/messages/latest');
  const sorted = bidders.sort((a, b) => {
    const aTime = latest[a.id] ? new Date(latest[a.id]) : 0;
    const bTime = latest[b.id] ? new Date(latest[b.id]) : 0;
    return bTime - aTime;
  });

  sorted.forEach(u => {
    const li = document.createElement('li');
    li.className = 'chat-list-item';
    li.dataset.userId = u.id;
    li.innerHTML = `<div class="chat-list-name">${(u.first_name||'') + ' ' + (u.last_name||'')}</div><div class="chat-list-sub">${u.email || ''}</div>`;
    li.addEventListener('click', () => openThread(u.id, (u.first_name||'') + ' ' + (u.last_name||'')));
    ul.appendChild(li);
  });
}

async function openThread(otherUserId, displayName) {
  window.__currentChatUserId = otherUserId;
  const headerTitle = document.getElementById('chat-thread-title');
  if (headerTitle) headerTitle.textContent = displayName || 'Conversation';
  const msgs = await authGet(`/messages/${otherUserId}`);
  const container = document.getElementById('messages-container');
  if (!container) return;
  container.innerHTML = '';
  msgs.forEach(renderMessage);
  container.scrollTop = container.scrollHeight;
}

async function loadHomeChats(myId) {
  try {
    const latest = await authGet('/messages/latest');
    const users = await authGet('/users');
    const list = document.getElementById('chat-home-list');
    if (!list) return;
    list.innerHTML = '';
    const chats = Object.entries(latest)
      .map(([uid, time]) => ({ uid: parseInt(uid), time: new Date(time) }))
      .sort((a, b) => b.time - a.time);
    for (const c of chats) {
      const u = users.find(x => x.id === c.uid);
      if (!u) continue;
      const li = document.createElement('li');
      li.className = 'chat-home-item';
      const messages = await authGet(`/messages/${u.id}`);
      const lastMsg = messages[messages.length - 1];
      const preview = lastMsg ? lastMsg.content.slice(0, 40) + (lastMsg.content.length > 40 ? '…' : '') : '';
      li.innerHTML = `
        <div class="chat-home-name">${u.first_name || ''} ${u.last_name || ''}</div>
        <div class="chat-home-preview">${preview}</div>
        <div class="chat-home-meta">${c.time.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}</div>
      `;
      li.addEventListener('click', () => {
        document.getElementById('chat-home').classList.add('hidden');
        document.getElementById('chat-thread').classList.remove('hidden');
        document.getElementById('chat-thread-title').textContent = (u.first_name || '') + ' ' + (u.last_name || '');
        openThread(u.id, (u.first_name || '') + ' ' + (u.last_name || ''));
      });
      list.appendChild(li);
    }
  } catch (err) {
    console.error('Error loading home chats:', err);
  }
}

document.addEventListener('click', (e) => {
  const back = e.target.closest('#chat-back-btn');
  if (back) {
    document.getElementById('chat-thread').classList.add('hidden');
    document.getElementById('chat-home').classList.remove('hidden');
  }
});

// Override send handler to respect selected recipient
const sendBtn = document.getElementById('send-chat-btn');
const inputEl = document.getElementById('chat-message-input');
if (sendBtn && inputEl) {
  sendBtn.onclick = async () => {
    const toId = window.__currentChatUserId;
    const content = inputEl.value.trim();
    if (!toId) { alert('Select a recipient first.'); return; }
    if (!content) return;
    // Emit via socket (server persists)
    window.socket.emit('send_message', { toUserId: toId, content });
    inputEl.value = '';
    inputEl.focus();
  };
}

function getCurrentUserId() {
  const token = localStorage.getItem("token");
  if (!token) return null;
  try {
    const payload = JSON.parse(atob(token.split(".")[1]));
    return payload.id;
  } catch {
    return null;
  }
}

function renderMessage(msg) {
  const container = document.getElementById("messages-container");
  if (!container) return;

  const meId = getCurrentUserId();
  const fromId = msg.sender_id ?? msg.fromUserId;
  const when = msg.created_at ? new Date(msg.created_at) : (msg.timestamp ? new Date(msg.timestamp) : new Date());

  const msgDiv = document.createElement("div");
  msgDiv.className = fromId === meId ? "message sent" : "message received";
  msgDiv.innerHTML = `
    <div class="message-content">${msg.content}</div>
    <div class="message-meta">${when.toLocaleTimeString()}</div>
  `;
  container.appendChild(msgDiv);
}

// Fallback delegated listener for navbar message button across all pages
document.addEventListener('click', (e) => {
  const btn = e.target.closest('#messages-btn');
  if (!btn) return;
  const panel = document.getElementById('chat-panel');
  if (panel) {
    panel.classList.add('open');
    // Lazy-init when opened from any page
    (async () => {
      try {
        const me = window.__me || await authGet('/users/me');
        window.__me = me;
        await Promise.all([loadManagers(me.id), loadBidders(me.id), loadHomeChats(me.id)]);
      } catch (err) {
        console.warn('chat init failed', err);
      }
    })();
  }
});