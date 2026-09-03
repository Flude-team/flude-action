import { writeFile } from 'node:fs/promises'

export async function downloadResult(resultUrl, destPath) {
  const response = await fetch(resultUrl)
  if (!response.ok) {
    throw new Error(`Failed to download the result archive: HTTP ${response.status} from the signed result URL.`)
  }
  const buffer = Buffer.from(await response.arrayBuffer())
  await writeFile(destPath, buffer)
  return destPath
}

export function inferResultFilename(resultUrl) {
  try {
    const { pathname } = new URL(resultUrl)
    const base = pathname.split('/').filter(Boolean).pop()
    if (base && base.includes('.')) return base
  } catch {
    // Not a parseable URL - fall through to the default below.
  }
  return 'flude-result.zip'
}
