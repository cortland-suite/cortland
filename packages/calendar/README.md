# cortland-calendar

Apple Calendar over MCP, built on the [governed framework](../governed/). This
package adds the missing WRITE capability (create, delete) plus the minimal
reads those writes need — and **there is no attendees parameter at all**.

## No invitations, by design

`event_create` deliberately cannot invite anyone: an event with attendees is
outward-facing — Calendar mails invitations the moment it saves — so v1 simply
does not have the parameter. The worst case is a stray event on your own
calendar, not an email in someone else's inbox. Same doctrine as an ungated
send: the capability that was never built cannot be bypassed.

## One calendar per query

Calendar.app Automation costs **~30 seconds per calendar** regardless of query
shape (see NOTES Q20). So `events_window` requires a single named calendar and
a bounded start-date window (max 62 days) — it never scans all calendars.
List names cheaply with `calendars_list`, then query the one you mean.

## Tools

| Tool | Mode | Notes |
|------|------|-------|
| `calendars_list` | read | calendar names + writable flag |
| `events_window` | read | events in ONE named calendar within a start-date window (max 62 days) |
| `event_create` | write-safe | provenance-stamped; no attendees; description redacted from the audit log |
| `event_delete` | destructive | by calendar + uid; full event snapshot captured as the undo recipe before deletion |

Everything inherits the framework contract: dry-run by default for gated tools,
per-action human approval out-of-band from the model, an audit row for every
execution path, injection fencing on event content, provenance on created
events.

## Notes

- The first call prompts for Automation permission and can be slow while
  Calendar.app cold-launches; timeouts say so instead of failing cryptically.
- `event_delete`'s undo recipe is an `event_create` call — recurring events
  restore as a single event, so prefer editing those in Calendar.app.
