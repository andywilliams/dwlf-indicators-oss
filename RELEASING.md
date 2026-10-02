# Releasing `@dwlf/indicators`

Every push to `main` runs `.github/workflows/release.yml`, which runs
`semantic-release`. Commits typed `fix:`, `feat:` or carrying a breaking-change
footer produce a version; anything else produces no release. There is no manual
publish step.

## The publish credential is not in this repository

This repo holds **no npm token**. Publishing is authorized by npm
[trusted publishing](https://docs.npmjs.com/trusted-publishers): GitHub mints a
short-lived OIDC token for the running workflow, and npm exchanges it for publish
rights on `@dwlf/indicators`. This is the same setup as `dwlf-charting-oss`
(`@dwlf/charting`) and `dwlf-mcp-server` (`@dwlf/mcp-server`).

Before editing anything in `.github/`:

- **The record on npm names this repository and the filename `release.yml`**, matched
  exactly, under `.github/workflows/`. Renaming the file, moving the job into a called
  workflow, or transferring the repository revokes publishing. Nothing fails until
  the next release, on `main`, after the merge. Update the record on npm in the same
  change.
- **`id-token: write` is part of the credential.** Without it the job cannot
  authenticate at all.
- **The npm plugin and the npm binary both have to support OIDC.**
  - `semantic-release` loads `@semantic-release/npm` from its own dependency tree,
    and only v13+ establishes the OIDC context.
  - That plugin shells out to `npm publish` with execa `preferLocal`. This repo has
    no local npm, so the binary that runs is the first `npm` on PATH. The workflow
    upgrades the runner's npm to 11.5.1, the first version that can publish over OIDC.
  - `.github/scripts/check-trusted-publishing.mjs` runs before `semantic-release` and
    refuses the release if either has drifted. Otherwise both failures show up as an
    authentication error at the registry, which reads like a credential problem.
- **The install runs with `--ignore-scripts`**, because every step in the job can
  exchange the ID token for publish rights.
- **A fork can never publish.** Workflows triggered from a fork cannot mint this
  repository's OIDC token.

## Configuring it (one-time)

On npmjs.com → `@dwlf/indicators` → *Settings* → *Trusted Publisher* → *GitHub Actions*:

| field | value |
|---|---|
| Organization or user | `andywilliams` |
| Repository | `dwlf-indicators-oss` |
| Workflow filename | `release.yml` |
| Environment | *(blank — this job declares no `environment:`)* |

Then, under *Settings* → *Publishing access*, choose **Require two-factor
authentication and disallow tokens**, and delete the old `NPM_TOKEN` repository
secret.
