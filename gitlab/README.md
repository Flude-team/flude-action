# Flude GitLab CI Template (DEL-B26)

A thin `.gitlab-ci.yml` template around the same control-plane client used by
the GitHub Action in `../` (`../src/control-plane-client.js`, `../src/poll.js`,
`../src/download.js`, `../src/zip-extract.js` are reused directly via
relative import - not copied, not rewritten). It never bundles the Flude
engine and never touches your source beyond reading `CI_PROJECT_URL`/
`CI_COMMIT_SHA` - the control-plane clones your public repository itself.

> **Status: Stage 1 / pre-release, same caveat as `../README.md`.** The
> control-plane API this talks to (`DEL-B23`) does not exist yet. Everything
> below describes the assumed contract this was built against.

## Why this code lives in the `flude-action` repo

`flude-action` predates GitLab support and is named after the GitHub Actions
concept, which is a real mismatch for a GitLab template. It stays here anyway
(see the DEL-B26 card in `Delivery_ToDo.md` for the full reasoning): the
shared client (`../src/control-plane-client.js`, `../src/poll.js`, etc.) has
no packaging story of its own yet, so a separate repo would need a git
submodule, a published npm package, or a copy - all real new maintenance
surface for five files, before `DEL-B23`'s contract has even stabilized once.
A plain relative import costs nothing and can never drift. Revisit the split
once the contract is real and there's a second forcing reason (unlike
Bitbucket's `DEL-B39`, which structurally needs its own repo - a Pipe is a
Docker image + `pipe.yml`, not a CI-YAML template).

