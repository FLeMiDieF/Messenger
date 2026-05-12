import json


def register(client, username, password="secret123"):
    return client.post("/register", data={"username": username, "password": password},
                       follow_redirects=True)


def login(client, username, password="secret123"):
    return client.post("/login", data={"username": username, "password": password},
                       follow_redirects=True)


# ── Auth ──────────────────────────────────────────────────────────────────

def test_register_ok(client):
    r = register(client, "alice")
    assert r.status_code == 200


def test_login_ok(client):
    login(client, "alice")
    r = client.get("/")
    assert r.status_code == 200


def test_duplicate_username(client):
    register(client, "bob")
    r = register(client, "bob")
    assert "занято" in r.data.decode()


def test_wrong_password(client):
    r = login(client, "alice", "wrong")
    assert "Неверное" in r.data.decode()


# ── API ───────────────────────────────────────────────────────────────────

def test_channels_empty(client):
    login(client, "alice")
    r = client.get("/api/channels")
    assert r.status_code == 200
    assert json.loads(r.data) == []


def test_create_channel(client):
    login(client, "alice")
    r = client.post("/api/channels",
                    json={"name": "general", "description": "test"},
                    content_type="application/json")
    assert r.status_code == 201
    data = json.loads(r.data)
    assert data["name"] == "general"
    assert data["my_role"] == "owner"


def test_channels_list_after_create(client):
    login(client, "alice")
    r = client.get("/api/channels")
    channels = json.loads(r.data)
    assert any(c["name"] == "general" for c in channels)


def test_user_search(client):
    login(client, "alice")
    register(client, "charlie")
    login(client, "alice")
    r = client.get("/api/users/search?q=char")
    users = json.loads(r.data)
    assert any(u["username"] == "charlie" for u in users)


def test_messages_empty(client):
    login(client, "alice")
    channels = json.loads(client.get("/api/channels").data)
    ch_id = next(c["id"] for c in channels if c["name"] == "general")
    r = client.get(f"/api/channels/{ch_id}/messages")
    assert r.status_code == 200
    assert json.loads(r.data) == []


def test_forbidden_channel(client):
    register(client, "dave")
    login(client, "dave")
    # dave is not in alice's general channel
    login(client, "alice")
    channels = json.loads(client.get("/api/channels").data)
    ch_id = next(c["id"] for c in channels if c["name"] == "general")
    login(client, "dave")
    r = client.get(f"/api/channels/{ch_id}/messages")
    assert r.status_code == 403
