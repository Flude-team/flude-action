import { createMockControlPlane } from './mock-server.js'

export async function withMockServer(options, fn) {
  const server = createMockControlPlane(options)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  try {
    await fn(`http://127.0.0.1:${port}`)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}
