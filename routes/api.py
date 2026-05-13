import os, uuid
from flask import Blueprint, jsonify, request, current_app
from flask_login import login_required, current_user
from werkzeug.utils import secure_filename
from models import db, User, Channel, ChannelMember, Message, HiddenMessage, BlockedUser

api = Blueprint("api", __name__, url_prefix="/api")

ALLOWED_AVATAR_EXT = {"png", "jpg", "jpeg", "gif", "webp"}
MAX_AVATAR_SIZE = 5 * 1024 * 1024  # 5 MB

ALLOWED_ATTACH_EXT = {
    "png","jpg","jpeg","gif","webp","bmp",
    "mp4","webm","mov","mkv",
    "mp3","wav","ogg","m4a","oga",
    "pdf","txt","doc","docx","xls","xlsx","ppt","pptx","zip","rar","7z","csv","json",
}
MAX_ATTACH_SIZE = 50 * 1024 * 1024  # 50 MB


# ── Users ──────────────────────────────────────────────────────────────────

@api.route("/users/search")
@login_required
def users_search():
    q = request.args.get("q", "").strip()
    if len(q) < 1:
        return jsonify([])
    users = User.query.filter(
        User.username.ilike(f"%{q}%"),
        User.id != current_user.id
    ).limit(10).all()
    return jsonify([u.to_dict() for u in users])


@api.route("/users/me")
@login_required
def me():
    return jsonify(current_user.to_dict())


@api.route("/users/<int:user_id>")
@login_required
def user_profile(user_id):
    user = User.query.get_or_404(user_id)
    return jsonify(user.to_dict())


@api.route("/users/me/avatar", methods=["POST"])
@login_required
def upload_avatar():
    if "file" not in request.files:
        return jsonify({"error": "Файл не передан"}), 400
    f = request.files["file"]
    if not f.filename:
        return jsonify({"error": "Пустое имя файла"}), 400
    ext = f.filename.rsplit(".", 1)[-1].lower()
    if ext not in ALLOWED_AVATAR_EXT:
        return jsonify({"error": "Допустимы: png, jpg, gif, webp"}), 400

    # Read into memory + size check
    data = f.read()
    if len(data) > MAX_AVATAR_SIZE:
        return jsonify({"error": "Файл больше 5 МБ"}), 400

    # Resize via Pillow to 256x256 square
    try:
        from PIL import Image
        from io import BytesIO
        img = Image.open(BytesIO(data))
        img = img.convert("RGB") if ext in ("jpg", "jpeg") else img.convert("RGBA")
        # Square crop centered
        w, h = img.size
        side = min(w, h)
        left = (w - side) // 2
        top  = (h - side) // 2
        img = img.crop((left, top, left + side, top + side)).resize((256, 256), Image.LANCZOS)
    except Exception as e:
        return jsonify({"error": f"Не удалось обработать изображение: {e}"}), 400

    # Save with unique name
    upload_dir = os.path.join(current_app.static_folder, "uploads", "avatars")
    os.makedirs(upload_dir, exist_ok=True)
    save_ext = "jpg" if ext in ("jpg", "jpeg") else ext
    filename = f"{current_user.id}_{uuid.uuid4().hex[:8]}.{save_ext}"
    path = os.path.join(upload_dir, filename)
    save_kwargs = {"quality": 88} if save_ext in ("jpg", "jpeg") else {}
    img.save(path, **save_kwargs)

    # Delete previous file if exists
    if current_user.avatar_url:
        old_name = current_user.avatar_url.rsplit("/", 1)[-1]
        old_path = os.path.join(upload_dir, old_name)
        if os.path.exists(old_path) and old_name != filename:
            try: os.remove(old_path)
            except OSError: pass

    current_user.avatar_url = f"/static/uploads/avatars/{filename}"
    db.session.commit()
    from extensions import socketio
    socketio.emit("profile_updated", current_user.to_dict())
    return jsonify(current_user.to_dict())


