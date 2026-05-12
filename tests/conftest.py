import os
import pytest

os.environ.setdefault("DATABASE_URL", "sqlite:///:memory:")
os.environ.setdefault("SECRET_KEY", "test-secret")
os.environ.setdefault("SOCKETIO_MESSAGE_QUEUE", "")


@pytest.fixture(scope="session")
def app():
    from app import create_app
    application = create_app()
    application.config["TESTING"] = True
    return application


@pytest.fixture(scope="session")
def client(app):
    return app.test_client()
