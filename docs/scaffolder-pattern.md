# Scaffolder script convention

A convention for the `scripts/scaffold_*.py` family. Adding a new scaffolder (or extending an existing one with a new feature toggle) follows the rules below so the three scripts stay consistent and so a new operator can predict the CLI without reading the source.

This is a pattern doc, not an implementation plan. When applying it to a specific script, write a separate plan (see "Open work" at the bottom).

---

## 1. What counts as a scaffolder

A scaffolder takes a small amount of input (a name, optionally a parquet) and emits a YAML config file in the repo's `config/` tree. The output is meant to be edited by hand afterward — the scaffolder produces a *starting point*, not a finished config.

In scope:

| Script | Output | Input |
|---|---|---|
| `scripts/scaffold_datastack.py` | `config/datastacks/<ds>.yaml` | datastack name |
| `scripts/scaffold_aligned_volume.py` | `config/aligned_volumes/<name>.yaml` | aligned-volume name |
| `scripts/scaffold_feature_explorer.py` | `config/feature_tables/<ds>/<id>.yaml` | parquet path + datastack |

Out of scope:

- `scripts/make_sample_embedding.py` — data generator (writes parquet + YAML for synthetic dev data), not a config scaffolder. The output is meant to be used as-is, not hand-edited.
- `scripts/dev/*.sh` — operator helpers; no config output.

A utility that doesn't produce a hand-edited YAML is not a scaffolder and is not bound by this convention.

---

## 2. The three-mode contract

Every scaffolder MUST support all three modes:

1. **Interactive** — `scripts/scaffold_foo.py` with no required flags. Prompts for every value, including the naming arg (datastack name, aligned-volume name, etc.). Uses `rich.prompt` for the UI to match the existing feature-explorer scaffolder.
2. **Hybrid** — any flag that supplies a value skips the corresponding prompt. The remaining values are prompted for. This is the common day-to-day mode: power users pass `--datastack foo` and skip the first question.
3. **Non-interactive** — `--non-interactive` skips all prompts. Every required value MUST be supplied via flag; missing values are a hard error with a clear message. This is the mode CI / regeneration scripts use.

**Rules:**

- For every prompt there is exactly one corresponding flag. A prompt with no flag breaks scriptability; a flag with no prompt breaks the interactive path.
- `--non-interactive` is a *no-prompts switch*, not a separate code path. The same code reads from `args.<field>` first, falls back to a prompt only when interactive.
- The naming arg (`--datastack`, `--name`, `--feature-table-id`) is NOT special — it follows the same rule as every other prompt.
- **Exception: filesystem-path inputs.** A flag whose value is *itself* a filesystem path the script must read (e.g., `scaffold_feature_explorer.py --parquet`) MAY stay `required=True` without a corresponding interactive prompt. Prompting for a free-text filesystem path inside `rich.Prompt` is bad UX — operators rely on shell tab-completion for paths, which a prompt doesn't provide. This exception covers actual paths only. Names that *participate in path construction* (e.g., `--datastack` feeding into `config/feature_tables/<datastack>/<id>.yaml`) are still names — they get an interactive prompt like any other.
- Refusing to overwrite (`--force` to override) is mode-independent. Failing fast on an existing file is fine in any mode; never prompt "overwrite? [y/N]" — `--force` is the explicit opt-in.

---

## 3. Feature-toggle YAML rendering

Most scaffolder outputs are heavily commented YAMLs where each major block can be turned on independently. The convention is **prompt → comment-flip**:

- Each major block in the output has a yes/no prompt: *"Enable cell-id lookup?"*, *"Configure decoration warmup?"*, etc.
- **Yes** → the block is rendered **uncommented**, with placeholder values the operator must fill in (`<TABLE NAME>`, `0` for ints, etc.).
- **No** → the block is rendered **commented out**, with the same body and a leading prose comment explaining what it does and when to turn it on.

The body of the commented and uncommented variants is the same template. The only difference is whether each line is prefixed with `# `. This means there's one source of truth per block and no drift between the "tutorial form" and the "live form".

**Rules:**

