/* ── State ─────────────────────────────────────────────── */
const socket = io({ transports: ["websocket"] });
let currentChannel    = null;
let allChannels       = [];
let ctxMessageId      = null;
let typingTimer       = null;
let oldestMsgId       = null;
let profileUserId     = null;
let profileBlocked    = false;
let searchActive      = false;
let replyTo           = null;       // {id, sender_username, content}
let unreadCounts      = {};         // channel_id → count
const sidebarTyping   = {};         // channel_id → timer
let mutedChannels     = new Set(JSON.parse(localStorage.getItem("muted") || "[]"));
let activeCallChannels = new Set();   // channel ids with an in-progress call

/* ── Avatar helper ─────────────────────────────────────── */
// Returns inline style + content for an avatar div given user-like data
function avatarStyle(url, color) {
  if (url) return `background-image:url('${url}');background-color:#222`;
  return `background:${color || '#5865f2'}`;
}
function avatarLetter(url, username) {
  return url ? "" : (username ? username[0].toUpperCase() : "?");
}
let _bannerRefreshInt = null;
function renderActiveCallBanner() {
  const b = document.getElementById("activeCallBanner");
  if (!b) return;
  if (!currentChannel) { b.classList.add("d-none"); _stopBannerRefresh(); return; }
  const isDmActive  = currentChannel.is_dm && activeCallChannels.has(currentChannel.id) && !_callPC;
  const isChActive  = !currentChannel.is_dm && _channelActiveCalls.has(currentChannel.id) && !_channelCall;
  const show = isDmActive || isChActive;
  b.classList.toggle("d-none", !show);
  if (show) _startBannerRefresh(currentChannel.id);
  else      _stopBannerRefresh();
}

function _startBannerRefresh(channelId) {
  _stopBannerRefresh();
  _bannerRefreshInt = setInterval(async () => {
    try {
      const s = await api(`/api/channels/${channelId}/call_status`);
      console.log("[call_status]", channelId, s, "_channelCall:", !!_channelCall, "_callPC:", !!_callPC);
      if (currentChannel?.id !== channelId) return;
      if (s.channel_active) _channelActiveCalls.add(channelId);
      else                  _channelActiveCalls.delete(channelId);
      if (s.dm_active)      activeCallChannels.add(channelId);
      else                  activeCallChannels.delete(channelId);
      // ALWAYS re-render to ensure UI matches server truth
      renderSidebar(allChannels);
      renderActiveCallBanner();
    } catch (e) {
      console.warn("[call_status] failed:", e);
    }
  }, 5000);
}

function _stopBannerRefresh() {
  if (_bannerRefreshInt) { clearInterval(_bannerRefreshInt); _bannerRefreshInt = null; }
}

function rejoinCallFromBanner() {
  if (currentChannel?.is_dm) startCall("audio");
  else joinChannelCall();
}

function setChatHeaderAvatar(url, color, username) {
  const el = document.getElementById("chatIcon");
  el.className = "avatar avatar-sm";
  el.style.cssText = "";
  applyAvatar(el, url, color, username);
}

function applyAvatar(el, url, color, username) {
  if (url) {
    el.style.backgroundImage = `url('${url}')`;
    el.style.backgroundColor = "#222";
  } else {
    el.style.backgroundImage = "";
    el.style.backgroundColor = color || "#5865f2";
  }
  el.textContent = url ? "" : (username ? username[0].toUpperCase() : "?");
  el.classList.toggle("has-img", !!url);
}

/* ── Sound ─────────────────────────────────────────────── */
/* Build a short two-tone "ding" WAV once and play it via <audio> — works in
   background tabs without the WebAudio gesture/suspend headaches. */
let _notifAudio = null;
function _buildNotifSound() {
  const sampleRate = 44100;
  const total = Math.floor(sampleRate * 0.5);
  const buf = new ArrayBuffer(44 + total * 2);
  const v = new DataView(buf);
  // RIFF header
  v.setUint32(0, 0x52494646, false); // "RIFF"
  v.setUint32(4, 36 + total * 2, true);
  v.setUint32(8, 0x57415645, false); // "WAVE"
  v.setUint32(12, 0x666d7420, false); // "fmt "
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  v.setUint32(36, 0x64617461, false); // "data"
  v.setUint32(40, total * 2, true);
  // Two tones with envelope
  const tones = [{ f: 880, start: 0,    dur: 0.18 },
                 { f: 1180, start: 0.13, dur: 0.22 }];
  for (let i = 0; i < total; i++) {
    const t = i / sampleRate;
    let s = 0;
    for (const tn of tones) {
      const local = t - tn.start;
      if (local >= 0 && local <= tn.dur) {
        const env = Math.exp(-local * 8);  // exponential decay
        s += Math.sin(2 * Math.PI * tn.f * local) * env;
      }
    }
    s = Math.max(-1, Math.min(1, s * 0.4));
    v.setInt16(44 + i * 2, s * 0x7fff, true);
  }
  const blob = new Blob([buf], { type: "audio/wav" });
  const a = new Audio(URL.createObjectURL(blob));
  a.preload = "auto";
  a.volume = 0.6;
  return a;
}

function playNotifSound() {
  try {
    if (!_notifAudio) _notifAudio = _buildNotifSound();
    // Reset & play (allow rapid replays)
    _notifAudio.currentTime = 0;
    const p = _notifAudio.play();
    if (p && p.catch) p.catch(() => {});
  } catch (e) {
    console.warn("playNotifSound failed:", e);
  }
}

/* ── Init ──────────────────────────────────────────────── */
document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("myUsername").textContent = MY_DISPLAY_NAME;
  applyAvatar(document.getElementById("myAvatar"), MY_AVATAR_URL, MY_COLOR, MY_DISPLAY_NAME);
  // Ask for notification permission
  if ("Notification" in window && Notification.permission === "default") {
    Notification.requestPermission();
  }
  loadChannels();
  document.addEventListener("click", () => {
    hideCtxMenu();
    document.getElementById("profilePopup").classList.add("d-none");
  });
});

/* ── Socket events ─────────────────────────────────────── */
socket.on("connect",      () => {
  console.log("WS connected");
  // Server will push channel_call_status / dm_call_status for all my channels
  // automatically on connect. No request needed.
});
socket.on("disconnect",   () => console.log("WS disconnected"));

