import { inflateRawSync } from 'node:zlib'

// A minimal, read-only ZIP reader (stored + deflate only, no Zip64, no
// encryption) - just enough to pull one named entry out of a small result
// archive without pulling in a third-party dependency. Does not verify
// CRC-32 checksums; that's an integrity check, not something needed to
// locate and decompress an entry.
//
// The archive format itself is an unconfirmed assumption (DEL-B23 hasn't
// shipped yet) - see README.md and src/sarif-report.js.

const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50
const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50
const END_OF_CENTRAL_DIRECTORY_MIN_SIZE = 22
const MAX_ZIP_COMMENT_SIZE = 0xffff

function findEndOfCentralDirectory(buffer) {
  const minOffset = Math.max(0, buffer.length - END_OF_CENTRAL_DIRECTORY_MIN_SIZE - MAX_ZIP_COMMENT_SIZE)
  for (let offset = buffer.length - END_OF_CENTRAL_DIRECTORY_MIN_SIZE; offset >= minOffset; offset -= 1) {
    if (buffer.readUInt32LE(offset) === END_OF_CENTRAL_DIRECTORY_SIGNATURE) {
      return offset
    }
  }
  throw new Error('Not a valid ZIP archive: end-of-central-directory record not found.')
}

export function listZipEntries(buffer) {
  const eocdOffset = findEndOfCentralDirectory(buffer)
  const entryCount = buffer.readUInt16LE(eocdOffset + 10)
  let offset = buffer.readUInt32LE(eocdOffset + 16)

  const entries = []
  for (let i = 0; i < entryCount; i += 1) {
    if (buffer.readUInt32LE(offset) !== CENTRAL_DIRECTORY_SIGNATURE) {
      throw new Error(`Not a valid ZIP archive: expected a central directory entry at offset ${offset}.`)
    }
    const compressionMethod = buffer.readUInt16LE(offset + 10)
    const compressedSize = buffer.readUInt32LE(offset + 20)
    const fileNameLength = buffer.readUInt16LE(offset + 28)
    const extraFieldLength = buffer.readUInt16LE(offset + 30)
    const fileCommentLength = buffer.readUInt16LE(offset + 32)
    const localHeaderOffset = buffer.readUInt32LE(offset + 42)
    const fileName = buffer.toString('utf8', offset + 46, offset + 46 + fileNameLength)

    entries.push({ fileName, compressionMethod, compressedSize, localHeaderOffset })
    offset += 46 + fileNameLength + extraFieldLength + fileCommentLength
  }
  return entries
}

export function extractZipEntry(buffer, fileName) {
  const entries = listZipEntries(buffer)
  const entry = entries.find((candidate) => candidate.fileName === fileName)
  if (!entry) {
    const present = entries.map((candidate) => candidate.fileName).join(', ') || '(none)'
    throw new Error(`"${fileName}" was not found in the archive. Entries present: ${present}`)
  }

  const localOffset = entry.localHeaderOffset
  if (buffer.readUInt32LE(localOffset) !== LOCAL_FILE_HEADER_SIGNATURE) {
    throw new Error(`Not a valid ZIP archive: expected a local file header at offset ${localOffset}.`)
  }
  const localFileNameLength = buffer.readUInt16LE(localOffset + 26)
  const localExtraFieldLength = buffer.readUInt16LE(localOffset + 28)
  const dataStart = localOffset + 30 + localFileNameLength + localExtraFieldLength
  const compressedData = buffer.subarray(dataStart, dataStart + entry.compressedSize)

  if (entry.compressionMethod === 0) {
    return Buffer.from(compressedData)
  }
  if (entry.compressionMethod === 8) {
    return inflateRawSync(compressedData)
  }
  throw new Error(`Unsupported ZIP compression method (${entry.compressionMethod}) for entry "${fileName}".`)
}
