"""Test env defaults, set before any `app` module is imported (app.config reads env once at import)."""
import os
import tempfile

os.environ.setdefault("ESTIMATES_DATABASE_URL", "postgresql://estimates:dev@127.0.0.1:5433/estimates")
os.environ.setdefault("DATA_DIR", tempfile.mkdtemp(prefix="est_data_"))
os.environ.setdefault("ALLOW_NO_INTERNAL_TOKEN", "1")
