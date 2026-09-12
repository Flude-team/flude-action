# Flude GitLab CI Template (DEL-B26)

A thin `.gitlab-ci.yml` template around the same control-plane client used by
the GitHub Action in `../` (`../src/control-plane-client.js`, `../src/poll.js`,
`../src/download.js`, `../src/zip-extract.js` are reused directly via
relative import - not copied, not rewritten). It never bundles the Flude
engine and never touches your source beyond reading `CI_PROJECT_URL`/
`CI_COMMIT_SHA` - the control-plane clones your public repository itself.

> **Status: Stage 1 / pre-release, same caveat as `../README.md`.** The
> control-plane API this talks to (`DEL-B23`) is now deployed and publicly
> accessible. Everything below describes the assumed contract this was built against.

## Why this code lives in the `flude-action` repo

`flude-action` predates GitLab support and is named after the GitHub Actions
concept, which is a real mismatch for a GitLab template. It stays here anyway
(see the DEL-B26 card in `Delivery_ToDo.md` for the full reasoning): the
shared client (`../src/control-plane-client.js`, `../src/poll.js`, etc.) has
no packaging story of its own yet, so a separate repo would need a git
submodule, a published npm package, or a copy - all real new maintenance
surface for five files.
A plain relative import costs nothing and can never drift. Revisit the split
once there's a second forcing reason (unlike
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
| `FLUDE_API_BASE_URL` | yes | Base URL of the control-plane API. Example: `https://flude-worker-controlplane-555636434059.us-central1.run.app`. Point this at a local mock while developing locally (see "Development & testing" below). |

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

### Real GitLab-runner verification (2026-09-03)

Done on a throwaway public test project on gitlab.com
(`derryk/flude-gitlab-del-b26-test`, owner's own account), against the
`with-codequality` mock started in the job's own `before_script` (same
technique as `../.github/workflows/e2e-mock.yml` on the GitHub side) - not
against the real control-plane.

