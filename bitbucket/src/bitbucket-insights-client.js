import { request as httpRequest } from 'node:http'

// Client for Bitbucket Cloud's Code Insights API (reports + annotations).
// Endpoint shapes verified directly against Atlassian's own docs
// (support.atlassian.com/bitbucket-cloud/docs/code-insights/) and the
// go-bitbucket/bitbucket-go-client generated clients, not guessed by
// analogy with GitHub/GitLab:
//
//   PUT  /2.0/repositories/{workspace}/{repo_slug}/commit/{commit}/reports/{reportId}
//   POST /2.0/repositories/{workspace}/{repo_slug}/commit/{commit}/reports/{reportId}/annotations
//
// Auth: inside a real Bitbucket Pipelines step, Bitbucket API calls must be
// routed through a genuine HTTP **forward proxy** Pipelines runs alongside
// every step at localhost:29418 - NOT a drop-in replacement hostname for
// api.bitbucket.org. Confirmed the hard way (2026-09-04, real Pipelines run,
// see bitbucket/README.md): a direct `fetch('http://localhost:29418/2.0/...')`
// gets a raw nginx 500 from the proxy itself. The real, working shape
// (verified against Atlassian Community's own accepted answer for this
// exact failure) is a genuine proxy request - connect to localhost:29418,
// send the **absolute** target URI as the request path
// (`http://api.bitbucket.org/2.0/...`, HTTP not HTTPS - the proxy can't
// tunnel HTTPS without a CONNECT it doesn't support here), auth injected by
// the proxy itself. `fetch`'s dispatcher/proxy support isn't available
// without an extra dependency (`undici`'s ProxyAgent isn't a Node 20 core
// module), so this uses plain `node:http` - zero third-party dependencies,
// same as the rest of this repo.
//
// Outside real Pipelines - this repo's own mock-backed tests, or a
// consumer's local dev - BITBUCKET_API_BASE_URL points at a plain mock HTTP
// server instead (not a proxy), so requests go straight to it with a normal
// `fetch`. Which transport to use is decided by whether BITBUCKET_API_BASE_URL
// is still the real Pipelines proxy default or has been overridden.
const REAL_PROXY_BASE_URL = 'http://host.docker.internal:29418'
// The proxy can only forward plain HTTP, not HTTPS (see above) - this is
// intentionally http://, not the https:// URL a direct (non-proxied) client
// would use.
const REAL_API_HOST = 'api.bitbucket.org'

const MAX_ANNOTATIONS_PER_REQUEST = 100

function reportPath(workspace, repoSlug, commit, reportId) {
  return (
    `/2.0/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(repoSlug)}` +
    `/commit/${encodeURIComponent(commit)}/reports/${encodeURIComponent(reportId)}`
  )
}

function requestViaRealProxy(path, { method, body }) {
  const bodyText = body ? JSON.stringify(body) : undefined
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: 'host.docker.internal',
        port: 29418,
        method,
        // The absolute target URI as the request path is what makes this a
        // genuine forward-proxy request rather than a request to a server
        // literally listening on port 29418.
        path: `http://${REAL_API_HOST}${path}`,
        headers: {
          'Content-Type': 'application/json',
          ...(bodyText ? { 'Content-Length': Buffer.byteLength(bodyText) } : {}),
        },
      },
      (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }))
      }
    )
    req.on('error', reject)
    if (bodyText) req.write(bodyText)
    req.end()
  })
}

async function requestViaMock(baseUrl, path, { method, body }) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: response.status, text: await response.text().catch(() => '') }
}

async function request(baseUrl, path, options) {
  const { status, text } =
    baseUrl === REAL_PROXY_BASE_URL ? await requestViaRealProxy(path, options) : await requestViaMock(baseUrl, path, options)
  if (status < 200 || status >= 300) {
    throw new Error(`Bitbucket Code Insights request failed: ${options.method} ${path} -> HTTP ${status} ${text}`)
  }
  return text
}

export async function putReport(baseUrl, workspace, repoSlug, commit, reportId, report) {
  await request(baseUrl, reportPath(workspace, repoSlug, commit, reportId), { method: 'PUT', body: report })
}

// Bitbucket allows at most 100 annotations per POST and 1000 per report
// (confirmed against Atlassian's docs) - chunk here rather than trust every
// caller to have done it, the same way gitlab-reporting.js doesn't trust
// its caller to have pre-validated the archive.
export async function postAnnotations(baseUrl, workspace, repoSlug, commit, reportId, annotations) {
  const path = `${reportPath(workspace, repoSlug, commit, reportId)}/annotations`
  for (let offset = 0; offset < annotations.length; offset += MAX_ANNOTATIONS_PER_REQUEST) {
    const chunk = annotations.slice(offset, offset + MAX_ANNOTATIONS_PER_REQUEST)
    await request(baseUrl, path, { method: 'POST', body: chunk })
  }
}
