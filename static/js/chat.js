/* ── State ─────────────────────────────────────────────── */
const socket = io({ transports: ["websocket"] });
let currentChannel  = null;
let allChannels     = [];
let ctxMessageId    = null;
let typingTimer     = null;
let oldestMsgId     = null;
let profileUserId   = null;
let profileBlocked  = false;

/* ── Init ──────────────────────────────────────────────── */
document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("myUsername").textContent = MY_USERNAME;
  document.getElementById("myAvatar").textContent   = MY_USERNAME[0].toUpperCase();
  loadChannels();
  document.addEventListener("click", () => {
    hideCtxMenu();
    document.getElementById("profilePopup").classList.add("d-none");
  });
});

/* ── Socket events ─────────────────────────────────────── */
socket.on("connect",      () => console.log("WS connected"));
socket.on("disconnect",   () => console.log("WS disconnected"));

socket.on("new_message", msg => {
  if (msg.channel_id === currentChannel?.id) appendMessage(msg);
  bumpChannelPreview(msg.channel_id, msg.content);
});

socket.on("message_updated", msg => {
  if (msg.channel_id !== currentChannel?.id) return;
  const el = document.querySelector(`[data-msg-id="${msg.id}"]`);
  if (!el) return;
  el.querySelector(".msg-content").textContent = msg.content;
  const editedSpan = el.querySelector(".msg-edited");
  if (editedSpan) editedSpan.textContent = "(изменено)";
  else el.querySelector(".msg-header")?.insertAdjacentHTML(
    "beforeend", '<span class="msg-edited">(изменено)</span>'
  );
  cancelEdit();
});

socket.on("message_deleted", data => {
  const el = document.querySelector(`[data-msg-id="${data.message_id}"]`);
  if (!el) return;
  if (data.mode === "all") {
    el.querySelector(".msg-content").innerHTML =
      '<span class="deleted">Сообщение удалено</span>';
    el.querySelector(".msg-actions")?.remove();
  } else {
    el.closest(".msg-group")?.remove();
  }
});

socket.on("user_status", ({ user_id, is_online }) => {
  document.querySelectorAll(`[data-uid="${user_id}"] .online-dot`).forEach(dot => {
    dot.classList.toggle("offline-dot", !is_online);
  });
});

// Invited to a channel
socket.on("channel_invite", ch => {
  if (!allChannels.find(c => c.id === ch.id)) {
    allChannels.unshift(ch);
    renderSidebar(allChannels);
  }
});

// New DM arrived while we're online
socket.on("new_dm", ch => {
  if (!allChannels.find(c => c.id === ch.id)) {
    allChannels.unshift({ ...ch });
    renderSidebar(allChannels);
  }
});

// Chat deleted by either party
socket.on("dm_deleted", ({ channel_id }) => {
  allChannels = allChannels.filter(c => c.id !== channel_id);
  renderSidebar(allChannels);
  if (currentChannel?.id === channel_id) {
    currentChannel = null;
    document.getElementById("chatView").classList.add("d-none");
    document.getElementById("welcomeScreen").classList.remove("d-none");
  }
});

socket.on("member_left", ({ channel_id, user_id }) => {
  if (channel_id !== currentChannel?.id) return;
  // Remove from members panel
  document.querySelector(`[data-uid="${user_id}"]`)?.remove();
  // Update count in header
  const meta = document.getElementById("chatMeta");
  const cur = parseInt(meta.textContent) || 0;
  if (cur > 0) meta.textContent = `${cur - 1} участников`;
});

socket.on("you_were_kicked", ({ channel_id }) => {
  allChannels = allChannels.filter(c => c.id !== channel_id);
  renderSidebar(allChannels);
  if (currentChannel?.id === channel_id) {
    currentChannel = null;
    document.getElementById("chatView").classList.add("d-none");
    document.getElementById("welcomeScreen").classList.remove("d-none");
    alert("Вы были исключены из канала.");
  }
});

socket.on("typing", ({ username }) => {
  const el = document.getElementById("typingIndicator");
  el.textContent = `${username} печатает...`;
  el.classList.remove("d-none");
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.classList.add("d-none"), 2500);
});

