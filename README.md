# Flude Docs (GitHub Action)

A thin GitHub Action client for the Flude SaaS control-plane. It never bundles
the Flude engine, never touches your source on the runner beyond reading
`GITHUB_REPOSITORY`/`GITHUB_SHA`, and has **zero third-party runtime
dependencies** — the control-plane clones your public repository itself.

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
    format: markdown

- run: unzip "${{ steps.flude.outputs.result-path }}" -d docs-output
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

### Inputs

| Name | Required | Default | Description |
| --- | --- | --- | --- |
| `api-token` | yes | — | Clerk API Key, sent as `Authorization: Bearer <token>`. |
| `api-base-url` | yes | — | Base URL of the control-plane API. |
| `format` | no | `markdown` | `markdown` or `html`. |
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

### Downloading the result

The action downloads the result archive itself (the signed URL has a short
TTL and is meant to be consumed once) and exposes the local path as
`result-path`. The archive's internal format isn't part of this action's
contract yet — pipe it into `unzip`/`tar` (or `actions/upload-artifact`)
depending on what the real control-plane ends up serving.

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
  timeout safety net.
- **End-to-end workflow** (`.github/workflows/e2e-mock.yml`): runs this
  action for real via `uses: ./` in a GitHub Actions job, against the mock
  server started as a background process, and asserts on its outputs
  (`job-id`, `status`, `result-url`, `result-path`). This is DEL-B22's own
  acceptance test, run continuously in CI rather than once by hand.

### What this repo does and does not verify

- **Verified**: the action's own logic — input parsing, HTTP calls, polling,
  status handling, error messages, downloading — against a mock that
  implements this repo's best-effort guess at the API contract.
- **Not verified**: the real control-plane, real Clerk token verification,
  real free-gate evaluation against a real repository, real GCS signed URLs,
  or the real 10-minute server-side timeout. That requires `DEL-B23` to exist
  first — see its card in `Delivery_ToDo.md` for the real end-to-end check.

Helper files that start a long-running mock server
(`test-support/start-mock-server.mjs`) deliberately live outside `test/`:
Node's test runner treats every file under a directory literally named
`test`/`tests` as a test file regardless of naming convention, and a file that
calls `server.listen()` and never resolves will hang `node --test` if left
there.

## License

Not yet chosen — see `LICENSE`. Requires an owner/counsel decision before
this repository is published (`DEL-B22`).
