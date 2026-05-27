"""AllDocs text adapter — Markdown, HTML, EPUB <-> UDM flow."""

from .importer import import_html, import_markdown
from .exporter import export_html, export_markdown

__all__ = [
    "import_markdown",
    "import_html",
    "export_markdown",
    "export_html",
]
