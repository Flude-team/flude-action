import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildZip } from '../test-support/zip-builder.js'
import { listZipEntries, extractZipEntry } from '../src/zip-extract.js'

test('extractZipEntry round-trips a stored entry', () => {
  const zip = buildZip([{ name: 'report.sarif', content: '{"hello":"world"}', method: 'stored' }])
  const extracted = extractZipEntry(zip, 'report.sarif')
  assert.equal(extracted.toString('utf8'), '{"hello":"world"}')
})

test('extractZipEntry round-trips a deflate-compressed entry', () => {
  const content = 'x'.repeat(5000) // large + repetitive enough that deflate actually compresses it
  const zip = buildZip([{ name: 'report.sarif', content, method: 'deflate' }])
  const extracted = extractZipEntry(zip, 'report.sarif')
  assert.equal(extracted.toString('utf8'), content)
})

test('extractZipEntry finds the right entry among several', () => {
  const zip = buildZip([
    { name: 'README.md', content: 'not this one' },
    { name: 'report.sarif', content: '{"target":true}', method: 'deflate' },
    { name: 'other.json', content: '{}' },
  ])
  const extracted = extractZipEntry(zip, 'report.sarif')
  assert.equal(extracted.toString('utf8'), '{"target":true}')
})

test('listZipEntries lists every entry name', () => {
  const zip = buildZip([
    { name: 'a.txt', content: 'a' },
    { name: 'b.txt', content: 'b' },
  ])
  const names = listZipEntries(zip).map((entry) => entry.fileName)
  assert.deepEqual(names, ['a.txt', 'b.txt'])
})

test('extractZipEntry throws a clear error for a missing entry', () => {
  const zip = buildZip([{ name: 'other.json', content: '{}' }])
  assert.throws(() => extractZipEntry(zip, 'report.sarif'), /was not found in the archive/)
})

test('extractZipEntry throws a clear error for a non-ZIP buffer', () => {
  const notAZip = Buffer.from('this is definitely not a zip file')
  assert.throws(() => extractZipEntry(notAZip, 'report.sarif'), /Not a valid ZIP archive/)
})
