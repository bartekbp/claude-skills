# Spec: Note Tags

Add tags to the existing notes service (Express + TypeScript).

## Requirements

1. `POST /notes/:id/tags` adds a tag (name, 1–40 chars) to a note;
   `DELETE /notes/:id/tags/:name` removes one. A note holds at most 20 tags.
2. `GET /notes?tag=x` filters notes by tag.
3. Whether tag names are case-sensitive is **not yet decided** — product will
   confirm after the design review. Do not guess either way.
4. A markdown API reference page for the new endpoints under `docs/tags.md`.
5. Unit tests for the tag service.

Out of scope: tag renaming, tag colors, bulk operations.
