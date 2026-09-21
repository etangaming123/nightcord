"""Admin CLI commands that touch files (nightcord_server.py)."""

import zipfile

import nightcord_server as cli
from nightcord.config import Config
from nightcord.db import Database


def test_backup(tmp_path, capsys):
    data = tmp_path / "data"
    db = Database(data / "nightcord.db")
    db.create_user("owner", "!", is_server_owner=True)
    db.close()
    (data / "legal").mkdir()
    (data / "legal" / "terms.md").write_text("Be nice.\n")
    (data / "key.pem").write_text("secret")
    cfg = Config(tls=False, data_dir=data)

    assert cli.cmd_backup(cfg, tmp_path / "out") == 0
    [zip_path] = (tmp_path / "out").iterdir()
    with zipfile.ZipFile(zip_path) as zf:
        names = set(zf.namelist())
        assert {"nightcord.db", "legal/terms.md"} <= names
        assert "key.pem" not in names
        zf.extract("nightcord.db", tmp_path / "restore")
    restored = Database(tmp_path / "restore" / "nightcord.db")
    assert restored.get_server_owner_row()["username"] == "owner"
    assert "Backup written" in capsys.readouterr().out


def test_config_set_new_keys(tmp_path):
    db = Database(tmp_path / "n.db")
    cfg = Config(tls=False, data_dir=tmp_path)
    assert cli.cmd_config(db, cfg, "set", "user_search", "staff") == 0
    assert cli.cmd_config(db, cfg, "set", "announcements_admins", "true") == 0
    assert cli.cmd_config(db, cfg, "set", "max_accounts_per_client", "3") == 0
    assert cli.cmd_config(db, cfg, "set", "max_accounts_per_client", "99") == 2
    got = db.get_server_config()
    assert (got["user_search"], got["announcements_admins"], got["max_accounts_per_client"]) == ("staff", True, 3)
