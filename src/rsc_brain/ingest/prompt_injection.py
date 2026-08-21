"""Conservative quarantine signals for instruction-targeting document content.

This is deliberately a *review signal*, not the security boundary and not a claim that a regex
can solve prompt injection. The structural boundary lives in :mod:`rsc_brain.ingest.prompts`;
matching here only keeps obvious attacks out of embedding/extraction until a curator reviews them.
"""

from __future__ import annotations

import base64
import binascii
import re
import unicodedata
from dataclasses import dataclass

_MAX_SCAN_CHARS = 200_000
_MAX_DECODED_BYTES = 8_192
_BASE64_TOKEN = re.compile(r"(?<![A-Za-z0-9+/])[A-Za-z0-9+/]{16,10924}={0,2}(?![A-Za-z0-9+/=])")
_SPACED_LETTERS = re.compile(r"(?<!\w)(?:[a-z0-9]\s+){3,}[a-z0-9](?!\w)", re.IGNORECASE)

_ATTACK_PATTERNS: tuple[re.Pattern[str], ...] = tuple(
    re.compile(pattern, re.IGNORECASE | re.DOTALL)
    for pattern in (
        r"\b(?:ignore|disregard|forget)\b.{0,100}\b(?:previous|prior|all|system|developer)\b.{0,60}\b(?:instructions?|rules?|prompts?)\b",
        r"\b(?:ignora|ignore|olvida|desobedece)\b.{0,100}\b(?:las?\s+)?(?:instrucciones?|reglas?|prompts?)\b",
        r"\b(?:system|developer|assistant)\s+(?:message|prompt|instruction)\s*:",
        r"\b(?:system|developer|assistant)\s*:\s*.{0,100}\b(?:ignore|output|return|call|label|tag|reveal|emit)\b",
        r"\b(?:call|invoke|execute|run)\b.{0,50}\b(?:tool|function)\b",
        r"\b(?:llama|invoca|ejecuta)\b.{0,50}\b(?:herramienta|funci[oó]n)\b",
        r"\b(?:label|tag|classify|mark|emit|output|return)\b.{0,80}\b(?:general|public|admin|sensitive)\b",
        r"\b(?:etiqueta|etiqu[eé]talo|clasifica|marca|devuelve|responde)\b.{0,80}\b(?:general|p[uú]blic[oa]|admin|sensible)\b",
        r"\b(?:reveal|leak|dump|exfiltrate)\b.{0,80}\b(?:projects?|secrets?|credentials?|instructions?|system prompt)\b",
        r"\b(?:revela|filtra|exfiltra|muestra)\b.{0,80}\b(?:proyectos?|secretos?|credenciales?|instrucciones?|prompt)\b",
    )
)


@dataclass(frozen=True, slots=True)
class PromptInjectionSignal:
    reason: str = "prompt_injection"
    source: str = "plain"
    pattern: str = ""


def _normalize(text: str) -> str:
    normalized = unicodedata.normalize("NFKC", text).casefold()
    return _SPACED_LETTERS.sub(lambda match: re.sub(r"\s+", "", match.group()), normalized)


def _match(text: str, *, source: str) -> PromptInjectionSignal | None:
    normalized = _normalize(text[:_MAX_SCAN_CHARS])
    compact = re.sub(r"[\s._-]+", "", normalized)
    for phrase in (
        "ignorepreviousinstructions",
        "ignorepriorinstructions",
        "ignoralasinstrucciones",
        "olvidalasinstrucciones",
    ):
        if phrase in compact:
            return PromptInjectionSignal(source=source, pattern=phrase)
    for pattern in _ATTACK_PATTERNS:
        if pattern.search(normalized):
            return PromptInjectionSignal(source=source, pattern=pattern.pattern)
    return None


def _decoded_base64(text: str) -> list[str]:
    decoded: list[str] = []
    for token_match in _BASE64_TOKEN.finditer(text[:_MAX_SCAN_CHARS]):
        token = token_match.group()
        if len(token) % 4:
            token += "=" * (4 - len(token) % 4)
        try:
            raw = base64.b64decode(token, validate=True)
        except (binascii.Error, ValueError):
            continue
        if not raw or len(raw) > _MAX_DECODED_BYTES:
            continue
        try:
            value = raw.decode("utf-8")
        except UnicodeDecodeError:
            continue
        if sum(character.isprintable() for character in value) / len(value) >= 0.85:
            decoded.append(value)
    return decoded


def detect_prompt_injection(text: str) -> PromptInjectionSignal | None:
    """Return a quarantine signal for known instruction-targeting forms, including Base64."""

    if signal := _match(text, source="plain"):
        return signal
    for decoded in _decoded_base64(text):
        if signal := _match(decoded, source="base64"):
            return signal
    return None