/* ── Channels ──────────────────────────────────────────── */
async function loadChannels() {
  const data = await api("/api/channels");
  allChannels = data;
  renderSidebar(data);
  const hash = location.hash.replace("#", "");
  if (hash) openChannel(parseInt(hash));
}

function renderSidebar(channels) {
  const chList = document.getElementById("channelList");
  const dmList = document.getElementById("dmList");
  chList.innerHTML = "";
  dmList.innerHTML = "";

  channels.forEach(ch => {
    const el = document.createElement("div");
    el.className = "channel-item" + (ch.id === currentChannel?.id ? " active" : "");
    el.dataset.chId = ch.id;
    el.onclick = () => openChannel(ch.id);

    const icon = ch.is_dm ? "bi-person-fill" : (ch.is_private ? "bi-lock-fill" : "bi-hash");
    el.innerHTML = `
      <i class="bi ${icon} flex-shrink-0" style="font-size:.8rem"></i>
      <div style="flex:1;min-width:0">
        <div style="font-size:.88rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(ch.name)}</div>
        <div class="ch-preview">${esc(ch.last_message || "")}</div>
      </div>`;

    (ch.is_dm ? dmList : chList).appendChild(el);
  });
}

function filterChannels(q) {
  q = q.toLowerCase();
  document.querySelectorAll(".channel-item").forEach(el => {
    el.style.display = el.textContent.toLowerCase().includes(q) ? "" : "none";
  });
}

function bumpChannelPreview(channelId, content) {
  const ch = allChannels.find(c => c.id === channelId);
  if (ch) { ch.last_message = content; ch.last_at = new Date().toISOString(); }
  allChannels.sort((a, b) => b.last_at.localeCompare(a.last_at));
  renderSidebar(allChannels);
}

/* ── Open channel ──────────────────────────────────────── */
async function openChannel(id) {
  if (currentChannel) socket.emit("leave", { channel_id: currentChannel.id });

  const data = await api(`/api/channels/${id}`);
  currentChannel = data;
  oldestMsgId = null;

  location.hash = id;
  socket.emit("join", { channel_id: id });

  document.getElementById("welcomeScreen").classList.add("d-none");
  document.getElementById("chatView").classList.remove("d-none");

  document.getElementById("chatName").textContent = data.name;
  document.getElementById("chatMeta").textContent =
    data.is_dm ? "" : `${data.member_count} участников`;
  document.getElementById("chatIcon").innerHTML =
    data.is_dm ? '<i class="bi bi-person-fill"></i>' :
    (data.is_private ? '<i class="bi bi-lock-fill"></i>' : '<i class="bi bi-hash"></i>');

  // Attach partner_id for DMs (from sidebar cache)
  const cached = allChannels.find(c => c.id === id);
  if (data.is_dm && cached?.partner_id) data.partner_id = cached.partner_id;
  currentChannel = data;

  renderChatActions(data);
  renderMembers(data.members || []);
  await loadMessages(id);

  document.querySelectorAll(".channel-item").forEach(el =>
    el.classList.toggle("active", parseInt(el.dataset.chId) === id)
  );
  document.getElementById("msgInput").focus();
}

async function renderChatActions(ch) {
  const wrap = document.getElementById("chatActions");
  wrap.innerHTML = "";

  const input = document.getElementById("msgInput");
  input.placeholder = "Написать сообщение...";
  input.disabled = false;

  if (ch.is_dm) {
    // Delete chat button always visible for DMs
    wrap.innerHTML = `
      <button class="btn-icon text-danger" title="Удалить переписку" onclick="deleteDm(${ch.id})">
        <i class="bi bi-trash"></i> <span style="font-size:.8rem">Удалить переписку</span>
      </button>`;

    // Check block status if we know the partner
    if (ch.partner_id) {
      const status = await api(`/api/users/${ch.partner_id}/block_status`).catch(() => null);
      if (status?.they_blocked) {
        input.placeholder = "Вы заблокированы";
        input.disabled = true;
      }
    }
    return;
  }

  const myRole = ch.my_role;
  if (myRole === "owner" || myRole === "admin") {
    wrap.innerHTML += `
      <button class="btn-icon" title="Пригласить" onclick="openInvite()">
        <i class="bi bi-person-plus"></i>
      </button>`;
  }
  if (myRole !== "owner") {
    wrap.innerHTML += `
      <button class="btn-icon text-danger" title="Выйти из канала" onclick="leaveChannel()">
        <i class="bi bi-door-open"></i>
      </button>`;
  }
  if (myRole === "owner") {
    wrap.innerHTML += `
      <button class="btn-icon text-danger" title="Удалить канал" onclick="deleteChannel()">
        <i class="bi bi-trash"></i>
      </button>`;
  }
}