socket.on("new_message", msg => {
  const isCurrent  = msg.channel_id === currentChannel?.id;
  const isMine     = msg.sender_id === ME;
  const pageHidden = document.visibilityState !== "visible";
  if (isCurrent) {
    appendMessage(msg);
  } else {
    unreadCounts[msg.channel_id] = (unreadCounts[msg.channel_id] || 0) + 1;
  }
  // Sound: play if message isn't mine, channel isn't muted, status isn't DND,
  // and either it's not the current channel OR the page isn't focused
  const shouldSound = !isMine && !mutedChannels.has(msg.channel_id) && MY_STATUS !== "dnd"
                      && (!isCurrent || pageHidden);
  if (shouldSound) playNotifSound();

  // Browser notification when tab hidden / not focused
  if (!isMine && pageHidden && !mutedChannels.has(msg.channel_id) && MY_STATUS !== "dnd"
      && "Notification" in window && Notification.permission === "granted"
      && localStorage.getItem("notifications_disabled") !== "1") {
    try {
      const ch = allChannels.find(c => c.id === msg.channel_id);
      const title = ch?.name || "Новое сообщение";
      const body = msg.content || (msg.attachment_type ? `📎 ${msg.attachment_name || msg.attachment_type}` : "");
      const n = new Notification(`${msg.sender_username} · ${title}`, {
        body, icon: msg.sender_avatar_url || undefined, tag: `ch_${msg.channel_id}`,
      });
      n.onclick = () => { window.focus(); openChannel(msg.channel_id); n.close(); };
    } catch (_) {}
  }
  const preview = msg.content || (msg.attachment_type ? `📎 ${msg.attachment_name || "вложение"}` : "");
  bumpChannelPreview(msg.channel_id, preview);
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
    // Stop & remove any attachments (image/video/audio/file)
    el.querySelectorAll(".msg-attachment").forEach(a => {
      const audio = a._audio || a.querySelector("audio");
      try { audio?.pause(); } catch (_) {}
      a.remove();
    });
  } else {
    // "delete for me" — also stop any playing audio in this group
    el.querySelectorAll(".msg-attachment").forEach(a => {
      try { a._audio?.pause(); } catch (_) {}
    });
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
    socket.emit("join", { channel_id: ch.id }); // subscribe for background notifications
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

socket.on("channel_deleted", ({ channel_id }) => {
  allChannels = allChannels.filter(c => c.id !== channel_id);
  renderSidebar(allChannels);
  if (currentChannel?.id === channel_id) {
    currentChannel = null;
    document.getElementById("chatView").classList.add("d-none");
    document.getElementById("welcomeScreen").classList.remove("d-none");
  }
});

socket.on("member_joined", (member) => {
  if (member.channel_id !== currentChannel?.id) return;
  if (document.querySelector(`[data-uid="${member.id}"]`)) return;
  currentChannel.member_count = (currentChannel.member_count || 0) + 1;
  document.getElementById("chatMeta").textContent = `${currentChannel.member_count} участников`;
  const list = document.getElementById("membersList");
  const div = document.createElement("div");
  div.className = "member-item";
  div.dataset.uid = member.id;
  const effStatusM = (!member.is_online || member.status === "offline") ? "offline" : (member.status || "active");
  div.innerHTML = `
    <div class="online-dot status-${effStatusM} ${effStatusM === 'offline' ? 'offline-dot' : ''}"></div>
    <div class="avatar avatar-sm ${member.avatar_url ? 'has-img' : ''}" style="${avatarStyle(member.avatar_url, member.avatar_color)};cursor:pointer"
         onclick="showUserProfile(${member.id},'${esc(member.username)}',event)">${avatarLetter(member.avatar_url, member.username)}</div>
    <span style="font-size:.88rem;overflow:hidden;text-overflow:ellipsis">${esc(member.username)}</span>`;
  list.appendChild(div);
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

socket.on("block_status_changed", ({ by_user_id, blocked }) => {
  if (!currentChannel?.is_dm || currentChannel?.partner_id !== by_user_id) return;
  const input = document.getElementById("msgInput");
  input.disabled = blocked;
  input.placeholder = blocked ? "Вы заблокированы" : "Написать сообщение...";
});

socket.on("profile_updated", user => {
  const dn = user.display_name || user.username;
  // Update avatars + names in messages
  document.querySelectorAll(`[data-sender-id="${user.id}"]`).forEach(g => {
    const av = g.querySelector(".msg-group > .avatar");
    if (av) applyAvatar(av, user.avatar_url, user.avatar_color, dn);
    const auth = g.querySelector(".msg-author");
    if (auth) auth.textContent = dn;
  });
  // Members panel
  const memberRow = document.querySelector(`[data-uid="${user.id}"]`);
  if (memberRow) {
    const av = memberRow.querySelector(".avatar");
    if (av) applyAvatar(av, user.avatar_url, user.avatar_color, dn);
    const dot = memberRow.querySelector(".online-dot");
    if (dot) setStatusDot(dot, user);
    const span = memberRow.querySelector("span");
    if (span) span.textContent = dn;
  }
  if (currentChannel?.is_dm && currentChannel?.partner_id === user.id) {
    setChatHeaderAvatar(user.avatar_url, user.avatar_color, dn);
    document.getElementById("chatName").textContent = dn;
  }
  // Sidebar DM rows
  let dirty = false;
  allChannels.forEach(c => {
    if (c.is_dm && c.partner_id === user.id) {
      c.partner_avatar_url   = user.avatar_url || "";
      c.partner_avatar_color = user.avatar_color || "#5865f2";
      c.name                 = dn;
      dirty = true;
    }
  });
  if (dirty) renderSidebar(allChannels);
});

function setStatusDot(dot, user) {
  dot.classList.remove("offline-dot", "status-active", "status-dnd", "status-offline");
  const effectiveStatus = (!user.is_online || user.status === "offline") ? "offline" : (user.status || "active");
  dot.classList.add("status-" + effectiveStatus);
  if (effectiveStatus === "offline") dot.classList.add("offline-dot");
}

socket.on("dm_call_status", ({ channel_id, active }) => {
  if (active) activeCallChannels.add(channel_id);
  else        activeCallChannels.delete(channel_id);
  renderSidebar(allChannels);
  if (currentChannel?.id === channel_id) renderActiveCallBanner();
});

socket.on("typing", ({ username, channel_id }) => {
  if (channel_id === currentChannel?.id) {
    const el = document.getElementById("typingIndicator");
    el.textContent = `${username} печатает...`;
    el.classList.remove("d-none");
    clearTimeout(el._timer);
    el._timer = setTimeout(() => el.classList.add("d-none"), 2500);
  }
  // Show typing on sidebar channel item
  const chEl = document.querySelector(`.channel-item[data-ch-id="${channel_id}"]`);
  const preview = chEl?.querySelector(".ch-preview");
  if (preview) {
    if (!preview.dataset.orig) preview.dataset.orig = preview.textContent;
    preview.textContent = `${username} печатает...`;
    preview.classList.add("ch-typing");
    clearTimeout(sidebarTyping[channel_id]);
    sidebarTyping[channel_id] = setTimeout(() => {
      preview.textContent = preview.dataset.orig || "";
      preview.classList.remove("ch-typing");
      delete preview.dataset.orig;
    }, 2500);
  }
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
    const unread = unreadCounts[ch.id] || 0;
    const muted  = mutedChannels.has(ch.id);
    const el = document.createElement("div");
    el.className = "channel-item" +
      (ch.id === currentChannel?.id ? " active" : "") +
      (unread ? " has-unread" : "");
    el.dataset.chId = ch.id;
    el.onclick = () => openChannel(ch.id);

    let iconHtml;
    if (ch.is_dm) {
      const url = ch.partner_avatar_url || "";
      const color = ch.partner_avatar_color || "#5865f2";
      const letter = url ? "" : (ch.name ? ch.name[0].toUpperCase() : "?");
      const bg = url ? `background-image:url('${url}');background-color:#222` : `background:${color}`;
      iconHtml = `<div class="avatar avatar-xs ${url ? 'has-img' : ''}" style="${bg};width:22px;height:22px;font-size:.7rem;flex-shrink:0">${letter}</div>`;
    } else if (ch.avatar_url) {
      iconHtml = `<div class="avatar avatar-xs has-img" style="background-image:url('${ch.avatar_url}');background-color:#222;width:22px;height:22px;font-size:.7rem;flex-shrink:0"></div>`;
    } else {
      const icon = ch.is_private ? "bi-lock-fill" : "bi-hash";
      iconHtml = `<i class="bi ${icon} flex-shrink-0" style="font-size:.8rem"></i>`;
    }
    el.innerHTML = `
      ${iconHtml}
      <div style="flex:1;min-width:0">
        <div style="font-size:.88rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:${unread ? 700 : 400}">${esc(ch.name)}</div>
        <div class="ch-preview">${esc(ch.last_message || "")}</div>
      </div>
      ${(activeCallChannels.has(ch.id) || _channelActiveCalls.has(ch.id)) ? '<i class="bi bi-telephone-fill" style="color:#23a55a;font-size:.78rem;flex-shrink:0;animation:pulse 1.4s infinite" title="Идёт звонок"></i>' : ""}
      ${muted ? '<i class="bi bi-bell-slash text-muted" style="font-size:.72rem;flex-shrink:0"></i>' : ""}
      ${unread ? `<span class="unread-badge">${unread > 99 ? "99+" : unread}</span>` : ""}`;

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
  delete unreadCounts[id];
  renderSidebar(allChannels);

  const data = await api(`/api/channels/${id}`);
  currentChannel = data;
  oldestMsgId = null;

  location.hash = id;
  socket.emit("join", { channel_id: id });

  document.getElementById("welcomeScreen").classList.add("d-none");
  document.getElementById("chatView").classList.remove("d-none");

  // Reset search and reply on channel switch
  cancelReply();
  document.getElementById("msgSearchBar").classList.add("d-none");
  clearMsgSearch();
  searchActive = false;

  document.getElementById("chatName").textContent = data.name;
  document.getElementById("chatMeta").textContent =
    data.is_dm ? "" : `${data.member_count} участников`;

  // Attach partner_id for DMs (from sidebar cache)
  const cached = allChannels.find(c => c.id === id);
  if (data.is_dm && cached?.partner_id) data.partner_id = cached.partner_id;
  currentChannel = data;

  // Header icon — for DM show partner avatar, for channels show #/lock icon
  if (data.is_dm && data.partner_id) {
    setChatHeaderAvatar("", "#5865f2", data.name);
    api(`/api/users/${data.partner_id}`).then(u => {
      if (currentChannel?.id === id) setChatHeaderAvatar(u.avatar_url, u.avatar_color, u.username);
    }).catch(() => {});
  } else if (data.avatar_url) {
    setChatHeaderAvatar(data.avatar_url, "#5865f2", data.name);
  } else {
    document.getElementById("chatIcon").innerHTML =
      data.is_private ? '<i class="bi bi-lock-fill"></i>' : '<i class="bi bi-hash"></i>';
    document.getElementById("chatIcon").className = "text-muted";
    document.getElementById("chatIcon").style.cssText = "";
  }

  renderChatActions(data);
  renderActiveCallBanner();
  renderMembers(data.members || []);

  // Verify call status from authoritative HTTP endpoint (kills any stale state)
  api(`/api/channels/${id}/call_status`).then(s => {
    if (currentChannel?.id !== id) return;
    if (s.channel_active) _channelActiveCalls.add(id);
    else                  _channelActiveCalls.delete(id);
    if (s.dm_active)      activeCallChannels.add(id);
    else                  activeCallChannels.delete(id);
    renderSidebar(allChannels);
    renderActiveCallBanner();
  }).catch(() => {});
  await loadMessages(id);

  document.querySelectorAll(".channel-item").forEach(el =>
    el.classList.toggle("active", parseInt(el.dataset.chId) === id)
  );
  document.getElementById("msgInput").focus();
}

function toggleMute(channelId) {
  if (mutedChannels.has(channelId)) {
    mutedChannels.delete(channelId);
  } else {
    mutedChannels.add(channelId);
  }
  localStorage.setItem("muted", JSON.stringify([...mutedChannels]));
  renderChatActions(currentChannel);
  renderSidebar(allChannels);
}

async function renderChatActions(ch) {
  const wrap = document.getElementById("chatActions");
  wrap.innerHTML = "";

  const input = document.getElementById("msgInput");
  input.placeholder = "Написать сообщение...";
  input.disabled = false;

  // Mute button always shown
  const isMuted = mutedChannels.has(ch.id);
  wrap.innerHTML = `
    <button class="btn-icon" title="${isMuted ? "Включить звук" : "Заглушить"}" onclick="toggleMute(${ch.id})">
      <i class="bi bi-bell${isMuted ? "-slash" : ""}-fill"></i>
    </button>`;

  if (ch.is_dm) {
    wrap.innerHTML += `
      <button class="btn-icon" title="Аудиозвонок" onclick="startCall('audio')">
        <i class="bi bi-telephone-fill"></i>
      </button>
      <button class="btn-icon" title="Видеозвонок" onclick="startCall('video')">
        <i class="bi bi-camera-video-fill"></i>
      </button>
      <button class="btn-icon text-danger" title="Удалить переписку" onclick="deleteDm(${ch.id})">
        <i class="bi bi-trash"></i>
      </button>`;

    // Check block status if we know the partner
    if (ch.partner_id) {
      const status = await api(`/api/users/${ch.partner_id}/block_status`).catch(() => null);
      if (status?.they_blocked) {
        input.placeholder = "Вы заблокированы";
        input.disabled = true;
      } else if (status?.i_blocked) {
        input.placeholder = "Вы заблокировали этого пользователя";
        input.disabled = true;
      }
    }
    return;
  }

  const myRole = ch.my_role;
  // Group call button (only if calls are allowed)
  if (ch.allow_calls !== false) {
    wrap.innerHTML += `
      <button class="btn-icon" title="Голосовой звонок в канал" onclick="joinChannelCall()">
        <i class="bi bi-telephone-fill"></i>
      </button>`;
  }
  if (myRole === "owner" || myRole === "admin") {
    wrap.innerHTML += `
      <button class="btn-icon" title="Пригласить" onclick="openInvite()">
        <i class="bi bi-person-plus"></i>
      </button>
      <button class="btn-icon" title="Настройки канала" onclick="openChannelSettings()">
        <i class="bi bi-gear-fill"></i>
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
    const effStatus = (!m.is_online || m.status === "offline") ? "offline" : (m.status || "active");
    div.innerHTML = `
      <div class="online-dot status-${effStatus} ${effStatus === 'offline' ? 'offline-dot' : ''}"></div>
      <div class="avatar avatar-sm ${m.avatar_url ? 'has-img' : ''}" style="${avatarStyle(m.avatar_url, m.avatar_color)};cursor:pointer" onclick="showUserProfile(${m.id},'${esc(m.display_name || m.username)}',event)">${avatarLetter(m.avatar_url, m.display_name || m.username)}</div>
      <span style="font-size:.88rem;overflow:hidden;text-overflow:ellipsis">${esc(m.display_name || m.username)}</span>
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
  msgs.forEach(m => area.appendChild(buildMessageEl(m)));
  rebuildDateSeparators();
  initAudioPlayers(area);
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
  msgs.forEach(m => area.insertBefore(buildMessageEl(m), area.firstChild));
  rebuildDateSeparators();
  initAudioPlayers(area);
  area.parentElement.scrollTop += area.scrollHeight - prevH;
}

/* ── Date separators ───────────────────────────────────── */
function getDateLabel(isoStr) {
  const d = new Date(isoStr);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Сегодня";
  if (d.toDateString() === yesterday.toDateString()) return "Вчера";
  return d.toLocaleDateString("ru", { day: "numeric", month: "long", year: "numeric" });
}

function makeDateSeparator(label) {
  const el = document.createElement("div");
  el.className = "date-sep";
  el.innerHTML = `<span>${label}</span>`;
  return el;
}

function rebuildDateSeparators() {
  const area = document.getElementById("messagesList");
  area.querySelectorAll(".date-sep").forEach(el => el.remove());
  let lastDate = null;
  area.querySelectorAll(".msg-group").forEach(el => {
    const d = el.dataset.msgDate;
    if (d && d !== lastDate) {
      area.insertBefore(makeDateSeparator(el.dataset.msgDateLabel), el);
      lastDate = d;
    }
  });
}

/* ── Message search ────────────────────────────────────── */
function toggleSearch() {
  const bar = document.getElementById("msgSearchBar");
  searchActive = bar.classList.toggle("d-none") === false;
  if (searchActive) {
    document.getElementById("msgSearchInput").focus();
  } else {
    clearMsgSearch();
  }
}

function searchMessages(q) {
  q = q.trim().toLowerCase();
  document.querySelectorAll(".msg-group").forEach(el => {
    if (!q) { el.style.display = ""; return; }
    const text = (el.querySelector(".msg-content")?.textContent || "").toLowerCase();
    const author = (el.querySelector(".msg-author")?.textContent || "").toLowerCase();
    el.style.display = (text.includes(q) || author.includes(q)) ? "" : "none";
  });
}

function clearMsgSearch() {
  document.getElementById("msgSearchInput").value = "";
  document.querySelectorAll(".msg-group").forEach(el => el.style.display = "");
}

function appendMessage(msg) {
  const area = document.getElementById("messagesList");
  const msgDate = new Date(msg.created_at).toDateString();
  const lastGroup = area.querySelector(".msg-group:last-of-type");
  if (!lastGroup || lastGroup.dataset.msgDate !== msgDate) {
    area.appendChild(makeDateSeparator(getDateLabel(msg.created_at)));
  }
  area.appendChild(buildMessageEl(msg));
  initAudioPlayers(area);
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
  div.dataset.msgDate = new Date(msg.created_at).toDateString();
  div.dataset.msgDateLabel = getDateLabel(msg.created_at);

  const time = new Date(msg.created_at).toLocaleTimeString("ru", { hour: "2-digit", minute: "2-digit" });
  const edited = msg.edited_at ? '<span class="msg-edited">(изменено)</span>' : "";
  const content = msg.is_deleted
    ? '<span class="deleted">Сообщение удалено</span>'
    : esc(msg.content);

  const contentPreview = esc((msg.content || "").slice(0, 60));
  const actions = msg.is_deleted ? "" : `
    <div class="msg-actions">
      <button class="btn-icon" title="Ответить" onclick="openReply(${msg.id},'${esc(msg.sender_display_name || msg.sender_username)}','${contentPreview}')"><i class="bi bi-reply"></i></button>
      ${canEdit ? `<button class="btn-icon" title="Редактировать" onclick="openEdit(${msg.id})"><i class="bi bi-pencil"></i></button>` : ""}
      ${canDelAll ? `<button class="btn-icon text-danger" title="Удалить для всех" onclick="confirmDelete(${msg.id},'all')"><i class="bi bi-trash"></i></button>` : ""}
      <button class="btn-icon" title="Удалить у себя" onclick="confirmDelete(${msg.id},'self')"><i class="bi bi-eye-slash"></i></button>
    </div>`;

  const attachHtml = renderAttachment(msg);

  const replyQuote = msg.reply_to ? `
    <div class="msg-reply" onclick="scrollToMsg(${msg.reply_to.id})">
      <span class="reply-author">${esc(msg.reply_to.sender_display_name || msg.reply_to.sender_username)}</span>${msg.reply_to.is_deleted ? "<i>Сообщение удалено</i>" : esc((msg.reply_to.content || "").slice(0, 80))}
    </div>` : "";

  div.innerHTML = `
    <div class="avatar ${msg.sender_avatar_url ? 'has-img' : ''}" style="${avatarStyle(msg.sender_avatar_url, msg.sender_avatar_color)};cursor:pointer" onclick="showUserProfile(${msg.sender_id},'${esc(msg.sender_display_name || msg.sender_username)}',event)">${avatarLetter(msg.sender_avatar_url, msg.sender_display_name || msg.sender_username)}</div>
    <div class="msg-body">
      ${replyQuote}
      <div class="msg-header">
        <span class="msg-author">${esc(msg.sender_display_name || msg.sender_username)}</span>
        <span class="msg-time">${time}</span>
        ${edited}
        ${actions}
      </div>
      <div class="msg-content">${content}</div>
      ${attachHtml}
      <div class="msg-edit-wrap d-none">
        <textarea class="msg-edit-input" rows="2" onkeydown="handleEditKey(event,${msg.id})"></textarea>
        <div class="msg-edit-hint">Enter — сохранить · Esc — отмена</div>
      </div>
    </div>`;
  return div;
}

/* ── Attachment render ─────────────────────────────────── */
function renderAttachment(msg) {
  if (!msg.attachment_url || msg.is_deleted) return "";
  const url  = msg.attachment_url;
  const name = esc(msg.attachment_name || "файл");
  const type = msg.attachment_type;
  if (type === "image") {
    return `<div class="msg-attachment"><img src="${url}" alt="${name}" onclick="openLightbox('${url}','image')" loading="lazy"></div>`;
  }
  if (type === "video") {
    return `<div class="msg-attachment"><video src="${url}" controls preload="metadata"></video></div>`;
  }
  if (type === "audio") {
    return `<div class="msg-attachment audio-player" data-audio-url="${url}" data-init="0">
              <button class="audio-play" type="button"><i class="bi bi-play-fill"></i></button>
              <canvas class="audio-wave" width="240" height="34"></canvas>
              <span class="small audio-time">0:00</span>
            </div>`;
  }
  return `<div class="msg-attachment"><a class="file-card" href="${url}" target="_blank" download="${name}">
            <i class="bi bi-file-earmark-fill"></i>
            <span class="fname">${name}</span>
            <i class="bi bi-download text-muted" style="font-size:.9rem"></i>
          </a></div>`;
}

/* ── Audio waveform player ─────────────────────────────── */
function _formatTimeSec(s) {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  return `${m}:${String(r).padStart(2, "0")}`;
}

function _computePeaks(audioBuffer, count) {
  const data = audioBuffer.getChannelData(0);
  const block = Math.floor(data.length / count);
  if (block <= 0) return new Array(count).fill(0);
  const peaks = new Array(count);
  for (let i = 0; i < count; i++) {
    let max = 0;
    const start = i * block;
    const end = Math.min(start + block, data.length);
    for (let j = start; j < end; j++) {
      const v = Math.abs(data[j]);
      if (v > max) max = v;
    }
    peaks[i] = max;
  }
  const top = Math.max(...peaks, 0.001);
  return peaks.map(p => p / top);
}

function _drawAudioWave(canvas, peaks, progress) {
  const ctx = canvas.getContext("2d");
  // Match canvas internal size to its CSS pixel size (HiDPI-safe enough)
  const cssW = canvas.clientWidth || canvas.width;
  const cssH = canvas.clientHeight || canvas.height;
  if (canvas.width !== cssW)  canvas.width  = cssW;
  if (canvas.height !== cssH) canvas.height = cssH;
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  if (!peaks || !peaks.length) {
    // Placeholder: faint flat line
    ctx.fillStyle = "#5a5d63";
    ctx.fillRect(0, h/2 - 1, w, 2);
    return;
  }
  const barCount = peaks.length;
  const barW = w / barCount;
  for (let i = 0; i < barCount; i++) {
    const barH = Math.max(2, peaks[i] * (h - 4));
    const x = i * barW;
    const y = (h - barH) / 2;
    ctx.fillStyle = (i / barCount) <= progress ? "#5865f2" : "#7a7c80";
    ctx.fillRect(x + 1, y, Math.max(1, barW - 2), barH);
  }
}

function initAudioPlayer(playerEl) {
  if (playerEl.dataset.init === "1") return;
  playerEl.dataset.init = "1";

  const url     = playerEl.dataset.audioUrl;
  const playBtn = playerEl.querySelector(".audio-play");
  const canvas  = playerEl.querySelector(".audio-wave");
  const timeEl  = playerEl.querySelector(".audio-time");

  const audio = new Audio();
  audio.preload = "metadata";
  audio.src = url;

  let peaks = null;

  // Decode audio once for waveform peaks
  fetch(url).then(r => r.arrayBuffer()).then(buf => {
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = new AC();
    return ctx.decodeAudioData(buf.slice(0));
  }).then(audioBuffer => {
    const w = canvas.clientWidth || 240;
    const count = Math.max(40, Math.floor(w / 4));
    peaks = _computePeaks(audioBuffer, count);
    _drawAudioWave(canvas, peaks, 0);
  }).catch(() => {
    _drawAudioWave(canvas, [], 0);
  });

  playBtn.onclick = () => {
    // Pause any other playing audio players
    document.querySelectorAll(".audio-player").forEach(other => {
      if (other !== playerEl && other._audio && !other._audio.paused) other._audio.pause();
    });
    if (audio.paused) audio.play();
    else audio.pause();
  };

  audio.addEventListener("play",  () => { playBtn.innerHTML = '<i class="bi bi-pause-fill"></i>'; });
  audio.addEventListener("pause", () => { playBtn.innerHTML = '<i class="bi bi-play-fill"></i>'; });
  audio.addEventListener("ended", () => {
    playBtn.innerHTML = '<i class="bi bi-play-fill"></i>';
    audio.currentTime = 0;
    _drawAudioWave(canvas, peaks, 0);
  });
  audio.addEventListener("timeupdate", () => {
    const dur = audio.duration || 0;
    const prog = dur ? audio.currentTime / dur : 0;
    _drawAudioWave(canvas, peaks, prog);
    timeEl.textContent = _formatTimeSec(audio.currentTime) + " / " + _formatTimeSec(dur);
  });
  audio.addEventListener("loadedmetadata", () => {
    timeEl.textContent = _formatTimeSec(0) + " / " + _formatTimeSec(audio.duration);
  });

  canvas.onclick = e => {
    if (!audio.duration) return;
    const rect = canvas.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    audio.currentTime = audio.duration * ratio;
  };

  playerEl._audio = audio;
}

function initAudioPlayers(root) {
  (root || document).querySelectorAll('.audio-player[data-init="0"]').forEach(initAudioPlayer);
}

function openLightbox(url, kind) {
  const ov = document.createElement("div");
  ov.className = "lightbox-overlay";
  ov.innerHTML = kind === "video"
    ? `<video src="${url}" controls autoplay></video>`
    : `<img src="${url}">`;
  ov.onclick = () => ov.remove();
  document.body.appendChild(ov);
}

/* ── Reply ─────────────────────────────────────────────── */
function openReply(msgId, username, content) {
  replyTo = { id: msgId, sender_username: username, content };
  document.getElementById("replyBar").classList.remove("d-none");
  document.getElementById("replyUsername").textContent = username;
  document.getElementById("replyPreview").textContent = content;
  document.getElementById("msgInput").focus();
}

function cancelReply() {
  replyTo = null;
  document.getElementById("replyBar").classList.add("d-none");
}

function scrollToMsg(msgId) {
  const el = document.querySelector(`[data-msg-id="${msgId}"]`);
  if (!el) return;
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  el.classList.add("msg-highlight");
  setTimeout(() => el.classList.remove("msg-highlight"), 1500);
}

/* ── Attachments ───────────────────────────────────────── */
let pendingAttach = null;  // {url, type, name}

async function onAttachSelected(input) {
  const file = input.files[0];
  input.value = "";
  if (!file) return;
  await doAttachUpload(file);
}

async function doAttachUpload(file) {
  if (file.size > 50 * 1024 * 1024) { alert("Файл больше 50 МБ"); return; }
  const fd = new FormData();
  fd.append("file", file);
  try {
    const r = await fetch("/api/messages/attachment", { method: "POST", body: fd });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      alert(err.error || `Ошибка ${r.status}`);
      return;
    }
    pendingAttach = await r.json();
    document.getElementById("attachPreviewName").textContent = pendingAttach.name;
    document.getElementById("attachPreview").classList.remove("d-none");
  } catch (e) {
    alert("Ошибка загрузки: " + e.message);
  }
}

function cancelAttach() {
  pendingAttach = null;
  document.getElementById("attachPreview").classList.add("d-none");
}

/* ── Voice recording ───────────────────────────────────── */
let _mediaRecorder = null;
let _recordChunks  = [];
let _recordStart   = 0;
let _recordTimer   = null;
let _recordCancelled = false;

async function startRecording() {
  if (_mediaRecorder) return;
  if (!navigator.mediaDevices || !window.MediaRecorder) {
    alert("Запись не поддерживается этим браузером");
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    _recordChunks = [];
    _recordCancelled = false;
    const mime = MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : "";
    _mediaRecorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
    _mediaRecorder.ondataavailable = e => { if (e.data.size > 0) _recordChunks.push(e.data); };
    _mediaRecorder.onstop = async () => {
      stream.getTracks().forEach(t => t.stop());
      const wasCancelled = _recordCancelled;
      const blob = new Blob(_recordChunks, { type: _mediaRecorder.mimeType || "audio/webm" });
      _mediaRecorder = null;
      clearInterval(_recordTimer);
      document.getElementById("recordingBar").classList.add("d-none");
      if (wasCancelled || blob.size === 0) return;
      const file = new File([blob], `voice_${Date.now()}.webm`, { type: blob.type });
      await doAttachUpload(file);
      // Auto-send voice message right away
      if (pendingAttach && currentChannel) {
        socket.emit("send_message", {
          channel_id: currentChannel.id,
          content: "",
          attachment_url:  pendingAttach.url,
          attachment_type: "audio",
          attachment_name: "Голосовое сообщение",
          reply_to_id: replyTo?.id ?? null,
        });
        pendingAttach = null;
        document.getElementById("attachPreview").classList.add("d-none");
        cancelReply();
      }
    };
    _mediaRecorder.start();
    _recordStart = Date.now();
    document.getElementById("recordingBar").classList.remove("d-none");
    _recordTimer = setInterval(() => {
      const sec = Math.floor((Date.now() - _recordStart) / 1000);
      document.getElementById("recordTimer").textContent = `${Math.floor(sec/60)}:${String(sec%60).padStart(2,'0')}`;
    }, 250);

    // Live waveform from microphone
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      const audioCtx = new AC();
      const src      = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      src.connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);
      const canvas = document.getElementById("recordWave");
      const ctx2d  = canvas.getContext("2d");
      // History buffer for scrolling waveform
      const history = [];
      const maxBars = 60;

      const draw = () => {
        if (!_mediaRecorder) {
          try { audioCtx.close(); } catch (_) {}
          return;
        }
        analyser.getByteFrequencyData(data);
        // Take average of low-mid frequency range for "loudness"
        let sum = 0;
        const N = Math.min(data.length, 32);
        for (let i = 2; i < N; i++) sum += data[i];
        const level = sum / (N - 2) / 255;
        history.push(level);
        if (history.length > maxBars) history.shift();

        const cssW = canvas.clientWidth || 320;
        const cssH = canvas.clientHeight || 32;
        if (canvas.width !== cssW)  canvas.width  = cssW;
        if (canvas.height !== cssH) canvas.height = cssH;
        ctx2d.clearRect(0, 0, cssW, cssH);
        const barW = cssW / maxBars;
        for (let i = 0; i < history.length; i++) {
          const v = history[i];
          const barH = Math.max(3, v * (cssH - 4) * 1.6);
          const x = (maxBars - history.length + i) * barW;
          const y = (cssH - barH) / 2;
          ctx2d.fillStyle = "#5865f2";
          ctx2d.fillRect(x + 1, y, Math.max(1, barW - 2), barH);
        }
        requestAnimationFrame(draw);
      };
      draw();
    } catch (_) {}
  } catch (e) {
    alert("Не удалось получить доступ к микрофону: " + e.message);
  }
}

function stopAndSendRecording() {
  if (_mediaRecorder && _mediaRecorder.state === "recording") {
    _mediaRecorder.stop();
  }
}

function cancelRecording() {
  if (_mediaRecorder) {
    _recordCancelled = true;
    try { _mediaRecorder.stop(); } catch (_) {}
  }
}

/* ── Send ──────────────────────────────────────────────── */
function sendMessage() {
  const input = document.getElementById("msgInput");
  const content = input.value.trim();
  if (!currentChannel) return;
  if (!content && !pendingAttach) return;
  const payload = {
    channel_id: currentChannel.id,
    content,
    reply_to_id: replyTo?.id ?? null,
  };
  if (pendingAttach) {
    payload.attachment_url  = pendingAttach.url;
    payload.attachment_type = pendingAttach.type;
    payload.attachment_name = pendingAttach.name;
  }
  socket.emit("send_message", payload);
  input.value = "";
  autoResize(input);
  cancelReply();
  cancelAttach();
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
  const is_private  = document.getElementById("newChannelPrivate").checked;
  const allow_calls = document.getElementById("newChannelAllowCalls").checked;
  if (!name) return;

  const ch = await api("/api/channels", "POST", { name, description, is_private, allow_calls });
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
  const rect = event.currentTarget.getBoundingClientRect();

  const profileAv  = document.getElementById("profileAvatar");
  const popup      = document.getElementById("profilePopup");
  const blockBtn   = document.getElementById("profileBlockBtn");
  const blockText  = document.getElementById("profileBlockText");

  // Show immediately with placeholder
  document.getElementById("profileUsername").textContent = username;
  document.getElementById("profileLogin").textContent = "";
  document.getElementById("profileBio").textContent = "";
  applyAvatar(profileAv, "", "#5865f2", username);
  blockBtn.style.display = userId === ME ? "none" : "";
  blockBtn.classList.remove("ctx-danger");
  blockText.textContent = "Заблокировать";

  popup.classList.remove("d-none");
  const popupW = 210;
  const popupH = popup.offsetHeight || 80;
  const spaceRight = window.innerWidth - rect.right;
  const left = spaceRight >= popupW + 8 ? rect.right + 8 : rect.left - popupW - 8;
  const top  = Math.min(rect.top, window.innerHeight - popupH - 8);
  popup.style.left = Math.max(4, left) + "px";
  popup.style.top  = Math.max(4, top)  + "px";

  if (userId === ME) {
    applyAvatar(profileAv, MY_AVATAR_URL, MY_COLOR, MY_DISPLAY_NAME);
    document.getElementById("profileUsername").textContent = MY_DISPLAY_NAME;
    document.getElementById("profileLogin").textContent = "@" + MY_USERNAME;
    document.getElementById("profileBio").textContent = MY_BIO;
    return;
  }

  // Load full data asynchronously
  const [userData, status] = await Promise.all([
    api(`/api/users/${userId}`).catch(() => null),
    api(`/api/users/${userId}/block_status`).catch(() => null),
  ]);
  if (userData) {
    const name = userData.display_name || userData.username;
    applyAvatar(profileAv, userData.avatar_url, userData.avatar_color, name);
    document.getElementById("profileUsername").textContent = name;
    document.getElementById("profileLogin").textContent = "@" + userData.username;
    document.getElementById("profileBio").textContent = userData.bio || "";
  }
  profileBlocked = status?.i_blocked ?? false;
  blockText.textContent = profileBlocked ? "Разблокировать" : "Заблокировать";
  blockBtn.classList.toggle("ctx-danger", !profileBlocked);
}

/* ── Settings ──────────────────────────────────────────── */
const PRESET_COLORS = ["#5865f2","#eb459e","#ed4245","#f0b232","#23a55a","#00b0f4","#593695","#ff7043"];

function openSettings() {
  const presets = document.getElementById("colorPresets");
  presets.innerHTML = "";
  PRESET_COLORS.forEach(c => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "color-preset" + (c.toLowerCase() === MY_COLOR.toLowerCase() ? " selected" : "");
    btn.style.background = c;
    btn.onclick = () => {
      document.getElementById("customColor").value = c;
      presets.querySelectorAll(".color-preset").forEach(b => b.classList.remove("selected"));
      btn.classList.add("selected");
      updateSettingsPreview();
    };
    presets.appendChild(btn);
  });
  document.getElementById("customColor").value = MY_COLOR;
  document.getElementById("settingsBio").value = MY_BIO || "";
  document.getElementById("bioCounter").textContent = `${(MY_BIO || "").length}/200`;
  document.getElementById("settingsStatus").value = MY_STATUS || "active";
  document.getElementById("settingsDisplayName").value = MY_DISPLAY_NAME === MY_USERNAME ? "" : MY_DISPLAY_NAME;
  document.getElementById("settingsDisplayName").placeholder = MY_USERNAME;
  document.getElementById("settingsLoginLabel").textContent = "@" + MY_USERNAME;
  const notifChk = document.getElementById("settingsNotifications");
  notifChk.checked = localStorage.getItem("notifications_disabled") !== "1";
  notifChk.onchange = () => {
    if (notifChk.checked) {
      localStorage.removeItem("notifications_disabled");
      if ("Notification" in window && Notification.permission === "default") {
        Notification.requestPermission();
      }
    } else {
      localStorage.setItem("notifications_disabled", "1");
    }
  };
  const nsChk = document.getElementById("settingsNoiseSuppression");
  nsChk.checked = localStorage.getItem("noise_suppression") !== "0";
  nsChk.onchange = () => {
    localStorage.setItem("noise_suppression", nsChk.checked ? "1" : "0");
  };
  renderBindsList();
  updateSettingsPreview();
  new bootstrap.Modal(document.getElementById("settingsModal")).show();
}

async function changeStatus(status) {
  await api("/api/users/me/status", "PATCH", { status });
  MY_STATUS = status;
}

/* ── Channel settings ──────────────────────────────────── */
function openChannelSettings() {
  if (!currentChannel || currentChannel.is_dm) return;
  document.getElementById("chSettingsName").value = currentChannel.name || "";
  document.getElementById("chSettingsDesc").value = currentChannel.description || "";
  applyAvatar(document.getElementById("chSettingsAvatar"),
              currentChannel.avatar_url, "#5865f2", currentChannel.name);
  document.getElementById("chRemoveAvatarBtn").style.display = currentChannel.avatar_url ? "" : "none";
  new bootstrap.Modal(document.getElementById("channelSettingsModal")).show();
}

async function saveChannelSettings() {
  const name = document.getElementById("chSettingsName").value.trim();
  const description = document.getElementById("chSettingsDesc").value.trim();
  if (!name) { alert("Название не может быть пустым"); return; }
  await api(`/api/channels/${currentChannel.id}`, "PATCH", { name, description });
  bootstrap.Modal.getInstance(document.getElementById("channelSettingsModal")).hide();
}

function uploadChannelAvatar(input) {
  _cropTarget = "channel";
  _cropChannelId = currentChannel?.id;
  const file = input.files[0];
  input.value = "";
  document.activeElement?.blur();
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) { alert("Файл больше 5 МБ"); return; }
  const reader = new FileReader();
  reader.onload = e => {
    _pendingDataUrl = e.target.result;
    // Hide channel settings modal first, then open cropper
    const settingsEl = document.getElementById("channelSettingsModal");
    const settingsInst = bootstrap.Modal.getInstance(settingsEl);
    if (settingsInst) {
      settingsEl.addEventListener("hidden.bs.modal", _afterChSettingsHidden, { once: true });
      settingsInst.hide();
    } else {
      _openCropperWithPending();
    }
  };
  reader.onerror = () => alert("Не удалось прочитать файл");
  reader.readAsDataURL(file);
}
function _afterChSettingsHidden() { _openCropperWithPending(); }

async function removeChannelAvatar() {
  if (!confirm("Удалить аватар канала?")) return;
  await api(`/api/channels/${currentChannel.id}/avatar`, "DELETE");
  currentChannel.avatar_url = "";
  applyAvatar(document.getElementById("chSettingsAvatar"),
              "", "#5865f2", currentChannel.name);
  document.getElementById("chRemoveAvatarBtn").style.display = "none";
}

function onCustomColor() {
  document.getElementById("colorPresets")
    .querySelectorAll(".color-preset").forEach(b => b.classList.remove("selected"));
  updateSettingsPreview();
}

function updateSettingsPreview() {
  const color = document.getElementById("customColor").value;
  const bio   = document.getElementById("settingsBio").value;
  const av    = document.getElementById("settingsAvatar");
  // Reset background-image override when switching colors (only if no uploaded photo)
  if (!MY_AVATAR_URL) av.style.backgroundImage = "";
  applyAvatar(av, MY_AVATAR_URL, color, MY_USERNAME);
  document.getElementById("removeAvatarBtn").style.display = MY_AVATAR_URL ? "" : "none";
  document.getElementById("bioCounter").textContent = `${bio.length}/200`;
}

let _cropper = null;
let _cropModal = null;
let _cropTarget = "user";       // "user" or "channel"
let _cropChannelId = null;

function uploadAvatar(input) {
  _cropTarget = "user";
  const file = input.files[0];
  input.value = "";
  // Move focus away so Bootstrap's aria-hidden on hide() doesn't warn
  document.activeElement?.blur();
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) {
    alert("Файл больше 5 МБ");
    return;
  }
  const reader = new FileReader();
  reader.onload = e => {
    _pendingDataUrl = e.target.result;
    const settingsEl = document.getElementById("settingsModal");
    const settingsInst = bootstrap.Modal.getInstance(settingsEl);
    if (settingsInst) {
      settingsEl.addEventListener("hidden.bs.modal", _afterSettingsHidden, { once: true });
      settingsInst.hide();
    } else {
      _openCropperWithPending();
    }
  };
  reader.onerror = () => alert("Не удалось прочитать файл");
  reader.readAsDataURL(file);
}

