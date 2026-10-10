# Joining a group

| Path | Who can use it | Result | Recorded as |
| --- | --- | --- | --- |
| Group invite code / `/join/<code>` link (shared by Telegram, WhatsApp, QR, copy; the student "join with code" box opens the same page) | **any number** of signed-in users except the workspace owner, up to the optional cap | depends on the group's **join policy**: ACTIVE at once (`AUTO`), a PENDING request for the teacher (`APPROVAL`), or refused (`MANUAL`) | `GROUP_CODE_LINK` |
| Single-use invite link `/g/<token>` | the first signed-in user to redeem it | ACTIVE at once, whatever the policy | `SINGLE_USE_LINK` |
| E-mail invite `/invite/<token>` | the invited address only | ACTIVE at once, whatever the policy | `EMAIL_INVITE` |
| Teacher adds an existing user by e-mail | teacher | ACTIVE at once | `TEACHER_ADDED` |
| Teacher accepts a syllabus join request for the group | teacher | ACTIVE at once | `SYLLABUS_REQUEST` |
| Teacher approves a code request (`APPROVAL`) | teacher | ACTIVE | `GROUP_CODE_LINK`, actor = the teacher |
| Teacher approves a PENDING row with no recorded source (left from before migration 0032) | teacher | ACTIVE | `TEACHER_APPROVED` |

There is no search-and-request path; every self-join goes through one of the links above. An exam's
share link never adds anyone: an exam's participants are the ACTIVE students of its assigned groups
(late joiners included), the students picked individually, and anyone who already has an attempt.

## Join policy

| Policy | Teacher sees (group form and Invite dialog) | Group code / link |
| --- | --- | --- |
| `AUTO` (default) | "Kod/linklə dərhal qoşulma" + the warning that the link admits anyone who has it | ACTIVE at once |
| `APPROVAL` | "Link ilə gələnlər müəllimin təsdiqini gözləyir" + the neutral note "Link ilə gələnlər siz təsdiq edənə qədər qrupa daxil olmur…" | PENDING request; ACTIVE at once for students the teacher already knows (below) |
| `MANUAL` | "Yalnız müəllimin manual əlavə etdiyi tələbələr" | refused (`GROUP_NOT_ACCEPTING`) |

Stored without touching `study_groups`: its `joinPolicy` enum keeps `AUTO`/`MANUAL`, and
`group_join_settings.approvalRequired` (migration **0044**) turns `AUTO` into `APPROVAL`
(`shared/groupJoinPolicy.effectiveJoinPolicy`; `MANUAL` wins). `groups.setJoinPolicy` writes both
in one transaction. Before 0044 is applied every group reads as `AUTO`/`MANUAL` as before, and
choosing `APPROVAL` fails rather than silently admitting. Changing the policy leaves waiting
requests for the teacher; under `AUTO` a waiting student who opens a valid link again is activated.

## Join provenance

