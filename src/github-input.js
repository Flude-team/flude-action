// Minimal re-implementation of the @actions/core input conventions, kept in-house
// so this action ships with zero third-party runtime dependencies.
//
// GitHub Actions exposes inputs as INPUT_<NAME> environment variables, where
// NAME is the input name uppercased with spaces (not hyphens) replaced by
// underscores - matching @actions/core's own getInput() behavior exactly.

export function getInput(name, { required = false } = {}) {
  const envName = `INPUT_${name.replace(/ /g, '_').toUpperCase()}`
  const value = (process.env[envName] || '').trim()
  if (required && value === '') {
    throw new Error(`Input required and not supplied: ${name}`)
  }
  return value
}

export function getBooleanInput(name, options) {
  const value = getInput(name, options).toLowerCase()
  if (['true', '1', 'yes'].includes(value)) return true
  if (['false', '0', 'no', ''].includes(value)) return false
  throw new Error(`Input does not look like a boolean: ${name} (got "${value}")`)
}