function renderMembers(members) {
  const list = document.getElementById("membersList");
  list.innerHTML = "";
  members.forEach(m => {
    const isMe = m.id === ME;
    const canManage = currentChannel?.my_role === "owner" ||
      (currentChannel?.my_role === "admin" && m.role === "member");
    const isOwner = currentChannel?.owner_id === ME;

    const div = document.createElement("div");
    div.className = "member-item";
    div.dataset.uid = m.id;
    div.innerHTML = `
      <div class="online-dot ${m.is_online ? "" : "offline-dot"}"></div>
      <div class="avatar avatar-sm" style="cursor:pointer" onclick="showUserProfile(${m.id},'${esc(m.username)}',event)">${m.username[0].toUpperCase()}</div>
      <span style="font-size:.88rem;overflow:hidden;text-overflow:ellipsis">${esc(m.username)}</span>
      ${m.role !== "member" ? `<span class="member-role role-${m.role}">${m.role === "owner" ? "владелец" : "admin"}</span>` : ""}
      ${(!isMe && canManage) ? `
        <div class="member-actions">
          ${isOwner && m.role !== "owner" ? `
            <button class="btn-icon" title="${m.role === "admin" ? "Снять admin" : "Выдать admin"}"
              onclick="toggleAdmin(${m.id}, '${m.role}')">
              <i class="bi bi-shield-${m.role === "admin" ? "x" : "check"}"></i>
            </button>` : ""}
          <button class="btn-icon text-danger" title="Кикнуть" onclick="kickMember(${m.id})">
            <i class="bi bi-person-x"></i>
          </button>
        </div>` : ""}`;
    list.appendChild(div);
  });
}

/* ── Messages ──────────────────────────────────────────── */
async function loadMessages(channelId) {
  const area = document.getElementById("messagesList");
  area.innerHTML = "";
  const msgs = await api(`/api/channels/${channelId}/messages`);
  if (msgs.length) oldestMsgId = msgs[0].id;
  msgs.forEach(appendMessage);
  scrollBottom();
  document.getElementById("loadMoreBtn").style.display =
    msgs.length >= 50 ? "block" : "none";
}

async function loadMoreMessages() {
  if (!currentChannel || !oldestMsgId) return;
  const msgs = await api(`/api/channels/${currentChannel.id}/messages?before=${oldestMsgId}`);
  if (!msgs.length) return;
  oldestMsgId = msgs[0].id;
  const area = document.getElementById("messagesList");
  const prevH = area.scrollHeight;
  msgs.forEach(m => prependMessage(m));
  area.parentElement.scrollTop += area.scrollHeight - prevH;
}

function appendMessage(msg) {
  const area = document.getElementById("messagesList");
  area.appendChild(buildMessageEl(msg));
  scrollBottom();
}

function prependMessage(msg) {
  const area = document.getElementById("messagesList");
  area.insertBefore(buildMessageEl(msg), area.firstChild);
}