Every path above writes one `group_member_sources` row per membership (`groupJoinSources.recordJoinSource`;
migration **0043**): `joinedVia`, `joinedAt`, `sourceId` (single-use link id, e-mail invite
id, syllabus request id or the invite code used) and `actorUserId` (the student for self-joins, the
teacher for adds and approvals). Rows are kept when a member is removed (a removed or declined
request's row is deleted). `autoReason` is `KNOWN_STUDENT` for a code join the APPROVAL policy let
straight in, otherwise null. Memberships older than the
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

Under `APPROVAL` a **request counts as a use when it is made** (its `GROUP_CODE_LINK` source row is
written with the request). So the cap bounds how many people can be waiting plus admitted, an
approval never fails on the cap, and a student who already asked still reads "request sent" when the
code is full. A declined request deletes its source row and so frees its place.

## Group invite code / link

`student.join` → `groups.joinByInvite`. Refused, with a message on the join page (shown before
sign-in when the preview already knows it), when:

- the code does not exist (never issued, or replaced by **Regenerate**) — `INVITE_NOT_FOUND`;
- the teacher turned the code off — `INVITE_CODE_INACTIVE`;
- its expiry date has passed — `INVITE_CODE_EXPIRED`;
- the group's join policy is **MANUAL** (only the teacher adds students) — `GROUP_NOT_ACCEPTING`;
- the code's cap is used up — `INVITE_CODE_LIMIT_REACHED`;
- the user owns the group's workspace — `CANNOT_JOIN_OWN_GROUP`;
- the user is already an active member — `ALREADY_MEMBER`;
- under `APPROVAL`, the teacher declined this user's request less than 24 hours ago —
  `JOIN_REQUEST_COOLDOWN` (neutral text: "try again later").

**AUTO**: the membership is created ACTIVE, and `groupJoin.afterLinkJoin` sends the student one
`TASK_ASSIGNED` for the group's open tasks and the teacher an informational `GROUP_MEMBER_JOINED`
("X joined the group via the invite link"). Group tasks, materials, syllabi (group grants), the group
board and analytics all derive from the ACTIVE row on read, so nothing else has to run. The student
lands on `/student/groups?group=<id>` with that group opened.

**APPROVAL**: the join page says "Link ilə gələnlər müəllimin təsdiqini gözləyir" and the button reads
"Sorğu göndər". The visit leaves one PENDING row (`INSERT IGNORE` on the unique group/user index,
inside the row lock: ten simultaneous students give ten requests, a double click gives one) and the
page shows "Sorğunuz göndərildi, müəllim təsdiq edəndə qrupa daxil olacaqsınız." — also on later
visits (`public.invite` returns the viewer's own `viewerStatus`). The teacher gets
`GROUP_MEMBER_JOINED` with `pending: true` ("Yeni qoşulma sorğusu", once per request, dedupe
`group-join-request:<membershipId>`) linking to `/teacher/groups/<id>?tab=requests`. A PENDING
member reaches nothing: every roster read (exam targets and participants, tasks, materials, syllabus
group grants and roster, group board, analytics, announcements) filters `status = ACTIVE`. The
student's "Qruplarım" shows the group as "Təsdiq gözləyir".

### Known students skip the queue

Under `APPROVAL`, a student the group's owner already knows is admitted **at once** instead of
leaving a request — unless the teacher unticks "Əvvəl mənim tələbəm olanları avtomatik qəbul et"
(next to the policy, shown only for `APPROVAL`; on by default; `group_join_settings.autoApproveKnown`,
migration **0048**). `groupJoinApproval.knownStudentReason` decides, across **every workspace the
group's owner owns** and never counting the group being joined:

| Reason | Means |
| --- | --- |
| `OTHER_GROUP` | an ACTIVE member of another of the teacher's groups (a PENDING request there doesn't count) |
| `FORMER_MEMBER` | was an ACTIVE member of another of the teacher's groups and was removed: the membership's `group_member_sources` row outlives it. A declined or removed **request** deletes its source row, so it leaves nothing; memberships removed before migration 0043 left no source and don't count |
| `SYLLABUS_REQUEST` | one of the teacher's syllabus join requests (group or individual) was accepted for the student |
| `SYLLABUS_GRANT` | the student was given individual access to one of the teacher's syllabi (`syllabus_access_grants.studentId`), even if since revoked |

Everything else still applies first: an inactive/expired/regenerated code, `MANUAL`, the use cap
(the automatic join counts as a use like any code join) and the **24-hour decline cooldown — it wins
over being known**. A known student's own earlier request is activated if they submit the code again;
from the join page (which shows "request sent" with no button) it simply stays for the teacher.

The membership is recorded as `GROUP_CODE_LINK` with `group_member_sources.autoReason =
KNOWN_STUDENT` (a teacher's approval clears it). The member list shows "avtomatik qəbul edildi
(tanış tələbə)" under the join path, and the teacher's `GROUP_MEMBER_JOINED` carries
`autoKnown: true` ("X «Qrup» qrupuna avtomatik qəbul olundu — əvvəl sizin tələbəniz olub",
key `group-join:<membershipId>`). The student gets the same as any `AUTO` join.

## Requests tab

`teacher.groups.decideRequests` (`APPROVED` | `DECLINED`, 1–200 students; the per-row buttons and
the select-all bulk actions both use it; `approveMember` remains for the single approve):

- **Approve** (`groups.approveRequests`): the PENDING row turns ACTIVE by a conditional UPDATE, so a
  double click or two teachers' tabs approve once. The source stays `GROUP_CODE_LINK` (same code)
  with the approving teacher as actor. Like any late joiner, the student is on the group's assigned
  exams at once (NOT_STARTED) and gets `TASK_ASSIGNED` for open tasks and the syllabus notices, plus
  `GROUP_JOIN_DECIDED` "Qrupa qəbul olundunuz" linking to the group.
- **Decline** (`groups.declineRequests`): the PENDING row and its source row are deleted (the code's
  place is freed), `group_join_declines` records who declined when, and the student gets a neutral
  `GROUP_JOIN_DECIDED` ("Qoşulma sorğunuza cavab verildi"; it never says "rejected"). The same
  student can't ask this group again for 24 hours (`JOIN_REQUEST_COOLDOWN_MS`), which also stops
  request spam; the `joinGroup` rate limit (10/min per user) applies as before.

Only the group's owner can decide (`NOT_FOUND` for anyone else); ids that are not waiting are skipped.
The group card and the tab show the number of waiting requests.

## History

Migration **0032** removed an earlier `APPROVAL` policy and moved its groups to `AUTO`; its leftover
PENDING rows were activated at startup when share tracking showed a valid link join. That startup
pass (`activatePendingLinkJoins`) is gone: it would now approve new requests behind the teacher's
back. Leftover rows without a recorded source stay in the Requests tab and approve as
`TEACHER_APPROVED`.
