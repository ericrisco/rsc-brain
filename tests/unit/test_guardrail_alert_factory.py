"""The production alert route receives real credentials, never SecretStr's masked rendering."""

from __future__ import annotations

from typing import Any, cast

from pydantic import SecretStr

from rsc_brain.config.models import HuntingConfig, SmtpConfig
from rsc_brain.hunting.channels import SmtpChannel
from rsc_brain.hunting.factory import build_hunt_service_from_config


def test_config_factory_unwraps_channel_credentials() -> None:
    hunting = HuntingConfig(
        channel="smtp",
        smtp=SmtpConfig(
            host="smtp.example.test",
            username="brain",
            password=SecretStr("real-secret"),
        ),
    )

    service = build_hunt_service_from_config(
        cast(Any, object()), hunting=hunting, public_origin="https://brain.example.test"
    )

    assert isinstance(service.channel, SmtpChannel)
    assert service.channel._settings.password == "real-secret"
    assert service.can_deliver is True
