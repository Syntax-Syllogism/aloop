---
title: Platform support
description: Supported host environments and platform-specific command and terminal behavior.
---

# Platform support

aloop supports Linux and macOS directly. Windows is a fully supported tier in
two modes: launched from Git Bash (POSIX `sh` available), or natively under
PowerShell with no POSIX shell on `PATH` at all. WSL is supported through its
Linux environment.

## Windows: Git Bash mode

Install Git for Windows, make sure its `sh.exe` is available on `PATH`, and
launch aloop from a Git Bash terminal. Use `--yes` for unattended runs or when
no interactive console is available.

A bare command string in `gate`/`setup`/`phase.commands` runs through `sh -c`,
same as POSIX:

```js
export default {
  setup: ['npm ci'],
  gate: ['npm test'],
};
```

## Windows: native PowerShell mode (no `sh`)

With no Git Bash (or any POSIX shell) on `PATH`, aloop runs setup and gate
commands under PowerShell 7+ (`pwsh`), falling back to Windows PowerShell
(`powershell.exe`) when `pwsh` is not installed. Set `shell` in the config to
override this auto-detection (e.g. `shell: 'cmd.exe'`).

A bare POSIX command string is not portable to this mode: `&&` with `$VAR`,
`[[ ]]`, `2>&1`, single-quote semantics, and `foo=bar cmd` env-prefixing all
differ or fail under PowerShell. Two structured forms exist so one config can
target both POSIX and native Windows:

- **`{ argv: [...] }`** — runs the given argv directly, no shell involved.
  Portable by construction; cannot express pipes, `&&`, or redirection.
- **`{ posix, windows, pwsh, cmd }`** — a per-platform object. On Windows,
  aloop picks `windows` if present, else `pwsh`, else `cmd`; on POSIX it picks
  `posix`. A config missing the variant needed on the current host fails at
  config-load time with an error naming the phase and command index, rather
  than failing mid-run.

```js
export default {
  setup: [{ argv: ['npm', 'ci'] }],
  gate: [{ posix: 'npm test 2>&1', windows: 'npm test *>&1' }],
};
```

The legacy string form keeps working everywhere — including native Windows,
via the shell resolved above — for commands simple enough not to need the
structured forms.

## Windows command execution

The shared command runner resolves extensionless commands through the Windows
`PATH` and `PATHEXT` environment variables. Executables are tried in path and
extension order. Direct `.exe` commands run as-is; `.cmd` and `.bat` shims run
through `ComSpec`, and `.ps1` scripts run through Windows PowerShell with a
non-interactive profile and execution-policy bypass. This lets configured agent
CLIs and the default shell work when their Windows launchers are on `PATH`.

A `.cmd`/`.bat` shim runs through `cmd.exe`, whose command line is capped at
about 8191 characters and which mangles newlines and shell metacharacters
(`% ! & | < >`). A large agent prompt passed as a command-line argument through
such a shim therefore arrives truncated or garbled. The Gemini adapter avoids
this by sending its prompt on stdin (an adapter may return an `input` string
that the runner writes to the child's stdin) instead of on the command line;
its Windows launcher is a shim, so a command-line prompt would be corrupted.

Command timeouts terminate the Windows process tree with `taskkill /PID /T /F`.
On POSIX hosts, aloop continues to use detached process groups and group
signals. A timeout or cancellation therefore cleans up child processes on both
platform families.

## Interactive confirmation

When confirmation is required, aloop uses standard input when it is a TTY. On
Windows, a non-TTY Git Bash invocation falls back to the Windows console input
device (`CONIN$`). If no terminal can be opened, aloop reports an actionable
error and asks the operator to rerun with `--yes`.

Piped task input does not provide confirmation input by itself. A piped run can
still remain interactive when Git Bash exposes its console, or it can run
unattended with `--yes`:

```sh
some-task-source fetch 123 | aloop --task-file - --name my-spec --yes
```

## Verification

The platform seams are covered by `test/platform.test.mjs`, and the
structured/per-platform command model by `test/loop.test.mjs`. CI runs three
jobs: the full regression suite on Ubuntu; the Git Bash Windows job (invoked
through the runner's Bash shell), which runs the native Windows platform
suite — including a real `.cmd` launch through `ComSpec` — with Git Bash's
`sh` present; and a dedicated `windows-native` job that strips Git's `usr\bin`
from `PATH`, asserts `sh` cannot be resolved, and then runs the same platform
suite plus the command-model tests entirely under `pwsh`. POSIX-only
integration fixtures (bash-syntax gate/setup strings) remain Ubuntu-only.
