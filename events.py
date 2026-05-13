from datetime import datetime
from flask import request
from flask_login import current_user
from flask_socketio import join_room, leave_room, emit
from extensions import socketio
from models import db, Message, HiddenMessage, ChannelMember, Channel, User, BlockedUser


def _get_membership(channel_id):
    return ChannelMember.query.filter_by(
        channel_id=channel_id, user_id=current_user.id
    ).first()


@socketio.on("connect")
def on_connect():
    if not current_user.is_authenticated:
        return False
    current_user.is_online = True
    db.session.commit()
    join_room(f"user_{current_user.id}")
    # Auto-join all channel rooms for background notifications
    memberships = ChannelMember.query.filter_by(user_id=current_user.id).all()
    for m in memberships:
        join_room(f"channel_{m.channel_id}")
    emit("user_status", {"user_id": current_user.id, "is_online": True}, broadcast=True)
    # Send current call status for every channel this user belongs to,
    # so a freshly-loaded client doesn't show stale "join" buttons.
    for m in memberships:
        ch_id = m.channel_id
        emit("channel_call_status", {
            "channel_id": ch_id,
            "active": ch_id in _CHANNEL_CALLS,
            "participants": list(_CHANNEL_CALLS.get(ch_id, [])),
        })
        emit("dm_call_status", {
            "channel_id": ch_id,
            "active": ch_id in _DM_CALLS,
            "participants": list(_DM_CALLS.get(ch_id, [])),
        })


_ACTIVE_CALLS = {}  # user_id -> partner_id (in-memory; resets on server restart)
_DM_CALLS = {}      # channel_id -> set(user_ids in call)


def _find_dm_channel_id(uid1, uid2):
    """Return DM channel id between two users, or None."""
    chs = Channel.query.filter_by(is_dm=True).all()
    for ch in chs:
        ids = {m.user_id for m in ch.members}
        if uid1 in ids and uid2 in ids:
            return ch.id
    return None


def _broadcast_dm_call(channel_id, active):
    ch = Channel.query.get(channel_id)
    if not ch:
        return
    payload = {"channel_id": channel_id, "active": active,
               "participants": list(_DM_CALLS.get(channel_id, []))}
    for m in ch.members:
        emit("dm_call_status", payload, room=f"user_{m.user_id}")


@socketio.on("disconnect")
def on_disconnect():
    if current_user.is_authenticated:
        # If was in a call, tell partner we left (so they can keep waiting / accept rejoin)
        partner_id = _ACTIVE_CALLS.pop(current_user.id, None)
        if partner_id:
            ch_id = _find_dm_channel_id(current_user.id, partner_id)
            if ch_id and ch_id in _DM_CALLS:
                _DM_CALLS[ch_id].discard(current_user.id)
                if not _DM_CALLS[ch_id]:
                    del _DM_CALLS[ch_id]
                    _broadcast_dm_call(ch_id, False)
                else:
                    _broadcast_dm_call(ch_id, True)
            emit("call_signal", {
                "type": "leave",
                "from_user_id": current_user.id,
                "from_username": current_user.username,
                "from_avatar_url": current_user.avatar_url or "",
                "from_avatar_color": current_user.avatar_color or "#5865f2",
                "data": None,
            }, room=f"user_{partner_id}")

        # Channel calls cleanup
        for ch_id in list(_CHANNEL_CALLS.keys()):
            if current_user.id in _CHANNEL_CALLS[ch_id]:
                _CHANNEL_CALLS[ch_id].discard(current_user.id)
                others = list(_CHANNEL_CALLS[ch_id])
                if not _CHANNEL_CALLS[ch_id]:
                    del _CHANNEL_CALLS[ch_id]
                for uid in others:
                    emit("channel_call_peer_left",
                         {"channel_id": ch_id, "user_id": current_user.id},
                         room=f"user_{uid}")
                _broadcast_channel_call(ch_id)

        current_user.is_online = False
        current_user.last_seen = datetime.utcnow()
        db.session.commit()
        emit("user_status", {"user_id": current_user.id, "is_online": False}, broadcast=True)


@socketio.on("join")
def on_join(data):
    channel_id = data.get("channel_id")
    if not _get_membership(channel_id):
        return
    join_room(f"channel_{channel_id}")


@socketio.on("leave")
def on_leave(data):
    channel_id = data.get("channel_id")
    leave_room(f"channel_{channel_id}")


