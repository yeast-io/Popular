# Popular Agent Web / Docker

[简体中文](README.md) | English

Run Agent on a computer, NAS, or server and configure your sites and downloader in a browser. The container can keep handling requests and downloads when you close the management page or use Popular on your phone; it must remain running.

## Before you start

Install Docker and Docker Compose v2 (`docker compose version` must work). Git, Node.js, and Rust are not required. Images support `linux/amd64` and `linux/arm64`: use Docker Desktop with Linux containers on macOS/Windows, Docker Engine on Linux, or a Synology model that supports Container Manager/Docker. This image does not support 32-bit ARM or MIPS.

The example pins `0.1.1-beta.1-647526a803ef`; Docker selects the matching architecture automatically. `edge` follows the most recent successful publication. There is currently no `latest` tag.

## Quick start

### 1. Save the Compose file

Create a `popular-agent` folder and save the following as **`compose.yaml`** inside it. This configuration pulls a prebuilt image; no source checkout or local compilation is needed.

```yaml
services:
  agent:
    image: ${AGENT_IMAGE:-ghcr.io/yeast-io/popular-agent:0.1.1-beta.1-647526a803ef}
    ports:
      - '${AGENT_PUBLISH_ADDRESS:-127.0.0.1}:${AGENT_WEB_PORT:-1423}:1423'
    environment:
      AGENT_WEB_ORIGIN: ${AGENT_WEB_ORIGIN:-http://127.0.0.1:1423}
      AGENT_SESSION_TTL_SECONDS: ${AGENT_SESSION_TTL_SECONDS:-28800}
      VERBOSE: ${VERBOSE:-false}
      LOG_LEVEL: ${LOG_LEVEL:-info}
    volumes:
      - agent-data:/var/lib/popular-agent
      - agent-secrets:/run/agent-secrets:ro
    read_only: true
    tmpfs:
      - /tmp:rw,noexec,nosuid,size=16m
    cap_drop: [ALL]
    security_opt: [no-new-privileges:true]
    pids_limit: 128
    stop_grace_period: 15s
    restart: unless-stopped
  init-secrets:
    profiles: [setup]
    image: ${AGENT_IMAGE:-ghcr.io/yeast-io/popular-agent:0.1.1-beta.1-647526a803ef}
    command: ['--init-secrets', '/run/agent-secrets']
    volumes:
      - agent-secrets:/run/agent-secrets
    read_only: true
    cap_drop: [ALL]
    security_opt: [no-new-privileges:true]
volumes:
  agent-data:
  agent-secrets:
```

### 2. Choose the browser address

**Access from the Docker host only:** keep the defaults and open `http://127.0.0.1:1423`.

**Access from a LAN computer, phone, or NAS:** create **`.env`** in the same folder:

```dotenv
AGENT_PUBLISH_ADDRESS=0.0.0.0
AGENT_WEB_PORT=1423
AGENT_WEB_ORIGIN=http://192.168.1.10:1423
```

Replace `192.168.1.10` with the LAN IP of the Docker host/NAS. Always use that exact browser address; do not interchange `localhost`, IPs, hostnames, HTTP/HTTPS, or ports. Make sure the file is not saved as `.env.txt`.

If port 1423 is occupied, change both `AGENT_WEB_PORT` and the port in `AGENT_WEB_ORIGIN` to the same available port. Leave the container port unchanged.

### 3. Pull, initialize, and start

Open a terminal in the folder containing `compose.yaml` and run these commands in order:

```sh
docker compose pull agent
docker compose --profile setup run --rm --no-deps init-secrets
docker compose up -d --no-build agent
```

Run `docker compose ps` to check the service. If health is still `starting`, check again after 30 seconds.

**Run `init-secrets` only once, for a new installation.** It generates the management password and encryption master key and refuses to overwrite existing keys. For an existing installation, start the service without initializing again.