let _pendingDataUrl = null;
function _afterSettingsHidden() { _openCropperWithPending(); }

function _ensureCropModal() {
  let el = document.getElementById("cropModal");
  if (el) return el;
  el = document.createElement("div");
  el.className = "modal fade";
  el.id = "cropModal";
  el.tabIndex = -1;
  el.setAttribute("data-bs-backdrop", "static");
  el.innerHTML = `
    <div class="modal-dialog modal-dialog-centered">
      <div class="modal-content bg-dark-2 border-0">
        <div class="modal-header border-0 pb-0">
          <h6 class="modal-title fw-bold">Выберите область</h6>
          <button type="button" class="btn-close btn-close-white btn-sm" data-bs-dismiss="modal" onclick="cancelCrop()"></button>
        </div>
        <div class="modal-body">
          <div style="max-height:60vh;overflow:hidden"></div>
          <div class="text-muted small text-center mt-2">Двигай и масштабируй область</div>
        </div>
        <div class="modal-footer border-0 pt-0 d-flex gap-2">
          <button type="button" class="btn btn-secondary btn-sm flex-fill" data-bs-dismiss="modal" onclick="cancelCrop()">Отмена</button>
          <button type="button" class="btn btn-accent btn-sm flex-fill" onclick="confirmCrop()">Сохранить</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(el);
  return el;
}

function _loadCropperLib() {
  if (window.Cropper) return Promise.resolve();
  // Inject CSS
  if (!document.querySelector('link[data-cropper]')) {
    const css = document.createElement("link");
    css.rel = "stylesheet";
    css.href = "https://cdn.jsdelivr.net/npm/cropperjs@1.6.2/dist/cropper.min.css";
    css.dataset.cropper = "1";
    document.head.appendChild(css);
  }
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://cdn.jsdelivr.net/npm/cropperjs@1.6.2/dist/cropper.min.js";
    s.onload  = () => resolve();
    s.onerror = () => reject(new Error("Не удалось загрузить Cropper.js"));
    document.head.appendChild(s);
  });
}

async function _openCropperWithPending() {
  if (!_pendingDataUrl) return;
  const dataUrl = _pendingDataUrl;
  _pendingDataUrl = null;

  try { await _loadCropperLib(); }
  catch (e) { alert(e.message); return; }

  if (_cropper) { _cropper.destroy(); _cropper = null; }

  const cropEl = _ensureCropModal();
  const holder = cropEl.querySelector(".modal-body > div");
  holder.innerHTML = '<img id="cropImage" style="max-width:100%;display:block">';
  const img = holder.firstElementChild;

  _cropModal = bootstrap.Modal.getOrCreateInstance(cropEl);

  cropEl.addEventListener("shown.bs.modal", function once() {
    cropEl.removeEventListener("shown.bs.modal", once);
    const init = () => {
      _cropper = new Cropper(img, {
        aspectRatio: 1, viewMode: 1, autoCropArea: 0.9, background: false,
        movable: true, zoomable: true, scalable: false, rotatable: false, dragMode: "move",
      });
    };
    if (img.complete && img.naturalWidth) init();
    else img.onload = init;
  });
  img.src = dataUrl;
  _cropModal.show();
}

function cancelCrop() {
  document.activeElement?.blur();
  if (_cropper) { _cropper.destroy(); _cropper = null; }
  const target = _cropTarget;
  setTimeout(() => {
    if (target === "channel") openChannelSettings();
    else                       openSettings();
  }, 200);
}

async function confirmCrop() {
  if (!_cropper) return;
  const canvas = _cropper.getCroppedCanvas({ width: 256, height: 256, imageSmoothingQuality: "high" });
  const target = _cropTarget;
  const chId   = _cropChannelId;
  canvas.toBlob(async blob => {
    const fd = new FormData();
    fd.append("file", new File([blob], "avatar.png", { type: "image/png" }));
    const url = target === "channel"
      ? `/api/channels/${chId}/avatar`
      : "/api/users/me/avatar";
    try {
      const r = await fetch(url, { method: "POST", body: fd });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        alert(err.error || `Ошибка ${r.status}`);
        return;
      }
      const data = await r.json();
      if (target === "channel") {
        if (currentChannel?.id === chId) currentChannel.avatar_url = data.avatar_url;
        // socket "channel_updated" will refresh other clients
      } else {
        MY_AVATAR_URL = (data.avatar_url || "") + "?t=" + Date.now();
        refreshOwnAvatars();
      }
      document.activeElement?.blur();
      _cropModal?.hide();
      if (_cropper) { _cropper.destroy(); _cropper = null; }
      // Re-open the appropriate settings modal
      setTimeout(() => {
        if (target === "channel") openChannelSettings();
        else                       openSettings();
      }, 200);
    } catch (e) {
      alert("Ошибка загрузки: " + e.message);
    }
  }, "image/png");
}

async function removeAvatar() {
  if (!confirm("Удалить фото профиля?")) return;
  await api("/api/users/me/avatar", "DELETE");
  MY_AVATAR_URL = "";
  refreshOwnAvatars();
  updateSettingsPreview();
}

function refreshOwnAvatars() {
  applyAvatar(document.getElementById("myAvatar"), MY_AVATAR_URL, MY_COLOR, MY_USERNAME);
  document.querySelectorAll(`[data-sender-id="${ME}"] .avatar`).forEach(av => {
    applyAvatar(av, MY_AVATAR_URL, MY_COLOR, MY_USERNAME);
  });
  const memberAv = document.querySelector(`[data-uid="${ME}"] .avatar`);
  if (memberAv) applyAvatar(memberAv, MY_AVATAR_URL, MY_COLOR, MY_USERNAME);
}

async function saveProfile() {
  const color = document.getElementById("customColor").value;
  const bio   = document.getElementById("settingsBio").value.trim();
  const display_name = document.getElementById("settingsDisplayName").value.trim();
  const data = await api("/api/users/me", "PATCH", { bio, avatar_color: color, display_name });
  MY_COLOR = color;
  MY_BIO   = bio;
  MY_DISPLAY_NAME = data.display_name;
  document.getElementById("myUsername").textContent = MY_DISPLAY_NAME;
  refreshOwnAvatars();
  document.activeElement?.blur();
  bootstrap.Modal.getInstance(document.getElementById("settingsModal")).hide();
}

async function profileToggleBlock() {
  if (!profileUserId || profileUserId === ME) return;
  const action = profileBlocked ? "unblock" : "block";
  await api(`/api/users/${profileUserId}/${action}`, "POST");
  profileBlocked = !profileBlocked;
  document.getElementById("profileBlockText").textContent = profileBlocked ? "Разблокировать" : "Заблокировать";
  document.getElementById("profileBlockBtn").classList.toggle("ctx-danger", !profileBlocked);
  document.getElementById("profilePopup").classList.add("d-none");

  // Refresh input/header if we're in DM with this user
  if (currentChannel?.is_dm && currentChannel?.partner_id === profileUserId) {
    await renderChatActions(currentChannel);
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
        <div class="avatar avatar-sm ${u.avatar_url ? 'has-img' : ''}" style="${avatarStyle(u.avatar_url, u.avatar_color)}">${avatarLetter(u.avatar_url, u.display_name || u.username)}</div>
        <div style="display:flex;flex-direction:column;min-width:0">
          <span class="text-truncate">${esc(u.display_name || u.username)}</span>
          ${u.display_name && u.display_name !== u.username ? `<span class="text-muted" style="font-size:.72rem">@${esc(u.username)}</span>` : ""}
        </div>`;
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
  socket.emit("join", { channel_id: ch.id });
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

/* ── Channel (group) calls ──────────────────────────────
   Mesh topology: each participant has a separate RTCPeerConnection
   to every other participant. State per-channel is in _channelCall. */

let _channelCall = null;  // { channelId, pcs:Map(uid->RTCPC), localStream, tiles:Map(uid->el), audioVols:Map }
const _channelActiveCalls = new Set();  // channel ids with an active call

async function toggleChannelCalls(channelId, allow) {
  await api(`/api/channels/${channelId}`, "PATCH", { allow_calls: !!allow });
  // ch.allow_calls is updated via channel_updated socket on all members
}

socket.on("channel_updated", ch => {
  // Strip my_role — it was computed for the sender, not for us
  const { my_role: _ignore, ...patch } = ch;
  if (currentChannel?.id === ch.id) {
    Object.assign(currentChannel, patch);
    document.getElementById("chatName").textContent = ch.name;
    setChatHeaderAvatar(ch.avatar_url, "#5865f2", ch.name);
    renderChatActions(currentChannel);
  }
  const c = allChannels.find(x => x.id === ch.id);
  if (c) Object.assign(c, patch);
  renderSidebar(allChannels);
});

const _channelCallParticipants = new Map();  // channel_id -> count

socket.on("channel_call_status", ({ channel_id, active, participants }) => {
  const wasActive = _channelActiveCalls.has(channel_id);
  const prevCount = _channelCallParticipants.get(channel_id) || 0;
  const newCount  = (participants || []).length;
  if (active) _channelActiveCalls.add(channel_id);
  else        _channelActiveCalls.delete(channel_id);
  _channelCallParticipants.set(channel_id, newCount);
  renderSidebar(allChannels);
  if (currentChannel?.id === channel_id) renderActiveCallBanner();

  const iAmInIt = _channelCall?.channelId === channel_id ||
                  (participants && participants.includes(ME));

  // Ring on transition inactive→active (call just started)
  const justStarted = active && !wasActive;
  if (justStarted && !iAmInIt && !mutedChannels.has(channel_id) && MY_STATUS !== "dnd") {
    _callRingStart(false);
    setTimeout(_callRingStop, 8000);
  }

  // Stop the ring if: someone else joined (count grew while we're not in it),
  // we're now in it, or the call ended
  if (!active || iAmInIt || (newCount > prevCount && newCount > 1)) {
    _callRingStop();
  }
});

socket.on("channel_call_error", ({ error }) => alert(error || "Ошибка"));

async function joinChannelCall() {
  if (!currentChannel || currentChannel.is_dm) return;
  if (_channelCall) return alert("Вы уже в звонке");
  if (currentChannel.allow_calls === false) return alert("Звонки отключены");
  _callRingStop();  // stop any incoming ring for this channel call
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: _audioConstraints(), video: false });
    _channelCall = {
      channelId: currentChannel.id,
      pcs: new Map(),
      localStream: stream,
      tiles: new Map(),
    };
    socket.emit("channel_call_join", { channel_id: currentChannel.id });
    showChannelCallPanel();
    addParticipantTile({ id: ME, username: MY_USERNAME, avatar_url: MY_AVATAR_URL, avatar_color: MY_COLOR }, true);
  } catch (e) {
    alert("Не удалось получить микрофон: " + e.message);
    _channelCall = null;
  }
}

