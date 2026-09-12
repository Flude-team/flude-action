# Build from the REPO ROOT, not this directory:
#   docker build -f bitbucket/Dockerfile -t <account>/<repo>:<tag> .
#
# A Bitbucket Pipe bakes its entire runtime into a Docker image at build
# time (unlike gitlab/flude.gitlab-ci.yml, which git-clones this whole repo
# at job run time) - so the image needs both ../src/*.js (shared control-plane
# client) and ./src/*.js (Bitbucket-specific) copied in at build time. Docker
# COPY cannot reach outside its build context, and this repo's shared client
# lives one directory above bitbucket/ - hence root-as-context, not the
# default "build from this Dockerfile's own directory".
FROM node:20-alpine
WORKDIR /pipe
# package.json only for its "type": "module" - src/*.js and bitbucket/src/*.js
# use ESM import/export, which Node only honors with that declared (or a
# .mjs extension, which the existing shared files don't use).
COPY package.json ./package.json
COPY src ./src
COPY bitbucket/src ./bitbucket/src
ENTRYPOINT ["node", "/pipe/bitbucket/src/run.js"]