If pulling returns `unauthorized` / `denied`, check that the [GHCR package](https://github.com/orgs/yeast-io/packages/container/package/popular-agent) is Public. A private package requires an authorized `ghcr.io` login. Do not put registry credentials in Compose or `.env`.

### 4. Read the password and sign in

```sh
docker compose exec agent cat /run/agent-secrets/admin-password
```

Enter the printed password on the management page. The default address is `http://127.0.0.1:1423`; LAN deployments use the address from step 2. The login page supports English and Chinese.

This is the **local Agent management password**, not your Popular account password or Agent Key. Read it only in your own terminal and do not share the output.

### 5. Complete the initial configuration

Follow the order below, then select a resource in Popular and add one download. Success means Agent is connected/bound, downloader validation succeeds, the site is verified and enabled, and the task appears in your configured downloader.

## Configure Agent in the browser

| Order | Location                       | Action                                                                                                                                                                                       |
| ----- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | Popular → Settings → Agent Key | Generate or copy your Agent Key. The Popular operator supplies the Gateway address.                                                                                                          |
| 2     | Agent → Settings → Gateway     | Enter the Gateway HTTPS base address and Agent Key, then select Connect. The first connection binds the device. Do not substitute the Popular website address or append `/client/v1/socket`. |
| 3     | Agent → Downloaders            | Choose qBittorrent or Transmission, enter the address and authentication credentials, then select Connect. Successful validation saves the configuration.                                    |
| 4     | Agent → Resource sites         | Enter each site's address and credentials, verify and save, and confirm it is enabled.                                                                                                       |
| 5     | Popular → Settings → Resources | Enable Agent resource requests, select this Agent, and choose participating sites and a default site.                                                                                        |

The Popular backend and Gateway must support Agent resource mode. If an older deployment does not show the switch, its operator must upgrade it. Manage site/downloader configuration in the local Agent; there is no need to duplicate those credentials in the cloud. Agent mode fails explicitly when the selected device is offline and does not fall back to cloud credentials.

### Which password or key goes where?

| Credential                  | Purpose                                              | Where to enter it                    |
| --------------------------- | ---------------------------------------------------- | ------------------------------------ |
| Management password         | Sign in to this Agent's management interface         | Agent login page                     |
| Agent Key                   | Authorize this Agent to bind to your Popular account | Agent → Settings → Gateway           |
| Site/downloader credentials | Access PT sites and connect to your downloader       | Agent → Resource sites / Downloaders |

### Site credentials

| Site   | Required credentials        |
| ------ | --------------------------- |
| M-Team | API Key                     |
| HDArea | Cookie + Passkey            |
| HDWing | Cookie; no separate Passkey |

Use the site's current valid HTTPS address. Update expired Cookies in Agent and verify again. Agent keeps credentials in its local encrypted store and prepares the actual torrent URL locally before submitting it to the downloader.

### Downloader addresses: use the container's point of view

| Downloader location                    | Example address                                           |
| -------------------------------------- | --------------------------------------------------------- |
| qBittorrent on a NAS/LAN device        | `http://192.168.1.10:8080`                                |
| Transmission on a NAS/LAN device       | `http://192.168.1.10:9091/transmission/rpc`               |
| qBittorrent on the Docker Desktop host | `http://host.docker.internal:8080`, with your actual port |

**Do not use `127.0.0.1` for a downloader outside the container:** it points to the Agent container itself. On Linux Docker Engine, use a reachable host LAN address; do not assume `host.docker.internal` exists by default. Other containers' service names work only when Agent joins the same Docker network.

### Synology Container Manager

Create a project in Container Manager and save the Compose content in its project directory. Configure `.env` for the NAS IP before starting the service. `init-secrets` is a one-time service under the `setup` profile and **must not be skipped**. If the GUI cannot run profiles, SSH into the NAS and run quick-start step 3 from that project directory. Keep the same project name and volumes to avoid creating a separate empty installation.

## Everyday commands

Run from the original Compose folder:

```sh
# Show service and health status
docker compose ps

# Show recent logs
docker compose logs --tail=100 agent

# Apply changes to .env
docker compose up -d --no-build agent

# Stop without deleting configuration or keys
docker compose stop agent

# Start again
docker compose up -d --no-build agent
```

Normal logs redact credentials, but inspect and remove private addresses/identity information before sharing logs. Set `VERBOSE=true` in `.env` only while troubleshooting; restore `false` and apply the configuration afterwards.

### Upgrade or roll back

Back up both volumes, then set `AGENT_IMAGE` in `.env` to the desired pinned version, or use `edge`:

```dotenv
AGENT_IMAGE=ghcr.io/yeast-io/popular-agent:edge
```

```sh
docker compose pull agent
docker compose up -d --no-build agent
```

**Do not run `init-secrets` during an upgrade.** Reuse the original Compose project and volumes. To roll back, set `AGENT_IMAGE` to your previous pinned tag and repeat the two commands above; check that release's notes for data-format compatibility across versions.

### Data and backups

| Volume          | Contents                                                                                |
| --------------- | --------------------------------------------------------------------------------------- |
| `agent-data`    | Configuration, device identity, task journal, and encrypted site/downloader credentials |
| `agent-secrets` | Encryption master key and management password                                           |

Actual volume names normally include the Compose project prefix. Stop Agent, then use your Docker/NAS backup tooling to **back up both volumes together**. Restore the matching pair before starting Agent. The data volume alone cannot decrypt credentials. Do not run `docker compose down -v` or remove these volumes unless you intend to erase the installation.

## Troubleshooting

| Symptom                                             | What to check                                                                                                                                                            |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `no matching manifest`                              | Docker must run Linux containers on amd64 or arm64. Prefer the tag without an architecture suffix.                                                                       |
| `unauthorized` / `denied`                           | Check package visibility and tag existence. A private package requires a registry login with read access.                                                                |
| Page unavailable or HTTP 403                        | Check container health, port publishing, and firewall rules. The browser address must exactly match `AGENT_WEB_ORIGIN`. Reapply configuration after editing `.env`.      |
| Initialization fails / startup fails on a key error | Read the logs. Do not initialize existing volumes again. Mount the original data and secrets volumes together; do not delete the old key as a workaround.                |
| Gateway/downloader/site validation fails            | Check the respective address, credential validity, HTTPS certificate, and connectivity from the container. Enter credentials again after changing the downloader target. |

The default published address is host loopback only. LAN HTTP does not encrypt sign-in or configuration requests; use it only on a trusted network. Use a trusted VPN or HTTPS reverse proxy across untrusted networks, and do not publish the plain HTTP management port directly to the Internet. A reverse proxy must preserve the original Host/Origin and disable SSE buffering.

## More information

[Architecture and advanced configuration](../../../../docs/agent-web.md) · [Agent resource mode](../../../../docs/agent-resource-routing.md) · [Image tags and publishing](../../../../docs/agent-image-release.md) · [Validation scope](../VALIDATION.md)