socket.on("channel_call_joined", async ({ channel_id, existing_participants }) => {
  if (!_channelCall || _channelCall.channelId !== channel_id) return;
  for (const p of existing_participants) {
    // Robust to both formats: plain id OR {id, username, ...}
    let user;
    if (typeof p === "object" && p && p.id) {
      user = p;
    } else {
      // Old server format — fetch user details
      try { user = await api(`/api/users/${p}`); }
      catch (_) { user = { id: p, username: "User " + p, avatar_color: "#5865f2" }; }
    }
    addParticipantTile(user, false);
    const pc = await _createPeerConnection(user.id);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit("channel_call_signal", {
      channel_id, to_user_id: user.id, type: "offer", data: offer
    });
  }
});

socket.on("channel_call_peer_joined", async ({ channel_id, user }) => {
  if (!_channelCall || _channelCall.channelId !== channel_id) return;
  // A new peer joined — they will send us an offer; just add their tile
  addParticipantTile(user, false);
});

socket.on("channel_call_peer_left", ({ channel_id, user_id }) => {
  if (!_channelCall || _channelCall.channelId !== channel_id) return;
  const pc = _channelCall.pcs.get(user_id);
  if (pc) { try { pc.close(); } catch (_) {} _channelCall.pcs.delete(user_id); }
  removeParticipantTile(user_id);
});

