# Runbook: restore the database from the Litestream replica

The SQLite database (`/data/marketingos.db` in production) replicates
continuously to object storage via Litestream (see `litestream.yml`). This
runbook covers restoring it.

## Automatic restore

`scripts/start.sh` runs `litestream restore -if-replica-exists` on boot
whenever the local database file is missing, so replacing a machine or wiping
the volume self-heals: the app restores the latest replica snapshot before
starting.

## Manual restore

On the production machine (e.g. `fly ssh console`):

```sh
# Stop writes first (scale to zero or stop the machine), then:
litestream restore -config /etc/litestream.yml -o /data/marketingos.db "$DATABASE_PATH"
```

To restore to a point in time, add `-timestamp 2026-08-31T12:00:00Z`.

## Verifying the restore path

`npm run test:restore` (also run in CI-less local verification) exercises the
full cycle against a local file replica: seed a WAL-mode database, replicate,
delete the original, restore, and assert the seeded row survives. Run it after
any change to the Litestream configuration.

Last verified: 2026-08-31 (locally, via `npm run test:restore`).
