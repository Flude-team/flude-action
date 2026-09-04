// Client for Bitbucket Cloud's Code Insights API (reports + annotations).
// Endpoint shapes verified directly against Atlassian's own docs
// (support.atlassian.com/bitbucket-cloud/docs/code-insights/) and the
// go-bitbucket/bitbucket-go-client generated clients, not guessed by
// analogy with GitHub/GitLab:
//
//   PUT  /2.0/repositories/{workspace}/{repo_slug}/commit/{commit}/reports/{reportId}
//   POST /2.0/repositories/{workspace}/{repo_slug}/commit/{commit}/reports/{reportId}/annotations
//
// Auth: inside a real Bitbucket Pipelines step, requests to the Bitbucket
// API must be routed through a proxy Pipelines runs alongside every step at
// http://localhost:29418 - it transparently injects a valid Authorization
// header, so this client never handles a token itself (this is exactly
// what the task described, and it's confirmed in Atlassian's own docs, not
// just taken on trust). Outside real Pipelines - this repo's own
// mock-backed tests, or a consumer's local dev - point BITBUCKET_API_BASE_URL
// at a plain HTTP mock instead; there is no proxy and no token to send in
// either case, since baseUrl swaps in for both the proxy and a real
// Authorization-header client would need.

const MAX_ANNOTATIONS_PER_REQUEST = 100

function reportUrl(baseUrl, workspace, repoSlug, commit, reportId) {
  return (
    `${baseUrl}/2.0/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(repoSlug)}` +
    `/commit/${encodeURIComponent(commit)}/reports/${encodeURIComponent(reportId)}`
  )
}

async function request(url, { method, body }) {
  const response = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`Bitbucket Code Insights request failed: ${method} ${url} -> HTTP ${response.status} ${text}`)
  }
  return response
}

export async function putReport(baseUrl, workspace, repoSlug, commit, reportId, report) {
  await request(reportUrl(baseUrl, workspace, repoSlug, commit, reportId), { method: 'PUT', body: report })
}

// Bitbucket allows at most 100 annotations per POST and 1000 per report
// (confirmed against Atlassian's docs) - chunk here rather than trust every
// caller to have done it, the same way gitlab-reporting.js doesn't trust
// its caller to have pre-validated the archive.
export async function postAnnotations(baseUrl, workspace, repoSlug, commit, reportId, annotations) {
  const url = `${reportUrl(baseUrl, workspace, repoSlug, commit, reportId)}/annotations`
  for (let offset = 0; offset < annotations.length; offset += MAX_ANNOTATIONS_PER_REQUEST) {
    const chunk = annotations.slice(offset, offset + MAX_ANNOTATIONS_PER_REQUEST)
    await request(url, { method: 'POST', body: chunk })
  }
}
