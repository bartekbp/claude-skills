# Spec: Notes API

Add a notes feature to the existing Express + TypeScript service.

## Requirements

1. CRUD for notes: `POST /notes`, `GET /notes`, `GET /notes/:id`, `DELETE /notes/:id`.
2. A note has `title` (required, at most 200 characters) and `body` (required, free text).
   Requests violating these rules return 400 with a message naming the offending field.
3. Notes are stored in a new `notes` table (id, title, body, created_at).
4. Every create and delete writes an `auditTrail` entry (actor, action, note id, timestamp)
   to the existing audit log table.
5. Unit tests for the service layer.

Out of scope: authentication changes, pagination, note sharing, configurable retention.
