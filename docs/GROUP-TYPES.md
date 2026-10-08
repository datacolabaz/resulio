# Group types: school class vs course

Resulio serves schools (subjects like Riyaziyyat, İnformatika; classes like 9A) and non-school
courses (AI Engineering, Java; levels Beginner → Professional). A group is one of two types, and
the group form, cards and join pages adapt to it.

| Type (`groupType`) | AZ label | First field | Second field |
| --- | --- | --- | --- |
| `SCHOOL` | Məktəb sinfi | **Fənn** — "məs. Riyaziyyat, İnformatika" | **Sinif** — "məs. 9A, 11B" (free text) |
| `COURSE` | Kurs / təlim | **İstiqamət** — "məs. AI Engineering, Java, Data Analytics" | **Səviyyə** — select: Başlanğıc / Orta / İrəli / Peşəkar, or "Digər" with free text |

## Data model

`study_groups` is a hot table, so (per the add-only rule in `docs/SYLLABUS-ARCHITECTURE.md`) no
column was added to it. Migration `0040_group_profiles` only creates a side table:

```
group_profiles (
  groupId   varchar(32) PK,               -- study_groups.id
  groupType enum('SCHOOL','COURSE') NOT NULL,
  level     varchar(64) NOT NULL DEFAULT '',  -- course Səviyyə: a GROUP_LEVELS key or free text
  source    varchar(32) NOT NULL DEFAULT 'TEACHER', -- 'TEACHER' or 'auto:<reason>'
  updatedAt timestamp
)
```

- `study_groups.subject` keeps the Fənn **or** İstiqamət (same column for both types).
- `study_groups.grade` keeps the Sinif (school classes only).
- `group_profiles.level` keeps the Səviyyə (courses only). Known levels are stored as keys
  (`BEGINNER`, `INTERMEDIATE`, `ADVANCED`, `PROFESSIONAL`) and shown in the reader's language;
  anything else (e.g. `B2`, `Junior`) is stored and shown as typed.
- Saving from the form stores only the chosen type's second field and clears the other one
  (`groupFieldsForType` in `shared/groupType.ts`), so a value never shows under the wrong label.
  While the form is open, switching types keeps both values so switching back restores them.
- API: `groupType` (optional for backwards compatibility — an older client mid-deploy, or the seed,
  gets the type its values point to) and `level` (max 64) were added to `teacher.groups.create` /
  `update`; `grade` is now capped at 32, the column's real length. Every group read
  (`list`, `detail`, public previews, student group list) returns `groupType`, `grade` (Sinif, empty
  for courses) and `level` (empty for school classes).

## Existing groups

Before this change the form had one combined "Sinif / səviyyə" field stored in `grade`. Nothing in
`study_groups` is rewritten: on every start `runGroupProfileBackfill` (server/modules/groupProfiles.ts)
writes a `group_profiles` row (`INSERT IGNORE`) for each group that has none, using
`classifyLegacyGroup` (shared/groupType.ts). Until a group has its row, reads classify it on the fly
with the same function, so pages look the same before and after the backfill.

Classification of the old `grade` value, in order:

1. **Looks like a class** → `SCHOOL`, value stays the Sinif. `9A`, `11 B`, `10`, `9-11`, `5-ci sinif`,
   `11-ci`, `IX`, `8 класс`, `Grade 7`, `orta məktəb` (numbers only 1–12). `source = auto:CLASS_PATTERN`.
2. **Looks like a level** → `COURSE`, value becomes the Səviyyə. Recognised words become keys
   (`Beginner`, `başlanğıc`, `orta`, `Orta səviyyə`, `İrəli`, `Advanced`, `Peşəkar`, `Начальный уровень` …);
   other level-like values are kept as typed (`B2`, `A1-A2`, `Upper-Intermediate`, `Junior`, `Level 2`,
   `1-ci səviyyə`). `source = auto:LEVEL_PATTERN`.
3. **Unknown or empty** → type from a strong subject hint (`Riyaziyyat`, `İnformatika` → SCHOOL;
   `AI Engineering`, `Java`, `IELTS` → COURSE; ambiguous subjects give no hint), else from the
   workspace (`providerType = SCHOOL` or category `SCHOOL` / `GRADUATION_EXAM` / `UNIVERSITY_PREP`
   → SCHOOL; `LANGUAGE` / `IT` / `BUSINESS` / `INTERNATIONAL_EXAM` / `EARLY_CHILDHOOD` → COURSE),
   else `COURSE`. The value is never dropped: it is shown as the Sinif (SCHOOL) or Səviyyə (COURSE).
   `source = auto:SUBJECT_HINT | auto:WORKSPACE | auto:DEFAULT`.

A teacher can always correct the type in the edit form; that row then gets `source = TEACHER`.
Audit what the backfill did with:

```sql
SELECT groupType, source, COUNT(*) FROM group_profiles GROUP BY groupType, source;
SELECT g.id, g.subject, g.grade, p.groupType, p.level, p.source
FROM study_groups g JOIN group_profiles p ON p.groupId = g.id WHERE p.source LIKE 'auto:%';
```

For a course, the old value is still in `study_groups.grade` until the teacher next saves the group
(reads ignore `grade` for courses). Rolling back to the previous release therefore needs only
`DROP TABLE group_profiles;` (plus removing the 0040 row from `__drizzle_migrations`) — no data was
moved out of `study_groups`; only levels typed after the upgrade live solely in the side table. Before migration 0040 is applied,
saving a course falls back to keeping its level in `grade`, so nothing typed is lost either way.

## Default type for a new group

`teacher.groups.newGroupDefaults`: the type of the workspace's most recently created group (teachers
usually create more of the same), else the workspace category as above, else **Kurs / təlim**
(the neutral choice: "İstiqamət / Səviyyə" reads fine for anything that isn't a school class, while
"Sinif" is wrong for a course). The teacher's own click always wins over the default.

## Migration numbering

There is no 0038 in the journal: this migration was first drafted as 0038, but 0039 reached `main`
first. drizzle's migrator only applies migrations whose `when` is newer than the last applied one, so
an older 0038 would be skipped where 0039 already ran; it was regenerated as 0040 on top of the 0039
snapshot instead. Do not reuse 0038.

## Related labels

Syllabus and question bank subjects are not tied to a group type, so they are labelled
**Fənn / istiqamət** with the placeholder "məs. Riyaziyyat, İnformatika, AI Engineering". The
syllabus **Səviyyə** field is unchanged.
