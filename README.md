# Flude Docs (GitHub Action)

A thin GitHub Action client for the Flude SaaS control-plane. It never bundles
the Flude engine, never touches your source on the runner beyond reading
`GITHUB_REPOSITORY`/`GITHUB_SHA`, and has **zero third-party runtime
dependencies** — the control-plane clones your public repository itself.

> Using GitLab instead? See [`gitlab/README.md`](gitlab/README.md) for the
> GitLab CI template (`DEL-B26`) — it reuses this repo's `src/*.js` client
> directly, not a separate implementation.
>
> Using Bitbucket instead? See [`bitbucket/README.md`](bitbucket/README.md)
> for the Bitbucket Pipe (`DEL-B39`) — same control-plane client, packaged as
> a Docker image (structurally different from the other two, see that
> README for why) and reporting via Bitbucket's Code Insights API instead of
> SARIF/Code Quality JSON.

> **Status: Stage 1 / pre-release.** The control-plane API this action talks
> to (`DEL-B23`) does not exist yet. Everything below the "Development &
> testing" section describes the assumed contract this action was built
> against — treat endpoint shapes and status strings as provisional until
> reconciled with the real control-plane.

## What Stage 1 covers

- Public repositories only, on **personal accounts** (not organizations).
- Filtered source volume (matching Flude's `file_patterns`) **≤ 5 MB**.
- Anything outside those bounds is a paid scenario that Stage 1 doesn't serve
  yet — the control-plane reports it as a rejected job, and this action fails
  the step with a clear explanation instead of a generic error.
- Rate limit: 5 jobs/day during an account's first week, then 1/day.

## Usage

```yaml
- uses: flude/flude-action@v1
  id: flude
  with:
    api-token: ${{ secrets.FLUDE_API_TOKEN }}
    api-base-url: ${{ vars.FLUDE_CONTROL_PLANE_URL }} # no public control-plane exists yet, see Status above
    format: hugo_markdown

- run: unzip "${{ steps.flude.outputs.result-path }}" -d docs-output

# Optional: publish findings to Code Scanning, if the result archive
# contained a report.sarif (see "GitHub-specific reporting" below).
- if: steps.flude.outputs.sarif-path != ''
  uses: github/codeql-action/upload-sarif@v3
  with:
    sarif_file: ${{ steps.flude.outputs.sarif-path }}
```

Repository and commit are taken from CI context (`GITHUB_REPOSITORY`,
`GITHUB_SHA`) — there's no separate "path to sources" input, since the
control-plane clones the repository itself.

### Getting an API token

Create one at `app.flude.guide` (`DEL-B41`, built in parallel — may not exist
yet either) by logging in with GitHub/GitLab/Bitbucket OAuth and creating a
Clerk API Key through the account page. Store it as a secret
(`FLUDE_API_TOKEN`) on your repository or organization. There is no OAuth flow
inside the CI run itself — the token is a long-lived Bearer credential you
create once, by hand.

See `app.flude.guide/privacy` for the Privacy Policy covering this OAuth login
and the data collected while your job runs (`DEL-A12`).

### Inputs

| Name | Required | Default | Description |
| --- | --- | --- | --- |
| `api-token` | yes | — | Clerk API Key, sent as `Authorization: Bearer <token>`. |
| `api-base-url` | yes | — | Base URL of the control-plane API. |
| `format` | no | `hugo_markdown` | `hugo_markdown` or `html`. |
| `strict` | no | `false` | Enable Strict Compilation Mode. |
| `poll-interval-seconds` | no | `10` | Delay between `GET /jobs/{id}` polls. |
| `max-wait-seconds` | no | `900` | Client-side safety net only — see below. |

### Outputs

| Name | Description |
| --- | --- |
| `job-id` | Job ID assigned by the control-plane. |
| `status` | Terminal status (`succeeded`, `failed`, `rejected_too_large`, `rejected_organization`, `rejected_private`, ...). |
| `result-url` | Signed, short-TTL GCS URL. **Download it immediately** — see "Downloading the result" below. |
| `result-path` | Local path to the downloaded archive. |
| `sarif-path` | Local path to a SARIF report extracted from the archive, if one was found. Empty otherwise — see "GitHub-specific reporting" below. |
| `summary-path` | Local path to the same markdown findings report already appended to `$GITHUB_STEP_SUMMARY`, as a plain file. Empty if no SARIF report was found. |

### Downloading the result

The action downloads the result archive itself (the signed URL has a short
TTL and is meant to be consumed once) and exposes the local path as
`result-path`. The archive's internal format isn't part of this action's
contract yet — pipe it into `unzip`/`tar` (or `actions/upload-artifact`)
depending on what the real control-plane ends up serving.

### GitHub-specific reporting (DEL-B25)

After downloading the result archive, the action makes one further
best-effort assumption: that the archive contains a **`report.sarif`** file
at its root, in the real SARIF 2.1.0 shape produced by
`engine/ude/reporting.py::to_sarif()` (`ude audit --report-format sarif` /
`ude diff --report-format sarif`). **This is not confirmed** — `DEL-B23`
hasn't shipped, so no real control-plane has ever decided how (or whether) a
SARIF report ends up in the archive. If `report.sarif` isn't found, or the
archive can't be read as a ZIP at all, the action logs a `::warning::` and
continues — a wrong assumption about the archive layout never fails an
otherwise-successful documentation job.

When `report.sarif` **is** found:

1. **Inline annotations** — every finding at `level: error` gets a
   `::error file=<path>,line=<n>::<message>` workflow command (file/line are
   omitted when the finding doesn't carry a location — both are independently
   optional in the underlying SARIF). `warning`/`note` findings don't get an
   annotation, by design — they're still fully visible in the two channels
   below, so nothing is silently dropped.
2. **Code Scanning upload** — this action is a plain `node20` action, not a
   composite one (that's DEL-B22's existing, already-implemented design,
   deliberately not restructured for this), so it cannot invoke another
   `uses:` step from inside its own runtime. It writes the extracted SARIF to
   the `sarif-path` output instead; add
   `github/codeql-action/upload-sarif@v3` as a **separate step** in your
   workflow (see the usage example above) to actually publish it to Code
   Scanning.
3. **`$GITHUB_STEP_SUMMARY`** — a markdown table listing **every** finding,
   of any level. An earlier design capped this list at 10 entries to match
   GitHub's own (unrelated) annotation-display limit; that cap was removed on
   purpose, specifically so the step summary is the one channel guaranteed to
   show the complete list regardless of how many findings there are or how
   GitHub's UI happens to render inline annotations.

   **`$GITHUB_STEP_SUMMARY` is allocated fresh per step by the runner** (the
   same ephemeral-per-step design as `$GITHUB_OUTPUT`) — the runner
   aggregates every step's contribution into the job's summary page for you,
   but a *later* step in your own workflow reading `$GITHUB_STEP_SUMMARY`
   only ever sees its own empty file, never this step's write. If you need
   the raw markdown in a later step (to post it as a PR comment, say), use
   the `summary-path` output instead — a plain file with identical content
   that actually persists across steps. Found this the hard way: an earlier
   version of this repo's own `e2e-sarif` CI job failed only on real
   GitHub-hosted runners, never locally, by making exactly this mistake in
   its own verification step.

### Timeouts

The **authoritative** job timeout (currently 10 minutes) is enforced
server-side by the control-plane. `max-wait-seconds` (default 900s) is only a
client-side safety net in case the server never reports a terminal status at
all — it is intentionally set higher than the server timeout so it normally
never triggers.

### Platforms

This action runs as a plain Node 20 action (no Docker), so it isn't
Linux-only — CI (`ci.yml`) runs the test suite on Ubuntu, Windows, and macOS
runners. (An earlier draft of this action ran the whole engine inside the
runner via Docker and was Linux-only for that reason; that design is gone —
the engine now runs on the control-plane's own infrastructure.)

## Development & testing

There is no real control-plane to test against yet, so this repo ships its
own mock (`test-support/mock-server.js`) implementing this repo's assumed API
contract, and is explicit about what is and isn't verified.

- **Unit tests** (`npm test`, i.e. `node --test`): exercise
  `src/control-plane-client.js`, `src/poll.js`, and `src/download.js` against
  the in-process mock, covering success, auth failure, rate limiting, each
  free-gate rejection status, an engine failure status, and the client-side
  timeout safety net; and `src/zip-extract.js`, `src/sarif-report.js`, and
  `src/github-reporting.js` (DEL-B25) against hand-built ZIP/SARIF fixtures
  (`test-support/zip-builder.js`, `test-support/sarif-fixture.js`), covering
  all three SARIF location edge cases, the missing/malformed-archive
  fallbacks, and that the step summary lists more than 10 findings without
  truncation.
- **End-to-end workflows** (`.github/workflows/e2e-mock.yml`): the `e2e` job
  runs this action for real via `uses: ./` against the mock server and
  asserts on `job-id`/`status`/`result-url`/`result-path` (DEL-B22's own
  acceptance test); the `e2e-sarif` job does the same against a mock result
  archive containing a 15-finding `report.sarif` and asserts the step summary
  and `sarif-path` output are both complete (DEL-B25's acceptance test),
  run continuously in CI rather than once by hand.

### What this repo does and does not verify

- **Verified by `e2e-mock.yml`**: the action's own logic — input parsing, HTTP calls, polling, status handling, error messages, downloading — against a mock that simulates the API contract.
- **Verified by `e2e-live.yml`**: the happy path against the real control-plane, real Clerk token verification, real GCS signed URLs, and real result archive generation for GitHub repositories.
- **Not verified (pending remaining DEL-B49 tasks)**: GitLab/Bitbucket repositories, free-gate evaluation, rate-limit enforcement (beyond the E2E override), kill-switch, and API-key issuance/revocation.

Helper files that start a long-running mock server
(`test-support/start-mock-server.mjs`) deliberately live outside `test/`:
Node's test runner treats every file under a directory literally named
`test`/`tests` as a test file regardless of naming convention, and a file that
calls `server.listen()` and never resolves will hang `node --test` if left
there.

## License

Not yet chosen — see `LICENSE`. Requires an owner/counsel decision before
this repository is published (`DEL-B22`).
