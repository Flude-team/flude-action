import { createServer } from 'node:http'

// A minimal stand-in for Bitbucket Cloud's real Code Insights API, used only
// for this repo's own tests and local rehearsal - real requests inside
// Bitbucket Pipelines go through the local proxy at localhost:29418 instead
// (see bitbucket/src/bitbucket-insights-client.js), which this mock does not
// attempt to replicate; it only implements the two endpoints that client
// calls, recording every request it receives so tests can assert on the
// exact JSON Bitbucket would have been sent.
export function createMockBitbucketApi() {
  const requests = []

  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const rawBody = Buffer.concat(chunks).toString('utf8')
    const body = rawBody ? JSON.parse(rawBody) : null
    requests.push({ method: req.method, url: req.url, body })

    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
  })

  return { server, requests }
}
