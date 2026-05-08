"""Sanity-check every YAML the runtime loads.

Validates:
  - `config/datastacks/*.yaml`           (DatastackConfig schema)
  - `config/aligned_volumes/*.yaml`      (AlignedVolumeConfig schema)
  - `cave_data_viewer/api/templates/links/*.yaml`  (LinkTemplate)
  - `cave_data_viewer/api/templates/plots/*.yaml`  (PlotSpec)

Exits non-zero on any YAML parse error or Pydantic validation error so this
can serve as a CI gate. Unknown-field warnings (operator typos that fall
through to defaults) print but do not fail — the runtime tolerates them.
"""

from __future__ import annotations

import argparse
import sys
from dataclasses import dataclass
from pathlib import Path

import yaml
from pydantic import BaseModel, ValidationError

from cave_data_viewer.api.services.datastack_config import (
    AlignedVolumeConfig,
    DatastackConfig,
    _warn_unknown_fields,
)
from cave_data_viewer.api.services.links import LinkTemplate
from cave_data_viewer.api.services.plots import PlotSpec


REPO_ROOT = Path(__file__).resolve().parents[2]
PACKAGE_ROOT = Path(__file__).resolve().parents[1]


@dataclass
class CheckTarget:
    label: str
    directory: Path
    schema: type[BaseModel]


TARGETS: list[CheckTarget] = [
    CheckTarget("datastack", REPO_ROOT / "config" / "datastacks", DatastackConfig),
    CheckTarget("aligned_volume", REPO_ROOT / "config" / "aligned_volumes", AlignedVolumeConfig),
    CheckTarget("link_template", PACKAGE_ROOT / "api" / "templates" / "links", LinkTemplate),
    CheckTarget("plot_spec", PACKAGE_ROOT / "api" / "templates" / "plots", PlotSpec),
]


def _check_file(path: Path, schema: type[BaseModel]) -> list[str]:
    """Validate a single YAML against its schema. Returns a list of error
    messages (empty when the file is OK).

    Unknown-field warnings are emitted as logging WARNINGs by
    `_warn_unknown_fields` and are not collected here — they're not failures.
    """
    errors: list[str] = []
    try:
        data = yaml.safe_load(path.read_text()) or {}
    except yaml.YAMLError as exc:
        return [f"{path}: YAML parse error: {exc}"]

    if isinstance(data, dict) and "name" not in data and schema in (LinkTemplate, PlotSpec):
        data["name"] = path.stem

    _warn_unknown_fields(schema, data, path)

    try:
        schema.model_validate(data)
    except ValidationError as exc:
        errors.append(f"{path}: validation error: {exc}")
    return errors


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--quiet", action="store_true",
        help="Only print errors. Useful in CI; default prints a per-file OK line too.",
    )
    args = parser.parse_args(argv)

    import logging
    logging.basicConfig(level=logging.WARNING, format="%(levelname)s %(name)s: %(message)s")

    all_errors: list[str] = []
    for target in TARGETS:
        if not target.directory.is_dir():
            if not args.quiet:
                print(f"[skip] {target.label}: {target.directory} (no directory)")
            continue
        files = sorted(target.directory.glob("*.yaml"))
        if not files and not args.quiet:
            print(f"[skip] {target.label}: {target.directory} (no YAMLs)")
            continue
        for path in files:
            errors = _check_file(path, target.schema)
            if errors:
                all_errors.extend(errors)
                for err in errors:
                    print(f"[FAIL] {err}", file=sys.stderr)
            elif not args.quiet:
                print(f"[ ok ] {target.label}: {path.name}")

    if all_errors:
        print(f"\n{len(all_errors)} error(s).", file=sys.stderr)
        return 1
    if not args.quiet:
        print("\nAll YAMLs validated.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
