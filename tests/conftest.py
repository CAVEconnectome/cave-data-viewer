"""Pytest harness for the dash-connectivity-viewer backend.

Boots a Flask app in dev-bypass mode (no CAVE token required) so endpoint
tests can hit the test client without auth plumbing. Tests that exercise
pure-Python helpers don't need this fixture and can import the helpers
directly.
"""

from __future__ import annotations

import os

# Set the dev-auth-bypass env var at module load time, BEFORE any test file
# triggers the import of cave_data_viewer.api.auth. The auth module evaluates
# the env var at import time and caches the result for the session; setting
# it inside the app() fixture is too late once any earlier-loaded test has
# triggered the api.auth import.
os.environ["CDV_DEV_AUTH_BYPASS"] = "1"

import pytest


@pytest.fixture()
def app():
    """A Flask app built via `create_app()` with auth bypassed.

    Auth bypass means handlers run without a middle-auth token cookie. CAVE
    calls inside handlers will still attempt to authenticate; tests that
    exercise endpoints touching CAVE should mock `request_client` or stick
    to endpoints that don't (e.g. `/plots/specs`, `/health`).
    """
    from cave_data_viewer.api import create_app
    return create_app()


@pytest.fixture()
def client(app):
    return app.test_client()
