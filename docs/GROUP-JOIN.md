# Joining a group

| Path | Who can use it | Result | Recorded as |
| --- | --- | --- | --- |
| Group invite code / `/join/<code>` link (shared by Telegram, WhatsApp, QR, copy; the student "join with code" box opens the same page) | **any number** of signed-in users except the workspace owner, up to the optional cap | **ACTIVE at once**, no approval | `GROUP_CODE_LINK` |
| Single-use invite link `/g/<token>` | the first signed-in user to redeem it | ACTIVE at once | `SINGLE_USE_LINK` |
| E-mail invite `/invite/<token>` | the invited address only | ACTIVE at once | `EMAIL_INVITE` |
| Teacher adds an existing user by e-mail | teacher | ACTIVE at once | `TEACHER_ADDED` |
| Teacher accepts a syllabus join request for the group | teacher | ACTIVE at once | `SYLLABUS_REQUEST` |
| Teacher approves a request left PENDING by the retired approval policy | teacher | ACTIVE | `TEACHER_APPROVED` |

There is no search-and-request path; every self-join goes through one of the links above. An exam's
share link never adds anyone: an exam's participants are the ACTIVE students of its assigned groups
(late joiners included), the students picked individually, and anyone who already has an attempt.

## Join provenance

Every path above writes one `group_member_sources` row per membership (`groupJoinSources.recordJoinSource`;
migration **0043**): `joinedVia`, `joinedAt`, `sourceId` (single-use link id, e-mail invite
id, syllabus request id or the invite code used) and `actorUserId` (the student for self-joins, the
teacher for adds and approvals). Rows are kept when a member is removed. Memberships older than the
table get one from the startup backfill (`runJoinSourceBackfill`, `backfilled = 1`): a redeemed
single-use link, an accepted e-mail invite, an accepted syllabus request (each within 10 minutes of the
membership row), the teacher's "joined via the invite link" notice for that membership, or a share
tracking JOINED event on the current code — otherwise `UNKNOWN` ("Naməlum"). The group's member list
("Qoşulma yolu") and the exam participants list ("Qrup: X · Qrup kodu/linki · 09.10.2026") show it.

## Code use cap

`group_code_limits.maxUses` (teacher: Invite → "Maksimum qoşulma sayı"; empty = unlimited) caps joins
through the **current** code — removed students still count, a regenerated code starts from zero.
`joinByInvite` runs in one transaction holding the group row lock (`SELECT … FOR UPDATE`), so
simultaneous joins can't overshoot it; a full code answers `INVITE_CODE_LIMIT_REACHED`, and the join
page says so before sign-in.

## Group invite code / link

`student.join` → `groups.joinByInvite`. Refused, with a message on the join page (shown before
sign-in when the preview already knows it), when:

- the code does not exist (never issued, or replaced by **Regenerate**) — `INVITE_NOT_FOUND`;
- the teacher turned the code off — `INVITE_CODE_INACTIVE`;
- its expiry date has passed — `INVITE_CODE_EXPIRED`;
- the group's join policy is **MANUAL** (only the teacher adds students) — `GROUP_NOT_ACCEPTING`;
- the user owns the group's workspace — `CANNOT_JOIN_OWN_GROUP`;
- the user is already an active member — `ALREADY_MEMBER`.

Otherwise the membership is created ACTIVE, and `groupJoin.afterLinkJoin` sends the student one
`TASK_ASSIGNED` for the group's open tasks and the teacher an informational `GROUP_MEMBER_JOINED`
("X joined the group via the invite link"). Group tasks, materials, syllabi (group grants), the group
board and analytics all derive from the ACTIVE row on read, so nothing else has to run. The student
lands on `/student/groups?group=<id>` with that group opened.

Join policies are `AUTO` (default) and `MANUAL`. The former `APPROVAL` policy, under which link
joins waited as PENDING for the teacher, was removed in migration **0032**, which also moved every
`APPROVAL` group to `AUTO`.

## Requests still PENDING from the approval era

Only `joinByInvite` under `APPROVAL` ever created PENDING rows, so every one of them came from the
group's code/link. They are handled in two ways:

1. **Startup backfill** (`groups.activatePendingLinkJoins`, run once per server start by
   `groupJoin.runPendingLinkJoinBackfill`): a PENDING row is activated — with the same
   `TASK_ASSIGNED` / `GROUP_MEMBER_JOINED` notices — only if share tracking recorded this student
   joining through the group's **current** code (`share_events` `JOINED`, target = that code) **and**
   that link would still let them in now (code active, not expired, group not MANUAL). Each row is
   flipped by a conditional UPDATE, so several instances starting together never activate or notify
   twice. Later starts find nothing: no new PENDING rows are created any more.
2. **On the next visit**: a student whose request is still PENDING and who opens a valid link again
   is activated immediately by `joinByInvite`.

Everything else stays PENDING for the teacher to approve or remove as before (the Requests tab is
unchanged): requests made with a code that has since been regenerated, deactivated or expired, in a
group now closed to self-join, or made before share tracking existed (migration 0013) and therefore
without a recorded link join.