function buildMessageEl(msg) {
  const isMe = msg.sender_id === ME;
  const myRole = currentChannel?.my_role;
  const canDelAll = isMe || myRole === "owner" || myRole === "admin";
  const canEdit   = isMe && !msg.is_deleted;

  const div = document.createElement("div");
  div.className = "msg-group";
  div.dataset.msgId = msg.id;
  div.dataset.senderId = msg.sender_id;

  const time = new Date(msg.created_at).toLocaleTimeString("ru", { hour: "2-digit", minute: "2-digit" });
  const edited = msg.edited_at ? '<span class="msg-edited">(изменено)</span>' : "";
  const content = msg.is_deleted
    ? '<span class="deleted">Сообщение удалено</span>'
    : esc(msg.content);

  const actions = msg.is_deleted ? "" : `
    <div class="msg-actions">
      ${canEdit ? `<button class="btn-icon" title="Редактировать" onclick="openEdit(${msg.id})"><i class="bi bi-pencil"></i></button>` : ""}
      ${canDelAll ? `<button class="btn-icon text-danger" title="Удалить для всех" onclick="confirmDelete(${msg.id},'all')"><i class="bi bi-trash"></i></button>` : ""}
      <button class="btn-icon" title="Удалить у себя" onclick="confirmDelete(${msg.id},'self')"><i class="bi bi-eye-slash"></i></button>
    </div>`;

  div.innerHTML = `
    <div class="avatar" style="cursor:pointer" onclick="showUserProfile(${msg.sender_id},'${esc(msg.sender_username)}',event)">${msg.sender_username[0].toUpperCase()}</div>
    <div class="msg-body">
      <div class="msg-header">
        <span class="msg-author">${esc(msg.sender_username)}</span>
        <span class="msg-time">${time}</span>
        ${edited}
        ${actions}
      </div>
      <div class="msg-content">${content}</div>
      <div class="msg-edit-wrap d-none">
        <textarea class="msg-edit-input" rows="2" onkeydown="handleEditKey(event,${msg.id})"></textarea>
        <div class="msg-edit-hint">Enter — сохранить · Esc — отмена</div>
      </div>
    </div>`;
  return div;
}

/* ── Send ──────────────────────────────────────────────── */
function sendMessage() {
  const input = document.getElementById("msgInput");
  const content = input.value.trim();
  if (!content || !currentChannel) return;
  socket.emit("send_message", { channel_id: currentChannel.id, content });
  input.value = "";
  autoResize(input);
}

function handleInputKey(e) {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
}

/* ── Edit ──────────────────────────────────────────────── */
function openEdit(msgId) {
  const el = document.querySelector(`[data-msg-id="${msgId}"]`);
  if (!el) return;
  const content = el.querySelector(".msg-content").textContent;
  const wrap = el.querySelector(".msg-edit-wrap");
  const ta   = wrap.querySelector(".msg-edit-input");
  ta.value = content;
  wrap.classList.remove("d-none");
  ta.focus();
  el.dataset.editing = "1";
}

function handleEditKey(e, msgId) {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    const ta = e.target;
    const content = ta.value.trim();
    if (content) socket.emit("edit_message", { message_id: msgId, content });
  }
  if (e.key === "Escape") cancelEdit();
}

function cancelEdit() {
  document.querySelectorAll("[data-editing]").forEach(el => {
    el.querySelector(".msg-edit-wrap")?.classList.add("d-none");
    delete el.dataset.editing;
  });
}

/* ── Delete ────────────────────────────────────────────── */
function confirmDelete(msgId, mode) {
  if (mode === "all" && !confirm("Удалить сообщение для всех?")) return;
  socket.emit("delete_message", { message_id: msgId, mode });
}

/* ── Typing ────────────────────────────────────────────── */
function sendTyping() {
  if (!currentChannel) return;
  clearTimeout(typingTimer);
  socket.emit("typing", { channel_id: currentChannel.id });
  typingTimer = setTimeout(() => {}, 2000);
}

/* ── Channel management ────────────────────────────────── */
function openCreateChannel() {
  document.getElementById("newChannelName").value = "";
  document.getElementById("newChannelDesc").value = "";
  new bootstrap.Modal(document.getElementById("createChannelModal")).show();
}

async function createChannel() {
  const name = document.getElementById("newChannelName").value.trim();
  const description = document.getElementById("newChannelDesc").value.trim();
  const is_private = document.getElementById("newChannelPrivate").checked;
  if (!name) return;

  const ch = await api("/api/channels", "POST", { name, description, is_private });
  bootstrap.Modal.getInstance(document.getElementById("createChannelModal")).hide();
  allChannels.unshift({ ...ch, last_message: "", last_at: ch.created_at });
  renderSidebar(allChannels);
  openChannel(ch.id);
}