@api.route("/users/me/status", methods=["PATCH"])
@login_required
def update_status():
    status = (request.get_json() or {}).get("status", "active")
    if status not in ("active", "dnd", "offline"):
        return jsonify({"error": "Неверный статус"}), 400
    current_user.status = status
    db.session.commit()
    from extensions import socketio
    socketio.emit("profile_updated", current_user.to_dict())
    return jsonify({"ok": True, "status": status})


@api.route("/messages/attachment", methods=["POST"])
@login_required
def upload_attachment():
    if "file" not in request.files:
        return jsonify({"error": "Файл не передан"}), 400
    f = request.files["file"]
    if not f.filename:
        return jsonify({"error": "Пустое имя файла"}), 400
    ext = f.filename.rsplit(".", 1)[-1].lower() if "." in f.filename else ""
    if ext not in ALLOWED_ATTACH_EXT:
        return jsonify({"error": f"Недопустимый формат: .{ext}"}), 400

    data = f.read()
    if len(data) > MAX_ATTACH_SIZE:
        return jsonify({"error": "Файл больше 50 МБ"}), 400

    if ext in ("png","jpg","jpeg","gif","webp","bmp"):
        kind = "image"
    elif ext in ("mp4","webm","mov","mkv"):
        kind = "video"
    elif ext in ("mp3","wav","ogg","m4a","oga"):
        kind = "audio"
    else:
        kind = "file"

    upload_dir = os.path.join(current_app.static_folder, "uploads", "chat")
    os.makedirs(upload_dir, exist_ok=True)
    safe_orig = secure_filename(f.filename) or f"file.{ext}"
    filename = f"{current_user.id}_{uuid.uuid4().hex[:10]}.{ext}"
    path = os.path.join(upload_dir, filename)
    with open(path, "wb") as out:
        out.write(data)

    return jsonify({
        "url": f"/static/uploads/chat/{filename}",
        "type": kind,
        "name": safe_orig,
    })


@api.route("/users/me/avatar", methods=["DELETE"])
@login_required
def delete_avatar():
    if current_user.avatar_url:
        old_name = current_user.avatar_url.rsplit("/", 1)[-1]
        upload_dir = os.path.join(current_app.static_folder, "uploads", "avatars")
        old_path = os.path.join(upload_dir, old_name)
        if os.path.exists(old_path):
            try: os.remove(old_path)
            except OSError: pass
    current_user.avatar_url = ""
    db.session.commit()
    from extensions import socketio
    socketio.emit("profile_updated", current_user.to_dict())
    return jsonify(current_user.to_dict())


@api.route("/users/me", methods=["PATCH"])
@login_required
def update_me():
    import re
    data = request.get_json()
    bio = (data.get("bio") or "").strip()[:200]
    color = (data.get("avatar_color") or "").strip()
    if color and not re.match(r'^#[0-9a-fA-F]{6}$', color):
        return jsonify({"error": "Неверный формат цвета"}), 400
    current_user.bio = bio
    if color:
        current_user.avatar_color = color
    if "display_name" in data:
        dn = (data.get("display_name") or "").strip()[:80]
        current_user.display_name = dn  # may be empty → falls back to username
    db.session.commit()
    from extensions import socketio
    socketio.emit("profile_updated", current_user.to_dict())
    return jsonify(current_user.to_dict())


# ── Channels ───────────────────────────────────────────────────────────────

@api.route("/channels/public")
@login_required
def public_channels():
    """Public channels the current user is NOT a member of."""
    my_ids = {m.channel_id for m in ChannelMember.query.filter_by(user_id=current_user.id).all()}
    channels = Channel.query.filter_by(is_private=False, is_dm=False).all()
    result = []
    for ch in channels:
        if ch.id not in my_ids:
            d = ch.to_dict()
            d["owner_username"] = ch.owner.username if ch.owner else "?"
            result.append(d)
    return jsonify(result)


