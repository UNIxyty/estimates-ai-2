"""Knowledge-file ingestion: readers -> structure analysis -> extraction -> logic -> pipeline (job handler).

The job handler lives in `app.ingest.pipeline` (imported by app.main to register it); importing this package
has no side effects.
"""
from .readers import IngestError

__all__ = ["IngestError"]
