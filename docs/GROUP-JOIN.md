# Joining a group

| Path | Who can use it | Result |
| --- | --- | --- |
| Group invite code / `/join/<code>` link (shared by Telegram, WhatsApp, QR, copy; the student "join with code" box opens the same page) | any signed-in user except the workspace owner | **ACTIVE at once**, no approval |
| Single-use invite link `/g/<token>` | the first signed-in user to redeem it | ACTIVE at once |
| E-mail invite `/invite/<token>` | the invited address only | ACTIVE at once |
| Teacher adds an existing user by e-mail | teacher | ACTIVE at once |

There is no search-and-request path; every self-join goes through one of the links above.

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
