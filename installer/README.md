# ark-installer — ARK-CORE Installer Engine

Universal deployment engine for Ark Pi builds. NOT a plugin — a core
subsystem every build flows through, including RaspyJack.

## What it actually does

This is a **compiler**, not a remote runner. The engine runs on the
operator's machine, ingests a build package, detects its needs, and
produces a deterministic first-boot install plan that the Pi
executes via `Automation_Custom_Script.sh`. Pi-side execution is the
plan; the engine's job is to make the plan correct + complete.

Three layers:
1. **Input** — git / zip / folder / bundle / raw tree → normalised staging
2. **Detection** — entry-points + apt/pip deps + hardware needs + arch
3. **Execution pipeline** — INIT → VALIDATE → PREPARE → INSTALL → CONFIGURE → FINALISE

See `../docs/INSTALLER.md` for the full architecture spec.

## CLI

```sh
# 1. Ingest a package (any of these inputs work)
node bin/ark-install.mjs ingest <source> --as <build_name>
#   <source> = https://github.com/foo/bar  (git)
#             = ./path/to/folder            (folder)
#             = ./path/to/build.zip         (zip)
#             = ./path/to/build.tar.gz      (bundle)

# 2. Detect requirements (scans staging, writes manifest.json)
node bin/ark-install.mjs detect <build_name>

# 3. Compile to first-boot install plan
node bin/ark-install.mjs compile <build_name> [--profile raspyjack]

# 4. Backup
node bin/ark-install.mjs backup <build_name>

# Convenience: ingest + detect + compile in one
node bin/ark-install.mjs run <source> --as <build_name> [--profile raspyjack]
```

## Output

Every build lands in `<repo>/builds/<build_name>/`:

```
builds/<build_name>/
  src/             # normalised source tree
  scripts/         # extracted/generated installer scripts
  config/          # ark-managed config overlay
  manifest.json    # build manifest (auto-generated if missing)
  install.log      # human-readable engine log
  install.plan.sh  # rendered first-boot script (the Pi runs this)
  install.plan.json # machine-readable plan (audit + diff)
```

## Pi-side execution

The Pi executes `install.plan.sh` as `Automation_Custom_Script.sh`
during DietPi first boot. Output is captured to
`/var/log/ark-install.log` on the Pi, which the Ark Agent later
posts back to the Hub for the operator to read.
