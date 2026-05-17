"""Tests for the `scope:` field round-trip through the recipes store.

`scope` is a recipe-level field shared between connectivity and explorer
kinds. The store layer (services/recipes.py) doesn't validate predicate
shape — that's Pydantic's job in services/datastack_config.py — but it
MUST preserve the field through put → get.
"""

from __future__ import annotations

from cave_data_viewer.api.services import recipes


class InMemoryStore:
    """Minimal GcsObjectStore-shaped fake."""

    def __init__(self) -> None:
        self._objects: dict[str, dict] = {}

    def set_yaml(self, path: str, content: dict) -> None:
        self._objects[path] = content

    def get_yaml(self, path: str):
        return self._objects.get(path)

    def list_yaml(self, prefix: str) -> list[dict]:
        return [v for k, v in self._objects.items() if k.startswith(prefix)]

    def delete(self, path: str) -> None:
        self._objects.pop(path, None)


def test_scope_roundtrips_on_connectivity_recipe() -> None:
    store = InMemoryStore()
    body = {
        "version": 1,
        "kind": "connectivity",
        "title": "with scope",
        "scope": {"predicates": [{"column": "cell_type", "op": "in", "values": ["L23P"]}]},
    }
    recipes.put_recipe(store, user_id=42, ds="ds_x", recipe_id="personal-aaaa", recipe_dict=body)
    out = recipes.get_recipe(store, user_id=42, ds="ds_x", recipe_id="personal-aaaa")
    assert out is not None
    assert out["scope"] == body["scope"]


def test_scope_roundtrips_on_explorer_recipe() -> None:
    store = InMemoryStore()
    body = {
        "version": 1,
        "kind": "explorer",
        "title": "with scope",
        "explorer": {"ft": "x", "emb": "y"},
        "scope": {"predicates": [{"column": "depth_um", "op": "gte", "value": 200}]},
    }
    recipes.put_recipe(store, user_id=42, ds="ds_x", recipe_id="personal-bbbb", recipe_dict=body)
    out = recipes.get_recipe(store, user_id=42, ds="ds_x", recipe_id="personal-bbbb")
    assert out is not None
    assert out["scope"] == body["scope"]


def test_scope_predicate_count_cap_enforced() -> None:
    """Scope with more than 100 predicates is rejected."""
    import pytest

    store = InMemoryStore()
    body = {
        "version": 1,
        "kind": "connectivity",
        "title": "too many",
        "scope": {
            "predicates": [
                {"column": f"c{i}", "op": "eq", "value": i} for i in range(101)
            ],
        },
    }
    with pytest.raises(recipes.RecipeValidationError):
        recipes.put_recipe(store, user_id=42, ds="ds_x", recipe_id="personal-cccc", recipe_dict=body)
