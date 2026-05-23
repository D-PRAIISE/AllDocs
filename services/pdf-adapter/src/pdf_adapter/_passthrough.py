"""
Passthrough-export support.

When a PDF round-trips through UDM unchanged (view → download with no
edits, or with edits limited to regions we can patch), we want to emit
the original PDF bytes verbatim instead of re-rendering from the UDM.
Re-rendering loses font fidelity, vector precision, and any content the
v0.1 importer drops on the floor (annotations, forms, color profiles).

Mechanism:
  1. At import, we stash a fingerprint of the UDM's editable content
     alongside the source PDF's URL and SHA-256 under
     ``metadata.passthrough``.
  2. At export, the exporter recomputes the fingerprint from the
     incoming UDM and compares. If it matches and the source file is
     reachable, we copy the source bytes to the output and skip the
     render path entirely.

Fingerprint design:
  Stable across JSON round-trips and float-precision shifts. Covers
  text content, image identity, and per-layer-type counts so any edit
  the v0.1 editor exposes flips the hash. Excludes positional floats
  (x/y/width/height) because TipTap may re-emit them with slightly
  different precision without semantic change — and positional changes
  alone can't happen in v0.1 (the editor doesn't expose drag).
"""
from __future__ import annotations

import hashlib
from typing import Any


def compute_fingerprint(udm: dict[str, Any]) -> str:
    """Stable 16-char hex digest of UDM content semantics.

    Differs whenever any of these change:
      - Number of pages
      - Text content of any run, in order
      - image_id of any image layer, in order
      - Count of each layer type per page
      - data_ref of any image resource (so swapping an image's bytes
        invalidates passthrough and routes to the patch exporter)
    """
    h = hashlib.sha256()

    content = udm.get("content") or {}
    pages = content.get("pages") or []
    h.update(f"pc:{len(pages)}\n".encode())

    for page in pages:
        # number + rotation + source index: any page-structure change
        # (reorder, delete, insert, rotate) flips the fingerprint.
        src = (page.get("_meta") or {}).get("source_page", "")
        h.update(
            f"p:{page.get('number', '?')}|rot:{page.get('rotation', 0)}|src:{src}\n".encode()
        )
        layer_counts: dict[str, int] = {}
        for layer in page.get("layers", []):
            t = layer.get("type", "")
            layer_counts[t] = layer_counts.get(t, 0) + 1
            if t == "text":
                for run in layer.get("runs", []):
                    # Text + formatting: a size/bold change with the same
                    # string must still invalidate passthrough so the
                    # patch exporter re-renders the run.
                    size = (run.get("font_size") or {}).get("value", "")
                    h.update(
                        f"t:{run.get('text', '')}|f:{run.get('font_id', '')}|s:{size}\n".encode(
                            "utf-8"
                        )
                    )
            elif t == "image":
                h.update(f"i:{layer.get('image_id', '')}\n".encode())
            elif t == "form":
                for field in layer.get("fields", []) or []:
                    h.update(
                        (
                            f"ff:{field.get('name', '')}|"
                            f"{field.get('kind', '')}|"
                            f"{field.get('value', '')}\n"
                        ).encode("utf-8")
                    )
            elif t == "shape":
                geom = layer.get("geometry") or {}
                # Include fill + stroke so a recolor invalidates passthrough.
                fill = (layer.get("fill") or {}).get("color", {}).get("literal", {})
                stroke = (
                    ((layer.get("stroke") or {}).get("paint") or {})
                    .get("color", {})
                    .get("literal", {})
                )
                h.update(
                    (
                        f"s:{geom.get('kind', '')}"
                        f"|f:{fill.get('r', '')},{fill.get('g', '')},{fill.get('b', '')},"
                        f"{fill.get('hex', '')}"
                        f"|k:{stroke.get('r', '')},{stroke.get('g', '')},{stroke.get('b', '')}\n"
                    ).encode()
                )
        for k in sorted(layer_counts):
            h.update(f"c:{k}={layer_counts[k]}\n".encode())

    # Image resource data_refs: an image swap keeps the same image_id and
    # layer counts (so the per-page hashing above wouldn't notice), but
    # the resource's data_ref changes to a data: URL. Hash it here so the
    # swap invalidates passthrough.
    for img in (udm.get("resources") or {}).get("images", []) or []:
        h.update(f"r:{img.get('id', '')}={img.get('data_ref', '')}\n".encode("utf-8"))

    return h.hexdigest()[:16]


def attach(
    udm: dict[str, Any],
    source_url: str,
    source_sha256: str,
) -> None:
    """Record a passthrough block on the UDM. Idempotent."""
    metadata = udm.setdefault("metadata", {})
    metadata["passthrough"] = {
        "source_url": source_url,
        "source_sha256": source_sha256,
        "fingerprint": compute_fingerprint(udm),
    }


def can_passthrough(udm: dict[str, Any]) -> dict[str, Any] | None:
    """Return the passthrough block if and only if the UDM still matches
    its recorded fingerprint. Returns None otherwise — caller should fall
    back to the render path.
    """
    metadata = udm.get("metadata") or {}
    pt = metadata.get("passthrough")
    if not isinstance(pt, dict):
        return None
    if not pt.get("source_url") or not pt.get("fingerprint"):
        return None
    if compute_fingerprint(udm) != pt["fingerprint"]:
        return None
    return pt