@socketio.on("send_message")
def on_send_message(data):
    channel_id = data.get("channel_id")
    content = (data.get("content") or "").strip()
    attachment_url  = (data.get("attachment_url") or "").strip()
    attachment_type = (data.get("attachment_type") or "").strip()
    attachment_name = (data.get("attachment_name") or "").strip()
    if (not content and not attachment_url) or not _get_membership(channel_id):
        return

    # Block check for DM channels
    ch = Channel.query.get(channel_id)
    if ch and ch.is_dm:
        partner = next((m.user for m in ch.members if m.user_id != current_user.id), None)
        if partner:
            is_blocked = BlockedUser.query.filter(
                db.or_(
                    db.and_(BlockedUser.blocker_id == current_user.id,
                            BlockedUser.blocked_id == partner.id),
                    db.and_(BlockedUser.blocker_id == partner.id,
                            BlockedUser.blocked_id == current_user.id),
                )
            ).first()
            if is_blocked:
                return

    reply_to_id = data.get("reply_to_id") or None
    msg = Message(channel_id=channel_id, sender_id=current_user.id, content=content,
                  reply_to_id=reply_to_id,
                  attachment_url=attachment_url,
                  attachment_type=attachment_type,
                  attachment_name=attachment_name)
    db.session.add(msg)
    db.session.commit()

    emit("new_message", msg.to_dict(), room=f"channel_{channel_id}")


@socketio.on("edit_message")
def on_edit_message(data):
    msg_id = data.get("message_id")
    content = (data.get("content") or "").strip()
    if not content:
        return

    msg = Message.query.get(msg_id)
    if not msg or msg.is_deleted:
        return
    if msg.sender_id != current_user.id:
        return

    msg.content = content
    msg.edited_at = datetime.utcnow()
    db.session.commit()

    emit("message_updated", msg.to_dict(), room=f"channel_{msg.channel_id}")


@socketio.on("delete_message")
def on_delete_message(data):
    msg_id = data.get("message_id")
    mode = data.get("mode", "self")  # "all" or "self"

    msg = Message.query.get(msg_id)
    if not msg:
        return

    membership = _get_membership(msg.channel_id)
    if not membership:
        return

    is_sender = msg.sender_id == current_user.id
    is_admin_or_owner = membership.role in ("owner", "admin")

    if mode == "all":
        # Sender can delete their own; admin/owner can delete anyone's
        if not is_sender and not is_admin_or_owner:
            return
        msg.is_deleted = True
        msg.content = ""
        msg.attachment_url = ""
        msg.attachment_type = ""
        msg.attachment_name = ""
        db.session.commit()
        emit("message_deleted", {"message_id": msg_id, "mode": "all"},
             room=f"channel_{msg.channel_id}")
    else:
        # "delete for me" — only hide for the requesting user
        existing = HiddenMessage.query.filter_by(
            message_id=msg_id, user_id=current_user.id
        ).first()
        if not existing:
            db.session.add(HiddenMessage(message_id=msg_id, user_id=current_user.id))
            db.session.commit()
        emit("message_deleted", {"message_id": msg_id, "mode": "self"},
             room=request.sid)


@socketio.on("call_signal")
def on_call_signal(data):
    """Relay WebRTC signaling between two users + track active calls."""
    if not current_user.is_authenticated:
        return
    target = data.get("to_user_id")
    if not target:
        return
    type_ = data.get("type")
    # Track call participation so we can notify the partner if user disconnects
    if type_ in ("invite", "answer"):
        _ACTIVE_CALLS[current_user.id] = target
        _ACTIVE_CALLS[target] = current_user.id
        # DM-channel level tracking (for "active call in this chat" indicator)
        ch_id = _find_dm_channel_id(current_user.id, target)
        if ch_id:
            was_empty = ch_id not in _DM_CALLS
            _DM_CALLS.setdefault(ch_id, set()).update([current_user.id, target])
            if was_empty or type_ == "answer":
                _broadcast_dm_call(ch_id, True)
    elif type_ == "leave":
        _ACTIVE_CALLS.pop(current_user.id, None)
        ch_id = _find_dm_channel_id(current_user.id, target)
        if ch_id and ch_id in _DM_CALLS:
            _DM_CALLS[ch_id].discard(current_user.id)
            if not _DM_CALLS[ch_id]:
                del _DM_CALLS[ch_id]
                _broadcast_dm_call(ch_id, False)
            else:
                _broadcast_dm_call(ch_id, True)  # still active, fewer people
    elif type_ in ("end", "decline", "busy"):
        _ACTIVE_CALLS.pop(current_user.id, None)
        _ACTIVE_CALLS.pop(target, None)
        ch_id = _find_dm_channel_id(current_user.id, target)
        if ch_id:
            _DM_CALLS.pop(ch_id, None)
            _broadcast_dm_call(ch_id, False)
    payload = {
        "type": type_,
        "from_user_id": current_user.id,
        "from_username": current_user.username,
        "from_avatar_url": current_user.avatar_url or "",
        "from_avatar_color": current_user.avatar_color or "#5865f2",
        "data": data.get("data"),
    }
    emit("call_signal", payload, room=f"user_{target}")


