from __future__ import annotations

import json
from pathlib import Path

from src.utils.config_loader import ConfigLoader


def test_opencode_key_falls_back_to_current_auth_store(
    tmp_path, monkeypatch
):
    config_dir = tmp_path / ".config" / "opencode"
    config_dir.mkdir(parents=True)
    (config_dir / "opencode.json").write_text(
        json.dumps(
            {
                "model": "deepseek/deepseek-v4-flash",
                "enabled_providers": ["deepseek"],
            }
        ),
        encoding="utf-8",
    )
    auth_dir = tmp_path / ".local" / "share" / "opencode"
    auth_dir.mkdir(parents=True)
    (auth_dir / "auth.json").write_text(
        json.dumps(
            {
                "deepseek": {
                    "type": "api",
                    "key": "test-deepseek-key",
                }
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setattr(Path, "home", lambda: tmp_path)

    assert (
        ConfigLoader._load_opencode_api_key("deepseek")
        == "test-deepseek-key"
    )


def test_opencode_legacy_embedded_provider_key_still_works(
    tmp_path, monkeypatch
):
    config_dir = tmp_path / ".config" / "opencode"
    config_dir.mkdir(parents=True)
    (config_dir / "opencode.json").write_text(
        json.dumps(
            {
                "provider": {
                    "deepseek": {
                        "options": {
                            "apiKey": "legacy-deepseek-key",
                        }
                    }
                }
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setattr(Path, "home", lambda: tmp_path)

    assert (
        ConfigLoader._load_opencode_api_key("deepseek")
        == "legacy-deepseek-key"
    )
