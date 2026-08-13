"""The config phase must leave an install that can actually connect (AUDIT-055)."""

from __future__ import annotations

from pathlib import Path

from rsc_brain.installer import env_init


def _seed(root: Path) -> None:
    (root / ".env.example").write_text(
        "POSTGRES_USER=rsc_brain\nPOSTGRES_DB=rsc_brain\nPOSTGRES_PASSWORD=\n"
        "RSC_BRAIN_DB_BIND=127.0.0.1\nRSC_BRAIN_DB_PORT=5432\n",
        encoding="utf-8",
    )
    (root / "config.example.yaml").write_text("hardware_profile: cpu_only\n", encoding="utf-8")


def test_materialise_generates_a_password_and_derives_the_dsn(tmp_path: Path) -> None:
    """`brain migrate` failed with DatabaseNotConfiguredError on a clean host: the installer
    generated POSTGRES_PASSWORD but never composed the DSN the application reads, leaving the
    operator to hand-assemble a connection string from three values they did not choose."""
    _seed(tmp_path)
    report = env_init.materialise(tmp_path)

    values = dict(
        line.split("=", 1)
        for line in (tmp_path / ".env").read_text(encoding="utf-8").splitlines()
        if "=" in line and not line.strip().startswith("#")
    )
    password = values["POSTGRES_PASSWORD"]
    assert password and password != ""
    dsn = values.get("RSC_BRAIN_DATABASE__DSN", "")
    assert dsn.startswith("postgresql+asyncpg://"), f"no usable DSN derived: {dsn!r}"
    assert password in dsn, "the DSN must carry the password the installer just generated"
    assert "rsc_brain" in dsn
    assert "RSC_BRAIN_DATABASE__DSN" in report.generated


def test_materialise_never_rotates_values_that_are_already_set(tmp_path: Path) -> None:
    """Re-running `apply` on a live install must not change the password out from under the
    running database, nor rewrite a DSN an operator pointed at their own server."""
    _seed(tmp_path)
    env_init.materialise(tmp_path)
    first = (tmp_path / ".env").read_text(encoding="utf-8")

    env_init.materialise(tmp_path)
    assert (tmp_path / ".env").read_text(encoding="utf-8") == first


def test_check_refuses_an_install_that_cannot_connect(tmp_path: Path) -> None:
    _seed(tmp_path)
    env_init.materialise(tmp_path)
    ok, _ = env_init.check(tmp_path)
    assert ok

    (tmp_path / ".env").write_text("POSTGRES_PASSWORD=set\n", encoding="utf-8")
    ok, detail = env_init.check(tmp_path)
    assert not ok and "DSN" in detail
