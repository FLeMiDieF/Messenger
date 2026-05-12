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
    for m in ChannelMember.query.filter_by(user_id=current_user.id).all():
        join_room(f"channel_{m.channel_id}")
    emit("user_status", {"user_id": current_user.id, "is_online": True}, broadcast=True)


@socketio.on("disconnect")
def on_disconnect():
    if current_user.is_authenticated:
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
    if not content or not _get_membership(channel_id):
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
                  reply_to_id=reply_to_id)
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


@socketio.on("typing")
def on_typing(data):
    channel_id = data.get("channel_id")
    if not _get_membership(channel_id):
        return
    emit("typing", {"user_id": current_user.id, "username": current_user.username,
                    "channel_id": channel_id},
         room=f"channel_{channel_id}", include_self=False)
