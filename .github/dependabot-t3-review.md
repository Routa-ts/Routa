# Dependabot reviews in T3 Code

[`workflows/dependabot-t3-review.yml`](workflows/dependabot-t3-review.yml) sends
one signed POST when a PR is opened by exactly `dependabot[bot]`. It does not
merge, approve, check out code, install dependencies, or use the GitHub API.
The existing CI and release workflows continue independently.

## Trigger and security

The sender uses `pull_request_target` with `types: [opened]`. This keeps the
workflow on trusted base-repository code, including when Dependabot proposes
changes to GitHub Actions. A `pull_request` sender with Dependabot secrets is
supported by GitHub, but would run the PR's workflow version. Keeping the
credential-bearing sender on trusted workflow code is the reason for using
`pull_request_target` here. Never add a PR checkout or execute PR code to this job.

`permissions: {}` disables all configurable `GITHUB_TOKEN` permissions. Secrets
are passed only to the POST step. PR fields are read as JSON from
`GITHUB_EVENT_PATH`, never interpolated into executable code. Requests must use
HTTPS on `relay.t3.codes`; redirects are refused. URLs, signatures, signing
secrets, PR titles, and response bodies are not printed.

The sender sets `User-Agent: Routa-Dependabot-T3/1.0`. A live connectivity test
found that the relay's Cloudflare protection rejected Python's default
User-Agent with HTTP 403 / error 1010; the explicit sender name received HTTP 202.

GitHub restricts secret access for Dependabot workflows. Store identical values
under the same names in **both** Actions and Dependabot repository secrets, so
the sender works with either secret source selected by GitHub. Do not enable
write tokens or relax fork-workflow security settings. See GitHub's
[Dependabot secret guidance](https://docs.github.com/en/code-security/reference/supply-chain-security/troubleshoot-dependabot/dependabot-on-actions)
and [`pull_request_target` security guidance](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#pull_request_target).

Concurrency serializes notifications per repository and PR. Manual reruns are
skipped with `github.run_attempt == 1`, and the sender never retries a POST.
`delivery_id` and `X-GitHub-Delivery` contain the same stable identifier,
`OWNER/REPO:pull_request:NUMBER:opened`, for correlation. This is not a claim
that T3 deduplicates arbitrary headers. Concurrency is not durable exactly-once
delivery; inspect T3 history before recovering an ambiguous network failure.

## Required secrets

No variables, PAT, or GitHub App credentials are needed by the sender.

| Name                | Value                                                                             |
| ------------------- | --------------------------------------------------------------------------------- |
| `T3_WEBHOOK_URL`    | The complete private relay URL for the existing **Review Dependabot PR** T3 task. |
| `T3_WEBHOOK_SECRET` | The exact shared secret configured for that task's HMAC signature verification.   |

Add **both names at each location**:

1. Repository **Settings → Secrets and variables → Actions → New repository secret**.
   [Open Actions secrets](https://github.com/Routa-ts/Routa/settings/secrets/actions).
2. Repository **Settings → Secrets and variables → Dependabot → New repository secret**.
   [Open Dependabot secrets](https://github.com/Routa-ts/Routa/settings/secrets/dependabot).

The secret names must match the workflow exactly. GitHub exposes both stores
through `secrets.NAME`; the workflow does not reference a separate Dependabot
context. Keep the two copies synchronized when rotating credentials.

## T3 configuration

The existing **Review Dependabot PR** task was inspected during setup. It is
enabled, uses a webhook trigger, and requires HMAC-SHA256 with:

- Header: `x-hub-signature-256`
- Encoding: `hex`
- Prefix: `sha256=`

In T3 Code, open **Settings → Scheduled tasks**, find **Review Dependabot PR**,
and copy its **Webhook URL**. Keep **Require signature** enabled. Use **Edit**
to inspect **Header**, **Prefix**, **Encoding**, and **Secret**, then **Save task**
if changing them. The stored signing secret is not returned by T3's read API.
Retrieve the original from your password manager. If it is lost, set a new
secret in T3's **Secret** field and use that same value in both GitHub stores.
Do not use the URL token as the HMAC secret.

The sender signs the exact UTF-8 JSON bytes sent in the request:

```text
x-hub-signature-256: sha256=<lowercase hex HMAC-SHA256(T3_WEBHOOK_SECRET, raw body)>
```

There is no timestamp prefix, alternate encoding, or extra signing input.
This matches the installed T3 task's signature configuration and T3's
HMAC-over-raw-body contract. The existing 60-minute maximum delivery age controls
how long the relay may hold a request while T3 is offline.

The body contains `action`, the repository's full name, `delivery_id`, and
`pull_request.number`, `title`, `url`, `author`, `html_url`, `user.login`,
`base.ref`, `base.sha`, `head.ref`, `head.sha`, and `head.repo.full_name`.
`base` and `head` retain GitHub's object shape because the existing T3 prompt
reads `{{body.pull_request.base.ref}}` and `{{body.pull_request.head.ref}}`.
The `url`/`author` aliases and nested GitHub fields identify the same PR.

## Safe testing and delivery checks

1. Configure secrets, then land the workflow on `main`. Local edits alone do not
   activate GitHub Actions. There is deliberately no manual dispatch trigger.
2. Wait for the next **new** Dependabot PR. Reopening, updating, synchronizing,
   closing, and human-created PRs must not send anything. A human-created PR
   produces a skipped notification job.
3. Open **Actions → Dependabot T3 review → the run → Send signed PR information
   to T3 → POST signed webhook**. A successful POST logs
   `T3 relay accepted webhook: HTTP 2xx; delivery=OWNER/REPO:pull_request:NUMBER:opened`.
   The log shows the actual status code in place of `2xx`.
4. Open the T3 task's recent webhook requests and match the delivery identifier
   in the request headers/body. Check **Signature verified** and the task's run
   history. An HTTP success proves relay acceptance, not signature verification,
   review completion, or a safe-to-merge decision.

The current T3 prompt can merge compatible updates after review. For an end-to-end
test without allowing a merge, temporarily replace its merge instruction with a
report-only instruction before the next new Dependabot PR, then restore it after
checking the result. This changes T3 behavior; the GitHub Action never merges.

For failures, missing secrets fail before any network request. HTTP failures log
only the status code; inspect T3 history for rejected signatures or a wrong secret.
For timeouts, inspect T3 history before taking recovery action because the relay
may already have accepted the POST. Rerunning the Actions job deliberately skips
delivery. Do not weaken the event or author checks to test with a human PR.
