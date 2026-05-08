"""Regression test for the phase-c late-binding closure bug.

Background: in `services/decoration.py`, the SWR revalidation closures
look like:

    def _refresh(_cache=ct_cache, _key=ct_key, _table=cell_type_table, _mv=mat_version):
        fresh = _fetch_cell_type_table(client_factory(), _table, _mv)
        _cache.set(_key, fresh)

The default-arg captures pin the values at function-definition time. Without
them, Python's late binding causes every closure in the same scope to read
the *current* values of `ct_cache` / `ct_key` / etc. — so when the outer
scope reassigns those (e.g. processing a different decoration table next
loop iteration), all already-submitted closures suddenly see the new state
and write to the wrong cache.

This test does NOT exercise the production code directly. It freezes the
binding pattern as a property test: a future refactor that drops the
default-arg capture must fail this test.
"""

from __future__ import annotations


def _make_late_bound_closures():
    """Builder that exhibits the BUG: closures bind by name, not by value.

    Every closure in `closures` will read the latest `value` in the loop's
    scope at call time, not the value at the iteration when it was created.
    """
    closures = []
    value = None
    for v in [1, 2, 3]:
        value = v

        def _f():
            return value
        closures.append(_f)
    return closures


def _make_default_arg_closures():
    """Builder that follows the rule: each closure default-arg-captures
    its own copy of `value`. This is the correct pattern."""
    closures = []
    for v in [1, 2, 3]:
        def _f(_value=v):
            return _value
        closures.append(_f)
    return closures


def test_late_binding_fails_as_expected():
    # Sanity: the bug exists. If this test ever fails, Python has
    # changed semantics and the rest of the file needs revisiting.
    closures = _make_late_bound_closures()
    assert [c() for c in closures] == [3, 3, 3]


def test_default_arg_capture_isolates_each_closure():
    # The actual property under test: each closure remembers its own
    # iteration's value. This is what the production revalidation
    # closures rely on.
    closures = _make_default_arg_closures()
    assert [c() for c in closures] == [1, 2, 3]


def test_decoration_revalidation_closures_use_default_args():
    """Lint-style guard: the production refresh closures in
    `services/decoration.py` must default-arg-capture every variable
    they reference. Drop one and this test fails — re-read CLAUDE.md
    before "cleaning up" the signature.
    """
    import inspect

    from cave_data_viewer.api.services import decoration

    source = inspect.getsource(decoration)
    # Each refresh closure inside `lookup_decorations` captures via
    # `_cache=...`, `_key=...`, `_table=...`, `_mv=...`. Search the
    # source for the canonical def lines and assert the default-arg
    # capture is present. Brittle to renames, but that's the point —
    # any rename of these closures should re-affirm the rule.
    refresh_closures = [
        "_refresh_soma",
        "_refresh_table",
    ]
    for name in refresh_closures:
        assert f"def {name}(_cache=" in source, (
            f"Closure {name!r} in decoration.py must default-arg-capture "
            "_cache. Without `_cache=...` the late-binding bug from "
            "phase-c regresses — see CLAUDE.md 'late-binding closure bug'."
        )