@api.route("/channels/<int:channel_id>/join", methods=["POST"])
@login_required
def join_channel(channel_id):
    ch = Channel.query.get_or_404(channel_id)
    if ch.is_private or ch.is_dm:
        return jsonify({"error": "Нельзя вступить в приватный или личный канал"}), 403
    if ChannelMember.query.filter_by(channel_id=ch.id, user_id=current_user.id).first():
        return jsonify({"error": "Уже в канале"}), 409
    db.session.add(ChannelMember(channel_id=ch.id, user_id=current_user.id, role="member"))
    db.session.commit()
    from extensions import socketio
    member_data = {**current_user.to_dict(), "role": "member", "channel_id": ch.id}
    socketio.emit("member_joined", member_data, room=f"channel_{ch.id}")
    return jsonify(ch.to_dict(current_user.id)), 201


@api.route("/channels")
@login_required
def channels_list():
    memberships = ChannelMember.query.filter_by(user_id=current_user.id).all()
    result = []
    for m in memberships:
        ch = m.channel
        data = ch.to_dict(current_user.id)
        data["avatar_url"] = ch.avatar_url or ""
        # For DMs show partner username as name
        if ch.is_dm:
            partner = next(
                (mem.user for mem in ch.members if mem.user_id != current_user.id),
                None
            )
            data["name"] = (partner.display_name or partner.username) if partner else "Удалён"
            data["partner_id"] = partner.id if partner else None
            data["partner_username"]     = partner.username if partner else ""
            data["partner_avatar_url"]   = (partner.avatar_url if partner else "") or ""
            data["partner_avatar_color"] = (partner.avatar_color if partner else "#5865f2") or "#5865f2"
        # Last message preview
        last_msg = Message.query.filter_by(channel_id=ch.id, is_deleted=False)\
            .order_by(Message.created_at.desc()).first()
        data["last_message"] = last_msg.content[:60] if last_msg else ""
        data["last_at"] = last_msg.created_at.isoformat() if last_msg else ch.created_at.isoformat()
        result.append(data)
    result.sort(key=lambda x: x["last_at"], reverse=True)
    return jsonify(result)


@api.route("/channels", methods=["POST"])
@login_required
def create_channel():
    data = request.get_json()
    name = (data.get("name") or "").strip()
    description = (data.get("description") or "").strip()
    is_private  = bool(data.get("is_private", False))
    allow_calls = bool(data.get("allow_calls", True))
    if not name:
        return jsonify({"error": "Название обязательно"}), 400

    ch = Channel(name=name, description=description,
                 is_private=is_private, allow_calls=allow_calls,
                 owner_id=current_user.id)
    db.session.add(ch)
    db.session.flush()
    db.session.add(ChannelMember(channel_id=ch.id, user_id=current_user.id, role="owner"))
    db.session.commit()
    return jsonify(ch.to_dict(current_user.id)), 201


@api.route("/channels/<int:channel_id>")
@login_required
def channel_detail(channel_id):
    ch = _get_member_channel(channel_id)
    members = [
        {**m.user.to_dict(), "role": m.role}
        for m in ch.members
    ]
    data = ch.to_dict(current_user.id)
    data["members"] = members
    if ch.is_dm:
        partner = next(
            (mem.user for mem in ch.members if mem.user_id != current_user.id),
            None
        )
        data["name"] = (partner.display_name or partner.username) if partner else "Удалён"
        data["partner_id"] = partner.id if partner else None
        data["partner_username"]     = partner.username if partner else ""
        data["partner_avatar_url"]   = (partner.avatar_url if partner else "") or ""
        data["partner_avatar_color"] = (partner.avatar_color if partner else "#5865f2") or "#5865f2"
    return jsonify(data)


