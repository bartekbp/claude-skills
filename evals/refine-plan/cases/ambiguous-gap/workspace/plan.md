# Implementation Plan: Note Tags

## Task 1: Tags migration

Add `migrations/0009_tags.sql`: `note_tags` table (`note_id`, `name varchar(40)`,
primary key on both), with a check constraint on name length 1–40.

Success: migration applies cleanly on a fresh database.

## Task 2: Tag service and tests

Implement `src/notes/tags.service.ts`: `addTag` (enforces the 20-tag cap),
`removeTag`, `listByTag`. Write `src/notes/tags.service.test.ts` first.

- run: `npm test -- tags.service`
- expect FAIL: TagsService is not defined
- implement, re-run
- expect PASS: 5 tests green

Success: `npm test -- tags.service` passes.

## Task 3: Endpoints

Add `POST /notes/:id/tags`, `DELETE /notes/:id/tags/:name`, and the
`GET /notes?tag=` filter to `src/notes/notes.controller.ts`; 400 on cap or
length violations naming the rule broken.

Success: controller tests pass.

## Task 4: API reference page

Write `docs/tags.md` documenting the three endpoints with request/response
examples, mirroring the style of `docs/notes.md`.

Success: page renders in the docs site preview.
