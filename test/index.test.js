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

test('language defaults to cpp: syntactic without a language input submits with language cpp and parser_backend syntactic', async () => {
  let capturedBody = null
  await withMockServer({ onJobSubmitted: (payload) => { capturedBody = payload } }, async (baseUrl) => {
    await withEnv(
      {
        GITHUB_REPOSITORY: 'acme/repo',
        GITHUB_SHA: 'abc123456789',
        'INPUT_API-TOKEN': 'test-token',
        'INPUT_API-BASE-URL': baseUrl,
        'INPUT_LANGUAGE': undefined,
        'INPUT_PARSER-BACKEND': 'syntactic',
        'INPUT_POLL-INTERVAL-SECONDS': '0',
        'INPUT_VCXPROJ-PATH': 'app.vcxproj',
      },
      async () => {
        await run()
      }
    )
    assert.ok(capturedBody)
    assert.equal(capturedBody.config.language, 'cpp')
    assert.equal(capturedBody.config.parser_backend, 'syntactic')
    assert.equal(capturedBody.config.vcxproj_path, 'app.vcxproj')
  })
})

test('run accepts syntactic parser-backend with build context inputs and forwards them in request body', async () => {
  const buildContextCases = [
    { input: { 'INPUT_VCXPROJ-PATH': 'app.vcxproj' }, field: 'vcxproj_path', expected: 'app.vcxproj' },
    { input: { 'INPUT_VCXPROJ-CONFIGURATION': 'Release' }, field: 'vcxproj_configuration', expected: 'Release' },
    { input: { 'INPUT_VCXPROJ-PLATFORM': 'x64' }, field: 'vcxproj_platform', expected: 'x64' },
    { input: { 'INPUT_BAZEL-BUILD-PATH': 'BUILD' }, field: 'bazel_build_path', expected: 'BUILD' },
    { input: { 'INPUT_BAZEL-TARGET-NAME': 'lib' }, field: 'bazel_target_name', expected: 'lib' },
    { input: { 'INPUT_CMAKE-LISTS-PATH': 'CMakeLists.txt' }, field: 'cmake_lists_path', expected: 'CMakeLists.txt' },
  ]

  for (const { input, field, expected } of buildContextCases) {
    let capturedBody = null
    await withMockServer({ onJobSubmitted: (payload) => { capturedBody = payload } }, async (baseUrl) => {
      await withEnv(
        {
          GITHUB_REPOSITORY: 'acme/repo',
          GITHUB_SHA: 'abc123456789',
          'INPUT_API-TOKEN': 'test-token',
          'INPUT_API-BASE-URL': baseUrl,
          'INPUT_LANGUAGE': 'cpp',
          'INPUT_PARSER-BACKEND': 'syntactic',
          'INPUT_POLL-INTERVAL-SECONDS': '0',
          ...input,
        },
        async () => {
          await run()
        }
      )
      assert.ok(capturedBody)
      assert.equal(capturedBody.config.parser_backend, 'syntactic')
      assert.equal(capturedBody.config[field], expected)
    })
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