- A "major block" is one that an operator can choose to set or leave at the inherited default. Trivial knobs (a single field with a sensible default) are NOT major blocks — emit them uncommented with the default value, no prompt.
- Each major block gets a `--<feature> / --no-<feature>` flag pair (Python's `argparse.BooleanOptionalAction`). The flag drives the prompt the same way the naming arg drives the name prompt.
- Two-state knobs that look like a radio (e.g., "public vs internal") should usually be modeled as a single boolean (`--live-enabled / --no-live-enabled`) rather than a mutually-exclusive flag pair. The boolean is half the surface area and stays compatible with the comment-flip pattern. Reserve `Prompt.ask(choices=[...])` + `add_mutually_exclusive_group()` for genuine N-way choices (N ≥ 3) where each option emits a different block body.
- "Yes" placeholder values must be obviously-placeholder (`<TABLE NAME>` not `nucleus_detection_v0`). The operator should see the value is wrong; emitting a plausible-but-wrong default is worse than emitting a syntactic placeholder.
- The leading prose comment ("what this does, when to turn it on") stays attached to the block in both forms. In the "yes" form it's still useful context for the next person editing the file.

**Why this inversion is worth doing:** the current "everything commented; uncomment what you need" approach makes the output a discovery surface but a poor starting point — operators routinely miss blocks because they never scroll past the prose. Inverting it means the emitted file is already configured for the operator's stated intent, with the remaining options visible as commented templates.

---

## 4. Standard CLI surface

Every scaffolder has the same shape:

```
scripts/scaffold_<thing>.py [name-arg] [feature flags] [--out PATH] [--force] [--non-interactive]
```

- `--out PATH` — output path override. Default is convention-derived from the name arg (`config/datastacks/<ds>.yaml`, etc.).
- `--force` — overwrite an existing output file. Default refuses with exit 2 and an explanatory message that mentions `--out` as the other option.
- `--non-interactive` — no prompts; missing required values error out.
- Feature flags use `argparse.BooleanOptionalAction` so `--cell-id-lookup` and `--no-cell-id-lookup` both work.
- Schema validation: when a Pydantic schema exists for the output (e.g., `FeatureTableSpec`), validate before write and refuse to write an invalid file. When no schema exists (e.g., the datastack YAML has only partial Pydantic coverage today), this step is skipped — don't synthesize a schema just to validate the scaffolder output.
- After write: print the output path, then a short "Next:" block listing the immediate follow-ups (typically: edit the placeholders, then restart the backend / run the next scaffolder).

---

## 5. Current state of each scaffolder

| Script | Mode-contract | Feature toggles | Validation | Gaps |
|---|---|---|---|---|
| `scaffold_feature_explorer.py` | Conforms. Interactive by default; `--non-interactive` works; flags exist for the values that matter. | N/A — the output is parquet-driven, not block-toggled. | Pydantic `FeatureTableSpec` validation before write. | None. |
| `scaffold_datastack.py` | Conforms. Three-mode contract; name prompted when not flagged; `--non-interactive` errors out on missing name. | Six yes/no toggles (`--live-enabled` + five block toggles); see §6. | None — no Pydantic schema for `DatastackConfig` wired in. | None. |
| `scaffold_aligned_volume.py` | Conforms. Three-mode contract; name prompted when not flagged; `--non-interactive` errors out on missing name. | One yes/no toggle (`--spatial-transform`) with a `--provider` subprompt when on; see §6. | None. | None. |

---

## 6. Major blocks per output

This section names the blocks each scaffolder's "feature toggle" prompts should cover. It will need to be updated when a new block is added to a YAML schema.

### `scaffold_datastack.py`

Seven prompts total: the name plus six yes/no toggles.

1. **Datastack name** (free-text; filename basename).
2. **Live mode enabled** — `--live-enabled / --no-live-enabled` boolean. Yes renders `live_mode: true`; no renders `live_mode: false`. Default no (public/release behavior).
3. **Cell-id lookup** — emits the `cell_id_lookup` + `root_id_lookup_main_table` + `root_id_lookup_alt_tables` triple.
4. **Synapse-table overrides** — emits the `synapse:` block (position prefix, aggregation rules). Usually no.
5. **Decoration warmup** — emits the `decoration_warmup:` block.
6. **Synapse warmup** — emits the `synapse_warmup:` block.
7. **Feature explorer** — emits the `feature_explorer:` block. When yes, the "Next:" footer should still point at `scaffold_feature_explorer.py` as the next step.

The `cache_alias` field is a single line and doesn't justify its own toggle; leave it as a commented one-liner regardless.

In addition to the YAML, the datastack scaffolder seeds two empty convention-path subdirs the recipe registry reads from: `config/examples/<ds>/` and `config/recipes/<ds>/`. These are side effects of running the scaffolder, not toggles — `mkdir -p` is cheap and lets the operator drop a recipe/example YAML straight in without a follow-up step. The registry already tolerates missing dirs, so the seeding is purely operator-friendliness.

### `scaffold_aligned_volume.py`

Two prompts total: the name and one block toggle, plus one conditional subprompt.

1. **Aligned-volume name** (free-text; filename basename).
2. **Spatial transform** (`--spatial-transform`) — emits the `spatial:` block. When yes, additionally prompts for `provider` (default `cortex`; accepts `null` or a dotted import path). The operator still fills in `transform`, `depth_range`, `layer_boundaries`, `layer_names` by hand because those are domain knowledge — the script emits `<PLACEHOLDER>` values for those fields when the block is on.

The `synapse:` block at this level is usually inherited; leave it as a commented template either way (no toggle). The per-datastack scaffolder owns synapse overrides.

### `scaffold_feature_explorer.py`

No changes. Its prompts are driven by parquet-column classification, not block toggles, and it already conforms to §2.

---

## 7. Adding a new scaffolder

When a fourth scaffolder appears:

1. Pick a name: `scripts/scaffold_<thing>.py` where `<thing>` matches the output's `config/<thing>s/` directory (singular noun).
2. Write the YAML template body as one string with placeholder slots for each major block. Each block has two sibling renderers (commented / uncommented) sharing one body string.
3. Wire an argparse with the standard flags (§4) plus one `BooleanOptionalAction` per major block.
4. Wire prompts in a single `_run_interactive()` function that reads `args.<field>` first and falls back to `rich.prompt`. The same function runs in all three modes — `--non-interactive` is a `prompts_disabled` flag passed in, not a separate function.
5. Update this doc's §5 and §6 to list the new scaffolder and its blocks.
6. Update `docs/setting-up-a-datastack.md`'s helper-scripts section.

---

## 8. Out of scope

Things this convention deliberately does NOT cover:

- **Migration of existing YAMLs.** The scaffolder produces new files. Editing an existing config is hand-work and shouldn't be automated by this family.
- **Schema generation.** Scaffolders consume the existing Pydantic schemas; they don't generate them.
- **GUI / web UI for configuration.** The CLI scaffolder is the configuration surface. A future web admin UI is a separate design.
- **Data-generation utilities** like `make_sample_embedding.py`. Different problem; different conventions.

---

## Open work

All three scaffolders conform to the convention. When extending — e.g., adding a new block toggle to `scaffold_datastack.py`, or a fourth scaffolder for a new YAML kind — update §5 and §6 in the same change.
