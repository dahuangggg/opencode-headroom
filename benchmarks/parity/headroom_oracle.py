"""Execute the pinned Headroom ContentRouter for parity snapshot generation."""

from __future__ import annotations

import hashlib
import inspect
import json
import sys
from datetime import UTC, datetime
from typing import Any

import headroom
import headroom.transforms.content_router as content_router_module
from headroom.transforms.content_router import ContentRouter, ContentRouterConfig


def sha256(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def structure_valid(fixture: dict[str, Any], compressed: str) -> bool:
    kind = fixture["kind"]
    original = fixture["content"]
    if kind == "json":
        try:
            json.loads(compressed)
            return True
        except json.JSONDecodeError:
            return False
    if kind == "diff":
        required = [
            line
            for line in original.splitlines()
            if line.startswith(("diff --git ", "--- ", "+++ ", "@@ "))
            or (line.startswith("+") and not line.startswith("+++"))
            or (line.startswith("-") and not line.startswith("---"))
        ]
        return all(line in compressed for line in required)
    if kind == "mixed":
        markers = [
            "<returncode>",
            "</returncode>",
            "<stdout>",
            "</stdout>",
            "<stderr>",
            "</stderr>",
        ]
        return all(marker in compressed for marker in markers)
    if kind == "table":
        return all(line in compressed for line in original.splitlines()[:2])
    return bool(compressed.strip())


def main() -> None:
    request: dict[str, Any] = json.load(sys.stdin)
    router_config = request["routerConfig"]
    router = ContentRouter(ContentRouterConfig(**router_config))
    results: list[dict[str, Any]] = []

    for fixture in request["fixtures"]:
        result = router.compress(
            fixture["content"],
            context=fixture["query"],
            question=fixture["query"],
        )
        compressed = str(result.compressed)
        facts = fixture["protectedFacts"]
        results.append(
            {
                "id": fixture["id"],
                "fixtureSha256": fixture["fixtureSha256"],
                "strategy": result.strategy_used.value,
                "originalTokens": result.total_original_tokens,
                "outputTokens": result.total_compressed_tokens,
                "outputSha256": sha256(compressed),
                "structureValid": structure_valid(fixture, compressed),
                "protectedFacts": facts,
                "retainedFacts": [fact for fact in facts if fact in compressed],
            }
        )

    source_path = inspect.getsourcefile(content_router_module)
    if source_path is None:
        raise RuntimeError("cannot locate Headroom ContentRouter source")
    with open(source_path, "rb") as source_file:
        source_hash = hashlib.sha256(source_file.read()).hexdigest()

    json.dump(
        {
            "schemaVersion": 1,
            "generatedAt": datetime.now(UTC).isoformat(),
            "reference": {
                "package": "headroom-ai",
                "version": headroom.__version__,
                "commit": request["commit"],
                "profile": request["profile"],
                "routerConfig": router_config,
                "contentRouterSha256": source_hash,
            },
            "fixtures": results,
        },
        sys.stdout,
        ensure_ascii=False,
    )


if __name__ == "__main__":
    main()
