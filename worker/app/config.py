"""Worker configuration, read once from the environment.

The DB URL is read from ESTIMATES_DATABASE_URL (not DATABASE_URL) so an exported DATABASE_URL in the
operator's shell cannot shadow the compose .env value. See README "Known gotchas".
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field


def _env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


def _float(name: str, default: float) -> float:
    try:
        return float(_env(name) or default)
    except ValueError:
        return default


def _int(name: str, default: int) -> int:
    try:
        return int(_env(name) or default)
    except ValueError:
        return default


@dataclass(frozen=True)
class Settings:
    database_url: str = field(default_factory=lambda: _env(
        "ESTIMATES_DATABASE_URL", "postgresql://estimates:estimates@db:5432/estimates"))
    data_dir: str = field(default_factory=lambda: _env("DATA_DIR", "/data/files"))
    migrations_dir: str = field(default_factory=lambda: _env(
        "MIGRATIONS_DIR", os.path.join(os.path.dirname(__file__), "..", "..", "db", "migrations")))
    internal_token: str = field(default_factory=lambda: _env("INTERNAL_TOKEN"))
    app_url: str = field(default_factory=lambda: _env("APP_URL", "http://localhost:3000").rstrip("/"))
    # Day/month boundaries (usage, budget) are computed in this zone: the DB session TimeZone is set to it.
    app_timezone: str = field(default_factory=lambda: _env("APP_TIMEZONE", "UTC"))
    build_hash: str = field(default_factory=lambda: _env("BUILD_HASH", "dev"))
    worker_concurrency: int = field(default_factory=lambda: _int("WORKER_CONCURRENCY", 3))

    # Bedrock
    aws_region: str = field(default_factory=lambda: _env("AWS_REGION", "eu-north-1"))
    model_fast: str = field(default_factory=lambda: _env(
        "BEDROCK_MODEL_FAST", "eu.anthropic.claude-haiku-4-5-20251001-v1:0"))
    model_standard: str = field(default_factory=lambda: _env(
        "BEDROCK_MODEL_STANDARD", "eu.anthropic.claude-sonnet-4-6"))
    model_advanced: str = field(default_factory=lambda: _env(
        "BEDROCK_MODEL_ADVANCED", "eu.anthropic.claude-opus-4-6-v1"))
    embedding_model: str = field(default_factory=lambda: _env(
        "BEDROCK_EMBEDDING_MODEL", "amazon.titan-embed-text-v2:0"))
    embedding_dim: int = 1024  # fixed by the vector(1024) columns
    llm_enabled: bool = field(default_factory=lambda: _env("LLM_ENABLED", "true").lower() != "false")

    # Costs / safety
    run_cost_cap_usd: float = field(default_factory=lambda: _float("RUN_COST_CAP_USD", 2.0))
    undo_seconds: int = field(default_factory=lambda: _int("UNDO_SECONDS", 10))
    permission_card_minutes: int = field(default_factory=lambda: _int("PERMISSION_CARD_MINUTES", 30))

    # Email
    resend_api_key: str = field(default_factory=lambda: _env("RESEND_API_KEY"))
    email_from: str = field(default_factory=lambda: _env("EMAIL_FROM", "Estimates <estimates@example.com>"))

    # Web search
    web_search_provider: str = field(default_factory=lambda: _env("WEB_SEARCH_PROVIDER", "brave"))
    brave_api_key: str = field(default_factory=lambda: _env("BRAVE_API_KEY"))
    tavily_api_key: str = field(default_factory=lambda: _env("TAVILY_API_KEY"))
    # Supplier allowlist for web prices: "domain[:CC]" comma-separated (CC = ISO country; default from the TLD).
    web_search_domains: str = field(default_factory=lambda: _env("WEB_SEARCH_DOMAINS", "elektrika.lv:LV"))
    web_search_unit_cost_usd: float = field(default_factory=lambda: _float("WEB_SEARCH_UNIT_COST_USD", 0.005))
    web_user_agent: str = field(default_factory=lambda: _env(
        "WEB_USER_AGENT", "EstimatesAgent/1.0 (+price lookup; respects robots.txt)"))

    # First admin (seed)
    first_admin_email: str = field(default_factory=lambda: _env("FIRST_ADMIN_EMAIL"))
    first_admin_name: str = field(default_factory=lambda: _env("FIRST_ADMIN_NAME", "Admin"))


settings = Settings()
