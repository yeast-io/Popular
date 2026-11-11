# Popular Agent

English | [简体中文](README.zh-CN.md)

Docker image connecting Popular to resource sites and local downloaders, with a Web management interface. Supports `linux/amd64` and `linux/arm64`.

- [Getting started](#getting-started)
- [Configuration](#configuration)
- [Persistence](#persistence)
- [Maintenance](#maintenance)

## Getting started

### Installation

```sh
docker pull ghcr.io/yeast-io/popular-agent:0.1.1-beta.1-647526a803ef
```

Docker selects the host architecture automatically. `edge` tracks the most recent successful publication.

### Quickstart

For a new installation, generate the management password and encryption master key:

```sh
docker run --rm \
  --volume popular-agent-secrets:/run/agent-secrets \
  ghcr.io/yeast-io/popular-agent:0.1.1-beta.1-647526a803ef \
  --init-secrets /run/agent-secrets
```

Start Agent:

```sh
docker run --name popular-agent --detach \
  --restart unless-stopped \
  --publish 127.0.0.1:1423:1423 \
  --env AGENT_WEB_ORIGIN=http://127.0.0.1:1423 \
  --volume popular-agent-data:/var/lib/popular-agent \
  --volume popular-agent-secrets:/run/agent-secrets:ro \
  ghcr.io/yeast-io/popular-agent:0.1.1-beta.1-647526a803ef
```

Read the management password:

```sh
docker exec popular-agent cat /run/agent-secrets/admin-password
```

Open <http://127.0.0.1:1423> and sign in with that password. Initialize secrets only once; reuse the existing volumes for restarts and upgrades.

### Docker Compose

Save [compose.yaml](compose.yaml) in an empty directory, then run:

```sh
docker compose --profile setup run --rm init-secrets
docker compose up -d agent
docker compose exec agent cat /run/agent-secrets/admin-password
```

The defaults use a published image and Docker-managed storage; no `.env` is required. For LAN/NAS access, create `.env` alongside `compose.yaml`:

```dotenv
AGENT_PUBLISH_ADDRESS=0.0.0.0
AGENT_WEB_ORIGIN=http://192.168.1.10:1423
```

Replace the IP with the Docker host address. CLI and Compose use different default volume names. Keep the original deployment method and project name for an existing installation.

## Automatic initialization and environment login (this source build)

This feature requires an image containing this change; the published tag above has not been updated. Build from the repository root:

```sh
docker build -f apps/helpers/agent/web/Dockerfile -t popular-agent-web:local .
```

Use the Compose file from this revision with the following `.env`:

```dotenv
AGENT_IMAGE=popular-agent-web:local
WEB_LOGIN_USER=admin
WEB_LOGIN_PASSWORD=replace-with-your-private-password
```

Run `docker compose up -d agent`; a manual `init-secrets` step is unnecessary. The secrets volume must be writable to generate and persist `master.key` on a new installation. Existing data without its key stops startup: restore the original key. Restarts and upgrades never replace it.

Set both login variables together: username 1–128 bytes without surrounding whitespace or control characters; password 8–4096 bytes. Environment login takes precedence over the password file and never writes or overwrites `admin-password`. Recreate the container to change these settings. When both values are empty or unset, file-based password-only login applies; an absent password file is generated automatically. Returning to file login without an existing password file requires a writable secrets volume. Existing complete secret files still support read-only mounts; to use automatic initialization with the older CLI example above, remove `:ro` from its secrets mount.

Keep both data and secrets volumes. Changing the environment password does not change the encryption key.

## Configuration

### Popular and downloader connections

1. Generate or copy an Agent Key in **Popular → Settings → Agent Key**.
2. Enter the Gateway HTTPS base address and Agent Key in **Agent → Settings → Gateway**, then select Connect.
3. Choose qBittorrent or Transmission in **Agent → Downloaders**, enter its address and credentials, then select Connect.
4. Configure, verify, and enable sites in **Agent → Resource sites**. M-Team: API Key; HDArea: Cookie + Passkey; HDWing: Cookie.
5. Enable Agent resource requests in **Popular → Settings → Resources**, then select the device and default site.

The Popular operator supplies the Gateway address. The management password authenticates Web sign-in; the Agent Key binds the account. Downloader addresses must be reachable from the container, such as `http://192.168.1.10:8080`; `127.0.0.1` refers to the Agent container itself.

### LAN access

Replace the published port and origin in the start command with:

```sh
--publish 1423:1423 \
--env AGENT_WEB_ORIGIN=http://192.168.1.10:1423
```

Replace the IP with the Docker host/NAS address. The browser address must match `AGENT_WEB_ORIGIN`; recreate the container to change environment variables. Use an HTTPS reverse proxy for public access.

### Environment variables

Set with `docker run --env`:

| Variable                    | Default                 | Description                                     |
| --------------------------- | ----------------------- | ----------------------------------------------- |
| `AGENT_WEB_ORIGIN`          | `http://127.0.0.1:1423` | Browser origin, including scheme and port       |
| `AGENT_SESSION_TTL_SECONDS` | `28800`                 | Session lifetime in seconds; range `60`–`86400` |
| `VERBOSE`                   | `false`                 | Diagnostic logging                              |
| `LOG_LEVEL`                 | `info`                  | Log level                                       |

Compose overrides are listed in [.env.example](.env.example). `AGENT_WEB_PORT` also updates the default local origin. Set `AGENT_WEB_ORIGIN` explicitly for LAN access or a reverse proxy.

## Persistence

| Mount path               | Contents                                                                    |
| ------------------------ | --------------------------------------------------------------------------- |
| `/var/lib/popular-agent` | Configuration, device identity, task journal, encrypted credentials         |
| `/run/agent-secrets`     | Encryption master key and optional management password; writable for automatic initialization |

The start command mounts the named volumes `popular-agent-data` and `popular-agent-secrets`. Stop the container before backing up both volumes together, and restore the matching data/key pair.

For Compose host-directory mounts, set `AGENT_DATA_MOUNT` and `AGENT_SECRETS_MOUNT` to absolute paths in `.env`. Create both directories with ownership `10001:10001` and mode `700` before starting. Existing volume data and keys must be migrated together.

## Maintenance

### Logs

```sh
docker logs --tail 100 --follow popular-agent
```

HTTP 403: match the browser address to `AGENT_WEB_ORIGIN`. Pull failure: check the tag, GHCR package visibility, and registry access.

### Upgrading

Pull the target version, then stop and remove the old container:

```sh
docker pull ghcr.io/yeast-io/popular-agent:0.1.1-beta.1-647526a803ef
docker stop popular-agent
docker rm popular-agent
```

Recreate the container with the start command above, replacing the image tag with the target version and retaining the original volumes. Do not reinitialize secrets or delete the volumes. For Compose deployments, update with `docker compose pull agent` and `docker compose up -d --no-build agent`.

### Shell access

```sh
docker exec -it popular-agent sh
```

[Advanced configuration](../../../../docs/agent-web.md) · [Image publication](../../../../docs/agent-image-release.md)
