import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, readFileSync, unlinkSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readCompileCommandsContent } from '../src/index.js'

// DEL-B75: compile_commands.json is conventionally .gitignore'd -- passing only its path
// through to the control-plane never actually reached job_runner.py's independent clone.
// readCompileCommandsContent() reads the file locally (this step runs right after the client's
// own build step generated it) so its content can be sent instead.

test('readCompileCommandsContent returns undefined when no path is given', () => {
  assert.equal(readCompileCommandsContent(''), undefined)
  assert.equal(readCompileCommandsContent(undefined), undefined)
})

test('readCompileCommandsContent returns the file content when the path resolves', () => {
  const dir = mkdtempSync(join(tmpdir(), 'flude-action-test-'))
  try {
    const path = join(dir, 'compile_commands.json')
    writeFileSync(path, '[{"file":"a.cpp"}]', 'utf8')
    assert.equal(readCompileCommandsContent(path), '[{"file":"a.cpp"}]')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('readCompileCommandsContent returns undefined (not throws) when the file is missing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'flude-action-test-'))
  try {
    const path = join(dir, 'does-not-exist.json')
    assert.doesNotThrow(() => readCompileCommandsContent(path))
    assert.equal(readCompileCommandsContent(path), undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('readCompileCommandsContent returns undefined for an oversized file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'flude-action-test-'))
  try {
    const path = join(dir, 'compile_commands.json')
    // One byte over the 900 KiB cap.
    writeFileSync(path, 'x'.repeat(900 * 1024 + 1), 'utf8')
    assert.equal(readCompileCommandsContent(path), undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

import { run } from '../src/index.js'
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

test('run throws fail-fast error when parser-backend is invalid', async () => {
  await withEnv(
    {
      GITHUB_REPOSITORY: 'acme/repo',
      GITHUB_SHA: 'abc123456789',
      'INPUT_API-TOKEN': 'test-token',
      'INPUT_API-BASE-URL': 'http://127.0.0.1:9999',
      'INPUT_PARSER-BACKEND': 'custom_backend',
    },
    async () => {
      await assert.rejects(
        () => run(),
        /Invalid 'parser-backend' input: "custom_backend" \(expected 'doxygen' or 'syntactic'\)\./
      )
    }
  )
})

test('run throws fail-fast error when parser-backend is syntactic but language is not cpp', async () => {
  await withEnv(
    {
      GITHUB_REPOSITORY: 'acme/repo',
      GITHUB_SHA: 'abc123456789',
      'INPUT_API-TOKEN': 'test-token',
      'INPUT_API-BASE-URL': 'http://127.0.0.1:9999',
      'INPUT_LANGUAGE': 'python',
      'INPUT_PARSER-BACKEND': 'syntactic',
    },
    async () => {
      await assert.rejects(
        () => run(),
        /The 'syntactic' parser backend is only supported for C\+\+ \(language: cpp\), got "python"\./
      )
    }
  )
})

test('run throws fail-fast error when parser-backend is syntactic and build context inputs are provided', async () => {
  const buildContextCases = [
    { 'INPUT_VCXPROJ-PATH': 'app.vcxproj' },
    { 'INPUT_VCXPROJ-CONFIGURATION': 'Release' },
    { 'INPUT_VCXPROJ-PLATFORM': 'x64' },
    { 'INPUT_BAZEL-BUILD-PATH': 'BUILD' },
    { 'INPUT_BAZEL-TARGET-NAME': 'lib' },
    { 'INPUT_CMAKE-LISTS-PATH': 'CMakeLists.txt' },
  ]

  for (const buildCase of buildContextCases) {
    await withEnv(
      {
        GITHUB_REPOSITORY: 'acme/repo',
        GITHUB_SHA: 'abc123456789',
        'INPUT_API-TOKEN': 'test-token',
        'INPUT_API-BASE-URL': 'http://127.0.0.1:9999',
        'INPUT_LANGUAGE': 'cpp',
        'INPUT_PARSER-BACKEND': 'syntactic',
        ...buildCase,
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

test('run sets parser-backend output when reported by control-plane and omits it when absent', async () => {
  await withMockServer({}, async (baseUrl) => {
    const dir = mkdtempSync(join(tmpdir(), 'flude-output-test-'))
    const outputFilePath = join(dir, 'github_output.txt')
    try {
      // 1. Output set when present
      writeFileSync(outputFilePath, '', 'utf8')
      await withEnv(
        {
          GITHUB_REPOSITORY: 'acme/repo',
          GITHUB_SHA: 'abc123456789',
          GITHUB_OUTPUT: outputFilePath,
          'INPUT_API-TOKEN': 'test-token',
          'INPUT_API-BASE-URL': baseUrl,
          'INPUT_LANGUAGE': 'cpp',
          'INPUT_PARSER-BACKEND': 'syntactic',
          'INPUT_POLL-INTERVAL-SECONDS': '0',
        },
        async () => {
          await run()
        }
      )

      const outputContent1 = readFileSync(outputFilePath, 'utf8')
      assert.match(outputContent1, /status<<flude_[^\n]+\nsucceeded\n/)
      assert.match(outputContent1, /parser-backend<<flude_[^\n]+\nsyntactic\n/)

      // 2. Output NOT set when absent from control-plane response
      writeFileSync(outputFilePath, '', 'utf8')
      await withEnv(
        {
          GITHUB_REPOSITORY: 'acme/scenario-no-parser-backend',
          GITHUB_SHA: 'abc123456789',
          GITHUB_OUTPUT: outputFilePath,
          'INPUT_API-TOKEN': 'test-token',
          'INPUT_API-BASE-URL': baseUrl,
          'INPUT_LANGUAGE': 'cpp',
          'INPUT_POLL-INTERVAL-SECONDS': '0',
        },
        async () => {
          await run()
        }
      )

      const outputContent2 = readFileSync(outputFilePath, 'utf8')
      assert.match(outputContent2, /status<<flude_[^\n]+\nsucceeded\n/)
      assert.doesNotMatch(outputContent2, /parser-backend/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
      for (const file of readdirSync(process.cwd())) {
        if (file.endsWith('.zip') && /^[0-9a-fA-F-]+\.zip$/.test(file)) {
          try { unlinkSync(file) } catch {}
        }
      }
    }
  })
})

