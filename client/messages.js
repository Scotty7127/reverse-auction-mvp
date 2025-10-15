// messages.js
const socket = io("http://localhost:4000");
let currentUser = null;
let activeChat = null;
let users = [];
let recentChats = new Set();

async function loadCurrentUser() {
  const res = await authFetch("/users/me");
  currentUser = await res.json();
  socket.emit("join_user", currentUser.id);
}

async function loadUsers() {
  const res = await authFetch("/users");
  users = await res.json();
}

async function loadRecentChats() {
  // For demo, assume server provides recent chats for current user
  const res = await authFetch(`/users/${currentUser.id}/recent_chats`);
  const recent = await res.json();
  recentChats = new Set(recent.map(u => u.id));
}

function createChatUI() {
  if (document.getElementById("chatPanel")) return;
  const panel = document.createElement("div");
  panel.id = "chatPanel";
  panel.style = `
    position: fixed;
    top: 0;
    right: -400px;
    width: 400px;
    height: 100vh;
    background: #f9fafc;
    border-left: 3px solid #0078d4;
    box-shadow: -4px 0 15px rgba(0,0,0,0.2);
    z-index: 999999;
    display: flex;
    transition: right 0.35s cubic-bezier(.4,0,.2,1);
    font-family: Arial, sans-serif;
  `;

  // Left column: user list
  const leftCol = document.createElement("div");
  leftCol.id = "chatUserList";
  leftCol.style = `
    width: 40%;
    border-right: 1px solid #ddd;
    display: flex;
    flex-direction: column;
    overflow-y: auto;
    padding: 16px 12px;
  `;

  // Right column: chat window
  const rightCol = document.createElement("div");
  rightCol.id = "chatWindow";
  rightCol.style = `
    width: 60%;
    display: flex;
    flex-direction: column;
    height: 100%;
    padding: 16px 12px;
  `;

  // Build user lists inside leftCol
  leftCol.innerHTML = `
    <div style="font-weight:bold; margin-bottom:8px;">Recent Conversations</div>
    <div id="recentList" style="flex-grow:1; overflow-y:auto; margin-bottom:16px;"></div>
    <div style="font-weight:bold; margin-bottom:8px;">New Chat</div>
    <div id="newChatList" style="flex-grow:1; overflow-y:auto;"></div>
  `;

  // Build chat window inside rightCol
  rightCol.innerHTML = `
    <div id="chatHeader" style="font-weight:bold; margin-bottom:12px; border-bottom:1px solid #ddd; padding-bottom:8px;">Select a chat</div>
    <div id="chatMessages" style="flex-grow:1; overflow-y:auto; margin-bottom:12px;"></div>
    <div style="display:flex; gap:8px;">
      <input id="chatInput" type="text" placeholder="Type a message..." style="flex:1; min-width:0; padding:6px 8px; font-size:14px;">
      <button id="chatSend" style="padding:6px 12px; font-size:14px;">Send</button>
    </div>
  `;

  panel.appendChild(leftCol);
  panel.appendChild(rightCol);
  document.body.appendChild(panel);

  document.getElementById("chatSend").addEventListener("click", sendMessage);
  document.getElementById("chatInput").addEventListener("keydown", e => {
    if (e.key === "Enter") sendMessage();
  });
}

function renderUserLists() {
  const recentListDiv = document.getElementById("recentList");
  const newChatListDiv = document.getElementById("newChatList");
  if (!recentListDiv || !newChatListDiv) return;

  recentListDiv.innerHTML = "";
  newChatListDiv.innerHTML = "";

  // Recent chats users (exclude self)
  const recentUsers = users.filter(u => recentChats.has(u.id) && u.id !== currentUser.id);
  // New chat users (exclude self and recent)
  const newUsers = users.filter(u => !recentChats.has(u.id) && u.id !== currentUser.id);

  const createUserItem = (user) => {
    const div = document.createElement("div");
    div.textContent = user.name || `User ${user.id}`;
    div.style = `
      padding: 8px 6px;
      cursor: pointer;
      border-radius: 4px;
    `;
    if (activeChat === user.id) {
      div.style.backgroundColor = "#e0e0e0";
      div.style.fontWeight = "bold";
    }
    div.addEventListener("click", () => {
      if (activeChat !== user.id) {
        activeChat = user.id;
        updateChatHeader();
        clearMessages();
        loadConversation(user.id);
        renderUserLists();
      }
    });
    div.addEventListener("mouseover", () => div.style.backgroundColor = "#f0f0f0");
    div.addEventListener("mouseout", () => {
      if (activeChat === user.id) {
        div.style.backgroundColor = "#e0e0e0";
      } else {
        div.style.backgroundColor = "transparent";
      }
    });
    return div;
  };

  recentUsers.forEach(u => recentListDiv.appendChild(createUserItem(u)));
  newUsers.forEach(u => newChatListDiv.appendChild(createUserItem(u)));
}

