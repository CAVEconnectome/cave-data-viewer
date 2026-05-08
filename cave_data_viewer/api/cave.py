"""CAVEclient construction with explicit auth-handling.

Two named functions force every call site to declare whether anonymous fallback
to `~/.cloudvolume/secrets/cave-secret.json` is intentional. The single
`make_client(auth_token=None)` ergonomic from earlier was unsafe: a missing
middle-auth token would silently elevate to whatever cave-secret holds (often a
service account in production). All anonymous calls log a reason for audit.
"""

import os
from urllib.parse import urlparse

from caveclient import CAVEclient
from caveclient.tools.caching import CachedClient


def _ensure_scheme(server_address: str) -> str:
    if not urlparse(server_address).scheme:
        return f"https://{server_address}"
    return server_address


def _build(datastack_name, server_address, auth_token, materialize_version):
    client = CachedClient(
        datastack_name=datastack_name,
        server_address=_ensure_scheme(server_address),
        auth_token=auth_token,
    )
    if materialize_version not in (None, "live", ""):
        client.materialize.version = int(materialize_version)
    return client


def make_client_with_token(
    datastack_name: str,
    server_address: str,
    auth_token: str,
    materialize_version: int | str | None = None,
) -> CAVEclient:
    """Build a CAVEclient with an explicit non-empty token. Raises if missing."""
    if not auth_token or not isinstance(auth_token, str):
        raise ValueError(
            f"make_client_with_token requires a non-empty string auth_token; "
            f"got {type(auth_token).__name__}. Use make_client_anonymous() if "
            f"local cave-secret fallback is intentional."
        )
    return _build(datastack_name, server_address, auth_token, materialize_version)


def make_client_anonymous(
    datastack_name: str,
    server_address: str,
    materialize_version: int | str | None = None,
    *,
    reason: str,
    env_token_var: str | None = None,
) -> CAVEclient:
    """Build a CAVEclient that *may* fall back to the local cave-secret.

    Use ONLY for paths where this is intended (dev bypass, scheduled warmup).
    Always logs `reason` and the resolved token source so audit trails reveal
    every privileged code path that bypasses the per-request user token.
    """
    token: str | None = None
    source = "cave-secret"
    if env_token_var:
        env_value = os.environ.get(env_token_var) or None
        if env_value:
            token = env_value
            source = env_token_var
    print(f"[anon-cave] reason={reason} datastack={datastack_name} token_source={source}", flush=True)
    return _build(datastack_name, server_address, token, materialize_version)


def make_global_client_with_token(server_address: str, auth_token: str) -> CAVEclient:
    if not auth_token or not isinstance(auth_token, str):
        raise ValueError("make_global_client_with_token requires a non-empty string auth_token")
    return CAVEclient(
        datastack_name=None,
        server_address=_ensure_scheme(server_address),
        global_only=True,
        auth_token=auth_token,
    )


def request_client(
    datastack_name: str,
    server_address: str,
    *,
    auth_token: str | None,
    dev_bypass: bool,
    materialize_version: int | str | None = None,
) -> CAVEclient:
    """Per-request CAVEclient builder. The single sanctioned dispatch from
    request handlers — refuses to fall back to cave-secret unless dev bypass
    is explicitly on. Production middle-auth misconfigurations surface as a
    raised error rather than silent privilege escalation.
    """
    if auth_token:
        return make_client_with_token(
            datastack_name, server_address, auth_token,
            materialize_version=materialize_version,
        )
    if dev_bypass:
        return make_client_anonymous(
            datastack_name, server_address,
            materialize_version=materialize_version,
            reason="dev_bypass",
        )
    raise ValueError(
        "request_client called without an auth token outside of dev bypass. "
        "Refusing to fall back to ~/.cloudvolume/secrets/cave-secret.json — "
        "this would silently use whatever token lives there. Investigate why "
        "middle_auth_client did not populate flask.g.auth_token."
    )
