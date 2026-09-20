# Privacy

- Everything ClawPhylax records stays in `~/.openclaw/clawphylax/ledger.sqlite`
  (or under `OPENCLAW_STATE_DIR`). No telemetry, no phone-home, no analytics.
- No bodies, no headers, no cookies, no tokens are captured. Query strings are
  stripped from paths.
- `exec` command text is stored (truncated). If your agent passes secrets on
  command lines, they will be in the ledger, the same way they would be in your
  shell history. `openclaw clawphylax export` shows exactly what is stored.
- Delete the ledger file to delete all data.
- A future, clearly opt-in version may let you share hashed `(skill, version,
  host)` pairs to compare a skill's behavior across installs. It is off, and
  will stay off unless you turn it on.
