// Minimal helper for reading plain environment-variable-based CI inputs.
// Shared by gitlab/src/run.js and bitbucket/src/run.js: GitLab CI/CD
// variables and Bitbucket Pipe variables (declared in pipe.yml's
// `variables:` list) are both already plain environment variables with no
// naming convention to undo - unlike GitHub Actions, which exposes action
// inputs as INPUT_<NAME> env vars (see github-input.js). This only adds the
// required/default/boolean handling those two runners need.
// Promoted here from gitlab/src/gitlab-input.js (2026-09-03) once a second
// platform needed the identical 18 lines - a plain relative import is
// simpler than a second copy or a package.

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
