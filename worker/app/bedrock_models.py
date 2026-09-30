"""List the Claude and embedding models your Bedrock region offers, and check the configured tier IDs.

    docker compose run --rm worker python -m app.bedrock_models
"""
from __future__ import annotations

import boto3

from .config import settings


def main() -> int:
    bedrock = boto3.client("bedrock", region_name=settings.aws_region)
    print(f"Region: {settings.aws_region}\n")
    profiles = []
    token = None
    while True:
        kw = {"maxResults": 100, **({"nextToken": token} if token else {})}
        resp = bedrock.list_inference_profiles(**kw)
        profiles += resp.get("inferenceProfileSummaries", [])
        token = resp.get("nextToken")
        if not token:
            break
    print("Inference profiles (use these IDs for Converse):")
    for p in sorted(profiles, key=lambda p: p["inferenceProfileId"]):
        if "anthropic" in p["inferenceProfileId"]:
            print(f"  {p['inferenceProfileId']:60s} {p.get('status', '')}")
    models = bedrock.list_foundation_models()["modelSummaries"]
    print("\nFoundation models (Anthropic, Cohere/Titan embeddings):")
    for m in sorted(models, key=lambda m: m["modelId"]):
        mid = m["modelId"]
        if mid.startswith("anthropic.") or "embed" in mid:
            print(f"  {mid:60s} {','.join(m.get('inferenceTypesSupported', []))}")
    configured = {"fast": settings.model_fast, "standard": settings.model_standard,
                  "advanced": settings.model_advanced, "embedding": settings.embedding_model}
    known = {p["inferenceProfileId"] for p in profiles} | {m["modelId"] for m in models}
    print("\nConfigured:")
    ok = True
    for tier, mid in configured.items():
        found = mid in known
        ok &= found
        print(f"  {tier:10s} {mid:60s} {'OK' if found else 'NOT OFFERED IN THIS REGION'}")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
