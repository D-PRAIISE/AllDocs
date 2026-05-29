# AllDocs privacy

## What we store, and for how long

| Data | Where it lives | How long |
|---|---|---|
| Uploaded files (PDF / DOCX / XLSX / PPTX / MD / HTML / EPUB) for the active editing session | `web/public/uploads/<session_id>/` | **24 hours.** A sweeper runs on each new import (or every 5 minutes) and deletes any session directory whose mtime is older than the TTL. |
| Extracted assets (images, fonts) for the active session | `web/public/uploads/<session_id>/assets/` | Same as above. |
| **Bug-report tickets** | `tickets/<ticket_id>/` — NOT public, NOT served | 30 days after the underlying bug is closed. |
| **Audit log** (event types + hashed IP — no document content) | `audit/<YYYY-MM-DD>.jsonl` | Operational records of imports / exports / bug-reports / rate-limit hits. IP is salted-hashed (16-char prefix) so logs can't be reverse-mapped to identify a user. |

Anything not listed here is not stored.

## What we never do

- **We never train ML models on your documents.** Not from regular
  edits, not from bug reports. If a future "donate a doc" feature is
  ever added, it will be a separate, clearly-labelled action on its
  own page — never part of the editor flow.
- **No accounts, no signups, no tracking cookies.**
- **No advertising, no third-party analytics.**

## Bug reports

Clicking **⚐ report a problem** in the editor opens a form. By
submitting, you choose what to attach:

- A description of what went wrong (required).
- The original file you uploaded (optional checkbox — defaults to on).
- Your current in-progress edits (optional checkbox — defaults to on).

Each submission is a deliberate action. Nothing is sent unless you
click **send report**. Tickets are stored privately on the server
(not exposed via any public URL) and reviewed only to fix the bug
you described. Tickets are deleted within 30 days of the bug being
closed.

## Telemetry

AllDocs sends no telemetry today. We may later add **opt-in**
anonymous error telemetry — event types only, never document
content. It will default to off and be one click to enable / disable.

