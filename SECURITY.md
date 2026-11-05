# Security Policy

Flude Docs is a small client of the Flude SaaS: this repository holds the GitHub Action, the GitLab template and the
Bitbucket Pipe. It never bundles the Flude engine and runs no code from your repository. The service itself runs in
Google Cloud and is described in the product documentation.

## Reporting a vulnerability

Please report security problems **privately**, not in a public issue or a pull request.

- Use GitHub's private vulnerability reporting: open the **Security** tab of this repository and choose
  **Report a vulnerability** (available once the repository owner has enabled it).
- Or write to **unidocengine@gmail.com** with the subject `Flude security`.

Please include:

- what you found and where (this repository, the control-plane API, the website `app.flude.guide`);
- the steps to reproduce it, ideally with a minimal repository or request;
- what an attacker could do with it, in your opinion;
- whether you want to be credited in the fix notes.

Do not include real credentials. If a report needs a key to reproduce, create a fresh API key for a test account and
revoke it afterwards.

## What to expect

This is a small project run by one person, so these are targets, not guarantees:

- an acknowledgement within 3 working days;
- a first assessment (accepted, needs more information, or not a vulnerability) within 10 working days;
- a fix or a mitigation for a confirmed issue as soon as it can be done safely, and a note in the repository when it
  is public.

We ask that you give us a reasonable time to fix a problem before you disclose it, and that you do not access data of
other users, degrade the service, or run automated scans against it at a rate that affects other people.

## Supported versions

Only the current `main` branch and the action referenced as `Flude-team/flude-action@main` receive fixes. The service
is in an open test (Stage 1): public repositories on personal accounts only, filtered source of at most 5 MB.

## Scope

In scope: the code in this repository, the Flude control-plane API, and the documentation sites. Out of scope: social
engineering, physical attacks, denial of service by volume, findings that need a compromised account or machine of the
reporter, and issues in third-party services (GitHub, GitLab, Bitbucket, Google Cloud, Clerk) that should be reported to
their owners.