async function loadConversation(userId) {
  // For demo, assume server provides messages between currentUser and userId
  const res = await authFetch(`/messages?user1=${currentUser.id}&user2=${userId}`);
  const messages = await res.json();
  messages.forEach(msg => {
    const senderName = msg.sender_id === currentUser.id ? "You" : (users.find(u => u.id === msg.sender_id)?.name || "Them");
    addMessage(senderName, msg.content);
  });
}

function updateChatHeader() {
  const header = document.getElementById("chatHeader");
  if (!header) return;
  if (!activeChat) {
    header.textContent = "Select a chat";
  } else {
    const user = users.find(u => u.id === activeChat);
    header.textContent = user ? `Chat with ${user.name}` : "Chat";
  }
}

function clearMessages() {
  const chatMessages = document.getElementById("chatMessages");
  if (chatMessages) chatMessages.innerHTML = "";
}

async function sendMessage() {
  const input = document.getElementById("chatInput");
  if (!input) return;
  const content = input.value.trim();
  if (!content || !activeChat) return;

  socket.emit("send_message", {
    sender_id: currentUser.id,
    receiver_id: activeChat,
    content
  });

  addMessage("You", content);
  input.value = "";

  // If this user was "new", move to recent
  if (!recentChats.has(activeChat)) {
    recentChats.add(activeChat);
    renderUserLists();
  }
}

socket.on("receive_message", (msg) => {
  if (msg.sender_id === activeChat) {
    addMessage("Them", msg.content);
  } else if (msg.receiver_id === currentUser.id) {
    alert(`💬 New message from ${users.find(u => u.id === msg.sender_id)?.name || "Someone"}!`);
    // Add sender to recentChats if not present
    if (!recentChats.has(msg.sender_id)) {
      recentChats.add(msg.sender_id);
      renderUserLists();
    }
  }
});

function addMessage(sender, content) {
  const div = document.createElement("div");
  div.textContent = `${sender}: ${content}`;
  div.style = "margin-bottom:6px; word-wrap: break-word;";
  const chatMessages = document.getElementById("chatMessages");
  if (chatMessages) {
    chatMessages.appendChild(div);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }
}

(async () => {
  await loadCurrentUser();
  await loadUsers();
  await loadRecentChats();
  createChatUI();
  renderUserLists();

  const btn = document.getElementById("messages-btn");
  if (!btn) {
    console.error("Messages button not found!");
    return;
  }

  let panel = document.getElementById("chatPanel");
  let open = false;

  btn.addEventListener("click", () => {
    console.log("💬 Chat button clicked");
    if (!panel) {
      createChatUI();
      renderUserLists();
      panel = document.getElementById("chatPanel");
    }

    // Ensure panel is always on top and visible
    panel.style.display = "flex";
    panel.style.zIndex = "999999";
    panel.style.transition = "none";
    panel.offsetHeight; // force reflow

    open = !open;
    panel.style.transition = "right 0.35s ease-in-out";
    panel.style.right = open ? "0" : "-400px";

    console.log(`Chat panel ${open ? "opened" : "closed"}`);
  });

  // Close the chat panel when clicking outside
  document.addEventListener("click", (event) => {
    const panelElement = document.getElementById("chatPanel");
    if (open && panelElement && !panelElement.contains(event.target) && !btn.contains(event.target)) {
      panelElement.style.right = "-400px";
      open = false;
      console.log("Chat panel closed by clicking outside");
    }
  });
})();