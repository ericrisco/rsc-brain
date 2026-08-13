"""12-factor configuration loading: YAML file overlaid by environment variables.

Precedence (highest wins): explicit init kwargs > environment > YAML file > code
defaults. Secrets never live in the YAML file — they arrive as environment
variables (FR-4.7). Nested keys use the ``RSC_BRAIN_`` prefix and ``__`` as the
delimiter, e.g. ``RSC_BRAIN_CAPABILITIES__EMBEDDER__API_KEY``.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import ClassVar

from pydantic_settings import (
    BaseSettings,
    PydanticBaseSettingsSource,
    SettingsConfigDict,
    YamlConfigSettingsSource,
)

from rsc_brain.config.models import AppConfig

CONFIG_ENV_VAR = "RSC_BRAIN_CONFIG"
DEFAULT_CONFIG_FILENAME = "config.yaml"


class Settings(AppConfig, BaseSettings):
    """Runtime settings: the :class:`AppConfig` tree, loaded 12-factor style."""

    model_config = SettingsConfigDict(
        env_prefix="RSC_BRAIN_",
        env_nested_delimiter="__",
        extra="ignore",
        case_sensitive=False,
        # AUDIT-056: compose injects `.env` into containers, but `brain apply` runs the CLI on the
        # host, where nothing loaded it — so the installer wrote a perfectly good DSN into a file
        # the application never read, and `brain migrate` stopped with "no database configured".
        # A real environment variable still outranks this file (pydantic-settings orders
        # init > env > dotenv), so a platform-injected value is never shadowed by a stale checkout.
        env_file=".env",
        env_file_encoding="utf-8",
    )

    # Set by :func:`load_settings` before instantiation; read in the source hook.
    _yaml_file: ClassVar[Path | None] = None

    @classmethod
    def settings_customise_sources(
        cls,
        settings_cls: type[BaseSettings],
        init_settings: PydanticBaseSettingsSource,
        env_settings: PydanticBaseSettingsSource,
        dotenv_settings: PydanticBaseSettingsSource,
        file_secret_settings: PydanticBaseSettingsSource,
    ) -> tuple[PydanticBaseSettingsSource, ...]:
        # Order = priority. Env must beat the YAML file, which beats defaults.
        sources: list[PydanticBaseSettingsSource] = [init_settings, env_settings, dotenv_settings]
        if cls._yaml_file is not None:
            sources.append(YamlConfigSettingsSource(settings_cls, yaml_file=cls._yaml_file))
        sources.append(file_secret_settings)
        return tuple(sources)


def _resolve_yaml_path(path: Path | str | None) -> Path | None:
    """Resolve which YAML file to load: explicit arg > env var > ./config.yaml."""
    if path is not None:
        return Path(path)
    env_path = os.environ.get(CONFIG_ENV_VAR)
    if env_path:
        return Path(env_path)
    default = Path(DEFAULT_CONFIG_FILENAME)
    return default if default.is_file() else None


def load_settings(path: Path | str | None = None) -> Settings:
    """Load configuration from YAML (if any) overlaid by the environment.

    Args:
        path: explicit YAML path. Falls back to ``$RSC_BRAIN_CONFIG`` then
            ``./config.yaml``; with none present, code defaults + env are used.
    """
    Settings._yaml_file = _resolve_yaml_path(path)
    return Settings()