async function deleteChannel() {
  if (!confirm(`Удалить канал «${currentChannel.name}»? Это действие необратимо.`)) return;
  await api(`/api/channels/${currentChannel.id}`, "DELETE");
  allChannels = allChannels.filter(c => c.id !== currentChannel.id);
  currentChannel = null;
  renderSidebar(allChannels);
  document.getElementById("chatView").classList.add("d-none");
  document.getElementById("welcomeScreen").classList.remove("d-none");
}

async function leaveChannel() {
  if (!confirm(`Выйти из канала «${currentChannel.name}»?`)) return;
  await api(`/api/channels/${currentChannel.id}/leave`, "POST");
  allChannels = allChannels.filter(c => c.id !== currentChannel.id);
  currentChannel = null;
  renderSidebar(allChannels);
  document.getElementById("chatView").classList.add("d-none");
  document.getElementById("welcomeScreen").classList.remove("d-none");
}

/* ── Members management ────────────────────────────────── */
function openInvite() {
  document.getElementById("inviteInput").value = "";
  new bootstrap.Modal(document.getElementById("inviteModal")).show();
}

async function inviteMember() {
  const username = document.getElementById("inviteInput").value.trim();
  if (!username) return;
  const member = await api(`/api/channels/${currentChannel.id}/members`, "POST", { username });
  bootstrap.Modal.getInstance(document.getElementById("inviteModal")).hide();
  const ch = await api(`/api/channels/${currentChannel.id}`);
  renderMembers(ch.members || []);
  currentChannel.member_count = (currentChannel.member_count || 0) + 1;
  document.getElementById("chatMeta").textContent = `${currentChannel.member_count} участников`;
}

async function kickMember(userId) {
  if (!confirm("Кикнуть участника?")) return;
  await api(`/api/channels/${currentChannel.id}/members/${userId}`, "DELETE");
  const ch = await api(`/api/channels/${currentChannel.id}`);
  renderMembers(ch.members || []);
}

async function toggleAdmin(userId, currentRole) {
  const newRole = currentRole === "admin" ? "member" : "admin";
  await api(`/api/channels/${currentChannel.id}/members/${userId}/role`, "PATCH", { role: newRole });
  const ch = await api(`/api/channels/${currentChannel.id}`);
  renderMembers(ch.members || []);
}

/* ── Profile popup (avatar click) ──────────────────────── */
async function showUserProfile(userId, username, event) {
  event.stopPropagation();
  profileUserId = userId;

  // Store rect BEFORE any await — currentTarget becomes null after first suspend
  const rect = event.currentTarget.getBoundingClientRect();

  document.getElementById("profileUsername").textContent = username;

  const popup    = document.getElementById("profilePopup");
  const blockBtn = document.getElementById("profileBlockBtn");
  const blockText = document.getElementById("profileBlockText");

  if (userId === ME) {
    blockBtn.style.display = "none";
  } else {
    blockBtn.style.display = "";
    const status = await api(`/api/users/${userId}/block_status`).catch(() => null);
    profileBlocked = status?.i_blocked ?? false;
    blockText.textContent = profileBlocked ? "Разблокировать" : "Заблокировать";
    blockBtn.classList.toggle("ctx-danger", !profileBlocked);
  }

  popup.classList.remove("d-none");
  popup.style.left = (rect.right + 8) + "px";
  popup.style.top  = rect.top + "px";
}

async function profileToggleBlock() {
  if (!profileUserId || profileUserId === ME) return;
  const action = profileBlocked ? "unblock" : "block";
  await api(`/api/users/${profileUserId}/${action}`, "POST");
  profileBlocked = !profileBlocked;
  document.getElementById("profileBlockText").textContent = profileBlocked ? "Разблокировать" : "Заблокировать";
  document.getElementById("profileBlockBtn").classList.toggle("ctx-danger", !profileBlocked);
  document.getElementById("profilePopup").classList.add("d-none");

  // Refresh input state if we're in DM with this user
  if (currentChannel?.is_dm && currentChannel?.partner_id === profileUserId) {
    renderChatActions(currentChannel);
  }
}

