"""Host detection + profile recommendation for `brain doctor` (FR-11.1, D7).

Best-effort, cross-platform, and dependency-free: each probe (Docker, GPU/VRAM via ``nvidia-smi``,
RAM, free ports) is wrapped so an absent tool degrades cleanly rather than failing. The pure
:func:`recommend_profile` is the decision the installer acts on: a GPU host → ``workstation``,
otherwise ``cpu_only``.
"""

from __future__ import annotations

import os
import shutil
import socket
import subprocess
from dataclasses import dataclass, field

from rsc_brain.config.models import HardwareProfile

DEFAULT_PORTS = (8000, 5432)


@dataclass(frozen=True, slots=True)
class HostReport:
    docker: bool
    has_gpu: bool
    gpu_name: str | None
    vram_mb: int | None
    ram_gb: float | None
    free_ports: dict[int, bool] = field(default_factory=dict)
    recommended_profile: str = HardwareProfile.CPU_ONLY.value


def recommend_profile(*, has_gpu: bool) -> HardwareProfile:
    """A GPU host runs the workstation profile; everything else runs cpu_only (G5)."""
    return HardwareProfile.WORKSTATION if has_gpu else HardwareProfile.CPU_ONLY


def _docker_present() -> bool:
    if shutil.which("docker") is None:
        return False
    try:
        result = subprocess.run(["docker", "info"], capture_output=True, timeout=5, check=False)
        return result.returncode == 0
    except (OSError, subprocess.SubprocessError):  # pragma: no cover - environment-dependent
        return False


def _detect_gpu() -> tuple[bool, str | None, int | None]:
    if shutil.which("nvidia-smi") is None:
        return False, None, None
    try:  # pragma: no cover - requires a GPU host
        result = subprocess.run(
            [
                "nvidia-smi",
                "--query-gpu=name,memory.total",
                "--format=csv,noheader,nounits",
            ],
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
        if result.returncode != 0 or not result.stdout.strip():
            return False, None, None
        name, _, vram = result.stdout.strip().splitlines()[0].partition(",")
        return True, name.strip(), int(vram.strip())
    except (OSError, subprocess.SubprocessError, ValueError):  # pragma: no cover
        return False, None, None


def _detect_ram_gb() -> float | None:
    try:
        page_size = os.sysconf("SC_PAGE_SIZE")
        pages = os.sysconf("SC_PHYS_PAGES")
        return round(page_size * pages / (1024**3), 1)
    except (ValueError, OSError, AttributeError):  # pragma: no cover - non-POSIX
        return None


def _port_free(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.settimeout(0.2)
        return probe.connect_ex(("127.0.0.1", port)) != 0


def detect_host(ports: tuple[int, ...] = DEFAULT_PORTS) -> HostReport:
    """Probe the host and recommend a hardware profile. All probes are best-effort."""
    has_gpu, gpu_name, vram_mb = _detect_gpu()
    return HostReport(
        docker=_docker_present(),
        has_gpu=has_gpu,
        gpu_name=gpu_name,
        vram_mb=vram_mb,
        ram_gb=_detect_ram_gb(),
        free_ports={port: _port_free(port) for port in ports},
        recommended_profile=recommend_profile(has_gpu=has_gpu).value,
    )
