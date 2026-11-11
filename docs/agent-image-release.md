# Agent Docker publication

The `Publish Agent Docker` GitHub Actions workflow builds and publishes the standalone Web/Docker Agent to `ghcr.io/yeast-io/popular-agent`. It does not deploy API, Web or Gateway services and does not produce desktop installers.

## Run a build

Push the intended source commit to GitHub, then dispatch `.github/workflows/publish-agent-image.yml` on that ref. No Docker Hub account or separate registry token is needed: the workflow uses its repository-scoped `GITHUB_TOKEN` with `packages: write`.

```sh
gh workflow run publish-agent-image.yml --ref main
```

Native `ubuntu-24.04` and `ubuntu-24.04-arm` runners build `linux/amd64` and `linux/arm64` respectively. Each image is loaded locally and checked for the expected architecture. The existing isolated Docker lifecycle test verifies non-root/read-only operation, health, password authentication, encrypted volume persistence, restart and logout. Only a successful image is pushed under its commit/architecture staging tag. The common version and `edge` tags are published only after both architectures pass.

Tags:

- `<Agent Web package version>-<12-character commit>`: multi-platform image.
- The same tag plus `-amd64` or `-arm64`: explicitly selected architecture.
- `edge`: the latest successful manually published multi-platform build.
- `sha-<full commit>-amd64` / `sha-<full commit>-arm64`: staging images for the verified individual builds.

The manifest job checks that the resulting index contains exactly Linux amd64 and arm64. Image labels identify the source repository and full commit. The package version remains unchanged by a Docker publication, so a desktop release is not triggered by a version bump. Neither a push nor a queued workflow proves successful publication; inspect both build jobs and the final manifest job.

## Pull and run

```sh
docker pull ghcr.io/yeast-io/popular-agent:edge
export AGENT_IMAGE=ghcr.io/yeast-io/popular-agent:edge
docker compose -f apps/helpers/agent/web/compose.yaml --profile setup run --rm init-secrets
docker compose -f apps/helpers/agent/web/compose.yaml up -d --no-build agent
```

Set `AGENT_WEB_ORIGIN`, bind address and port for the intended local/LAN deployment as described in [Agent Web](agent-web.md). Prefer the commit-qualified version tag when pinning an installation. Both the initializer and service use `AGENT_IMAGE`; leaving it unset retains the existing local-build behavior.

New GHCR packages may initially be private even for a public source repository. Check package visibility and anonymous pull access after the first successful publication. If private access is intentional, users need their own authorized registry login. Never bake a registry token, site credential, downloader password, master key or initialized data volume into the image. The Dockerfile-specific context allowlist excludes local secrets and generated data.