- **Job succeeds end-to-end on a real shared runner** - MR
  [`!1`](https://gitlab.com/derryk/flude-gitlab-del-b26-test/-/merge_requests/1),
  pipeline
  [`#2817229456`](https://gitlab.com/derryk/flude-gitlab-del-b26-test/-/pipelines/2817229456),
  job [`16287818788`](https://gitlab.com/derryk/flude-gitlab-del-b26-test/-/jobs/16287818788):
  clone → mock start → submit → poll (`running...`) → download → `5
  finding(s) written to gl-code-quality-report.json` → `Job succeeded`.
  (The *first* attempt on this same MR genuinely failed first -
  `Cannot find module '.../gitlab/src/run.js'` - because the `gitlab/`
  directory had been committed locally but never pushed to
  `github.com/Flude-team/flude-action`, which is what the job's own `git
  clone` actually fetches from. Pushed, retried, passed. Real bug a
  local-only check could never have caught, exactly the class of thing this
  section exists to catch.)
- **`artifacts:reports:codequality` actually uploads** - same job log:
  `gl-code-quality-report.json: found 1 matching artifact files and
  directories` /
  `Uploading artifacts as "codequality" to coordinator... 201 Created`.
- **`include: remote:` against the raw GitHub URL resolves cleanly** -
  verified via the test project's own Pipeline Editor
  (`-/ci/editor`, Validate tab: "Pipeline syntax is correct"; Full
  configuration tab: the merged config shows the `flude:` job - `stage:
  test`, `image: node:20`, the `$FLUDE_DISABLE`/`merge_request_event`/
  `$CI_COMMIT_BRANCH` rules, `FLUDE_FORMAT: markdown` - fully resolved from
  `https://raw.githubusercontent.com/Flude-team/flude-action/main/gitlab/flude.gitlab-ci.yml`).
  This was checked in isolation (pasted into the editor, never committed)
  rather than as the actual template used by the two test MRs below, which
  instead inline a `before_script` override to start the mock - see "The
  `flude:` job's `before_script:` needs a local-dev override" below for why.
- **Findings render in a real MR's diff/overview widget** - the harder,
  genuinely non-obvious part. MR `!1` merged first (`main` now has its own
  `.gitlab-ci.yml` and a baseline pipeline,
  [`#2817375023`](https://gitlab.com/derryk/flude-gitlab-del-b26-test/-/pipelines/2817375023),
  with the same 5 mock findings). A **second** MR,
  [`!2`](https://gitlab.com/derryk/flude-gitlab-del-b26-test/-/merge_requests/2)
  (`MOCK_FINDINGS_COUNT: '6'` instead of the default 5 - see the mock change
  below), was needed to actually see anything: GitLab's Code Quality MR
  widget **diffs the head pipeline's report against the target branch's own
  baseline report** - it does not just list everything present in the head
  report. Against an identical 5-finding baseline it correctly said "Code
  Quality hasn't changed" (not a bug - accurate, since nothing had). Once the
  head branch's report had a 6th finding, the widget correctly said **"Code
  Quality scans found 1 new finding"**, expandable to **"Info - finding
  number 5, in `src/file5.py:6`"** - exactly the new entry, correctly
  attributed, nothing else. A consumer with no prior baseline pipeline on
  their target branch (the common case - first time adding this template)
  will see "hasn't changed" on their very first MR even with real findings
  present; the widget only starts showing degradations once the target
  branch has run this job at least once itself.

To make the second MR possible without touching the archive-layout contract,
`test-support/start-mock-server.mjs`'s `with-codequality` scenario gained a
`MOCK_FINDINGS_COUNT` env var (default 5, unchanged) instead of a hardcoded
count - test-only, no `src/*.js` or `gitlab/src/*.js` change.

#### The `flude:` job's `before_script:` needs a local-dev override

Neither test MR used the bare `include: remote:` from "Usage" above verbatim
- to test against a mock instead of the real control-plane,
both test projects' own `.gitlab-ci.yml` instead defined the `flude:` job
directly (copy of `flude.gitlab-ci.yml`'s job, `MOCK_SCENARIO`/
`MOCK_FINDINGS_COUNT`/`MOCK_TOKEN` added to `variables:`, and a
`before_script` step added to start
`node .flude-action/test-support/start-mock-server.mjs &` and poll it ready
before the real `script:` step runs `gitlab/src/run.js`). This is the
pattern a real consumer would follow to develop against this template
locally against a mock - not a
limitation of `include:` itself (see the Pipeline Editor check above, which
did exercise the bare `include: remote:` in isolation).

### What this repo does and does not verify

- **Verified**:
  - `run.js`'s and `gitlab-reporting.js`'s own logic (unit tests and a real local invocation against the mock).
  - The template's actual mechanics on a real GitLab shared runner (clone, mock start, submit/poll/download, artifact upload, `include: remote:` resolution, and MR-widget rendering of new findings).
  - The `flude.gitlab-ci.yml` template supports `$CI_PIPELINE_SOURCE == "schedule"`.
  - The real test project `derryk/flude-gitlab-del-b26-test` has a C++ fixture (`UndocumentedWidget`) and a `verify-flude` job that successfully parses and validates the real contents of `gl-code-quality-report.json`.
- **Not yet verified (pending real run)**:
  - A full live run against the real control-plane with a real Clerk token and real free-gate evaluation. The infrastructure is ready, but the CI/CD variables and Pipeline Schedule in the test project are configured manually by the owner and the final run has not yet completed.

#### Pipeline Schedule Cadence

Unlike GitHub Actions (which offers unlimited public runner minutes), GitLab.com provides a flat 400 compute-minutes per month across the entire namespace. A real hourly run (~24 × 30 runs × ~1.75 minutes) would exhaust the free quota in about 9-10 days. Therefore, the scheduled E2E run against the live control-plane uses a **daily** cadence, safely consuming only ~50 minutes per month.