@api.route("/channels/<int:channel_id>", methods=["PATCH"])
@login_required
def update_channel(channel_id):
    ch = _get_member_channel(channel_id)
    member = ChannelMember.query.filter_by(channel_id=ch.id, user_id=current_user.id).first()
    if ch.owner_id != current_user.id and (not member or member.role != "admin"):
        return jsonify({"error": "Только владелец/админ может менять настройки"}), 403
    if ch.is_dm:
        return jsonify({"error": "Нельзя редактировать личный чат"}), 400
    data = request.get_json() or {}
    if "allow_calls" in data:
        ch.allow_calls = bool(data["allow_calls"])
    if "name" in data:
        name = (data.get("name") or "").strip()
        if not name:
            return jsonify({"error": "Название не может быть пустым"}), 400
        ch.name = name[:100]
    if "description" in data:
        ch.description = (data.get("description") or "").strip()[:300]
    db.session.commit()
    from extensions import socketio
    socketio.emit("channel_updated", ch.to_dict(current_user.id), room=f"channel_{ch.id}")
    return jsonify(ch.to_dict(current_user.id))


@api.route("/channels/<int:channel_id>/avatar", methods=["POST"])
@login_required
def upload_channel_avatar(channel_id):
    ch = _get_member_channel(channel_id)
    member = ChannelMember.query.filter_by(channel_id=ch.id, user_id=current_user.id).first()
    if ch.owner_id != current_user.id and (not member or member.role != "admin"):
        return jsonify({"error": "Только владелец/админ"}), 403
    if ch.is_dm:
        return jsonify({"error": "Нельзя редактировать личный чат"}), 400
    if "file" not in request.files:
        return jsonify({"error": "Файл не передан"}), 400
    f = request.files["file"]
    ext = f.filename.rsplit(".", 1)[-1].lower() if f.filename else ""
    if ext not in ALLOWED_AVATAR_EXT:
        return jsonify({"error": "Допустимы: png, jpg, gif, webp"}), 400
    data = f.read()
    if len(data) > MAX_AVATAR_SIZE:
        return jsonify({"error": "Файл больше 5 МБ"}), 400

    try:
        from PIL import Image
        from io import BytesIO
        img = Image.open(BytesIO(data))
        img = img.convert("RGB") if ext in ("jpg", "jpeg") else img.convert("RGBA")
        w, h = img.size
        side = min(w, h)
        left = (w - side) // 2
        top  = (h - side) // 2
        img = img.crop((left, top, left + side, top + side)).resize((256, 256), Image.LANCZOS)
    except Exception as e:
        return jsonify({"error": f"Не удалось обработать изображение: {e}"}), 400

    upload_dir = os.path.join(current_app.static_folder, "uploads", "channels")
    os.makedirs(upload_dir, exist_ok=True)
    save_ext = "jpg" if ext in ("jpg", "jpeg") else ext
    filename = f"{ch.id}_{uuid.uuid4().hex[:8]}.{save_ext}"
    path = os.path.join(upload_dir, filename)
    save_kwargs = {"quality": 88} if save_ext in ("jpg", "jpeg") else {}
    img.save(path, **save_kwargs)

    if ch.avatar_url:
        old_name = ch.avatar_url.rsplit("/", 1)[-1]
        old_path = os.path.join(upload_dir, old_name)
        if os.path.exists(old_path) and old_name != filename:
            try: os.remove(old_path)
            except OSError: pass

    ch.avatar_url = f"/static/uploads/channels/{filename}"
    db.session.commit()
    from extensions import socketio
    socketio.emit("channel_updated", ch.to_dict(current_user.id), room=f"channel_{ch.id}")
    return jsonify(ch.to_dict(current_user.id))


