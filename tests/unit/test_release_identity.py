"""SPEC release-identity: a build's declared identity is the code it runs.

The defect this closes, measured on a real host: `brain --version` reported `0.13.0` on a checkout
that `git describe` identified as `v0.13.0-49-gb440e6e` — forty-nine commits past the tag. An
operator running `main` and an operator running the actual 0.13.0 release got the same string.

The identity therefore has **two forms**, and the tests below bind each claim to the right one:

- the **full** form tells every build apart — a published version, a descendant of one, and a
  modified tree are all distinguishable;
- the **public** form is a truthful reduction of it, carrying no source revision, and is what an
  unauthenticated caller receives.

The invariant that matters most is not that they are equal — they are not — but that the public
form **never over-claims**. Saying "0.13.0" for a build that is not 0.13.0 is the original defect,
and a reduction is only allowed to lose detail, never to gain a claim.
"""

from __future__ import annotations

import pytest

from rsc_brain import __version__
from rsc_brain.identity_release import Identity, public_of, resolve

# A stamp as the build writes it: what `git describe --tags --always --dirty` yields.
RELEASE = "v0.13.0"
DESCENDANT = "v0.13.0-49-gb440e6e"
DIRTY = "v0.13.0-49-gb440e6e-dirty"
DIRTY_AT_TAG = "v0.13.0-dirty"
# Those four are test DATA — the stamp `git describe` produced on the host where the defect was
# measured — so they stay at 0.13.0 through every future release, and the assertions about them stay
# literal. The *unstamped* cases below are different: `resolve(None)` falls back to the package's own
# version, so asserting a literal there stops testing the property the moment the package is bumped.
# Which is why they read `__version__`.


class TestFullForm:
    def test_a_published_build_is_named_by_its_version(self) -> None:
        identity = resolve(RELEASE)
        assert identity.is_published is True
        assert identity.version == "0.13.0"

    def test_a_descendant_is_not_a_published_build(self) -> None:
        """The measured defect: 49 commits past the tag must not read as the tag."""
        identity = resolve(DESCENDANT)
        assert identity.is_published is False
        assert identity.version == "0.13.0", "it still descends from 0.13.0"
        assert identity.full != resolve(RELEASE).full

    def test_a_modified_tree_is_not_a_published_build(self) -> None:
        """Even at the tag: if the tree was dirty, the artifact is not that release."""
        identity = resolve(DIRTY_AT_TAG)
        assert identity.is_published is False

    @pytest.mark.parametrize(
        ("left", "right"),
        [
            (RELEASE, DESCENDANT),
            (DESCENDANT, DIRTY),
            (RELEASE, DIRTY_AT_TAG),
            ("v0.13.0-1-gaaaaaaa", "v0.13.0-1-gbbbbbbb"),
        ],
    )
    def test_different_source_revisions_have_different_full_identities(
        self, left: str, right: str
    ) -> None:
        assert resolve(left).full != resolve(right).full

    def test_the_full_form_never_raises_on_a_stamp_it_cannot_parse(self) -> None:
        """A resolver that can crash makes every surface that reads it fragile."""
        for stamp in ("", "   ", "not-a-version", "v", "vvv1.2.3", "\x00", "v1.2.3" * 500):
            identity = resolve(stamp)
            assert isinstance(identity.full, str)
            assert identity.full


class TestTheHonestFallback:
    """AUDIT-090's lesson, applied before the defect can exist: the absence of a value must not be
    reported as a definite answer. An unstamped build is a source checkout, and it must say so."""

    @pytest.mark.parametrize("absent", [None, "", "   "])
    def test_an_unstamped_build_does_not_claim_to_be_a_release(self, absent: str | None) -> None:
        identity = resolve(absent)
        assert identity.is_published is False
        assert identity.full != __version__, (
            "an unstamped build reporting the bare package version is exactly the defect: it is "
            "indistinguishable from the published release"
        )

    def test_an_unstamped_build_says_what_it_descends_from(self) -> None:
        """Useless is not the same as honest. It should still name the version line."""
        identity = resolve(None)
        assert identity.version == __version__

    def test_an_unstamped_build_is_marked_as_unknown_rather_than_guessed(self) -> None:
        identity = resolve(None)
        assert "unknown" in identity.full


class TestPublicForm:
    def test_a_published_build_publishes_its_version(self) -> None:
        assert public_of(resolve(RELEASE)) == "0.13.0"

    @pytest.mark.parametrize("stamp", [DESCENDANT, DIRTY, DIRTY_AT_TAG, None, "", "garbage"])
    def test_it_never_claims_a_published_version_it_is_not(self, stamp: str | None) -> None:
        """The one invariant a reduction may not break: losing detail is allowed, gaining a claim
        is not."""
        identity = resolve(stamp)
        public = public_of(identity)
        assert not identity.is_published
        assert public != identity.version, (
            f"the public form {public!r} is indistinguishable from the published version "
            f"{identity.version!r}, so a development build answers as a release"
        )

    @pytest.mark.parametrize("stamp", [DESCENDANT, DIRTY, "v0.13.0-1-gaaaaaaa"])
    def test_it_carries_no_source_revision(self, stamp: str) -> None:
        """Decided in clarify: the unauthenticated answer names the version, never the commit."""
        public = public_of(resolve(stamp))
        for revision in ("gb440e6e", "gaaaaaaa", "49"):
            assert revision not in public, f"the public form leaks the source revision: {public!r}"

    @pytest.mark.parametrize("stamp", [RELEASE, DESCENDANT, DIRTY, None, "garbage"])
    def test_public_and_full_agree_on_the_version_descended_from(self, stamp: str | None) -> None:
        identity = resolve(stamp)
        assert identity.version in public_of(identity)

    def test_two_development_builds_may_share_a_public_form(self) -> None:
        """Deliberate, and the reason the two forms exist. The public form is coarse by decision;
        only the full form tells two unpublished builds apart."""
        left, right = resolve("v0.13.0-1-gaaaaaaa"), resolve("v0.13.0-2-gbbbbbbb")
        assert public_of(left) == public_of(right)
        assert left.full != right.full


class TestTheIdentityIsInert:
    """It must answer while the database, the providers and the configuration are all unreachable —
    which is only guaranteed if it reads none of them."""

    def test_resolving_touches_nothing(self, monkeypatch: pytest.MonkeyPatch) -> None:
        import socket

        def _forbidden(*args: object, **kwargs: object) -> None:
            raise AssertionError("the identity resolver opened a socket")

        monkeypatch.setattr(socket, "socket", _forbidden)
        monkeypatch.setattr(socket, "create_connection", _forbidden)
        assert resolve(RELEASE).full

    def test_it_is_a_value_not_a_service(self) -> None:
        assert isinstance(resolve(RELEASE), Identity)
        assert resolve(RELEASE) == resolve(RELEASE)
