// Minimal helper for reading GitLab CI/CD variables. Unlike GitHub Actions
// (which exposes action inputs as INPUT_<NAME> env vars, see
// ../../src/github-input.js), GitLab CI/CD variables are already plain
// environment variables with no naming convention to undo - this only adds
// the required/default/boolean handling gitlab/src/run.js needs.

export function getEnv(name, { required = false, defaultValue = '' } = {}) {
  const value = (process.env[name] ?? '').trim()
  if (value === '') {
    if (required) {
      throw new Error(`Environment variable required and not supplied: ${name}`)
    }
    return defaultValue
  }
  return value
}

export function getBooleanEnv(name, options) {
  const value = getEnv(name, options).toLowerCase()
  if (['true', '1', 'yes'].includes(value)) return true
  if (['false', '0', 'no', ''].includes(value)) return false
  throw new Error(`Environment variable does not look like a boolean: ${name} (got "${value}")`)
}
