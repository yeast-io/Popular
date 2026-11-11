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

Alternatively, use [compose.yaml](compose.yaml). Set `AGENT_IMAGE=ghcr.io/yeast-io/popular-agent:0.1.1-beta.1-647526a803ef` in an adjacent `.env` file, then run:

```sh
docker compose pull agent
docker compose --profile setup run --rm --no-deps init-secrets
docker compose up -d --no-build agent
docker compose exec agent cat /run/agent-secrets/admin-password
```

CLI and Compose use different default volume names. Keep the original deployment method and project name for an existing installation.

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

Compose also supports `AGENT_IMAGE`, `AGENT_PUBLISH_ADDRESS`, and `AGENT_WEB_PORT`. For LAN access, set `AGENT_PUBLISH_ADDRESS=0.0.0.0` and update `AGENT_WEB_ORIGIN` to match.

## Persistence

| Mount path               | Contents                                                                    |
| ------------------------ | --------------------------------------------------------------------------- |
| `/var/lib/popular-agent` | Configuration, device identity, task journal, encrypted credentials         |
| `/run/agent-secrets`     | Encryption master key and management password; mounted read-only at runtime |

The start command mounts the named volumes `popular-agent-data` and `popular-agent-secrets`. Stop the container before backing up both volumes together, and restore the matching data/key pair.

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