The consequence: `include: project:` (GitLab's idiomatic "reference another
GitLab-hosted project's template" syntax) doesn't apply, since this repo is
hosted on GitHub. Use `include: remote:` with the raw file URL instead - see
`flude.gitlab-ci.yml`'s own header comment for the exact line.

## Usage

```yaml
include:
  - remote: 'https://raw.githubusercontent.com/Flude-team/flude-action/main/gitlab/flude.gitlab-ci.yml'
```

That adds a `flude` job to your pipeline's `test` stage, gated by default to
merge-request pipelines and pushes to the default branch (set
`FLUDE_DISABLE: "true"` as a variable to turn it off entirely). Set the two
required CI/CD variables in **Settings > CI/CD > Variables** (mask both):

| Variable | Required | Description |
| --- | --- | --- |
| `FLUDE_API_TOKEN` | yes | Clerk API Key from `app.flude.guide`, sent as `Authorization: Bearer <token>`. Same token mechanism as the GitHub Action (`DEL-B22`/`DEL-B41`) - a long-lived credential you create once by hand, no OAuth flow inside the CI run itself. |
| `FLUDE_API_BASE_URL` | yes | Base URL of the control-plane API. No public control-plane exists yet - point this at your own control-plane or local mock while developing (see "Development & testing" below). |

Optional variables, all with defaults (override under the included job's
`variables:` in your own `.gitlab-ci.yml`, or set project-level CI/CD
variables of the same name):

| Variable | Default | Description |
| --- | --- | --- |
| `FLUDE_FORMAT` | `markdown` | `markdown` or `html`. |
| `FLUDE_STRICT` | `false` | Enable Strict Compilation Mode. |
| `FLUDE_POLL_INTERVAL_SECONDS` | `10` | Delay between `GET /jobs/{id}` polls. |
| `FLUDE_MAX_WAIT_SECONDS` | `900` | Client-side safety net only - the authoritative timeout (currently 10 minutes) is server-side. |
| `FLUDE_CODEQUALITY_PATH` | `gl-code-quality-report.json` | Where the extracted Code Quality report is written; also what `artifacts:reports:codequality` points at. |
| `FLUDE_ACTION_REF` | `main` | git ref of `Flude-team/flude-action` to clone for the client code. Pin to a commit SHA for stability once a tag exists. |

## What the job actually does

One job, one `script:`, no separate stages - see `flude.gitlab-ci.yml`'s own
header comment for why (short version: `artifacts:` is GitLab's only
cross-*job* persistence mechanism, so staying inside one job's script
sidesteps that entire class of bug rather than needing to prove artifacts
survive a stage boundary).

1. `git clone` this repo (pinned to `FLUDE_ACTION_REF`) into `.flude-action`
   in `before_script`, then run `node .flude-action/gitlab/src/run.js`.
2. `run.js` reads `CI_PROJECT_URL`/`CI_COMMIT_SHA` for the repository/commit
   (there's no separate "path to sources" variable, same as the GitHub
   Action - the control-plane clones the repository itself) and submits a
   job with `platform: 'gitlab'`.
3. Polls `GET /jobs/{id}` via `../src/poll.js`, unmodified. Free-gate
   rejections (`rejected_too_large`/`rejected_organization`/
   `rejected_private`) are terminal job statuses handled the same way as the
   GitHub Action - not a separate client-side check against GitLab's own
   project API. The control-plane owns that decision (`DEL-B23`) identically
   for every platform.
4. Downloads the result archive via `../src/download.js`, unmodified.
5. Extracts a **`codequality.json`** entry from the archive
   (`gitlab-reporting.js`) and writes it to `FLUDE_CODEQUALITY_PATH`, which
   the job then exposes via `artifacts:reports:codequality`.

### The `codequality.json` archive-layout assumption

Same honesty rule as `../README.md`'s SARIF section: `DEL-B23` hasn't
shipped, so no real control-plane has ever decided how a Code Quality report
ends up in the result archive. This template assumes a top-level
**`codequality.json`** entry, in the real shape produced by
`engine/ude/reporting.py::to_codeclimate()` (verified directly against that
source - see the excerpt in the DEL-B26 card in `Delivery_ToDo.md`):

```json
[
  {
    "description": "...",
    "check_name": "<rule_id>",
    "fingerprint": "<md5(rule_id:entity_name)>",
    "severity": "major|minor|info",
    "location": { "path": "<file>", "lines": { "begin": <line> } }
  }
]
```

A finding without both `file` and `line` is silently excluded by
`to_codeclimate()` itself (GitLab's schema requires `location.lines.begin` to
be an integer) - `gitlab-reporting.js` does not attempt to synthesize a
fallback location for one. This is a **second, independent** naming
assumption from `report.sarif` (the GitHub Action's own archive-layout
guess, `../src/sarif-report.js`) - the same archive is not guaranteed to
contain both, or either. If `codequality.json` isn't found, or can't be
parsed, the job logs a console warning and continues without failing - a
wrong assumption about the archive layout never fails an otherwise-successful
documentation job. No `--fingerprint-ignore` / merge-request-vs-branch
comparison logic is needed on top of this - `to_codeclimate()`'s fingerprint
is stable across unrelated line-number shifts already (hashes `rule_id` +
`entity_name`, not `line`), which is exactly what GitLab's own MR diff widget
needs to recognize "this is the same finding as last time" across commits.

### A known cosmetic wart in reused `poll.js`

`../src/poll.js` (reused here unmodified, per this card's own instruction not
to rewrite it) logs via `../src/github-output.js`'s `logNotice`/`logWarning`,
which prefix messages with GitHub's `::notice::`/`::warning::` workflow-command
syntax. GitLab doesn't parse that syntax - it just shows up as literal text
in the job log (confirmed by the local run below). This is cosmetic only:
`logNotice`/`logWarning` are plain `console.log`/`console.warn` wrappers, they
don't touch `GITHUB_OUTPUT` or any other GitHub-only environment state, so
nothing breaks. Not fixed here, since fixing it means either forking `poll.js`
(against this card's own "don't rewrite" instruction) or adding a
platform-neutral logger parameter to it (a real, if small, change to shared
code that's out of this card's scope) - flagged instead so a future pass
addressing all three platforms' logging together (GitHub/GitLab/Bitbucket,
`DEL-B39`) can fix it once, not three times.

## Development & testing

Same approach as `../README.md`: no real control-plane to test against yet,
so this reuses `../test-support/mock-server.js` (via a new `with-codequality`
scenario in `../test-support/start-mock-server.mjs`) implementing the assumed
API contract.

- **Unit tests** (`npm test` from the repo root, i.e. `node --test`):
  `test/gitlab-reporting.test.js` exercises `gitlab/src/gitlab-reporting.js`
  against hand-built ZIP/Code-Quality fixtures
  (`test-support/zip-builder.js`, `test-support/codequality-fixture.js`),
  covering a successful extraction, a missing entry, a non-ZIP archive, and a
  present-but-unparsable entry. `gitlab/src/run.js` reuses
  `../src/control-plane-client.js`/`../src/poll.js`/`../src/download.js`,
  already covered by the existing GitHub-side unit tests against the same
  mock - it is not re-tested per input/error-branch here.
- **Real local run** (not automated, done once by hand for this card - see
  "What this repo does and does not verify" below for why it isn't a GitLab
  CI job yet): started the mock control-plane
  (`MOCK_SCENARIO=with-codequality node test-support/start-mock-server.mjs`)
  and invoked `gitlab/src/run.js` directly with GitLab-shaped env vars
  (`GITLAB_CI=true`, `CI_PROJECT_URL`, `CI_COMMIT_SHA`, `FLUDE_API_TOKEN`,
  `FLUDE_API_BASE_URL` pointed at the mock). Confirmed: exit code 0, a real
  `gl-code-quality-report.json` was written to disk with 5 findings in the
  exact schema above (fingerprints, severities, locations all correct); a
  `rejected_too_large` scenario correctly threw and exited 1 with the
  free-gate explanation; a missing `FLUDE_API_TOKEN` correctly threw and
  exited 1 before ever contacting the mock.

### What this repo does and does not verify

- **Verified**: `run.js`'s and `gitlab-reporting.js`'s own logic - variable
  parsing, the full submit/poll/download/extract cycle, error handling - via
  both unit tests and a real local invocation against the mock control-plane,
  as described above.
- **Not verified**: running the actual `flude.gitlab-ci.yml` template on a
  real GitLab runner (this development environment has no GitLab project or
  account to test against), and therefore also not verified: that findings
  actually render in a real merge request's diff widget, that `include:
  remote:` resolves and merges correctly against a real consumer pipeline,
  that `stage: test` doesn't collide with a consumer's customized `stages:`
  list in practice, or the real control-plane / real Clerk token verification
  / real free-gate evaluation / real GCS signed URLs (same gap as
  `../README.md`, gated on `DEL-B23`). **This is the acceptance criterion
  this card explicitly asks for and it remains open** - re-run this on a real
  GitLab project (even against the mock, which needs no real control-plane)
  before treating DEL-B26 as done, not just this repo's own local checks.
