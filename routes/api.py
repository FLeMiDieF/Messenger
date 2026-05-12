from flask import Blueprint, jsonify, request
from flask_login import login_required, current_user
from models import db, User, Channel, ChannelMember, Message, HiddenMessage, BlockedUser

api = Blueprint("api", __name__, url_prefix="/api")


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
    return jsonify(ch.to_dict(current_user.id)), 201


@api.route("/channels")
@login_required
def channels_list():
    memberships = ChannelMember.query.filter_by(user_id=current_user.id).all()
    result = []
    for m in memberships:
        ch = m.channel
        data = ch.to_dict(current_user.id)
        # For DMs show partner username as name
        if ch.is_dm:
            partner = next(
                (mem.user for mem in ch.members if mem.user_id != current_user.id),
                None
            )
            data["name"] = partner.username if partner else "Удалён"
            data["partner_id"] = partner.id if partner else None
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
    is_private = bool(data.get("is_private", False))
    if not name:
        return jsonify({"error": "Название обязательно"}), 400

    ch = Channel(name=name, description=description,
                 is_private=is_private, owner_id=current_user.id)
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
        data["name"] = partner.username if partner else "Удалён"
        data["partner_id"] = partner.id if partner else None
    return jsonify(data)


@api.route("/channels/<int:channel_id>", methods=["DELETE"])
@login_required
def delete_channel(channel_id):
    ch = _get_member_channel(channel_id)
    if ch.owner_id != current_user.id:
        return jsonify({"error": "Только владелец может удалить канал"}), 403
    db.session.delete(ch)
    db.session.commit()
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

    # Notify the invited user in real-time
    ch_data = ch.to_dict(user.id)
    ch_data["last_message"] = ""
    ch_data["last_at"] = ch.created_at.isoformat()
    from extensions import socketio
    socketio.emit("channel_invite", ch_data, room=f"user_{user.id}")

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
            data["name"] = partner.username
            data["partner_id"] = partner.id
            return jsonify(data)

    ch = Channel(name=f"dm_{current_user.id}_{user_id}", is_dm=True, owner_id=current_user.id)
    db.session.add(ch)
    db.session.flush()
    db.session.add(ChannelMember(channel_id=ch.id, user_id=current_user.id, role="member"))
    db.session.add(ChannelMember(channel_id=ch.id, user_id=user_id, role="member"))
    db.session.commit()

    data = ch.to_dict(current_user.id)
    data["name"] = partner.username
    data["partner_id"] = partner.id

    # Notify the partner in real-time so they see the DM immediately
    partner_data = ch.to_dict(user_id)
    partner_data["name"] = current_user.username
    partner_data["partner_id"] = current_user.id
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
    return jsonify({"ok": True, "blocked": True})


@api.route("/users/<int:user_id>/unblock", methods=["POST"])
@login_required
def unblock_user(user_id):
    blocked = BlockedUser.query.filter_by(blocker_id=current_user.id, blocked_id=user_id).first()
    if blocked:
        db.session.delete(blocked)
        db.session.commit()
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