@api.route("/channels/<int:channel_id>/avatar", methods=["DELETE"])
@login_required
def delete_channel_avatar(channel_id):
    ch = _get_member_channel(channel_id)
    member = ChannelMember.query.filter_by(channel_id=ch.id, user_id=current_user.id).first()
    if ch.owner_id != current_user.id and (not member or member.role != "admin"):
        return jsonify({"error": "Только владелец/админ"}), 403
    if ch.avatar_url:
        old_name = ch.avatar_url.rsplit("/", 1)[-1]
        upload_dir = os.path.join(current_app.static_folder, "uploads", "channels")
        old_path = os.path.join(upload_dir, old_name)
        if os.path.exists(old_path):
            try: os.remove(old_path)
            except OSError: pass
    ch.avatar_url = ""
    db.session.commit()
    from extensions import socketio
    socketio.emit("channel_updated", ch.to_dict(current_user.id), room=f"channel_{ch.id}")
    return jsonify(ch.to_dict(current_user.id))


@api.route("/channels/<int:channel_id>", methods=["DELETE"])
@login_required
def delete_channel(channel_id):
    ch = _get_member_channel(channel_id)
    if ch.owner_id != current_user.id:
        return jsonify({"error": "Только владелец может удалить канал"}), 403
    member_ids = [m.user_id for m in ch.members]
    db.session.delete(ch)
    db.session.commit()
    from extensions import socketio
    for uid in member_ids:
        socketio.emit("channel_deleted", {"channel_id": channel_id}, room=f"user_{uid}")
    return jsonify({"ok": True})


# ── Members ────────────────────────────────────────────────────────────────

@api.route("/channels/<int:channel_id>/members", methods=["POST"])
@login_required
def invite_member(channel_id):
    ch = _get_member_channel(channel_id)
    _require_role(ch, ["owner", "admin"])
    data = request.get_json()
    user = User.query.filter_by(username=data.get("username", "").strip()).first()
    if not user:
        return jsonify({"error": "Пользователь не найден"}), 404
    if ChannelMember.query.filter_by(channel_id=ch.id, user_id=user.id).first():
        return jsonify({"error": "Уже в канале"}), 409
    db.session.add(ChannelMember(channel_id=ch.id, user_id=user.id, role="member"))
    db.session.commit()

    from extensions import socketio
    # Notify the invited user so channel appears in their sidebar
    ch_data = ch.to_dict(user.id)
    ch_data["last_message"] = ""
    ch_data["last_at"] = ch.created_at.isoformat()
    socketio.emit("channel_invite", ch_data, room=f"user_{user.id}")
    # Notify everyone viewing the channel that a new member appeared
    member_data = {**user.to_dict(), "role": "member", "channel_id": ch.id}
    socketio.emit("member_joined", member_data, room=f"channel_{ch.id}")

    return jsonify({**user.to_dict(), "role": "member"}), 201


@api.route("/channels/<int:channel_id>/members/<int:user_id>", methods=["DELETE"])
@login_required
def kick_member(channel_id, user_id):
    ch = _get_member_channel(channel_id)
    _require_role(ch, ["owner", "admin"])
    if user_id == ch.owner_id:
        return jsonify({"error": "Нельзя исключить владельца"}), 403
    member = ChannelMember.query.filter_by(channel_id=ch.id, user_id=user_id).first_or_404()
    db.session.delete(member)
    db.session.commit()
    from extensions import socketio
    socketio.emit("member_left", {"channel_id": channel_id, "user_id": user_id},
                  room=f"channel_{channel_id}")
    socketio.emit("you_were_kicked", {"channel_id": channel_id},
                  room=f"user_{user_id}")
    return jsonify({"ok": True})


@api.route("/channels/<int:channel_id>/members/<int:user_id>/role", methods=["PATCH"])
@login_required
def change_role(channel_id, user_id):
    ch = _get_member_channel(channel_id)
    if ch.owner_id != current_user.id:
        return jsonify({"error": "Только владелец может менять роли"}), 403
    if user_id == current_user.id:
        return jsonify({"error": "Нельзя изменить свою роль"}), 400
    role = request.get_json().get("role")
    if role not in ("admin", "member"):
        return jsonify({"error": "Роль: admin или member"}), 400
    member = ChannelMember.query.filter_by(channel_id=ch.id, user_id=user_id).first_or_404()
    member.role = role
    db.session.commit()
    return jsonify({"ok": True, "role": role})


