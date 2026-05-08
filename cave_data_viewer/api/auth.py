import os
from functools import wraps

import flask


_DEV_BYPASS = os.environ.get("CDV_DEV_AUTH_BYPASS", "").lower() in {"1", "true", "yes", "on"}


def _bypass_decorator(func):
    @wraps(func)
    def wrapper(*args, **kwargs):
        return func(*args, **kwargs)
    return wrapper


if _DEV_BYPASS:
    auth_required = _bypass_decorator
    auth_requires_permission = lambda *_, **__: _bypass_decorator  # noqa: E731
else:
    from middle_auth_client import (
        auth_required as auth_required,
        auth_requires_permission as auth_requires_permission,
    )


def current_token() -> str | None:
    # `flask.g.auth_token` is populated by middle-auth-client's
    # `@auth_required` decorator after it validates the cookie. With the
    # SPA's paste-token escape hatch removed, the cookie is the only auth
    # path — so this is the only place a token surfaces.
    return flask.g.get("auth_token")


def current_user_id() -> int | None:
    # `flask.g.auth_user` is populated by middle-auth-client alongside
    # `auth_token`. Public-access fallback sets `id: 0` (anonymous sentinel)
    # — callers that store per-user data (e.g. recipes) must refuse 0.
    # Returns None in dev-bypass mode (no auth_user populated) or when the
    # decorator hasn't run.
    if _DEV_BYPASS:
        return None
    user = flask.g.get("auth_user")
    if not user:
        return None
    return user.get("id")


def is_dev_bypass() -> bool:
    return _DEV_BYPASS
