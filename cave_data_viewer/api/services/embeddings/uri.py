"""URI fetching for the Feature Explorer.

Two URI schemes are supported in v1:

- ``file://`` — local filesystem. Used in dev (the manifest + parquet live
  under ``/tmp/cdv-embeddings/``) and also by tests.
- ``gs://`` — Google Cloud Storage. Resolved with the same
  ``google-cloud-storage`` client style used by
  ``services.object_store.GcsObjectStore`` so the auth path (ADC + optional
  billing/quota project) matches the rest of the app.

``http(s)://`` is not implemented in v1 — the catalog-service path will need
it eventually but the project's only dependency that bundles ``requests``
transitively is ``caveclient``, and a HEAD-and-GET wrapper here would just
duplicate what fsspec would give us with a single extra dep. Add it when
there is an actual http source to point at.
"""

from __future__ import annotations

from pathlib import Path
from urllib.parse import urlparse


def fetch_bytes(uri: str, *, project: str | None = None) -> bytes:
    """Return the contents of ``uri`` as bytes.

    Parameters
    ----------
    uri
        ``file://path/to/file.yaml``, an absolute local path (treated as
        ``file://``), or ``gs://bucket/path/to/object``.
    project
        Optional GCP project name used as the billing/quota project on the
        GCS client. End-user ADC often needs this; service accounts do not.
        Threaded through from ``app.config['GCS_CACHE_PROJECT']`` at the
        call site.

    Raises
    ------
    ValueError
        On an unsupported URI scheme. The message includes the offending
        scheme so misconfigurations are easy to spot.
    """
    parsed = urlparse(uri)
    scheme = parsed.scheme

    if scheme in ("", "file"):
        path = local_path_for(uri)
        if path is None:  # defensive — local_path_for never returns None when scheme in ("","file")
            raise ValueError(f"could not derive local path from {uri!r}")
        return path.read_bytes()

    if scheme == "gs":
        # Lazy import so non-GCS deployments (or tests) don't pay the
        # cost of touching google-auth machinery.
        from google.cloud import storage

        if not parsed.netloc:
            raise ValueError(f"gs:// URI missing bucket: {uri!r}")
        client = storage.Client(project=project) if project else storage.Client()
        bucket = client.bucket(parsed.netloc)
        blob_name = parsed.path.lstrip("/")
        if not blob_name:
            raise ValueError(f"gs:// URI missing object path: {uri!r}")
        return bucket.blob(blob_name).download_as_bytes()

    raise ValueError(f"unsupported URI scheme {scheme!r} in {uri!r}")


def list_yaml_uris(uri: str, *, project: str | None = None) -> list[str]:
    """List ``*.yaml`` / ``*.yml`` files under a directory or prefix URI.

    Parameters
    ----------
    uri
        Directory URI:
        - ``file://path/to/dir`` or ``/abs/path/to/dir`` (local)
        - ``gs://bucket/some/prefix`` or ``gs://bucket/some/prefix/`` (GCS)
        The trailing slash is optional and stripped before listing.

    Returns a list of URIs (in the same scheme as the input) for the
    immediate children that end in ``.yaml`` or ``.yml``. Subdirectories
    are NOT recursed.

    Returns ``[]`` (with a logged warning by the caller, if appropriate)
    when the directory doesn't exist or contains no YAML files.
    """
    parsed = urlparse(uri)
    scheme = parsed.scheme

    if scheme in ("", "file"):
        path = local_path_for(uri)
        if path is None:
            return []
        if not path.is_dir():
            return []
        out: list[str] = []
        for child in sorted(path.iterdir()):
            if child.is_file() and child.suffix.lower() in (".yaml", ".yml"):
                out.append(f"file://{child.resolve()}")
        return out

    if scheme == "gs":
        # Lazy import; see fetch_bytes for the rationale.
        from google.cloud import storage

        if not parsed.netloc:
            raise ValueError(f"gs:// URI missing bucket: {uri!r}")
        client = storage.Client(project=project) if project else storage.Client()
        bucket = client.bucket(parsed.netloc)
        prefix = parsed.path.lstrip("/")
        if prefix and not prefix.endswith("/"):
            prefix = prefix + "/"
        out = []
        for blob in client.list_blobs(bucket, prefix=prefix):
            name = blob.name
            # Skip pseudo-subdirectory markers (zero-byte objects whose
            # name ends with `/`) and anything beneath a subdirectory
            # (Listing is recursive by default; gate to immediate children
            # by counting slashes past the prefix.).
            if name.endswith("/"):
                continue
            rest = name[len(prefix):] if prefix else name
            if "/" in rest:
                continue
            if not (rest.endswith(".yaml") or rest.endswith(".yml")):
                continue
            out.append(f"gs://{parsed.netloc}/{name}")
        return sorted(out)

    raise ValueError(f"unsupported URI scheme {scheme!r} in {uri!r}")


def local_path_for(uri: str) -> Path | None:
    """Return a ``Path`` for a ``file://`` URI (or a bare absolute path),
    else ``None``.

    Used by the parquet loader to skip the bytes-via-memory round-trip when
    the file is already local — pyarrow can memory-map directly from disk,
    which matters for ~500MB embedding frames.
    """
    parsed = urlparse(uri)
    if parsed.scheme == "":
        return Path(uri)
    if parsed.scheme == "file":
        # urlparse on file:///abs/path gives netloc="" and path="/abs/path";
        # on file://host/abs/path it gives netloc="host" — we don't support
        # the host form, treat as path-only.
        return Path(parsed.path)
    return None
