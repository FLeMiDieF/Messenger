import eventlet
eventlet.monkey_patch()

from flask import Flask
from flask_login import LoginManager
from config import Config
from models import db, User
from extensions import migrate, socketio


def create_app():
    app = Flask(__name__)
    app.config.from_object(Config)

    db.init_app(app)
    migrate.init_app(app, db)
    socketio.init_app(
        app,
        message_queue=app.config["SOCKETIO_MESSAGE_QUEUE"],
        async_mode="eventlet",
        cors_allowed_origins="*",
    )

    login_manager = LoginManager(app)
    login_manager.login_view = "auth.login"
    login_manager.login_message = "Войдите в аккаунт."
    login_manager.login_message_category = "warning"

    @login_manager.user_loader
    def load_user(user_id):
        return User.query.get(int(user_id))

    from routes.auth import auth
    from routes.chat import chat
    from routes.api import api
    app.register_blueprint(auth)
    app.register_blueprint(chat)
    app.register_blueprint(api)

    import events  # noqa: F401 — registers SocketIO handlers

    with app.app_context():
        db.create_all()

    return app


if __name__ == "__main__":
    app = create_app()
    socketio.run(app, debug=True, host="0.0.0.0", port=5001)
