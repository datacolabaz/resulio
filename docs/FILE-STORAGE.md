# File storage

Uploaded files (task attachments, materials, student submissions, syllabus files, question-import
PDFs) have one `files` row each: name, type, size, workspace, uploader, public flag. The bytes live
in one of two places:

- **MySQL** (the default, and everything uploaded before R2): base64 in `files.dataBase64`, 8 MB cap per file.
- **Cloudflare R2** (S3-compatible), once configured: `files.dataBase64` is empty and a `file_objects`
  row records the bucket and object key (`files/<workspaceId>/<fileId><ext>`).

Reads prefer the MySQL copy when it is there, so both kinds work side by side and old files keep
working while (or without ever) being moved. Credentials are only ever environment variables on the
API service, never stored in the database.

## Downloads and access

`GET /api/files/:id` always runs the app's access check first (workspace member, student the task
reaches, public share page, …), exactly as before. Then, for a file in R2:

- `R2_DOWNLOAD_MODE=redirect` (default): a `302` to a presigned URL valid for 5 minutes, with the
  file's name and type. The bucket stays private; the link names one object and expires.
- `R2_DOWNLOAD_MODE=proxy`: the API reads the object and streams it, so the browser never sees an R2 URL.
- `R2_PUBLIC_BASE_URL` (optional, a public bucket URL or custom domain) is used only for files anyone
  may open (`OPEN` access); private files still get a presigned URL.

## Setting up R2 (step by step)

1. Cloudflare dashboard → **R2 Object Storage** → enable R2 (needs a payment method; the free tier is
   10 GB stored, 1M writes and 10M reads a month, no egress fees).
2. **Create bucket**, e.g. `resulio-files`, location *Automatic*. Leave public access **off**.
3. Note the **Account ID** (R2 overview page, right column).
4. R2 → **Manage R2 API Tokens** → **Create API token**: permission *Object Read & Write*, scope
   *Apply to specific buckets only* → the bucket above. Copy the **Access Key ID** and **Secret Access Key**
   (the secret is shown once).
5. Railway → `resulio-api` service → **Variables** → add:

   | Variable | Value |
   | --- | --- |
   | `R2_ACCOUNT_ID` | the account id |
   | `R2_ACCESS_KEY_ID` | the token's access key id |
   | `R2_SECRET_ACCESS_KEY` | the token's secret |
   | `R2_BUCKET` | `resulio-files` |
   | `R2_DOWNLOAD_MODE` | optional: `proxy` |
   | `R2_PUBLIC_BASE_URL` | optional, only with a public bucket or custom domain |

   The frontend service needs nothing. Railway redeploys; from then on new uploads go to R2
   (Admin → Files & storage shows "New uploads go to Cloudflare R2").
6. Upload a file in the app and download it again to check. To roll back, remove the variables (or set
   `FILE_STORAGE_BACKEND=db`): new uploads go back to MySQL. Files already in R2 still need the R2
   variables to be read, so keep them while any exist.

## Moving existing files

`scripts/migrate-files-to-r2.ts` (`pnpm files:to-r2`) is a dry run unless `--apply`, and is safe to
re-run or stop at any point. Run it where both `DATABASE_URL` and the `R2_*` variables are set, e.g.
`railway run pnpm files:to-r2` from a checkout linked to the API service.

```sh
pnpm files:to-r2                      # plan: how many files / MB would be copied
pnpm files:to-r2 --apply              # copy; checks each object's size, then records it in file_objects
pnpm files:to-r2 --purge-db           # plan the purge
pnpm files:to-r2 --purge-db --apply   # empty files.dataBase64, only where the object is confirmed in R2
```

`--limit N` caps the files per run, `--batch N` the batch size (50). Copying keeps the MySQL copy, so
downloads are unchanged until the purge; the purge re-checks every object first and skips any that is
missing or has the wrong size. The database only shrinks on disk after the purge (MySQL reuses the
space; `OPTIMIZE TABLE files` returns it).

## Admin view

Admin → **Files & storage** shows the total size, the MySQL / R2 split, sizes by file type, by feature
(materials, imports, student submissions, task and syllabus files) and by teacher, the largest files,
and an optional soft quota (display only: uploads are never blocked by it).