socket.on("channel_call_signal", async msg => {
  if (!_channelCall || _channelCall.channelId !== msg.channel_id) return;
  const fromUid = msg.from_user_id;
  let pc = _channelCall.pcs.get(fromUid);
  if (msg.type === "offer") {
    if (!pc) pc = await _createPeerConnection(fromUid);
    // Make sure tile exists
    if (!_channelCall.tiles.has(fromUid)) {
      addParticipantTile({
        id: fromUid, username: msg.from_username,
        avatar_url: msg.from_avatar_url, avatar_color: msg.from_avatar_color,
      }, false);
    }
    await pc.setRemoteDescription(msg.data);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit("channel_call_signal", {
      channel_id: msg.channel_id, to_user_id: fromUid, type: "answer", data: answer
    });
  } else if (msg.type === "answer") {
    if (!pc) return;
    try { await pc.setRemoteDescription(msg.data); } catch (_) {}
  } else if (msg.type === "ice") {
    if (!pc) return;
    try { await pc.addIceCandidate(msg.data); } catch (_) {}
  }
});

async function _createPeerConnection(remoteUid) {
  const pc = new RTCPeerConnection(ICE_CONFIG);
  _channelCall.pcs.set(remoteUid, pc);
  // Add our local tracks
  _channelCall.localStream.getTracks().forEach(t => pc.addTrack(t, _channelCall.localStream));
  pc.onicecandidate = e => {
    if (e.candidate) {
      socket.emit("channel_call_signal", {
        channel_id: _channelCall.channelId, to_user_id: remoteUid,
        type: "ice", data: e.candidate
      });
    }
  };
  pc.ontrack = e => {
    const stream = e.streams[0];
    const tile = _channelCall.tiles.get(remoteUid);
    if (!tile) return;
    // Screen share track? — by stream-id flag set via "screen_start" signal
    if (_channelCall.screenStreamIds?.has(stream.id)) {
      _renderChannelScreenStream(stream, remoteUid);
      return;
    }
    if (e.track.kind === "audio") {
      let audio = tile.querySelector("audio");
      if (!audio) {
        audio = document.createElement("audio");
        audio.autoplay = true;
        tile.appendChild(audio);
      }
      audio.srcObject = stream;
      audio.muted = _isDeafened;
      if (_selectedSpeakerId && audio.setSinkId) {
        try { audio.setSinkId(_selectedSpeakerId); } catch (_) {}
      }
      _setupTileGain(remoteUid, audio);
    } else if (e.track.kind === "video") {
      let video = tile.querySelector("video");
      if (!video) {
        video = document.createElement("video");
        video.autoplay = true; video.playsInline = true; video.muted = true;
        video.className = "call-video";
        tile.insertBefore(video, tile.firstChild);
      }
      video.srcObject = stream;
      const av = tile.querySelector(".call-avatar-xl");
      if (av) av.style.display = "none";
      e.track.onended = () => {
        video.remove();
        if (av) av.style.display = "";
      };
    }
  };
  return pc;
}

function addParticipantTile(user, isMe) {
  if (!_channelCall) return;
  if (!user || !user.id) { console.warn("addParticipantTile: bad user", user); return; }
  if (_channelCall.tiles.has(user.id)) return;
  const grid = document.getElementById("callTiles");
  // Hide old DM-style tiles in group call mode
  document.getElementById("callPartnerTile").classList.add("d-none");
  document.getElementById("callLocalTile").classList.add("d-none");

  const tile = document.createElement("div");
  tile.className = "call-tile";
  tile.dataset.uid = user.id;
  tile.innerHTML = `
    <div class="call-avatar-xl"></div>
    ${!isMe ? `
    <div class="tile-vol">
      <i class="bi bi-volume-up-fill"></i>
      <input type="range" min="0" max="100" value="100" oninput="setChannelParticipantVolume(${user.id}, this.value)">
      <span class="vol-pct">100%</span>
    </div>` : ""}
    <div class="call-tile-footer">
      <span class="speaking-dot"></span>
      <span class="call-tile-name">${esc(user.username || ("User " + user.id))}${isMe ? " (Вы)" : ""}</span>
    </div>`;
  applyAvatar(tile.querySelector(".call-avatar-xl"),
              user.avatar_url, user.avatar_color, user.username || "?");
  grid.appendChild(tile);
  _channelCall.tiles.set(user.id, tile);
}

function removeParticipantTile(uid) {
  if (!_channelCall) return;
  const t = _channelCall.tiles.get(uid);
  if (!t) return;
  // Stop the audio playback in this tile
  const a = t.querySelector("audio");
  if (a) { try { a.pause(); a.srcObject = null; } catch (_) {} }
  t.remove();
  _channelCall.tiles.delete(uid);
}

function _setupTileGain() { /* no-op now; use native audio.volume */ }

function setChannelParticipantVolume(uid, pct) {
  if (!_channelCall) return;
  const tile = _channelCall.tiles.get(uid);
  if (!tile) return;
  const audioEl = tile.querySelector("audio");
  if (!audioEl) return;
  const v = (parseInt(pct) || 0) / 100;
  audioEl.muted = (v === 0);
  audioEl.volume = Math.min(1, v);
  const pctEl = tile.querySelector(".vol-pct");
  if (pctEl) pctEl.textContent = pct + "%";
}

let _chSpeakingRAF = null;
let _chAnalyses = new Map(); // uid -> { analyser, data, ctx }

function _startChannelSpeakingDetection() {
  _stopChannelSpeakingDetection();
  const AC = window.AudioContext || window.webkitAudioContext;
  // Local
  if (_channelCall?.localStream?.getAudioTracks().length) {
    try {
      const ctx = new AC();
      const src = ctx.createMediaStreamSource(_channelCall.localStream);
      const an = ctx.createAnalyser(); an.fftSize = 256;
      src.connect(an);
      _chAnalyses.set(ME, { analyser: an, data: new Uint8Array(an.frequencyBinCount), ctx });
    } catch (_) {}
  }
  const reattach = () => {
    if (!_channelCall) return;
    for (const [uid, tile] of _channelCall.tiles) {
      if (uid === ME || _chAnalyses.has(uid)) continue;
      const a = tile.querySelector("audio");
      if (a?.srcObject) {
        try {
          const ctx = new AC();
          const src = ctx.createMediaStreamSource(a.srcObject);
          const an = ctx.createAnalyser(); an.fftSize = 256;
          src.connect(an);
          _chAnalyses.set(uid, { analyser: an, data: new Uint8Array(an.frequencyBinCount), ctx });
        } catch (_) {}
      }
    }
  };
  reattach();
  const reInt = setInterval(reattach, 1500);

  const loop = () => {
    if (!_channelCall) { clearInterval(reInt); _stopChannelSpeakingDetection(); return; }
    // Drop analyses for tiles that no longer exist
    for (const uid of [..._chAnalyses.keys()]) {
      if (uid !== ME && !_channelCall.tiles.has(uid)) {
        const e = _chAnalyses.get(uid);
        try { e.ctx.close(); } catch (_) {}
        _chAnalyses.delete(uid);
      }
    }
    const aTrack = _channelCall.localStream?.getAudioTracks()[0];
    const micOn = aTrack ? aTrack.enabled : false;
    for (const [uid, { analyser, data }] of _chAnalyses) {
      analyser.getByteFrequencyData(data);
      let s = 0; for (let i = 0; i < data.length; i++) s += data[i];
      const power = s / data.length / 255;
      const tile = _channelCall.tiles.get(uid);
      if (!tile) continue;
      const speaking = power > 0.05 && (uid !== ME || micOn);
      tile.classList.toggle("speaking", speaking);
      tile.querySelector(".speaking-dot")?.classList.toggle("active", speaking);
    }
    _chSpeakingRAF = requestAnimationFrame(loop);
  };
  _chSpeakingRAF = requestAnimationFrame(loop);
}

function _stopChannelSpeakingDetection() {
  if (_chSpeakingRAF) cancelAnimationFrame(_chSpeakingRAF);
  _chSpeakingRAF = null;
  for (const e of _chAnalyses.values()) try { e.ctx.close(); } catch (_) {}
  _chAnalyses.clear();
}

function showChannelCallPanel() {
  document.getElementById("callName").textContent = currentChannel.name;
  document.getElementById("callStatus").textContent = "Звонок в канале";
  applyAvatar(document.getElementById("callAvatar"), "", "#5865f2", currentChannel.name);
  applyAvatar(document.getElementById("callMiniAvatar"), "", "#5865f2", currentChannel.name);
  document.getElementById("callMiniName").textContent = currentChannel.name;
  // Hide screen / dm-only tiles
  document.getElementById("callScreenTile").classList.add("d-none");
  document.getElementById("callPanel").classList.remove("d-none");
  document.querySelector("#callPanel .call-window").style.display = "";
  document.getElementById("callMiniBar").classList.add("d-none");
  // Reset position
  const win = document.querySelector("#callPanel .call-window");
  win.style.transform = "translate(-50%, -50%)";
  win.style.left = "50%"; win.style.top = "50%";
  _initCallDrag();
  _startChannelSpeakingDetection();
}

function leaveChannelCall() {
  if (!_channelCall) return;
  const leftChannelId = _channelCall.channelId;
  const remainingAfterMe = Math.max(0, _channelCall.tiles.size - 1);
  _stopChannelSpeakingDetection();
  socket.emit("channel_call_leave", { channel_id: leftChannelId });
  for (const pc of _channelCall.pcs.values()) try { pc.close(); } catch (_) {}
  _channelCall.localStream?.getTracks().forEach(t => t.stop());
  for (const [, t] of _channelCall.tiles) t.remove();
  // Close per-tile audio contexts
  if (_channelCall.tileGains) {
    for (const info of _channelCall.tileGains.values()) {
      try { info.ctx.close(); } catch (_) {}
    }
  }
  _channelCall = null;
  document.getElementById("callPartnerTile").classList.remove("d-none");
  document.getElementById("callLocalTile").classList.remove("d-none");
  document.getElementById("callPanel").classList.add("d-none");
  document.getElementById("callMiniBar").classList.add("d-none");
  // If we were the last one — clear active state immediately (don't wait for server)
  if (remainingAfterMe === 0) {
    _channelActiveCalls.delete(leftChannelId);
    _channelCallParticipants.delete(leftChannelId);
  }
  renderSidebar(allChannels);
  renderActiveCallBanner();
}

/* ── Channel call: camera ──────────────────────────────── */
async function _toggleChannelVideo() {
  const stream = _channelCall.localStream;
  const existing = stream.getVideoTracks();
  const btn = document.getElementById("callVideoBtn");
  if (existing.length) {
    const enabled = existing[0].enabled;
    existing.forEach(t => t.enabled = !enabled);
    const myTile = _channelCall.tiles.get(ME);
    const lv = myTile?.querySelector("video");
    const la = myTile?.querySelector(".call-avatar-xl");
    if (lv) lv.style.display = enabled ? "none" : "";
    if (la) la.style.display = enabled ? "" : "none";
    btn.classList.toggle("active", enabled);
    btn.innerHTML = enabled ? '<i class="bi bi-camera-video-off-fill"></i>' : '<i class="bi bi-camera-video-fill"></i>';
    return;
  }
  try {
    const vstream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 } });
    const vtrack = vstream.getVideoTracks()[0];
    stream.addTrack(vtrack);
    // Add to all PCs and renegotiate with each
    for (const [uid, pc] of _channelCall.pcs) {
      pc.addTrack(vtrack, stream);
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit("channel_call_signal", {
        channel_id: _channelCall.channelId, to_user_id: uid, type: "offer", data: offer
      });
    }
    // Local preview in own tile
    const myTile = _channelCall.tiles.get(ME);
    if (myTile) {
      let v = myTile.querySelector("video");
      if (!v) {
        v = document.createElement("video");
        v.autoplay = true; v.playsInline = true; v.muted = true;
        v.className = "call-video";
        myTile.insertBefore(v, myTile.firstChild);
      }
      v.srcObject = stream;
      const av = myTile.querySelector(".call-avatar-xl");
      if (av) av.style.display = "none";
    }
    btn.classList.remove("active");
    btn.innerHTML = '<i class="bi bi-camera-video-fill"></i>';
  } catch (e) {
    alert("Не удалось включить камеру: " + e.message);
  }
}

/* ── Channel call: screen share ────────────────────────── */
let _channelScreen = null;  // { stream, vSender:Map(uid->RTCRtpSender), aSender:Map }

async function _startChannelScreenShare(surface) {
  if (!_channelCall) return;
  if (_channelScreen) { return _stopChannelScreenShare(); }
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { displaySurface: surface }, audio: true,
    });
    const vTrack = stream.getVideoTracks()[0];
    const aTrack = stream.getAudioTracks()[0];
    _channelScreen = { stream, vSender: new Map(), aSender: new Map() };
    _channelCall.screenStreamIds = new Set([stream.id]);

    // Notify all peers about the screen stream id
    for (const uid of _channelCall.pcs.keys()) {
      socket.emit("channel_call_signal", {
        channel_id: _channelCall.channelId, to_user_id: uid,
        type: "screen_start", data: { stream_id: stream.id }
      });
    }
    // Add tracks to every PC and renegotiate
    for (const [uid, pc] of _channelCall.pcs) {
      _channelScreen.vSender.set(uid, pc.addTrack(vTrack, stream));
      if (aTrack) _channelScreen.aSender.set(uid, pc.addTrack(aTrack, stream));
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit("channel_call_signal", {
        channel_id: _channelCall.channelId, to_user_id: uid, type: "offer", data: offer
      });
    }
    // Local preview into the screen tile (shared with DM call HTML)
    document.getElementById("callScreenVideo").srcObject = stream;
    document.getElementById("callScreenTile").classList.remove("d-none");
    document.getElementById("callScreenBtn").classList.add("on");

    vTrack.onended = () => _stopChannelScreenShare();
  } catch (e) {
    if (e.name !== "NotAllowedError" && e.name !== "AbortError") {
      alert("Не удалось включить демонстрацию: " + e.message);
    }
  }
}

