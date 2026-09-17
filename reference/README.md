# CARE reference environment

Runs CARE with the [care-abdm](https://github.com/ohcnetwork/care-abdm) plug using only Docker. Every run builds from source on GitHub:

| Part | Source |
| --- | --- |
| CARE backend | care `develop`, built with care's own `docker/prod.Dockerfile` |
| CARE frontend | care_fe `develop` |
| ABDM plug | care-abdm `2df14d7` (`backend/` and `frontend/`) |

care-abdm is pinned because its newer commits need CARE migrations that aren't on care `develop` yet. The commit appears twice in `compose.yaml`, in the api and web build args.

## Run

Needs Docker with Compose 2.37 or later (tested with Docker Desktop 28). Pass your ABDM sandbox client ID and secret.

macOS:

```bash
ABDM_CLIENT_ID='YOUR_CLIENT_ID' ABDM_CLIENT_SECRET='YOUR_CLIENT_SECRET' docker compose -f https://github.com/ohcnetwork/care_create.git#reference:reference/compose.yaml up --build --wait --yes && open http://localhost:4400
```

Linux:

```bash
ABDM_CLIENT_ID='YOUR_CLIENT_ID' ABDM_CLIENT_SECRET='YOUR_CLIENT_SECRET' docker compose -f https://github.com/ohcnetwork/care_create.git#reference:reference/compose.yaml up --build --wait --yes && xdg-open http://localhost:4400
```

Windows PowerShell:

```powershell
$env:ABDM_CLIENT_ID='YOUR_CLIENT_ID'; $env:ABDM_CLIENT_SECRET='YOUR_CLIENT_SECRET'; docker compose -f https://github.com/ohcnetwork/care_create.git#reference:reference/compose.yaml up --build --wait --yes; if ($LASTEXITCODE -eq 0) { Start-Process http://localhost:4400 }
```

`--wait` holds the command until CARE is ready, then http://localhost:4400 opens in your browser. Sign in as the superuser `admin` with the password `admin`. CARE's other demo users, such as `care-doctor` and `care-nurse`, have the password `Ohcn@123`.

The first run downloads and builds everything from source, which takes about 10 minutes on an Apple Silicon Mac. Later runs rebuild only what changed.

## Milestones

M1 runs by default. For M2, add `--profile m2` before `up`. It opens a public HTTPS tunnel for ABDM callbacks and sets it as the plug's callback URL. Only `/api/abdm/` is reachable through the tunnel. Register the URL as the bridge URL from a facility's ABDM setup page. The tunnel URL changes on every run.

To use your own public URL instead of the tunnel, set `ABDM_CALLBACK_BASE_URL` and leave out `--profile m2`.

## Port

The app runs on port 4400. To use another port, set `REFERENCE_PORT`, for example `REFERENCE_PORT=5000`, and change the address at the end of the command to match.

## Stop

```bash
docker compose -p care-reference down
```

Add `-v` to also delete the database and uploaded files.
