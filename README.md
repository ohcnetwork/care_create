# @ohcn/care

A CLI to bootstrap and manage a full local [CARE](https://github.com/ohcnetwork/care) development environment in a single command.

```bash
npx @ohcn/care create
```

## Commands

| Command | Aliases | Description |
| --- | --- | --- |
| `care create [directory]` | | Clone and bootstrap a full local CARE setup. |
| `care run [directory]` | `start` | Install missing deps and start the backend, frontend, and plug dev servers. |
| `care sync [directory]` | `update` | Pull latest changes for all repos, update dependencies, and run migrations. |
| `care db populate [directory]` | `seed` | Load dummy fixture data into the database. |
| `care db clear [directory]` | `reset` | Remove all data from the database. |
| `care stop [directory]` | `down` | Stop running services and clean up. |

`[directory]` defaults to the current directory for every command except `create`. Each command (other than `create`) reads `.care-create.json` to know whether the setup is Docker or native and acts accordingly.

## `care create`

```bash
care create              # or: care create ./care-platform
```

1. Prompts for a target directory and runtime (Docker Compose or native).
2. For the **native** runtime, prompts for the `DATABASE_URL` and `REDIS_URL` (with sensible localhost defaults) so you can point at your own Postgres/Redis; `CELERY_BROKER_URL` is derived from the Redis URL.
3. Lets you pick backend and frontend plugs from a bundled registry ([`src/plugs.json`](src/plugs.json)).
4. Prompts only for the environment variables each selected plug marks as `prompt`; everything else uses its `default`.
5. Asks whether to populate the database with dummy data.
6. Clones `care` and `care_fe` (plus the selected plug repos) at the branches defined in the registry.
7. Configures backend plugs via `ADDITIONAL_PLUGS` (their env lands in each plug's `configs`), and writes `care_fe/.env.local`. For Docker, it also pins a unique `COMPOSE_PROJECT_NAME` in `care/.env`, so the setup's containers and volumes never collide with another `care` checkout's (Compose would otherwise name them all `care`); manual `docker compose`/`make` commands run in `care/` pick it up too.
8. Builds and starts the services, makes backend plugs editable, runs migrations, syncs permissions/valuesets, optionally loads fixtures, and registers frontend plugin configs.
9. Writes a `.care-create.json` manifest so the other commands know the layout.
10. **ABDM plug (Docker runtime):** writes a `docker-compose.tunnel.yaml` override that adds a [`cloudflare/cloudflared`](https://hub.docker.com/r/cloudflare/cloudflared) service exposing the backend through a public quick tunnel. That service shares the stack's lifecycle (started by `up`, removed by `down`), so no `cloudflared` binary is needed on the host. Once it's up, the CLI reads the public URL from the tunnel container's logs, sets `BACKEND_DOMAIN` to it, recreates the backend, and registers the ABDM callback (session + update-bridge APIs). For the native runtime this is deferred to `care run` (the native backend isn't started by `create`).

**Re-running `create` is safe (resumable/hybrid).** Existing clones are reused and fast-forwarded (`git pull --ff-only`), anything missing is cloned, and configuration + bring-up run again. Local changes that block a fast-forward are reported as warnings rather than aborting the run.

### Options

| Flag | Description |
| --- | --- |
| `--branch <branch>` | Override the branch used for the core `care` and `care_fe` repos. |
| `--skip-install` | Clone and configure only; skip building and starting services. |

## `care run`

Run from the target directory (or pass it as an argument) to launch every dev server (`start` is an alias):

```bash
care run              # or: care run ./care-platform
```

- Brings up the backend (docker `up -d`, or `runserver` for native).
- Starts the `care_fe` dev server (http://localhost:4000).
- Starts each selected frontend plug's dev server (e.g. http://localhost:5173).
- Installs npm dependencies for any target missing `node_modules`.
- Each server's dev command comes from `devCommand` in the registry/manifest (defaults to `npm run dev`), and output is streamed with a colored `[name]` prefix.
- **ABDM plug:** exposes the backend through a public cloudflare quick tunnel and repoints the ABDM gateway's callback (gateway session API followed by the update-bridge API), writing the public URL to `BACKEND_DOMAIN`.
  - **Docker:** the tunnel runs as a `cloudflared` compose service (added by `docker-compose.tunnel.yaml`), so it comes up with the stack and is torn down by `care stop`—no host binary required.
  - **Native:** the tunnel runs as a host [`cloudflared`](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) subprocess that stays alive with the dev servers (requires the `cloudflared` binary on your `PATH`).
  - If credentials aren't set (or, for native, `cloudflared` is missing) the step is skipped with a warning.

Press `Ctrl+C` to stop the dev servers.

## `care sync`

Update an existing setup end-to-end:

```bash
care sync              # or: care update ./care-platform
```

- `git pull --ff-only` on every repo (core `care`, `care_fe`, and each plug). Repos with local changes are skipped with a warning; the rest continue.
- Updates backend dependencies and re-installs plugs editable (docker rebuilds with `--build`; native runs `pipenv install`).
- Runs migrations and syncs permissions/valuesets.
- Runs `npm install` for the frontend and each frontend plug.

`sync` is non-destructive — it never re-seeds or wipes data.

## `care db`

Manage the database for an existing setup. The runtime (Docker vs native) is detected from the manifest.

```bash
care db populate       # load dummy fixture data (alias: care db seed)
care db clear          # flush all rows, then re-sync permissions/valuesets (alias: care db reset)
care db clear --hard   # drop and recreate the database, then migrate + re-sync
```

## `care stop`

Stop services and clean up (`down` is an alias):

```bash
care stop              # stop containers / dev servers
care stop --volumes    # docker only: also remove volumes (wipes DB + storage)
```

- **Docker:** runs `docker compose down` (add `-v`/`--volumes` to wipe data).
- **Native:** frees the known dev-server ports (backend `9000`, frontend `4000`, and each frontend plug's port).

## Requirements

- Node.js >= 18
- Git
- Docker + Docker Compose (for the Docker runtime), or pipenv + local Postgres/Redis (for native)
- Native runtime only: a C toolchain and **GMP** are required for plugs that build `fastecdsa` from source (e.g. `abdm`). The CLI auto-detects GMP and warns with install hints if it's missing — macOS: `brew install gmp`; Debian/Ubuntu: `sudo apt install libgmp-dev`; Fedora/RHEL: `sudo dnf install gmp-devel`. On Windows, use the Docker runtime (or WSL) for such plugs.
- `abdm` plug on the **native** runtime only: the [`cloudflared`](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) binary on your `PATH`, used to expose the backend through a public tunnel and register the ABDM callback URL (skipped with a warning if absent). On the Docker runtime the tunnel runs as a `cloudflared` container, so no host binary is needed.


## The plugs registry

Every plug — backend or frontend — is described in [`src/plugs.json`](src/plugs.json) with its repo, branch, and env schema. Each env entry supports:

- `default` — value used when not prompted.
- `prompt` — ask the user for this value during setup.
- `secret` — mask the input.
- `description` — shown in the prompt.

To add a plug, add an entry under `backend` or `frontend`.

## Development

Written in TypeScript, bundled with tsup.

```bash
npm install
npm run dev -- create --help   # run from source with tsx
npm run typecheck              # tsc --noEmit
npm run build                  # emit dist/cli.js
node dist/cli.js create        # run the built CLI

# try it as the `care` binary
npm link
care create --skip-install
```
