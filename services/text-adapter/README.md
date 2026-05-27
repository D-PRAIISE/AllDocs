# text-adapter

Markdown / HTML <-> UDM flow-mode adapter for AllDocs.

Importers target the same UDM flow blocks as the office adapter
(Heading, Paragraph, List, Table, Code, Quote, Divider) so any file
format imported here renders in the existing FlowEditor + FlowContentView.

Importers:
- `import_markdown(path)` — CommonMark via markdown-it-py
- `import_html(path)` — sanitized via bleach, then DOM-walked

Exporters:
- `export_markdown(udm, output)` — UDM flow → CommonMark
- `export_html(udm, output)` — UDM flow → minimal HTML

EPUB support lives here too — EPUB is a zip of HTML + manifest, and
the HTML adapter does the heavy lifting.
