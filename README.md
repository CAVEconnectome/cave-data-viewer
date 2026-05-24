# CAVE Diver

A Flask API + React/TypeScript SPA for diving into CAVE (Connectome
Annotation Versioning Engine) connectivity, decorations, and spatial
features.

Extracted from [ceesem/dash-connectivity-viewer](https://github.com/ceesem/dash-connectivity-viewer)
after the legacy three-Dash-app layout was replaced with a unified
workspace SPA. The Python package directory `cave_data_viewer/` and the
`CDV_*` env var prefix are kept from the prior name; the historical Dash
dependency is gone.

## Components

- `cave_data_viewer/api/` — Flask backend. Connectivity, decorations,
  cell-id lookup, Neuroglancer link generation, server-side Plotly figure
  rendering, SpatialProvider abstraction for anatomy-specific spatial
  features.
- `frontend/` — Vite + React + TypeScript SPA.

See `CLAUDE.md` for architecture notes.

## Local development

```bash
# Backend (auto-discovers CDV_DATASTACK_CONFIG_DIR for datastack YAMLs).
# AirPlay squats on port 5000 — use 5001 locally.
CDV_DEV_AUTH_BYPASS=1 CDV_PORT=5001 uv run python run_api.py

# Frontend
cd frontend
npm install
npm run dev      # vite dev server
npm run build    # tsc -b && vite build
```

`CDV_DEV_AUTH_BYPASS=1` skips middle-auth-client so a local dev
environment doesn't need a CAVE token in cookies; production must run
without it.

## Configuration

- [Environment variables reference](docs/environment-variables.md) — every
  runtime knob, what it controls, and whether it's required or optional.
- [Setting up a datastack](docs/setting-up-a-datastack.md) — how to add a
  new dataset to a deployment.
- [Datastack YAML reference](docs/datastack-config.md) — field-by-field
  reference for `config/datastacks/<ds>.yaml`.
- [Aligned-volume YAML reference](docs/aligned-volumes.md) — field-by-field
  reference for `config/aligned_volumes/<av>.yaml`.

## License

See `LICENSE.txt`.
