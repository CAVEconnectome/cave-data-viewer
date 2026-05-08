import hashlib
import json
from typing import Any


def canonical_query_hash(payload: Any) -> str:
    blob = json.dumps(payload, sort_keys=True, default=str, separators=(",", ":"))
    return hashlib.sha1(blob.encode("utf-8")).hexdigest()


def is_live(mat_version: int | str | None) -> bool:
    return mat_version in (None, "", "live")
