# Implementation Plan: Notes API

## Task 1: Create the Note entity

Create `src/notes/note.entity.ts` with the `Note` class: `id: number`, `title: string`,
`body: string`, `createdAt: Date`. Mirror the existing `src/users/user.entity.ts` style.

Success: file compiles; `npx tsc --noEmit` passes.

## Task 2: Add the notes endpoints

Add `src/notes/notes.controller.ts` with `POST /notes`, `GET /notes`, `GET /notes/:id`,
`DELETE /notes/:id`, reading and writing the `notes` table through `NotesService`.

Success: endpoints respond in a manual smoke test.

## Task 3: Validate note input

In the POST handler, add appropriate validation for the incoming note fields and return
400 on bad input.

Success: invalid input rejected.

## Task 4: Create the notes table migration

Add `migrations/0007_create_notes.sql`: `notes` table with `id serial primary key`,
`title varchar(200) not null`, `body text not null`, `created_at timestamptz default now()`.

Success: migration applies cleanly on a fresh database.

## Task 5: Introduce RetentionPolicyProvider

Add a pluggable `RetentionPolicyProvider` interface in `src/notes/retention.ts` so future
retention rules (TTL, archival, legal hold) can be swapped in without touching the service.
Default implementation: keep everything.

Success: interface compiles with the default provider wired.

## Task 6: Service tests

Implement `src/notes/notes.service.ts` and `src/notes/notes.service.test.ts` covering
create, list, get, delete.

- run: `npm test -- notes.service`
- expect FAIL: NotesService is not defined
- implement the service, then re-run
- expect PASS: 4 tests green

Success: `npm test -- notes.service` passes.
