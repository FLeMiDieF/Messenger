import os

BASE_DIR = os.path.abspath(os.path.dirname(__file__))


class Config:
    SECRET_KEY = os.environ.get("SECRET_KEY", "dev-secret-key-change-in-prod")

    SQLALCHEMY_DATABASE_URI = os.environ.get(
        "DATABASE_URL",
        "sqlite:///" + os.path.join(BASE_DIR, "messenger.db"),
    )
    SQLALCHEMY_TRACK_MODIFICATIONS = False

    REDIS_URL = os.environ.get("REDIS_URL", "redis://localhost:6379/0")

    # Flask-SocketIO
    SOCKETIO_MESSAGE_QUEUE = os.environ.get("REDIS_URL", None)