_CHANNEL_CALLS = {}  # channel_id -> set(user_ids in call)

def _broadcast_channel_call(channel_id):
    ch = Channel.query.get(channel_id)
    if not ch:
        return
    payload = {
        "channel_id": channel_id,
        "active": channel_id in _CHANNEL_CALLS,
        "participants": list(_CHANNEL_CALLS.get(channel_id, [])),
    }
    for m in ch.members:
        emit("channel_call_status", payload, room=f"user_{m.user_id}")


@socketio.on("channel_call_join")
def on_channel_call_join(data):
    if not current_user.is_authenticated:
        return
    channel_id = data.get("channel_id")
    if not channel_id:
        return
    ch = Channel.query.get(channel_id)
    if not ch or ch.is_dm:
        return
    if ch.allow_calls is False:
        emit("channel_call_error", {"error": "Звонки отключены в этом канале"})
        return
    if not ChannelMember.query.filter_by(channel_id=channel_id, user_id=current_user.id).first():
        return
    existing_ids = list(_CHANNEL_CALLS.get(channel_id, set()))
    _CHANNEL_CALLS.setdefault(channel_id, set()).add(current_user.id)
    me_payload = {
        "id": current_user.id, "username": current_user.username,
        "avatar_url": current_user.avatar_url or "",
        "avatar_color": current_user.avatar_color or "#5865f2",
    }
    # Build full user objects for existing participants
    existing_users = []
    for uid in existing_ids:
        u = User.query.get(uid)
        if u:
            existing_users.append({
                "id": u.id, "username": u.username,
                "avatar_url": u.avatar_url or "",
                "avatar_color": u.avatar_color or "#5865f2",
            })
    emit("channel_call_joined", {
        "channel_id": channel_id,
        "existing_participants": existing_users,
    })
    # Notify existing participants that a new user joined
    for uid in existing_ids:
        emit("channel_call_peer_joined", {
            "channel_id": channel_id, "user": me_payload,
        }, room=f"user_{uid}")
    _broadcast_channel_call(channel_id)


@socketio.on("channel_call_leave")
def on_channel_call_leave(data):
    if not current_user.is_authenticated:
        return
    channel_id = data.get("channel_id")
    if not channel_id:
        return
    in_set = channel_id in _CHANNEL_CALLS
    if in_set:
        _CHANNEL_CALLS[channel_id].discard(current_user.id)
        others = list(_CHANNEL_CALLS[channel_id])
        if not _CHANNEL_CALLS[channel_id]:
            del _CHANNEL_CALLS[channel_id]
        for uid in others:
            emit("channel_call_peer_left", {
                "channel_id": channel_id, "user_id": current_user.id,
            }, room=f"user_{uid}")
    # ALWAYS broadcast status — even if call no longer exists, so stale clients update
    _broadcast_channel_call(channel_id)


@socketio.on("channel_call_signal")
def on_channel_call_signal(data):
    """Relay WebRTC signal between two specific users in a channel call."""
    if not current_user.is_authenticated:
        return
    target = data.get("to_user_id")
    if not target:
        return
    emit("channel_call_signal", {
        "channel_id": data.get("channel_id"),
        "from_user_id": current_user.id,
        "from_username": current_user.username,
        "from_avatar_url": current_user.avatar_url or "",
        "from_avatar_color": current_user.avatar_color or "#5865f2",
        "type": data.get("type"),  # offer, answer, ice
        "data": data.get("data"),
    }, room=f"user_{target}")


@socketio.on("typing")
def on_typing(data):
    channel_id = data.get("channel_id")
    if not _get_membership(channel_id):
        return
    emit("typing", {"user_id": current_user.id, "username": current_user.username,
                    "channel_id": channel_id},
         room=f"channel_{channel_id}", include_self=False)
