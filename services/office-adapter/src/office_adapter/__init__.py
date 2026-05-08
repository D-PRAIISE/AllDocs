"""AllDocs Office format adapter (DOCX in v0.1)."""
from .exporter import export_docx, export_docx_from_file
from .importer import UDM_VERSION, import_docx

__all__ = ["UDM_VERSION", "export_docx", "export_docx_from_file", "import_docx"]
__version__ = "0.1.0"