async function _stopChannelScreenShare() {
  if (!_channelCall || !_channelScreen) return;
  const sStream = _channelScreen.stream;
  sStream.getTracks().forEach(t => t.stop());

  for (const [uid, pc] of _channelCall.pcs) {
    const vs = _channelScreen.vSender.get(uid);
    const as = _channelScreen.aSender.get(uid);
    if (vs) try { pc.removeTrack(vs); } catch (_) {}
    if (as) try { pc.removeTrack(as); } catch (_) {}
    socket.emit("channel_call_signal", {
      channel_id: _channelCall.channelId, to_user_id: uid, type: "screen_stop"
    });
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit("channel_call_signal", {
        channel_id: _channelCall.channelId, to_user_id: uid, type: "offer", data: offer
      });
    } catch (_) {}
  }
  _channelCall.screenStreamIds?.delete(sStream.id);
  _channelScreen = null;

  document.getElementById("callScreenVideo").srcObject = null;
  document.getElementById("callScreenTile").classList.add("d-none");
  document.getElementById("callScreenBtn").classList.remove("on");
}

function _renderChannelScreenStream(stream, fromUid) {
  const sv = document.getElementById("callScreenVideo");
  const sa = document.getElementById("callScreenAudio");
  const tile = document.getElementById("callScreenTile");
  if (stream.getVideoTracks().length) {
    sv.srcObject = stream;
    tile.classList.remove("d-none");
  }
  if (stream.getAudioTracks().length) {
    sa.srcObject = stream;
    sa.muted = _isDeafened;
    document.getElementById("screenVolWrap").classList.remove("d-none");
  }
}

// Channel-aware screen-share entry point
async function startScreenShare(surface) {
  document.getElementById("screenShareMenu").classList.add("d-none");
  if (_channelCall) return _startChannelScreenShare(surface);
  return _startDmScreenShare(surface);
}

// Handle channel screen signals
socket.on("channel_call_signal", msg => {
  if (!_channelCall || _channelCall.channelId !== msg.channel_id) return;
  if (msg.type === "screen_start") {
    _channelCall.screenStreamIds = _channelCall.screenStreamIds || new Set();
    if (msg.data?.stream_id) _channelCall.screenStreamIds.add(msg.data.stream_id);
  } else if (msg.type === "screen_stop") {
    document.getElementById("callScreenTile").classList.add("d-none");
    document.getElementById("screenVolWrap").classList.add("d-none");
    document.getElementById("callScreenVideo").srcObject = null;
    document.getElementById("callScreenAudio").srcObject = null;
  }
});

/* ── WebRTC calls ──────────────────────────────────────── */
window.addEventListener("beforeunload", e => {
  if (_callPC) {
    e.preventDefault();
    e.returnValue = "Идёт звонок — точно закрыть?";
    return e.returnValue;
  }
});


const ICE_CONFIG = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
  ]
};
let _callPC       = null;
let _callStream   = null;
let _callPartner  = null;   // {id, username, avatar_url, avatar_color}
let _callIsCaller = false;
let _callType     = "audio";
let _callPendingIce = [];   // ICE candidates received before remote desc set
let _callStartTs  = 0;
let _callTimerInt = null;
let _callIncoming = null;   // pending invite payload
let _callRingAudio = null;
let _callRingTimer = null;

let _ringAudio = null;
function _buildRingTone() {
  // 2-second WAV: two tones (ring-ring pattern), gets looped via <audio loop>
  const sampleRate = 44100;
  const total = sampleRate * 2;  // 2 seconds
  const buf = new ArrayBuffer(44 + total * 2);
  const v = new DataView(buf);
  v.setUint32(0, 0x52494646, false); v.setUint32(4, 36 + total * 2, true);
  v.setUint32(8, 0x57415645, false); v.setUint32(12, 0x666d7420, false);
  v.setUint32(16, 16, true);  v.setUint16(20, 1, true);  v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true);  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);  v.setUint16(34, 16, true);
  v.setUint32(36, 0x64617461, false); v.setUint32(40, total * 2, true);
  for (let i = 0; i < total; i++) {
    const t = i / sampleRate;
    let s = 0;
    // Ring-ring pattern: two short rings then pause
    const inRing1 = (t >= 0    && t < 0.45);
    const inRing2 = (t >= 0.55 && t < 1.0);
    if (inRing1 || inRing2) {
      // Mix 440 + 480 Hz like a phone ring
      s = (Math.sin(2 * Math.PI * 440 * t) + Math.sin(2 * Math.PI * 480 * t)) * 0.25;
    }
    v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, s)) * 0x7fff, true);
  }
  const blob = new Blob([buf], { type: "audio/wav" });
  const a = new Audio(URL.createObjectURL(blob));
  a.loop = true;
  a.volume = 0.55;
  return a;
}

function _callRingStart(loop) {
  _callRingStop();
  if (!_ringAudio) _ringAudio = _buildRingTone();
  try {
    _ringAudio.currentTime = 0;
    const p = _ringAudio.play();
    if (p && p.catch) p.catch(() => {});
  } catch (_) {}
  if (!loop) {
    _callRingTimer = setTimeout(_callRingStop, 30000);
  }
}
function _callRingStop() {
  if (_callRingTimer) { clearTimeout(_callRingTimer); _callRingTimer = null; }
  if (_ringAudio) { try { _ringAudio.pause(); _ringAudio.currentTime = 0; } catch (_) {} }
}

let _disconnectTimeout = null;
let _expectedScreenStreamId = null;  // set by "screen_start" signal
let _amAlone = false;                // partner left, but I'm still in the call panel

function _setupPC(partnerId) {
  const pc = new RTCPeerConnection(ICE_CONFIG);
  pc.onicecandidate = e => {
    if (e.candidate) {
      socket.emit("call_signal", { to_user_id: partnerId, type: "ice", data: e.candidate });
    }
  };
  // Track inbound streams. Multiple tracks may arrive: mic, camera, screen video, screen audio.
  // Heuristic: if a track's stream has only that track and it's video — likely screen. Otherwise camera.
  pc.ontrack = e => {
    const stream = e.streams[0] || new MediaStream([e.track]);
    const t = e.track;
    const isScreen = _expectedScreenStreamId && stream.id === _expectedScreenStreamId;
    if (t.kind === "audio") {
      if (isScreen) {
        const sa = document.getElementById("callScreenAudio");
        sa.srcObject = stream;
        _setupScreenVolume();
        document.getElementById("screenVolWrap").classList.remove("d-none");
      } else {
        const mainAudio = document.getElementById("callRemoteAudio");
        mainAudio.srcObject = stream;
        _setupPartnerVolume();
      }
    } else if (t.kind === "video") {
      if (isScreen) {
        const sv = document.getElementById("callScreenVideo");
        sv.srcObject = stream;
        document.getElementById("callScreenTile").classList.remove("d-none");
        t.onended = () => {
          document.getElementById("callScreenTile").classList.add("d-none");
          document.getElementById("screenVolWrap").classList.add("d-none");
          sv.srcObject = null;
          const sa = document.getElementById("callScreenAudio");
          if (sa.srcObject) sa.srcObject = null;
        };
      } else {
        const camV = document.getElementById("callRemoteVideo");
        camV.srcObject = stream;
        camV.classList.remove("d-none");
        document.getElementById("callPartnerAvatar").style.display = "none";
      }
    }
  };
  pc.onconnectionstatechange = () => {
    const s = pc.connectionState;
    if (s === "connected") {
      if (_disconnectTimeout) { clearTimeout(_disconnectTimeout); _disconnectTimeout = null; }
      document.getElementById("callStatus").textContent = "В разговоре";
      if (!_callStartTs) {
        _callStartTs = Date.now();
        _callTimerInt = setInterval(() => {
          const sec = Math.floor((Date.now() - _callStartTs) / 1000);
          const t = `${Math.floor(sec/60)}:${String(sec%60).padStart(2,'0')}`;
          document.getElementById("callTimer").textContent = t;
          document.getElementById("callMiniTimer").textContent = t;
        }, 500);
      }
    } else if (s === "disconnected") {
      // Brief drop — wait up to 30s before giving up
      document.getElementById("callStatus").textContent = "Переподключение...";
      if (_disconnectTimeout) clearTimeout(_disconnectTimeout);
      _disconnectTimeout = setTimeout(() => {
        if (_callPC && _callPC.connectionState !== "connected") endCall();
      }, 30000);
    } else if (s === "failed" || s === "closed") {
      endCall();
    }
  };
  return pc;
}

/* ── Per-source volume (per audio element, ready for multi-user) ──
   _audioVols: id -> { audioEl, gain, srcCtx, sliderEl, pctEl }
   Setting volume to 0 fully mutes (audio.muted=true) so silence is guaranteed
   even if Web Audio routing failed for some reason. */
const _audioVols = new Map();

function _attachVolumeControl(key, audioEl, sliderEl, pctEl) {
  if (_audioVols.has(key)) return;
  // Native audio.volume only — no Web Audio (which has too many edge cases)
  const entry = { audioEl, sliderEl, pctEl };
  _audioVols.set(key, entry);
  _applyVol(entry, sliderEl.value);
}

function _applyVol(entry, pct) {
  const v = (parseInt(pct) || 0) / 100;
  if (entry.pctEl) entry.pctEl.textContent = pct + "%";
  entry.audioEl.muted = (v === 0);
  entry.audioEl.volume = Math.min(1, v);
}

// Public — call from sliders
function setPartnerVolume(pct) {
  const e = _audioVols.get("partner");
  if (e) _applyVol(e, pct);
  else {
    // Pre-setup fallback — at least update UI/text
    document.getElementById("volPartnerPct").textContent = pct + "%";
    const a = document.getElementById("callRemoteAudio");
    a.muted = (parseInt(pct) === 0);
    a.volume = Math.min(1, (parseInt(pct) || 0) / 100);
  }
}
function setScreenVolume(pct) {
  const e = _audioVols.get("screen");
  if (e) _applyVol(e, pct);
  else {
    document.getElementById("volScreenPct").textContent = pct + "%";
    const a = document.getElementById("callScreenAudio");
    a.muted = (parseInt(pct) === 0);
    a.volume = Math.min(1, (parseInt(pct) || 0) / 100);
  }
}

function _setupPartnerVolume() {
  _attachVolumeControl("partner",
    document.getElementById("callRemoteAudio"),
    document.getElementById("volPartnerSlider"),
    document.getElementById("volPartnerPct"));
}
function _setupScreenVolume() {
  _attachVolumeControl("screen",
    document.getElementById("callScreenAudio"),
    document.getElementById("volScreenSlider"),
    document.getElementById("volScreenPct"));
}

/* ── Screen tile fullscreen ────────────────────────────── */
function toggleScreenFullscreen() {
  const el = document.getElementById("callScreenTile");
  if (!el) return;
  if (document.fullscreenElement) {
    document.exitFullscreen?.();
  } else {
    (el.requestFullscreen || el.webkitRequestFullscreen)?.call(el);
  }
}
document.addEventListener("fullscreenchange", () => {
  const icon = document.getElementById("screenFsIcon");
  if (!icon) return;
  icon.className = document.fullscreenElement
    ? "bi bi-fullscreen-exit"
    : "bi bi-arrows-fullscreen";
});

/* ── Draggable call window ─────────────────────────────── */
function _initCallDrag() {
  const win = document.querySelector("#callPanel .call-window");
  const bar = win?.querySelector(".call-topbar");
  if (!win || !bar || bar._dragInit) return;
  bar._dragInit = true;
  let dx = 0, dy = 0, dragging = false;
  bar.addEventListener("mousedown", e => {
    // Ignore clicks on buttons inside topbar
    if (e.target.closest("button")) return;
    dragging = true;
    const r = win.getBoundingClientRect();
    dx = e.clientX - r.left;
    dy = e.clientY - r.top;
    win.style.transform = "none";  // detach from centering
    win.style.left = r.left + "px";
    win.style.top  = r.top  + "px";
    document.body.style.userSelect = "none";
  });
  document.addEventListener("mousemove", e => {
    if (!dragging) return;
    const w = win.offsetWidth, h = win.offsetHeight;
    const maxX = window.innerWidth  - w;
    const maxY = window.innerHeight - h;
    win.style.left = Math.max(0, Math.min(maxX, e.clientX - dx)) + "px";
    win.style.top  = Math.max(0, Math.min(maxY, e.clientY - dy)) + "px";
  });
  document.addEventListener("mouseup", () => {
    if (dragging) {
      dragging = false;
      document.body.style.userSelect = "";
    }
  });
}

/* ── Minimize/restore call window ───────────────────────── */
function minimizeCall() {
  document.querySelector("#callPanel .call-window").style.display = "none";
  const m = document.getElementById("callMiniBar");
  m.classList.remove("d-none");
}
function restoreCall() {
  document.querySelector("#callPanel .call-window").style.display = "";
  document.getElementById("callMiniBar").classList.add("d-none");
}

function _audioConstraints() {
  // Honour user toggle stored in localStorage
  const ns = localStorage.getItem("noise_suppression") !== "0";
  return {
    echoCancellation: ns,
    noiseSuppression: ns,
    autoGainControl:  ns,
  };
}

async function _getMedia(type) {
  return navigator.mediaDevices.getUserMedia({
    audio: _audioConstraints(),
    video: type === "video" ? { width: 640, height: 480 } : false,
  });
}

async function startCall(type) {
  if (_callPC) return alert("Вы уже в звонке");
  if (!currentChannel?.is_dm || !currentChannel.partner_id) return;
  const partner = {
    id: currentChannel.partner_id,
    username: currentChannel.name,
    avatar_url: currentChannel.partner_avatar_url || "",
    avatar_color: currentChannel.partner_avatar_color || "#5865f2",
  };
  try {
    _callStream = await _getMedia(type);
  } catch (e) {
    return alert("Не удалось получить доступ к микрофону/камере: " + e.message);
  }
  _callIsCaller = true;
  _callType = type;
  _callPartner = partner;
  _callPendingIce = [];

  _callPC = _setupPC(partner.id);
  _callStream.getTracks().forEach(t => _callPC.addTrack(t, _callStream));
  if (type === "video") {
    document.getElementById("callLocalVideo").srcObject = _callStream;
    document.getElementById("callVideoWrap").classList.remove("d-none");
  }

  showCallPanel(partner, "Вызов...");
  _callRingStart(false);

  const offer = await _callPC.createOffer();
  await _callPC.setLocalDescription(offer);
  socket.emit("call_signal", {
    to_user_id: partner.id,
    type: "invite",
    data: { sdp: offer, callType: type },
  });

  // Auto-cancel if no answer in 30s
  setTimeout(() => {
    if (_callPC && !_callPC.remoteDescription) {
      alert("Нет ответа");
      endCall();
    }
  }, 30000);
}

