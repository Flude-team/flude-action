# Flude Bitbucket Pipe (DEL-B39)

A Bitbucket Pipe around the same control-plane client used by the GitHub
Action (`../`) and the GitLab CI template (`../gitlab/`) - `../src/control-plane-client.js`,
`../src/poll.js`, `../src/download.js`, `../src/zip-extract.js`, and
`../src/sarif-report.js` are reused directly, not copied, not rewritten.

> **Status: Stage 1 / pre-release, same caveat as `../README.md`.** The
> control-plane API this talks to (`DEL-B23`) does not exist yet.

## Why a Pipe is structurally different from the other two clients

Unlike the GitHub Action (plain `node20`, source checked out by the runner)
and the GitLab template (`git clone`s this repo at job run time), a
**Bitbucket Pipe is a Docker image** - `pipe.yml` + a `Dockerfile`, published
to a public registry, referenced by tag from a consumer's own
`bitbucket-pipelines.yml`. Everything the pipe needs is baked into the image
at **build** time, not fetched at **run** time. Concretely:

- `Dockerfile` must be built with the **repository root** as its context
  (`docker build -f bitbucket/Dockerfile .` from the repo root, not from
  `bitbucket/`) so it can `COPY` both `../src/*.js` (shared client) and
  `./src/*.js` (Bitbucket-specific) - Docker `COPY` cannot reach outside its
  build context, and the shared client lives one directory above `bitbucket/`.
- The image also needs a `package.json` declaring `"type": "module"` copied
  in (this repo's own root one), since the shared files use ESM
  `import`/`export` and Node only honors that with `type: module` present
  (or a `.mjs` extension, which the shared files don't use).
- **Genuinely built and run** (2026-09-04, `docker build`/`docker run`, this
  environment has Docker available): the image builds successfully at
  **193MB** (well under the official-pipe 1GB limit) and, run against the two
  mocks below, correctly submitted a job and polled it through the
  control-plane mock via `host.docker.internal` (proving the packaging,
  entrypoint, ESM resolution, and container-to-host networking all work).
  The *download* step then failed inside the container only because the
  mock's own `result_url` hardcodes `127.0.0.1` (correct for its normal
  in-process test usage, unreachable from a separate container's network
  namespace) - a test-fixture limitation, not a pipe bug, and the identical
  code's full submit→poll→download→report cycle was separately verified for
  real via the non-containerized run described below.

## The `codequality.json`-equivalent question: there isn't one

`DEL-B26` (GitLab) could assume a second, parallel archive entry
(`codequality.json`) because a real server-side serializer for it already
exists (`engine/ude/reporting.py::to_codeclimate()`). **No such function
exists for Bitbucket** - only `to_sarif()` and `to_codeclimate()` are real.
Inventing a third, wholly unconfirmed archive-entry-name guess
(`bitbucket-insights.json` or similar) would add risk for no benefit, so
this client instead **reuses `report.sarif`** - the one archive-layout
assumption GitHub's `DEL-B25` already made - and converts SARIF's findings
into Bitbucket's Code Insights shape in JS (`bitbucket-reporting.js`),
reusing `../src/sarif-report.js`'s already-platform-neutral
`parseSarifFindings()` directly. If `DEL-B23` ever ships a native Bitbucket
format, switch this file to read it directly instead of converting - don't
keep converting out of inertia.

## Output mapping: Bitbucket Code Insights (report + annotations)

Not SARIF, not GitLab's Code Quality JSON - Bitbucket Cloud's own **Code
Insights API**, verified directly against Atlassian's docs and the
`go-bitbucket`/`bitbucket-go-client` generated clients (not guessed by
analogy with the other two platforms):

```text
PUT  /2.0/repositories/{workspace}/{repo_slug}/commit/{commit}/reports/{reportId}
POST /2.0/repositories/{workspace}/{repo_slug}/commit/{commit}/reports/{reportId}/annotations
```

- **Report** (`title`, `details`, `report_type`, `result`, `data[]`
  required/used fields): `report_type` and `annotation_type`'s enums are
  fixed and don't include a "documentation" option -
  `report_type: BUG`/`annotation_type: CODE_SMELL` are this client's
  reasoned choice among `{BUG, SECURITY, COVERAGE, TEST}` /
  `{VULNERABILITY, CODE_SMELL, BUG}`, not a fabricated value. `result` is
  `FAILED` if any finding is at SARIF level `error`, else `PASSED` - a
  quality gate independent of the underlying documentation job's own exit
  code, same non-fatal-reporting philosophy as the other two platforms.
- **Annotations**: `severity` maps SARIF's `error`/`warning`/`note` to
  Bitbucket's `HIGH`/`MEDIUM`/`LOW` (the same three-way shape as GitLab's
  `to_codeclimate()` mapping to `major`/`minor`/`info`). Only findings with
  **both** `file` and `line` get an annotation - a finding missing either
  can't attach to a diff position. `external_id` (required, must be unique)
  is a deterministic hash of the finding's own identity fields, so re-posting
  the same finding on a later run updates it in place instead of duplicating
  it.