/* ── Delete DM ─────────────────────────────────────────── */
async function deleteDm(channelId) {
  if (!confirm("Удалить всю переписку? Это удалит чат у обоих участников.")) return;
  await api(`/api/dm/${channelId}`, "DELETE");
  // dm_deleted socket event handles UI cleanup
}

/* ── DM ────────────────────────────────────────────────── */
function openNewDm() {
  document.getElementById("dmSearchInput").value = "";
  document.getElementById("userSearchResults").innerHTML = "";
  new bootstrap.Modal(document.getElementById("newDmModal")).show();
}

let searchTimer = null;
function searchUsers(q) {
  clearTimeout(searchTimer);
  if (!q.trim()) { document.getElementById("userSearchResults").innerHTML = ""; return; }
  searchTimer = setTimeout(async () => {
    const users = await api(`/api/users/search?q=${encodeURIComponent(q)}`);
    const res = document.getElementById("userSearchResults");
    res.innerHTML = "";
    users.forEach(u => {
      const div = document.createElement("div");
      div.className = "user-result";
      div.innerHTML = `
        <div class="avatar avatar-sm">${u.username[0].toUpperCase()}</div>
        <span>${esc(u.username)}</span>`;
      div.onclick = () => startDm(u.id);
      res.appendChild(div);
    });
  }, 300);
}

async function startDm(userId) {
  bootstrap.Modal.getInstance(document.getElementById("newDmModal")).hide();
  const ch = await api(`/api/dm/${userId}`, "POST");
  const existing = allChannels.find(c => c.id === ch.id);
  if (!existing) {
    allChannels.unshift({ ...ch, last_message: "", last_at: ch.created_at || new Date().toISOString() });
    renderSidebar(allChannels);
  }
  openChannel(ch.id);
}

/* ── Context menu (legacy, kept for right-click) ───────── */
function hideCtxMenu() { document.getElementById("ctxMenu").classList.add("d-none"); }

/* ── Browse public channels ────────────────────────────── */
async function openBrowseChannels() {
  const list = document.getElementById("publicChannelsList");
  list.innerHTML = '<div class="text-muted small text-center py-2">Загрузка...</div>';
  new bootstrap.Modal(document.getElementById("browseChannelsModal")).show();

  const channels = await api("/api/channels/public").catch(() => []);
  list.innerHTML = "";
  if (!channels.length) {
    list.innerHTML = '<div class="text-muted small text-center py-2">Нет доступных каналов</div>';
    return;
  }
  channels.forEach(ch => {
    const div = document.createElement("div");
    div.className = "user-result justify-content-between";
    div.innerHTML = `
      <div class="d-flex align-items-center gap-2">
        <i class="bi bi-hash text-muted"></i>
        <div>
          <div style="font-size:.88rem;font-weight:600">${esc(ch.name)}</div>
          <div class="text-muted" style="font-size:.75rem">${esc(ch.description || "")} · ${ch.member_count} участников</div>
        </div>
      </div>
      <button class="btn btn-accent btn-sm" style="font-size:.78rem;padding:.2rem .6rem"
        onclick="joinChannel(${ch.id})">Вступить</button>`;
    list.appendChild(div);
  });
}

async function joinChannel(channelId) {
  const ch = await api(`/api/channels/${channelId}/join`, "POST");
  bootstrap.Modal.getInstance(document.getElementById("browseChannelsModal")).hide();
  allChannels.unshift({ ...ch, last_message: "", last_at: new Date().toISOString() });
  renderSidebar(allChannels);
  openChannel(ch.id);
}

/* ── Helpers ───────────────────────────────────────────── */
async function api(url, method = "GET", body = null) {
  const opts = {
    method,
    headers: { "Content-Type": "application/json" },
  };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(url, opts);

  // Detect silent login redirect (session expired)
  const ct = r.headers.get("content-type") || "";
  if (!ct.includes("application/json")) {
    window.location.href = "/login";
    throw new Error("Session expired");
  }

  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    alert(err.error || `Ошибка ${r.status}`);
    throw new Error(err.error);
  }
  return r.json();
}

function esc(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function scrollBottom() {
  const area = document.getElementById("messagesArea");
  area.scrollTop = area.scrollHeight;
}

function autoResize(el) {
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, 160) + "px";
}
