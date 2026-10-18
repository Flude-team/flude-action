import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, unlinkSync } from 'node:fs'
import { run } from '../gitlab/src/run.js'
import { withMockServer } from '../test-support/helpers.js'

async function withEnv(overrides, fn) {
  const original = {}
  for (const [k, v] of Object.entries(overrides)) {
    original[k] = process.env[k]
    if (v === undefined) {
      delete process.env[k]
    } else {
      process.env[k] = v
    }
  }
  try {
    return await fn()
  } finally {
    for (const [k, v] of Object.entries(original)) {
      if (v === undefined) {
        delete process.env[k]
      } else {
        process.env[k] = v
      }
    }
  }
}

function captureConsole() {
  const logs = []
  const originalLog = console.log
  console.log = (...args) => logs.push(args.join(' '))
  return {
    logs,
    restore: () => {
      console.log = originalLog
    },
  }
}

test('GitLab run() fail-fast: invalid FLUDE_PARSER_BACKEND', async () => {
  await withEnv(
    {
      CI_PROJECT_URL: 'https://gitlab.com/acme/project',
      CI_COMMIT_SHA: 'abc123456789',
      FLUDE_API_TOKEN: 'test-token',
      FLUDE_API_BASE_URL: 'http://127.0.0.1:9999',
      FLUDE_PARSER_BACKEND: 'invalid_backend',
    },
    async () => {
      await assert.rejects(
        () => run(),
        /Invalid FLUDE_PARSER_BACKEND: "invalid_backend" \(expected 'doxygen' or 'syntactic'\)\./
      )
    }
  )
})

test('GitLab run() fail-fast: FLUDE_PARSER_BACKEND=syntactic on non-cpp language', async () => {
  await withEnv(
    {
      CI_PROJECT_URL: 'https://gitlab.com/acme/project',
      CI_COMMIT_SHA: 'abc123456789',
      FLUDE_API_TOKEN: 'test-token',
      FLUDE_API_BASE_URL: 'http://127.0.0.1:9999',
      FLUDE_LANGUAGE: 'python',
      FLUDE_PARSER_BACKEND: 'syntactic',
    },
    async () => {
      await assert.rejects(
        () => run(),
        /The 'syntactic' parser backend is only supported for C\+\+ \(language: cpp\), got "python"\./
      )
    }
  )
})

test('GitLab run() fail-fast: FLUDE_PARSER_BACKEND=syntactic with build context inputs', async () => {
  const buildContextVars = [
    { FLUDE_VCXPROJ_PATH: 'project.vcxproj' },
    { FLUDE_VCXPROJ_CONFIGURATION: 'Release' },
    { FLUDE_VCXPROJ_PLATFORM: 'x64' },
    { FLUDE_BAZEL_BUILD_PATH: 'BUILD' },
    { FLUDE_BAZEL_TARGET_NAME: 'lib' },
    { FLUDE_CMAKE_LISTS_PATH: 'CMakeLists.txt' },
  ]

  for (const vars of buildContextVars) {
    await withEnv(
      {
        CI_PROJECT_URL: 'https://gitlab.com/acme/project',
        CI_COMMIT_SHA: 'abc123456789',
        FLUDE_API_TOKEN: 'test-token',
        FLUDE_API_BASE_URL: 'http://127.0.0.1:9999',
        FLUDE_LANGUAGE: 'cpp',
        FLUDE_PARSER_BACKEND: 'syntactic',
        ...vars,
      },
      async () => {
        await assert.rejects(
          () => run(),
          /The 'syntactic' parser backend cannot be combined with vcxproj, bazel, or cmake build-context inputs\./
        )
      }
    )
  }
})

test('GitLab run() submits FLUDE_PARSER_BACKEND and logs parser backend result', async () => {
  await withMockServer({}, async (baseUrl) => {
    const capture = captureConsole()
    try {
      await withEnv(
        {
          CI_PROJECT_URL: 'https://gitlab.com/acme/project',
          CI_COMMIT_SHA: 'abc123456789',
          FLUDE_API_TOKEN: 'test-token',
          FLUDE_API_BASE_URL: baseUrl,
          FLUDE_LANGUAGE: 'cpp',
          FLUDE_PARSER_BACKEND: 'syntactic',
          FLUDE_POLL_INTERVAL_SECONDS: '0',
        },
        async () => {
          await run()
        }
      )
      assert.ok(capture.logs.some((msg) => msg.includes('Parser backend: syntactic')))
    } finally {
      capture.restore()
      for (const file of readdirSync(process.cwd())) {
        if (file.endsWith('.zip') && /^[0-9a-fA-F-]+\.zip$/.test(file)) {
          try { unlinkSync(file) } catch {}
        }
      }
    }
  })
})