- **Limits** (confirmed against Atlassian's docs): **100 annotations per
  POST, 1000 per report** - `bitbucket-insights-client.js` chunks into
  batches of 100 automatically rather than trusting the caller to have done
  it.
- **"Only the latest commit's reports show on a PR"** (as the task
  description said, and confirmed in Atlassian's own docs): this needs no
  special handling - the pipe naturally reports against
  `$BITBUCKET_COMMIT` on every run, and Bitbucket's PR view always shows
  whichever commit is currently at the branch tip. A consumer's own
  `bitbucket-pipelines.yml` running this pipe on every `pull-requests` build
  already satisfies "resend the report on every update" for free.

### Authentication: the `localhost:29418` proxy, not a token

Confirmed directly in Atlassian's docs, not assumed by analogy: inside a
real Bitbucket Pipelines step, requests to `api.bitbucket.org` must be
routed through a proxy Pipelines runs alongside every step at
`http://localhost:29418`, which transparently injects a valid
`Authorization` header - this client (`bitbucket-insights-client.js`) never
handles a Bitbucket token itself. `BITBUCKET_API_BASE_URL` defaults to that
proxy address and is overridable only so this repo's own tests/local
rehearsal can point it at a mock instead (no proxy, no token needed either
way - `fetch` with no `Authorization` header at all, since the mock doesn't
check one).

This is unrelated to `FLUDE_API_TOKEN`, which is still a real, required
credential (the same Clerk API Key mechanism as the other two platforms) -
it authenticates to the **Flude control-plane**, not to Bitbucket's own API.

**A real bug this documentation-reading alone didn't catch, only a real
Pipelines run did (2026-09-04):** `localhost:29418` is a genuine HTTP
**forward proxy**, not a drop-in hostname for `api.bitbucket.org`. The first
live attempt sent `fetch('http://localhost:29418/2.0/repositories/...')`
directly - i.e. treated port 29418 as if a server there answered API paths
itself - and got back a raw `nginx/1.26.3` `500 Internal Server Error` from
the proxy, not a JSON error from Bitbucket's API. The correct shape (matches
an Atlassian Community accepted answer for this exact symptom): connect to
the proxy, then send the **absolute target URI** as the request path -
`http://api.bitbucket.org/2.0/...` (`http://`, not `https://` - the proxy
can't tunnel HTTPS via CONNECT here) - as the literal path of the request
line. `fetch`'s `dispatcher`/proxy support needs `undici`'s `ProxyAgent`,
which isn't a Node 20 core module, so `bitbucket-insights-client.js` uses
plain `node:http` for this one call shape instead of adding a dependency.
Fixed and reverified for real - see "Real live Bitbucket Pipelines run" below.

## Usage (once published - see "Publishing" below)

```yaml
# bitbucket-pipelines.yml
pipelines:
  pull-requests:
    '**':
      - step:
          name: Flude Docs
          script:
            - pipe: docker://ghcr.io/flude-team/bitbucket-pipe:0.1.0
              variables:
                FLUDE_API_TOKEN: $FLUDE_API_TOKEN
                FLUDE_API_BASE_URL: $FLUDE_API_BASE_URL
  branches:
    main:
      - step:
          name: Flude Docs
          script:
            - pipe: docker://ghcr.io/flude-team/bitbucket-pipe:0.1.0
              variables:
                FLUDE_API_TOKEN: $FLUDE_API_TOKEN
                FLUDE_API_BASE_URL: $FLUDE_API_BASE_URL
```

`FLUDE_API_TOKEN`/`FLUDE_API_BASE_URL` are set as **repository variables**
(Repository settings > Pipelines > Repository variables, mask the token) -
same Clerk API Key mechanism as the GitHub/GitLab clients (`DEL-B22`/`DEL-B41`).

### Optional variables (all with defaults)

| Variable | Default | Description |
| --- | --- | --- |
| `FLUDE_FORMAT` | `markdown` | `markdown` or `html`. |
| `FLUDE_STRICT` | `false` | Enable Strict Compilation Mode. |
| `FLUDE_POLL_INTERVAL_SECONDS` | `10` | Delay between `GET /jobs/{id}` polls. |
| `FLUDE_MAX_WAIT_SECONDS` | `900` | Client-side safety net only - the authoritative timeout is server-side. |

## Publishing

1. **The Docker image itself:** The pipe's Docker image is actively built and published to GitHub Container Registry at `ghcr.io/flude-team/bitbucket-pipe:0.1.3` (it is a public package, so Bitbucket Pipelines can pull it without credentials).
2. **Official Bitbucket Pipes Registry listing** (optional, cosmetic
   discoverability - a consumer can already use `pipe: docker://<image>`
   directly without this). The official-pipes process wants the *source*
   repository itself hosted on Bitbucket (`pipe.yml`'s own `repository:`
   field), which this repo isn't (same GitHub-hosting mismatch
   `../gitlab/README.md` already documents for GitLab's `include: project:`).
   Not pursued for the same reason: no second forcing requirement yet, easy
   to revisit later with a thin Bitbucket-hosted mirror if it's ever worth it.

## Development & testing

- **Unit tests** (`npm test` from the repo root): `test/bitbucket-reporting.test.js`
  exercises `bitbucket/src/bitbucket-reporting.js` against a hand-built SARIF
  fixture (reusing `test-support/sarif-fixture.js`/`zip-builder.js`) and a new
  `test-support/bitbucket-mock-server.js` (records every request it
  receives, for exact-payload assertions) - covering a normal conversion,
  chunking >100 annotations into multiple POSTs, a missing `report.sarif`,
  and the all-findings-missing-location case (report still gets PUT, no
  annotations call happens at all).
- **Real local run, twice** (2026-09-04): started `test-support/start-mock-server.mjs`
  (`MOCK_SCENARIO=with-sarif`, 15 findings) and
  `test-support/start-bitbucket-mock-server.mjs` and invoked
  `bitbucket/src/run.js` directly with Bitbucket-shaped env vars
  (`BITBUCKET_BUILD_NUMBER`, `BITBUCKET_REPO_FULL_NAME`, `BITBUCKET_COMMIT`).
  Confirmed: exit code 0, `15 finding(s) reported to Bitbucket Code Insights
  (7 with an attached annotation; report "flude-docs-quality")` - 7 is
  correct (only findings with both `file` and `line`, same fixture the
  GitHub side's `e2e-sarif` workflow uses). Separately confirmed:
  `rejected_private` (exit 1, free-gate explanation), missing
  `FLUDE_API_TOKEN` (exit 1 before any network call), and a malformed
  `BITBUCKET_REPO_FULL_NAME` with no `/` (exit 1, clear message).
- **Real Docker build + run** (2026-09-04): see "Why a Pipe is structurally
  different" above - image builds at 193MB, submit+poll genuinely succeeded
  from inside the container against the mock via `host.docker.internal`;
  download failed only due to the mock's own `127.0.0.1`-hardcoded
  `result_url`, a test-fixture limitation already worked around by the
  direct (non-Docker) run above using the identical code.
- **Real live Bitbucket Pipelines run** (2026-09-04, owner's own `flude`
  workspace, public test repository `flude/flude-bitbucket-del-b39-test`,
  since Pipelines itself requires the account-level "Bitbucket account"
  two-step verification - a genuinely separate setting from Atlassian ID's
  own 2FA, confirmed the hard way after several rounds of "still blocked"):
  a real PR (`!1`) running `node .flude-action/bitbucket/src/run.js` directly
  (not the Docker Pipe - no registry to pull it from yet, see "Publishing"),
  against the mock started in the same job step (same technique as the
  GitLab side's `e2e-mock`-equivalent local rehearsal), with
  `BITBUCKET_API_BASE_URL` left at its real default so the Code Insights
  calls went through the genuine `localhost:29418` proxy, not a mock.
  First real attempt failed on the forward-proxy bug described above; fixed,
  pushed, rerun (pipeline `#10`) - **succeeded**: job log shows the real
  submit/poll/download cycle, then a `PUT`/`POST` through the real proxy
  that this time returned success, and the PR's own build-status panel shows
  `1 of 1 build passed` with a `1 Report` link. Opening it shows Bitbucket's
  own real Code Insights report UI: **"Flude documentation quality" - 15
  finding(s), 5 at level "error"**, each row with severity
  (High/Medium/Info), rule id, message, and a `path:line` link
  (`src/file6.py:7` etc.) - exactly the 15/5 shape the `with-sarif` mock
  fixture produces. Annotations don't render inline in the PR's diff view
  because none of the mock's `src/fileN.py` paths are part of this PR's
  actual diff (it only touches `bitbucket-pipelines.yml`) - the same
  location-must-be-in-the-diff behavior GitHub/GitLab both have; the report
  itself, which is the part this card's acceptance criterion is actually
  about, is real and genuinely populated.

### What this repo does and does not verify

- **Verified**: `bitbucket-reporting.js`'s and `bitbucket-insights-client.js`'s
  own logic (unit tests against a mock), the full submit/poll/download/report
  cycle via a real local invocation, the Docker image's packaging via a real
  build, and the actual `localhost:29418` proxy auth. We also verified a real Code Insights report with real
  findings on a real PR, and the account-level 2FA gate Pipelines itself requires.
  Furthermore, the pipe has now been proven to work as an actual **Docker image** (`pipe: docker://...`) inside a real, standing Scheduled Bitbucket Pipeline running against the **real deployed control-plane**, successfully exercising Clerk token verification and the `rejected_repo_organization` free-gate rejection logic (proving the exact commit-author-distribution heuristic works as intended).
- **Not verified**: The real result archive structure (whether it contains a `report.sarif` at its root) is assumed, mirroring the DEL-B25 specification, but this client depends on it.
