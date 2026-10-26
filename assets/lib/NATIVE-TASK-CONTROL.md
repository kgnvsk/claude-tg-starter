# Native task control

`~/bin/native-task-control` lists and stops native background tasks observed by
this agent's running Claude owner host. It sends a `stop_task` control request
directly to that process. It does not send an owner message, ask the model to run
TaskStop, or change the existing `/stop` command.

Run it as the selected agent's Linux user, with that agent's normal HOME. Root
execution is refused. The helper uses only that home's existing
`.claude/channels/telegram/messages.db`; it accepts no database or process path.

## Contract v1

All successful commands return JSON with `schema: "novsky.native-task-control.v1"`.

```sh
~/bin/native-task-control list --json --limit 20
~/bin/native-task-control stop --request "$REQUEST_UUID" --binding-json "$BINDING_JSON"
~/bin/native-task-control status --request "$REQUEST_UUID" --json
```

Copy the entire `binding` object from a current, `controllable: true` list entry.
Do not reconstruct it from a task name, transcript, previous process, or task ID
alone. Generate one UUID for the stop operation and retain it with the result.
Repeating that UUID and identical binding reads the same durable request. A
different binding with the same UUID is refused.

The exact binding keys are:

```json
{
  "session_id": "observed-session-id",
  "stamp": "current-delivery-stamp",
  "generation": 1234567890,
  "task_id": "observed-task-id",
  "run_id": null,
  "tool_use_id": "observed-originating-tool-use-id",
  "occurrence": 1,
  "launch_ref": "observed-originating-tool-use-id"
}
```

`run_id` is the exact string emitted by Claude or **explicit null** when its
`task_started` event omitted it. No run ID is generated. Null is allowed only
when the current process's lifecycle event supplies a nonempty `tool_use_id`
matching the current native obligation's `launch_ref` and occurrence. A stopped
event must carry that same tool-use binding. Missing or mismatched linkage gives
`binding: null`, `controllable: false`, and a reason; the task ID remains visible.
The process generation is distinct from the resumed conversation's session ID.

List output includes `runtime`, `tasks`, `next_cursor`, and `incomplete`. Each task
has `task_id`, `binding`, `state`, `observed_at`, `controllable`, and `reason`.
Follow a non-null `next_cursor` with `list --cursor "$CURSOR"`; a cursor belongs
only to that runtime generation. The default page is 20, the maximum is 50.
`incomplete: true` means the process reached its observation capacity, so an
absent task cannot be inferred to have stopped. Only lifecycle events from the
current host process appear; a resumed task without a fresh start event cannot
be controlled by guessing its identity.

Stop/status output includes `request_id`, `status`, `confirmed`, `reason`,
`binding`, and `updated_at`. Interpret statuses as follows:

| Status | Meaning |
| --- | --- |
| `queued` | Durable request; no control write yet. |
| `sent` | Control write attempted; outcome not yet proven. |
| `acknowledged` | Claude accepted the control request. This is not proof of a stop. |
| `stopped` | Exact lifecycle stop observed and the same open ledger occurrence closed. Only this has `confirmed: true`. |
| `already_terminal` | Task completed/failed/stopped before dispatch, or completed/failed while the request waited. No claim that this request stopped it. |
| `unsupported` | Claude rejected the native protocol as unsupported. |
| `unconfirmed` | Write, lifecycle, process generation, or ledger outcome is uncertain. |
| `rejected` | Binding or queue validation refused the request. |

An error exits nonzero and returns bounded JSON with `reason` and
`confirmed: false`. A missing runtime/schema or stale heartbeat returns
`unavailable` for list. A successful empty Claude response `{}` is only an ACK:
some CLI versions also ACK an already-ended or unknown task. There is no
automatic resend after uncertainty, and a new UUID cannot bypass a pending or
uncertain stop for the same observed launch. Poll the retained request ID;
do not interpret an empty list or an ACK as task completion.

## Limits and compatibility

The host dispatches at most four requests per second. A queued request expires
after 30 seconds; a sent request without a matching terminal event becomes
unconfirmed after 30 seconds. A later exact stopped event can still confirm that
same request. The runtime heartbeat must be at most ten seconds old. Limits are
32 unresolved requests per current process, 4,096 lifecycle observations per
process, 10,000 durable request records, and 64 KiB per CLI result. Capacity
failures are explicit; request history is not silently pruned.

This requires the stream-json owner host, typed `task_started` and
`task_notification` events, and Claude's `control_request` subtype `stop_task`.
Local protocol inspection established this handler in CLI 2.1.309. Static
inspection of 2.1.302 found the relevant literals but is not behavioral proof;
that version still needs the release's canary test. Older or incomplete event
streams remain unavailable or unconfirmed rather than falling back to an
impersonated owner prompt. Existing native hooks continue to own ordinary task
completion and result delivery. A confirmed stop is not a file-delivery receipt.
