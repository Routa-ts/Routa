# Triage Labels

Dex has no native labels. The skills encode each canonical triage role as a `Triage:` line in the task description.

| Label in Matt's skills | Value in Dex description | Meaning |
| --- | --- | --- |
| `needs-triage` | `needs-triage` | Maintainer needs to evaluate the task |
| `needs-info` | `needs-info` | Waiting for more information |
| `ready-for-agent` | `ready-for-agent` | Fully specified and ready for an agent |
| `ready-for-human` | `ready-for-human` | Requires human implementation or judgment |
| `wontfix` | `wontfix` | Will not be actioned |

Every triaged task should contain exactly one `Category:` value (`bug` or `enhancement`) and one `Triage:` value.
