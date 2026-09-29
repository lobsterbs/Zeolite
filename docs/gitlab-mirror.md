# GitLab mirror

GitHub Actions workflow `.github/workflows/mirror.yml` mirrors this repository to
<https://gitlab.com/lobsterbs/Zeolite> on every push, branch create, and branch delete.

Authentication: the workflow runs in the `lobster` GitHub environment and reads the
`GITLAB_PAT` environment secret. The token is a GitLab Personal Access Token belonging to
the lobsterbs account (Owner on the GitLab project) with at least `write_repository`
scope, so it can git-push over HTTPS.