@api.route("/channels/<int:channel_id>/call_status")
@login_required
def channel_call_status(channel_id):
    _get_member_channel(channel_id)
    from events import _CHANNEL_CALLS, _DM_CALLS
    return jsonify({
        "channel_id": channel_id,
        "channel_active": channel_id in _CHANNEL_CALLS,
        "channel_participants": list(_CHANNEL_CALLS.get(channel_id, [])),
        "dm_active": channel_id in _DM_CALLS,
        "dm_participants": list(_DM_CALLS.get(channel_id, [])),
    })


@api.route("/channels/<int:channel_id>/leave", methods=["POST"])
@login_required
def leave_channel(channel_id):
    ch = _get_member_channel(channel_id)
    if ch.owner_id == current_user.id:
        return jsonify({"error": "Владелец не может выйти — передайте владение или удалите канал"}), 403
    member = ChannelMember.query.filter_by(
        channel_id=ch.id, user_id=current_user.id
    ).first_or_404()
    db.session.delete(member)
    db.session.commit()
    from extensions import socketio
    socketio.emit("member_left", {"channel_id": channel_id, "user_id": current_user.id},
                  room=f"channel_{channel_id}")
    return jsonify({"ok": True})


# ── Messages ───────────────────────────────────────────────────────────────

@api.route("/channels/<int:channel_id>/messages")
@login_required
def messages_list(channel_id):
    _get_member_channel(channel_id)
    before_id = request.args.get("before", type=int)
    query = Message.query.filter_by(channel_id=channel_id)
    if before_id:
        query = query.filter(Message.id < before_id)
    msgs = query.order_by(Message.created_at.desc()).limit(50).all()
    msgs.reverse()
    hidden_ids = {
        h.message_id for h in HiddenMessage.query.filter_by(user_id=current_user.id).all()
    }
    return jsonify([m.to_dict(current_user.id) for m in msgs if m.id not in hidden_ids])


# ── DM ─────────────────────────────────────────────────────────────────────

@api.route("/dm/<int:user_id>", methods=["POST"])
@login_required
def create_dm(user_id):
    if user_id == current_user.id:
        return jsonify({"error": "Нельзя написать самому себе"}), 400
    partner = User.query.get_or_404(user_id)

    # Check if blocked
    if BlockedUser.query.filter_by(blocker_id=user_id, blocked_id=current_user.id).first():
        return jsonify({"error": "Вы заблокированы этим пользователем"}), 403

    # Check if DM already exists
    my_channels = {m.channel_id for m in current_user.memberships}
    partner_channels = {m.channel_id for m in partner.memberships}
    shared = my_channels & partner_channels
    for ch_id in shared:
        ch = Channel.query.get(ch_id)
        if ch and ch.is_dm:
            data = ch.to_dict(current_user.id)
            data["name"] = partner.display_name or partner.username
            data["partner_id"] = partner.id
            data["partner_username"]     = partner.username
            data["partner_avatar_url"]   = partner.avatar_url or ""
            data["partner_avatar_color"] = partner.avatar_color or "#5865f2"
            return jsonify(data)

    ch = Channel(name=f"dm_{current_user.id}_{user_id}", is_dm=True, owner_id=current_user.id)
    db.session.add(ch)
    db.session.flush()
    db.session.add(ChannelMember(channel_id=ch.id, user_id=current_user.id, role="member"))
    db.session.add(ChannelMember(channel_id=ch.id, user_id=user_id, role="member"))
    db.session.commit()

    data = ch.to_dict(current_user.id)
    data["name"] = partner.display_name or partner.username
    data["partner_id"] = partner.id
    data["partner_username"]     = partner.username
    data["partner_avatar_url"]   = partner.avatar_url or ""
    data["partner_avatar_color"] = partner.avatar_color or "#5865f2"

    # Notify the partner in real-time so they see the DM immediately
    partner_data = ch.to_dict(user_id)
    partner_data["name"] = current_user.display_name or current_user.username
    partner_data["partner_id"] = current_user.id
    partner_data["partner_username"]     = current_user.username
    partner_data["partner_avatar_url"]   = current_user.avatar_url or ""
    partner_data["partner_avatar_color"] = current_user.avatar_color or "#5865f2"
    partner_data["last_message"] = ""
    partner_data["last_at"] = ch.created_at.isoformat()
    from extensions import socketio
    socketio.emit("new_dm", partner_data, room=f"user_{user_id}")

    return jsonify(data), 201