socket.on("call_signal", async msg => {
  const t = msg.type;
  if (t === "invite") {
    // If I'm alone in a call panel waiting for THIS user — auto-accept (no ring/modal)
    if (_amAlone && _callPartner?.id === msg.from_user_id) {
      _callIncoming = msg;
      _amAlone = false;
      document.getElementById("callStatus").textContent = "Соединение...";
      acceptCall();
      return;
    }
    if (_callPC || _callIncoming) {
      socket.emit("call_signal", { to_user_id: msg.from_user_id, type: "busy" });
      return;
    }
    _callIncoming = msg;
    showIncomingCall(msg);
    const dm = allChannels.find(c => c.is_dm && c.partner_id === msg.from_user_id);
    const muted = dm && mutedChannels.has(dm.id);
    if (!muted) _callRingStart(true);
    return;
  }
  if (t === "leave") {
    // Partner left voluntarily — keep panel open so they can rejoin
    if (_callPC) { try { _callPC.close(); } catch (_) {} _callPC = null; }
    _amAlone = true;
    _callPendingIce = [];
    if (_disconnectTimeout) { clearTimeout(_disconnectTimeout); _disconnectTimeout = null; }
    document.getElementById("callStatus").textContent =
      `${msg.from_username || "Собеседник"} вышел — ожидание возврата...`;
    // Clear partner media
    const rv = document.getElementById("callRemoteVideo");
    rv.srcObject = null; rv.classList.add("d-none");
    document.getElementById("callPartnerAvatar").style.display = "";
    document.getElementById("callRemoteAudio").srcObject = null;
    document.getElementById("callScreenTile").classList.add("d-none");
    document.getElementById("screenVolWrap").classList.add("d-none");
    document.getElementById("callScreenVideo").srcObject = null;
    document.getElementById("callScreenAudio").srcObject = null;
    document.getElementById("partnerSpeakingDot").classList.remove("active");
    document.getElementById("callPartnerTile").classList.remove("speaking");
    return;
  }
  if (t === "answer") {
    if (!_callPC) return;
    await _callPC.setRemoteDescription(msg.data);
    _callRingStop();
    document.getElementById("callStatus").textContent = "Ответ получен";
    // Flush queued ICE
    for (const c of _callPendingIce) {
      try { await _callPC.addIceCandidate(c); } catch (_) {}
    }
    _callPendingIce = [];
    return;
  }
  if (t === "ice") {
    if (!_callPC) return;
    if (_callPC.remoteDescription) {
      try { await _callPC.addIceCandidate(msg.data); } catch (_) {}
    } else {
      _callPendingIce.push(msg.data);
    }
    return;
  }
  if (t === "renegotiate") {
    if (!_callPC) return;
    await _callPC.setRemoteDescription(msg.data);
    const ans = await _callPC.createAnswer();
    await _callPC.setLocalDescription(ans);
    socket.emit("call_signal", { to_user_id: msg.from_user_id, type: "reneg-answer", data: ans });
    // Show video wrap if remote added video
    document.getElementById("callVideoWrap").classList.remove("d-none");
    return;
  }
  if (t === "reneg-answer") {
    if (!_callPC) return;
    try { await _callPC.setRemoteDescription(msg.data); } catch (_) {}
    return;
  }
  if (t === "screen_start") {
    _expectedScreenStreamId = msg.data?.stream_id || null;
    return;
  }
  if (t === "screen_stop") {
    _expectedScreenStreamId = null;
    document.getElementById("callScreenTile").classList.add("d-none");
    document.getElementById("screenVolWrap").classList.add("d-none");
    const sv = document.getElementById("callScreenVideo");
    const sa = document.getElementById("callScreenAudio");
    if (sv.srcObject) sv.srcObject = null;
    if (sa.srcObject) sa.srcObject = null;
    return;
  }
  if (t === "end" || t === "decline" || t === "busy") {
    if (t === "busy") alert("Пользователь занят");
    if (t === "decline" && _callIsCaller) alert("Звонок отклонён");
    endCall(true);
    return;
  }
});

function showIncomingCall(msg) {
  const m = document.getElementById("incomingCallModal");
  applyAvatar(document.getElementById("incomingCallAvatar"),
              msg.from_avatar_url, msg.from_avatar_color, msg.from_username);
  document.getElementById("incomingCallName").textContent = msg.from_username;
  document.getElementById("incomingCallType").textContent =
    (msg.data?.callType === "video" ? "Видеозвонок" : "Аудиозвонок") + "...";
  m.classList.remove("d-none");
}

function hideIncomingCall() {
  document.getElementById("incomingCallModal").classList.add("d-none");
}

async function acceptCall() {
  const inv = _callIncoming;
  if (!inv) return;
  _callRingStop();
  hideIncomingCall();
  _callType = inv.data?.callType || "audio";
  _callPartner = {
    id: inv.from_user_id,
    username: inv.from_username,
    avatar_url: inv.from_avatar_url,
    avatar_color: inv.from_avatar_color,
  };
  _callIsCaller = false;
  _callPendingIce = [];

  try {
    _callStream = await _getMedia(_callType);
  } catch (e) {
    socket.emit("call_signal", { to_user_id: _callPartner.id, type: "decline" });
    _callIncoming = null;
    return alert("Нет доступа к устройству: " + e.message);
  }

  _callPC = _setupPC(_callPartner.id);
  _callStream.getTracks().forEach(t => _callPC.addTrack(t, _callStream));
  if (_callType === "video") {
    document.getElementById("callLocalVideo").srcObject = _callStream;
    document.getElementById("callVideoWrap").classList.remove("d-none");
  }

  showCallPanel(_callPartner, "Соединение...");

  await _callPC.setRemoteDescription(inv.data.sdp);
  const answer = await _callPC.createAnswer();
  await _callPC.setLocalDescription(answer);
  socket.emit("call_signal", { to_user_id: _callPartner.id, type: "answer", data: answer });
  _callIncoming = null;
}

function declineCall() {
  if (!_callIncoming) return;
  socket.emit("call_signal", { to_user_id: _callIncoming.from_user_id, type: "decline" });
  _callRingStop();
  hideIncomingCall();
  _callIncoming = null;
}

function endCall(skipEmit) {
  // If in a channel (group) call, leave that instead
  if (_channelCall) { leaveChannelCall(); return; }
  // Always notify server so its state cleans up. If we were alone (partner already left),
  // send "end" so the call entry is fully removed; otherwise "leave" so partner can wait.
  if (_callPartner && !skipEmit) {
    socket.emit("call_signal", {
      to_user_id: _callPartner.id,
      type: _amAlone ? "end" : "leave",
    });
  }
  _amAlone = false;
  _callRingStop();
  _stopSpeakingDetection();
  if (_callTimerInt) { clearInterval(_callTimerInt); _callTimerInt = null; }
  if (_disconnectTimeout) { clearTimeout(_disconnectTimeout); _disconnectTimeout = null; }
  if (_screenStream) { _screenStream.getTracks().forEach(t => t.stop()); _screenStream = null; }
  _screenVideoSender = null; _screenAudioSender = null; _origCameraTrack = null;
  document.getElementById("callScreenBtn").classList.remove("on");
  if (_callStream) _callStream.getTracks().forEach(t => t.stop());
  if (_callPC) try { _callPC.close(); } catch (_) {}
  _callStream = null; _callPC = null; _callPartner = null;
  _callIsCaller = false; _callPendingIce = [];
  _callStartTs = 0;

  // Clean up audio gain contexts so they can be recreated next call
  for (const e of _audioVols.values()) {
    try { e.srcCtx?.close(); } catch (_) {}
  }
  _audioVols.clear();

  document.getElementById("callPanel").classList.add("d-none");
  document.getElementById("callMiniBar").classList.add("d-none");
  document.getElementById("callRemoteVideo").srcObject = null;
  document.getElementById("callRemoteVideo").classList.add("d-none");
  document.getElementById("callLocalVideo").srcObject = null;
  document.getElementById("callLocalVideo").classList.add("d-none");
  document.getElementById("callScreenVideo").srcObject = null;
  document.getElementById("callRemoteAudio").srcObject = null;
  document.getElementById("callScreenAudio").srcObject = null;
  document.getElementById("callScreenTile").classList.add("d-none");
  document.getElementById("screenVolWrap").classList.add("d-none");
  document.getElementById("callTimer").textContent = "0:00";
  document.getElementById("callMiniTimer").textContent = "0:00";
  document.getElementById("partnerSpeakingDot").classList.remove("active");
  document.getElementById("meSpeakingDot").classList.remove("active");
  document.getElementById("callPartnerTile")?.classList.remove("speaking");
  document.getElementById("callLocalTile")?.classList.remove("speaking");
  renderActiveCallBanner();
}

/* ── Speaking detection (analyser on remote + local) ───── */
let _speakingRAF = null;
let _meAnalyser = null, _meCtx = null, _meData = null;
let _partnerAnalyser = null, _partnerObserveCtx = null, _partnerData = null;

function _startSpeakingDetection() {
  _stopSpeakingDetection();
  const AC = window.AudioContext || window.webkitAudioContext;
  // Local speaking
  try {
    if (_callStream && _callStream.getAudioTracks().length) {
      _meCtx = new AC();
      const src = _meCtx.createMediaStreamSource(_callStream);
      _meAnalyser = _meCtx.createAnalyser(); _meAnalyser.fftSize = 256;
      src.connect(_meAnalyser);
      _meData = new Uint8Array(_meAnalyser.frequencyBinCount);
    }
  } catch (_) {}

  // Remote speaking — observe the remote audio's MediaStream directly
  const tryAttachRemote = () => {
    const a = document.getElementById("callRemoteAudio");
    if (!a.srcObject) return false;
    try {
      _partnerObserveCtx = new AC();
      const src = _partnerObserveCtx.createMediaStreamSource(a.srcObject);
      _partnerAnalyser = _partnerObserveCtx.createAnalyser(); _partnerAnalyser.fftSize = 256;
      src.connect(_partnerAnalyser);
      _partnerData = new Uint8Array(_partnerAnalyser.frequencyBinCount);
    } catch (_) {}
    return true;
  };
  if (!tryAttachRemote()) {
    // Retry shortly when remote stream is set
    const tries = setInterval(() => { if (tryAttachRemote()) clearInterval(tries); }, 500);
    setTimeout(() => clearInterval(tries), 8000);
  }

  const tile = (id, dotId, on) => {
    const t = document.getElementById(id);
    const d = document.getElementById(dotId);
    if (!t || !d) return;
    t.classList.toggle("speaking", on);
    d.classList.toggle("active", on);
  };

  const loop = () => {
    let mePower = 0, partPower = 0;
    if (_meAnalyser && _meData) {
      _meAnalyser.getByteFrequencyData(_meData);
      let s = 0; for (let i = 0; i < _meData.length; i++) s += _meData[i];
      mePower = s / _meData.length / 255;
    }
    if (_partnerAnalyser && _partnerData) {
      _partnerAnalyser.getByteFrequencyData(_partnerData);
      let s = 0; for (let i = 0; i < _partnerData.length; i++) s += _partnerData[i];
      partPower = s / _partnerData.length / 255;
    }
    // Don't show "speaking" if mic is muted
    const aTrack = _callStream?.getAudioTracks()[0];
    const micOn = aTrack ? aTrack.enabled : false;
    tile("callLocalTile", "meSpeakingDot", micOn && mePower > 0.05);
    tile("callPartnerTile", "partnerSpeakingDot", partPower > 0.05);
    _speakingRAF = requestAnimationFrame(loop);
  };
  _speakingRAF = requestAnimationFrame(loop);
}

function _stopSpeakingDetection() {
  if (_speakingRAF) cancelAnimationFrame(_speakingRAF);
  _speakingRAF = null;
  try { _meCtx?.close(); } catch (_) {}
  try { _partnerObserveCtx?.close(); } catch (_) {}
  _meCtx = null; _meAnalyser = null; _meData = null;
  _partnerObserveCtx = null; _partnerAnalyser = null; _partnerData = null;
}

function showCallPanel(partner, status) {
  // Top bar avatar / name
  applyAvatar(document.getElementById("callAvatar"),
              partner.avatar_url, partner.avatar_color, partner.username);
  applyAvatar(document.getElementById("callMiniAvatar"),
              partner.avatar_url, partner.avatar_color, partner.username);
  document.getElementById("callName").textContent = partner.username;
  document.getElementById("callMiniName").textContent = partner.username;
  document.getElementById("callStatus").textContent = status;

  // Partner tile avatar
  const pa = document.getElementById("callPartnerAvatar");
  applyAvatar(pa, partner.avatar_url, partner.avatar_color, partner.username);
  pa.style.display = "";
  document.getElementById("callPartnerName").textContent = partner.username;

  // Local self tile avatar
  const la = document.getElementById("callLocalAvatar");
  applyAvatar(la, MY_AVATAR_URL, MY_COLOR, MY_USERNAME);
  la.style.display = _callType === "video" ? "none" : "";
  const lv = document.getElementById("callLocalVideo");
  lv.classList.toggle("d-none", _callType !== "video");

  // Reset volume sliders
  document.getElementById("volPartnerSlider").value = 100;
  document.getElementById("volPartnerPct").textContent = "100%";
  document.getElementById("volScreenSlider").value = 100;
  document.getElementById("volScreenPct").textContent = "100%";
  document.getElementById("screenVolWrap").classList.add("d-none");

  // Reset state of buttons
  document.getElementById("callMuteBtn").classList.remove("active");
  document.getElementById("callMuteBtn").innerHTML = '<i class="bi bi-mic-fill"></i>';
  document.getElementById("callDeafenBtn").classList.remove("active");
  document.getElementById("callDeafenBtn").innerHTML = '<i class="bi bi-volume-up-fill"></i>';
  document.getElementById("callVideoBtn").classList.toggle("active", _callType !== "video");
  document.getElementById("callScreenBtn").classList.remove("on");

  document.getElementById("callPanel").classList.remove("d-none");
  document.querySelector("#callPanel .call-window").style.display = "";
  document.getElementById("callMiniBar").classList.add("d-none");
  renderActiveCallBanner();

  // Reset window position to centered
  const win = document.querySelector("#callPanel .call-window");
  win.style.transform = "translate(-50%, -50%)";
  win.style.left = "50%";
  win.style.top  = "50%";
  _initCallDrag();

  // Speaking detection for self
  _startSpeakingDetection();
}

function _currentLocalStream() { return _channelCall?.localStream || _callStream; }

