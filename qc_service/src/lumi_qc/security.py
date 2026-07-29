from __future__ import annotations

import hashlib
import json
import os
import re
import secrets
from pathlib import Path
from typing import Any

SECRET_KEY_PATTERN = re.compile(
    r"(password|passwd|pwd|otp|secret|api[_-]?key|token|authorization|cookie)",
    re.IGNORECASE,
)
SECRET_TEXT_PATTERN = re.compile(
    r"(?i)\b(password|passwd|pwd|otp|secret|api[_-]?key|authorization|bearer)\b"
    r"\s*[:=]\s*([^\s,;]+)"
)
GOOGLE_API_KEY_PATTERN = re.compile(r"\bAIza[A-Za-z0-9_-]{30,}\b")
ACCOUNT_TEXT_PATTERN = re.compile(
    r"(?i)\b(tk|tài khoản|tai khoan|account|username|user)\b"
    r"\s*[:=]\s*([^\s,;]+)(?:\s*[/|]\s*([^\s,;]+))?"
)


def load_or_create_installation_token(data_dir: Path) -> str:
    configured = os.environ.get("LUMI_QC_INSTALLATION_TOKEN", "").strip()
    if configured:
        if len(configured) < 24:
            raise ValueError("LUMI_QC_INSTALLATION_TOKEN must contain at least 24 characters.")
        return configured
    token_path = data_dir / ".installation-token"
    if token_path.exists():
        token = token_path.read_text(encoding="utf-8").strip()
        if len(token) >= 24:
            return token
    token = secrets.token_urlsafe(36)
    token_path.write_text(token, encoding="utf-8")
    return token


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def redact(value: Any, depth: int = 0) -> Any:
    if depth > 10:
        return "[depth-limit]"
    if isinstance(value, dict):
        return {
            str(key): (
                "[REDACTED]"
                if SECRET_KEY_PATTERN.search(str(key))
                else redact(item, depth + 1)
            )
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [redact(item, depth + 1) for item in value[:200]]
    if isinstance(value, str):
        redacted = GOOGLE_API_KEY_PATTERN.sub("[REDACTED_GOOGLE_API_KEY]", value)
        redacted = SECRET_TEXT_PATTERN.sub(r"\1=[REDACTED]", redacted)
        redacted = ACCOUNT_TEXT_PATTERN.sub(r"\1=[REDACTED_ACCOUNT]", redacted)
        return redacted[:20000]
    return value


def sanitized_json(value: Any) -> str:
    return json.dumps(redact(value), ensure_ascii=False, separators=(",", ":"))


def is_allowed_origin(origin: str | None) -> bool:
    if not origin:
        return True
    return origin.startswith("chrome-extension://")
