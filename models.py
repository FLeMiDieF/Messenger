from datetime import datetime
from flask_sqlalchemy import SQLAlchemy
from flask_login import UserMixin
from werkzeug.security import generate_password_hash, check_password_hash

db = SQLAlchemy()


class User(UserMixin, db.Model):
    __tablename__ = "users"

    id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.String(80), unique=True, nullable=False)
    password_hash = db.Column(db.String(256), nullable=False)
    is_online = db.Column(db.Boolean, default=False)
    last_seen = db.Column(db.DateTime, default=datetime.utcnow)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

    memberships = db.relationship("ChannelMember", back_populates="user", lazy="dynamic")
    messages = db.relationship("Message", back_populates="sender", lazy="dynamic")
    hidden_messages = db.relationship("HiddenMessage", back_populates="user", lazy="dynamic")

    def set_password(self, password):
        self.password_hash = generate_password_hash(password)

    def check_password(self, password):
        return check_password_hash(self.password_hash, password)

    def to_dict(self):
        return {
            "id": self.id,
            "username": self.username,
            "is_online": self.is_online,
            "last_seen": self.last_seen.isoformat(),
        }


class Channel(db.Model):
    __tablename__ = "channels"

    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(100), nullable=False)
    description = db.Column(db.String(300), default="")
    is_dm = db.Column(db.Boolean, default=False)
    is_private = db.Column(db.Boolean, default=False)
    owner_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=False)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

    owner = db.relationship("User", foreign_keys=[owner_id])
    members = db.relationship("ChannelMember", back_populates="channel", cascade="all, delete-orphan")
    messages = db.relationship("Message", back_populates="channel", cascade="all, delete-orphan",
                               order_by="Message.created_at")

    def to_dict(self, current_user_id=None):
        member = None
        if current_user_id:
            member = ChannelMember.query.filter_by(
                channel_id=self.id, user_id=current_user_id
            ).first()
        return {
            "id": self.id,
            "name": self.name,
            "description": self.description,
            "is_dm": self.is_dm,
            "is_private": self.is_private,
            "owner_id": self.owner_id,
            "my_role": member.role if member else None,
            "member_count": len(self.members),
        }


class ChannelMember(db.Model):
    __tablename__ = "channel_members"
    __table_args__ = (db.UniqueConstraint("channel_id", "user_id"),)

    id = db.Column(db.Integer, primary_key=True)
    channel_id = db.Column(db.Integer, db.ForeignKey("channels.id", ondelete="CASCADE"), nullable=False)
    user_id = db.Column(db.Integer, db.ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    # owner / admin / member
    role = db.Column(db.String(20), default="member", nullable=False)
    joined_at = db.Column(db.DateTime, default=datetime.utcnow)

    channel = db.relationship("Channel", back_populates="members")
    user = db.relationship("User", back_populates="memberships")


class Message(db.Model):
    __tablename__ = "messages"

    id = db.Column(db.Integer, primary_key=True)
    channel_id = db.Column(db.Integer, db.ForeignKey("channels.id", ondelete="CASCADE"), nullable=False)
    sender_id = db.Column(db.Integer, db.ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    content = db.Column(db.Text, nullable=False)
    is_deleted = db.Column(db.Boolean, default=False)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    edited_at = db.Column(db.DateTime, nullable=True)

    channel = db.relationship("Channel", back_populates="messages")
    sender = db.relationship("User", back_populates="messages")
    hidden_by = db.relationship("HiddenMessage", back_populates="message", cascade="all, delete-orphan")

    def to_dict(self, hidden_for_user_id=None):
        hidden = False
        if hidden_for_user_id:
            hidden = HiddenMessage.query.filter_by(
                message_id=self.id, user_id=hidden_for_user_id
            ).first() is not None
        return {
            "id": self.id,
            "channel_id": self.channel_id,
            "sender_id": self.sender_id,
            "sender_username": self.sender.username if self.sender else "Удалён",
            "content": "" if self.is_deleted else self.content,
            "is_deleted": self.is_deleted,
            "is_hidden": hidden,
            "created_at": self.created_at.isoformat() + "Z",
            "edited_at": self.edited_at.isoformat() + "Z" if self.edited_at else None,
        }


class BlockedUser(db.Model):
    """blocker_id has blocked blocked_id."""
    __tablename__ = "blocked_users"
    __table_args__ = (db.UniqueConstraint("blocker_id", "blocked_id"),)

    id = db.Column(db.Integer, primary_key=True)
    blocker_id = db.Column(db.Integer, db.ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    blocked_id = db.Column(db.Integer, db.ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)


class HiddenMessage(db.Model):
    """Message hidden for a specific user ("delete for me")."""
    __tablename__ = "hidden_messages"
    __table_args__ = (db.UniqueConstraint("message_id", "user_id"),)

    id = db.Column(db.Integer, primary_key=True)
    message_id = db.Column(db.Integer, db.ForeignKey("messages.id", ondelete="CASCADE"), nullable=False)
    user_id = db.Column(db.Integer, db.ForeignKey("users.id", ondelete="CASCADE"), nullable=False)

    message = db.relationship("Message", back_populates="hidden_by")
    user = db.relationship("User", back_populates="hidden_messages")