function toggleCallMute() {
  const stream = _currentLocalStream();
  if (!stream) return;
  const tracks = stream.getAudioTracks();
  const enabled = tracks.length && tracks[0].enabled;
  tracks.forEach(t => t.enabled = !enabled);
  const btn = document.getElementById("callMuteBtn");
  btn.innerHTML = enabled ? '<i class="bi bi-mic-mute-fill"></i>' : '<i class="bi bi-mic-fill"></i>';
  btn.classList.toggle("active", enabled);
}

let _isDeafened = false;
function toggleCallDeafen() {
  _isDeafened = !_isDeafened;
  const newMuted = _isDeafened;
  // DM
  const a = document.getElementById("callRemoteAudio");
  const sa = document.getElementById("callScreenAudio");
  if (a) a.muted = newMuted;
  if (sa) sa.muted = newMuted;
  // Channel — mute every per-tile audio
  if (_channelCall) {
    for (const tile of _channelCall.tiles.values()) {
      const tA = tile.querySelector("audio");
      if (tA) tA.muted = newMuted;
    }
  }
  const btn = document.getElementById("callDeafenBtn");
  btn.innerHTML = newMuted ? '<i class="bi bi-volume-mute-fill"></i>' : '<i class="bi bi-volume-up-fill"></i>';
  btn.classList.toggle("active", newMuted);
}

/* ── Device selection ──────────────────────────────────── */
function toggleCallDevices() {
  const p = document.getElementById("callDevicesPanel");
  const willShow = p.classList.contains("d-none");
  p.classList.toggle("d-none");
  if (willShow) populateDeviceLists();
}

async function populateDeviceLists() {
  try {
    const devs = await navigator.mediaDevices.enumerateDevices();
    const fill = (sel, kind, currentLabel) => {
      sel.innerHTML = "";
      devs.filter(d => d.kind === kind).forEach((d, i) => {
        const o = document.createElement("option");
        o.value = d.deviceId;
        o.textContent = d.label || `${kind} ${i + 1}`;
        if (d.label && currentLabel && d.label === currentLabel) o.selected = true;
        sel.appendChild(o);
      });
      if (!sel.options.length) {
        const o = document.createElement("option");
        o.textContent = "Нет устройств"; o.disabled = true;
        sel.appendChild(o);
      }
    };
    const aTrack = _callStream?.getAudioTracks()[0];
    const vTrack = _callStream?.getVideoTracks()[0];
    fill(document.getElementById("micSelect"), "audioinput", aTrack?.label);
    fill(document.getElementById("camSelect"), "videoinput", vTrack?.label);
    fill(document.getElementById("spkSelect"), "audiooutput", null);
  } catch (_) {}
}

function _allCallSenders(kind) {
  const out = [];
  if (_callPC) {
    for (const s of _callPC.getSenders()) if (s.track?.kind === kind) out.push(s);
  }
  if (_channelCall) {
    for (const pc of _channelCall.pcs.values()) {
      for (const s of pc.getSenders()) if (s.track?.kind === kind) out.push(s);
    }
  }
  return out;
}

async function changeMicDevice(deviceId) {
  const stream = _currentLocalStream();
  if (!stream) { alert("Сначала войдите в звонок"); return; }
  try {
    const ns = await navigator.mediaDevices.getUserMedia({
      audio: { deviceId: { exact: deviceId }, ..._audioConstraints() }, video: false
    });
    const newTrack = ns.getAudioTracks()[0];
    const senders = _allCallSenders("audio");
    for (const s of senders) { try { await s.replaceTrack(newTrack); } catch (_) {} }
    stream.getAudioTracks().forEach(t => { stream.removeTrack(t); t.stop(); });
    stream.addTrack(newTrack);
  } catch (e) { alert("Не удалось сменить микрофон: " + e.message); }
}

async function changeCamDevice(deviceId) {
  const stream = _currentLocalStream();
  if (!stream) { alert("Сначала войдите в звонок"); return; }
  try {
    const ns = await navigator.mediaDevices.getUserMedia({
      audio: false, video: { deviceId: { exact: deviceId }, width: 640, height: 480 }
    });
    const newTrack = ns.getVideoTracks()[0];
    const senders = _allCallSenders("video");
    if (senders.length) {
      for (const s of senders) try { await s.replaceTrack(newTrack); } catch (_) {}
    } else if (_callPC && _callPartner) {
      _callPC.addTrack(newTrack, stream);
      const offer = await _callPC.createOffer();
      await _callPC.setLocalDescription(offer);
      socket.emit("call_signal", { to_user_id: _callPartner.id, type: "renegotiate", data: offer });
    } else if (_channelCall) {
      for (const [uid, pc] of _channelCall.pcs) {
        pc.addTrack(newTrack, stream);
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.emit("channel_call_signal", {
          channel_id: _channelCall.channelId, to_user_id: uid, type: "offer", data: offer
        });
      }
    }
    stream.getVideoTracks().forEach(t => { stream.removeTrack(t); t.stop(); });
    stream.addTrack(newTrack);
    // Local previews
    const lv = document.getElementById("callLocalVideo");
    if (lv) { lv.srcObject = stream; lv.classList.remove("d-none"); }
    const la = document.getElementById("callLocalAvatar");
    if (la) la.style.display = "none";
    if (_channelCall) {
      const myTile = _channelCall.tiles.get(ME);
      if (myTile) {
        let v = myTile.querySelector("video");
        if (!v) {
          v = document.createElement("video");
          v.autoplay = true; v.playsInline = true; v.muted = true;
          v.className = "call-video";
          myTile.insertBefore(v, myTile.firstChild);
        }
        v.srcObject = stream;
        const av = myTile.querySelector(".call-avatar-xl");
        if (av) av.style.display = "none";
      }
    }
  } catch (e) { alert("Не удалось сменить камеру: " + e.message); }
}

/* ── Screen sharing ────────────────────────────────────── */
let _screenStream      = null;
let _screenVideoSender = null;
let _screenAudioSender = null;
let _origCameraTrack   = null;

function toggleScreenShareMenu(ev) {
  ev?.stopPropagation();
  if (_channelScreen) { _stopChannelScreenShare(); return; }
  if (_screenStream)  { stopScreenShare();        return; }
  const m = document.getElementById("screenShareMenu");
  m.classList.toggle("d-none");
  // Close on outside click
  if (!m.classList.contains("d-none")) {
    setTimeout(() => {
      const closer = e => {
        if (!m.contains(e.target)) {
          m.classList.add("d-none");
          document.removeEventListener("click", closer);
        }
      };
      document.addEventListener("click", closer);
    }, 0);
  }
}

async function _startDmScreenShare(surface) {
  if (!_callPC) { alert("Сначала начни звонок"); return; }
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { displaySurface: surface },
      audio: true,
    });
    _screenStream = stream;

    const vTrack = stream.getVideoTracks()[0];
    const aTrack = stream.getAudioTracks()[0];

    // ADD as separate senders — don't replace the camera. Screen becomes a new tile.
    _screenVideoSender = _callPC.addTrack(vTrack, stream);
    if (aTrack) {
      _screenAudioSender = _callPC.addTrack(aTrack, stream);
    }

    // Local preview goes into the dedicated screen tile (so you see what you're sharing)
    document.getElementById("callScreenVideo").srcObject = stream;
    document.getElementById("callScreenTile").classList.remove("d-none");
    document.getElementById("callScreenBtn").classList.add("on");

    // Tell partner: stream with this ID is the screen — so they put it in the right tile
    socket.emit("call_signal", {
      to_user_id: _callPartner.id, type: "screen_start", data: { stream_id: stream.id }
    });

    // Renegotiate so partner sees the new tracks
    const offer = await _callPC.createOffer();
    await _callPC.setLocalDescription(offer);
    socket.emit("call_signal", { to_user_id: _callPartner.id, type: "renegotiate", data: offer });

    // Detect when user clicks browser's native "Stop sharing"
    vTrack.onended = () => stopScreenShare();
  } catch (e) {
    if (e.name !== "NotAllowedError" && e.name !== "AbortError") {
      alert("Не удалось включить демонстрацию: " + e.message);
    }
  }
}

async function stopScreenShare() {
  if (!_screenStream || !_callPC) return;

  _screenStream.getTracks().forEach(t => t.stop());
  _screenStream = null;

  if (_screenVideoSender) {
    try { _callPC.removeTrack(_screenVideoSender); } catch (_) {}
    _screenVideoSender = null;
  }
  if (_screenAudioSender) {
    try { _callPC.removeTrack(_screenAudioSender); } catch (_) {}
    _screenAudioSender = null;
  }

  // Hide local screen tile preview
  document.getElementById("callScreenVideo").srcObject = null;
  document.getElementById("callScreenTile").classList.add("d-none");
  document.getElementById("callScreenBtn").classList.remove("on");

  // Tell partner explicitly so their tile hides immediately (renegotiation alone is unreliable)
  if (_callPartner) {
    socket.emit("call_signal", { to_user_id: _callPartner.id, type: "screen_stop" });
  }

  // Renegotiate to actually drop the tracks on the partner side
  try {
    const offer = await _callPC.createOffer();
    await _callPC.setLocalDescription(offer);
    socket.emit("call_signal", { to_user_id: _callPartner.id, type: "renegotiate", data: offer });
  } catch (_) {}
}

async function changeSpkDevice(deviceId) {
  const audios = [
    document.getElementById("callRemoteAudio"),
    document.getElementById("callScreenAudio"),
    document.getElementById("callRemoteVideo"),
    document.getElementById("callScreenVideo"),
  ];
  if (_channelCall) {
    for (const tile of _channelCall.tiles.values()) {
      tile.querySelectorAll("audio,video").forEach(el => audios.push(el));
    }
  }
  if (!audios.find(x => x?.setSinkId)) {
    alert("Этот браузер не поддерживает выбор устройства вывода");
    return;
  }
  try {
    for (const el of audios) {
      if (el?.setSinkId) await el.setSinkId(deviceId);
    }
    // Remember chosen output for newly-added tile audios
    _selectedSpeakerId = deviceId;
  } catch (e) { alert("Не удалось сменить динамик: " + e.message); }
}
let _selectedSpeakerId = null;

/* ── Call hotkeys (configurable) ───────────────────────── */
const DEFAULT_BINDS = { mute: "", deafen: "", video: "", devices: "", end: "" };
let CALL_BINDS = { ...DEFAULT_BINDS, ...(JSON.parse(localStorage.getItem("call_binds") || "{}")) };

const BIND_LABELS = {
  mute: "Микрофон", deafen: "Звук", video: "Камера",
  devices: "Устройства", end: "Завершить",
};
const BIND_ACTIONS = {
  mute:    () => toggleCallMute(),
  deafen:  () => toggleCallDeafen(),
  video:   () => toggleCallVideo(),
  devices: () => toggleCallDevices(),
  end:     () => endCall(),
};

function _formatBindKey(k) {
  if (!k) return "—";
  if (k === " ") return "Space";
  if (k === "escape") return "Esc";
  return k.length === 1 ? k.toUpperCase() : k;
}

function renderBindsList() {
  const list = document.getElementById("bindsList");
  if (!list) return;
  list.innerHTML = "";
  Object.keys(DEFAULT_BINDS).forEach(action => {
    const row = document.createElement("div");
    row.className = "d-flex align-items-center gap-2";
    row.innerHTML = `
      <span class="small flex-fill">${BIND_LABELS[action]}</span>
      <button type="button" class="btn btn-sm btn-secondary" data-action="${action}"
              style="min-width:80px;font-family:monospace">${_formatBindKey(CALL_BINDS[action])}</button>`;
    row.querySelector("button").onclick = function() { startBindCapture(this, action); };
    list.appendChild(row);
  });
}

let _capturingBind = null;
function startBindCapture(btn, action) {
  if (_capturingBind) return;
  _capturingBind = { btn, action };
  btn.textContent = "Нажми клавишу...";
  btn.style.background = "var(--accent)";
}

// Use capture phase + window so we get the key before Bootstrap modal handlers
window.addEventListener("keydown", e => {
  // Bind capture mode — runs first, ignores everything else
  if (_capturingBind) {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    if (e.key === "Escape") {
      const { btn, action } = _capturingBind;
      btn.textContent = _formatBindKey(CALL_BINDS[action]);
      btn.style.background = "";
      _capturingBind = null;
      return;
    }
    const k = e.key.toLowerCase();
    CALL_BINDS[_capturingBind.action] = k;
    localStorage.setItem("call_binds", JSON.stringify(CALL_BINDS));
    _capturingBind.btn.textContent = _formatBindKey(k);
    _capturingBind.btn.style.background = "";
    _capturingBind = null;
    return;
  }
  // Normal call hotkeys (only when in a call)
  if (!_callPC) return;
  const ae = document.activeElement;
  const tag = ae?.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || ae?.isContentEditable) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const k = e.key.toLowerCase();
  for (const action of Object.keys(CALL_BINDS)) {
    const bound = CALL_BINDS[action];
    if (bound && bound === k) {
      e.preventDefault();
      BIND_ACTIONS[action]();
      return;
    }
  }
}, true);  // capture phase

function resetBinds() {
  CALL_BINDS = { ...DEFAULT_BINDS };
  localStorage.setItem("call_binds", JSON.stringify(CALL_BINDS));
  renderBindsList();
}

async function toggleCallVideo() {
  if (_channelCall) return _toggleChannelVideo();
  if (!_callPC || !_callStream) return;
  const videoTracks = _callStream.getVideoTracks();
  if (videoTracks.length) {
    const enabled = videoTracks[0].enabled;
    videoTracks.forEach(t => t.enabled = !enabled);
    const btn = document.getElementById("callVideoBtn");
    btn.innerHTML = enabled ? '<i class="bi bi-camera-video-off-fill"></i>' : '<i class="bi bi-camera-video-fill"></i>';
    btn.classList.toggle("active", enabled);
    const lv = document.getElementById("callLocalVideo");
    const la = document.getElementById("callLocalAvatar");
    if (enabled) { lv.classList.add("d-none"); la.style.display = ""; }
    else        { lv.classList.remove("d-none"); la.style.display = "none"; }
  } else {
    // Add video track on the fly
    try {
      const vstream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 } });
      const vtrack = vstream.getVideoTracks()[0];
      _callStream.addTrack(vtrack);
      _callPC.addTrack(vtrack, _callStream);
      document.getElementById("callLocalVideo").srcObject = _callStream;
      document.getElementById("callLocalVideo").classList.remove("d-none");
      document.getElementById("callLocalAvatar").style.display = "none";
      document.getElementById("callVideoBtn").classList.remove("active");
      // Renegotiate (NOT a new invite — would be treated as new call)
      const offer = await _callPC.createOffer();
      await _callPC.setLocalDescription(offer);
      socket.emit("call_signal", { to_user_id: _callPartner.id, type: "renegotiate",
                                   data: offer });
    } catch (e) {
      alert("Не удалось включить камеру: " + e.message);
    }
  }
}
