import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
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
