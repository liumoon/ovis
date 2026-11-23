### Added
- `ovis join` adds a PC to your Ovis account with a single-use invite that a device signed in to
  the account made, with no sign-in on the PC: `ovis join --invite-file <path>` (or `ovis join -`
  on standard input, or `OVIS_INVITE`). It names the account the invite is for and asks you to type
  `yes`, or checks it against `--account <id>` where nobody can type (a script, a coding agent).
  A plain invite then waits up to 10 minutes for **Add** on a device of the account, as `ovis add`
  does; an auto invite adds the PC at once. Stopped or not added, it takes the PC off the account's
  list again. `--json` prints one object at the end, and each way it can fail has its own exit code.
- `ovis status --json` prints what an agent reads: the version, whether Ovis runs, this PC's ID,
  the relay (on, connected), the account it is in and whether it waits for **Add**.
