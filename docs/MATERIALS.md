# Materials

A material is something a teacher shares with students: a file or a link, plus template details
(subject, topic, level, tags, …). The `materials` row keeps what every material has (title,
description, file, recipients, share code); everything added by the templates lives in
`content_meta` (one row per material, `entityType = MATERIAL`). Tasks created from a material
template ("Tapşırıq kimi yarat") get a `content_meta` row with `entityType = TASK` for the same
details; their publishing still follows the task's own rules.

| Table | What it holds |
| --- | --- |
| `content_meta` | template, kind, status, `publishAt`, visibility, notify flag, `notifiedAt`, link URL, template values (JSON) |
| `content_tags` | workspace-wide tags (`TOPIC` / `TECHNOLOGY`), unique by normalized name; a topic tag may point at a question-bank topic |
| `content_tag_links` | which material / task uses which tag |
| `upload_sessions` | direct uploads to R2 in progress (see "Large uploads") |

Migration `0042_content_meta` creates the four tables. On start the API fills a `content_meta` row
for every material without one (`runMaterialMetaBackfill`, `INSERT IGNORE`, safe to rerun):
template `GENERAL`, kind from the file type, `PUBLISHED`, visibility `LINK`, `notifiedAt` = the
upload time (so nothing old is announced again) and the old topic as a tag. Until the migration
runs, materials behave as before (every read treats a missing table as "no details").

## Templates

`shared/materialTemplates.ts` is the single source: the templates (Mühazirə, Təhvil, Layihə,
Praktiki, Dataset, Link, Ümumi), their fields, which are required, the material kinds, which file
types each kind accepts and its size class. The form renders from it and the server validates
against it, so adding a field means editing that file only. Template values are stored as JSON in
`content_meta.values`; `materials.subject` / `topic` are kept in sync for older readers.

Grading criteria (Təhvil, Layihə) are never sent to students (`studentFacingMeta`).

## Publishing

| Status | Students see it | Notified |
| --- | --- | --- |
| Published now | yes | on save, if "Tələbələrə bildiriş göndər" is ticked |
| Scheduled (`publishAt` in the future) | from `publishAt` | by the sweeper at `publishAt` |
| Draft | no | when it is published |

The sweeper (`runScheduledMaterialSweep`, every 30 s) takes due rows with `notifiedAt` empty and
claims each one with a conditional `UPDATE`, so a save and the sweeper, or two API instances, never
announce the same material twice. A `publishAt` in the past means "now". Hidden materials are left
out of the student list and are not marked viewed.

## Who can open it

- **Recipients:** active student members of the chosen groups plus individually picked students.
- **Visibility `LINK`** (default): anyone signed in with the share link may open it and is added to the
  material's students (the old behaviour).
- **Visibility `RECIPIENTS`:** the share link only works for recipients; others see "no access".
- Drafts and scheduled materials are closed to everyone but the teacher, link or not.

`GET /api/files/:id` applies the same rules (`downloadAccess`): a material's file is open by link only
while some material using it is visible with `LINK`; otherwise only workspace members, students the
material reaches, and students reaching it through a syllabus lesson. Link materials open the URL
directly; the student's click is recorded like a download.

## Notifications

`MATERIAL_SHARED` (IN_APP, PUSH, EMAIL — e-mail off by default), key
`material-shared:<materialId>:<userId>`. On create or going live: every recipient. On edit of a
visible material: only students it newly reaches. See `docs/NOTIFICATIONS.md`.

## Tags

Tags are shared per workspace. Suggestions (`teacher.tasks.suggestTags`) list the workspace's tags
by use, then, for topics, the question-bank topics of the workspace (`QUESTION_BANK` source). Names
are matched ignoring case, accents and punctuation (`ı`/`i` and `ə`/`e` count as the same).

## Large uploads

Files up to 8 MB go through the API as before. Larger material files go straight from the browser
to R2 when R2 is configured:

1. `teacher.tasks.startUpload` checks the type, the kind's size limit and the workspace quota,
   records a `PENDING` session and returns one signed `PUT` URL (up to 100 MB) or opens a
   multipart upload (16 MB parts, URLs signed in batches of 20 via `uploadPartUrls`). Each URL is
   bound to the object key, content type and exact length, and expires (PUT 30 min, part 15 min).
2. The browser uploads with progress; cancel calls `abortUpload`, retry starts a new session.
3. `completeUpload` finishes the multipart upload (the server lists the parts, so the browser needs
   no ETags), `HEAD`s the object and checks size and type. Only then are the `files` and
   `file_objects` rows written. A mismatch deletes the object.
4. Abandoned sessions (24 h) are aborted and deleted by the upload sweeper (every 15 min).

Without R2 (`FILE_STORAGE_BACKEND=db` or no R2 variables) the form says so and keeps the 8 MB limit.

### Limits

The limit follows the material's kind:

| Size class | Material kinds | Default |
| --- | --- | --- |
| `DOCUMENT` | file, task, question bank, other | 50 MB |
| `PRESENTATION` | presentation | 100 MB |
| `DATASET` | dataset, code | 200 MB |
| `VIDEO` | video | 500 MB |

Which extensions each class accepts is in `UPLOAD_TYPES` (documents, images, spreadsheets,
presentations, audio/video, CSV/JSON/ZIP/Parquet/notebooks); never HTML, SVG or anything a browser
would run.

Admin → Settings → **Material uploads** changes them (`platform_settings`
`storage.materialUploadLimitsMb`, 1–2000 MB each; `files.sizeBytes` is a signed INT) and sets the
hard **storage quota per teacher** (`storage.workspaceQuotaBytes`; files of the workspace plus
uploads in progress; student submissions are not counted). Empty = default / no quota.

### R2 setup for direct uploads

The bucket needs a CORS rule so the browser may `PUT` to it. Cloudflare dashboard → **R2 Object
Storage** → the bucket (`resulio-files`) → **Settings** → **CORS Policy** → **Add CORS policy** →
paste and **Save**:

```json
[
  {
    "AllowedOrigins": ["https://resulio.co", "https://www.resulio.co"],
    "AllowedMethods": ["PUT", "GET", "HEAD"],
    "AllowedHeaders": ["content-type", "content-length"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

Add a staging or local origin (e.g. `http://localhost:3000`) only on a bucket used for testing.

Then the lifecycle rule for multipart uploads nobody finished (a safety net next to the sweeper):
bucket → **Settings** → **Object lifecycle rules** → **Add rule** → name `abort-incomplete-uploads`,
apply to all objects, action **Abort incomplete multipart uploads** after **1 day** → **Save**.

No new environment variables: direct uploads use the same `R2_*` variables and token (*Object Read &
Write*) as the rest of file storage.
