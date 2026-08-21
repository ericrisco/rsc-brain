"""Canonical separation between code-owned instructions and variable model data."""

from __future__ import annotations

import json
from typing import Any

UNTRUSTED_BOUNDARY = "untrusted_data_v1"


def untrusted_data_message(kind: str, /, **payload: Any) -> dict[str, str]:
    """Encode every variable value as JSON data in a dedicated user message.

    ``kind`` is a code-owned literal. ``default=str`` keeps rare Pydantic error context serializable;
    the resulting representation remains a quoted JSON value and never joins trusted instructions.
    """

    return {
        "role": "user",
        "content": json.dumps(
            {"boundary": UNTRUSTED_BOUNDARY, "kind": kind, "payload": payload},
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
            default=str,
        ),
    }