@api.route("/dm/<int:channel_id>", methods=["DELETE"])
@login_required
def delete_dm(channel_id):
    ch = Channel.query.get_or_404(channel_id)
    if not ch.is_dm:
        return jsonify({"error": "Не является личным чатом"}), 400
    member = ChannelMember.query.filter_by(channel_id=channel_id, user_id=current_user.id).first()
    if not member:
        return jsonify({"error": "Нет доступа"}), 403

    # Find partner to notify
    partner_member = next(
        (m for m in ch.members if m.user_id != current_user.id), None
    )
    partner_id = partner_member.user_id if partner_member else None

    db.session.delete(ch)
    db.session.commit()

    # Notify both users to remove chat from their list
    from extensions import socketio
    socketio.emit("dm_deleted", {"channel_id": channel_id}, room=f"user_{current_user.id}")
    if partner_id:
        socketio.emit("dm_deleted", {"channel_id": channel_id}, room=f"user_{partner_id}")

    return jsonify({"ok": True})


# ── Block ───────────────────────────────────────────────────────────────────

@api.route("/users/<int:user_id>/block", methods=["POST"])
@login_required
def block_user(user_id):
    if user_id == current_user.id:
        return jsonify({"error": "Нельзя заблокировать себя"}), 400
    User.query.get_or_404(user_id)
    existing = BlockedUser.query.filter_by(blocker_id=current_user.id, blocked_id=user_id).first()
    if not existing:
        db.session.add(BlockedUser(blocker_id=current_user.id, blocked_id=user_id))
        db.session.commit()
    from extensions import socketio
    socketio.emit("block_status_changed",
                  {"by_user_id": current_user.id, "blocked": True},
                  room=f"user_{user_id}")
    return jsonify({"ok": True, "blocked": True})


@api.route("/users/<int:user_id>/unblock", methods=["POST"])
@login_required
def unblock_user(user_id):
    blocked = BlockedUser.query.filter_by(blocker_id=current_user.id, blocked_id=user_id).first()
    if blocked:
        db.session.delete(blocked)
        db.session.commit()
    from extensions import socketio
    socketio.emit("block_status_changed",
                  {"by_user_id": current_user.id, "blocked": False},
                  room=f"user_{user_id}")
    return jsonify({"ok": True, "blocked": False})


@api.route("/users/<int:user_id>/block_status")
@login_required
def block_status(user_id):
    i_blocked = BlockedUser.query.filter_by(
        blocker_id=current_user.id, blocked_id=user_id
    ).first() is not None
    they_blocked = BlockedUser.query.filter_by(
        blocker_id=user_id, blocked_id=current_user.id
    ).first() is not None
    return jsonify({"i_blocked": i_blocked, "they_blocked": they_blocked})


# ── Helpers ────────────────────────────────────────────────────────────────

def _get_member_channel(channel_id):
    ch = Channel.query.get_or_404(channel_id)
    member = ChannelMember.query.filter_by(
        channel_id=channel_id, user_id=current_user.id
    ).first()
    if not member:
        from flask import abort
        abort(403)
    return ch


def _require_role(channel, roles):
    member = ChannelMember.query.filter_by(
        channel_id=channel.id, user_id=current_user.id
    ).first()
    if not member or member.role not in roles:
        from flask import abort
        abort(403)
