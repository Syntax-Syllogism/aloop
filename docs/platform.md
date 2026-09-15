---
title: Platform support
description: Supported host environments and platform-specific command and terminal behavior.
---

# Platform support

aloop supports Linux and macOS directly. Windows is supported when aloop is
launched from Git Bash supplied by Git for Windows. WSL is supported through
its Linux environment.

## Windows prerequisites

Install Git for Windows, make sure its `sh.exe` is available on `PATH`, and
launch aloop from a Git Bash terminal. The supported Windows setup is not native
`cmd.exe` or PowerShell. Use `--yes` for unattended runs or when no interactive
console is available.

The configured `shell` runs setup and gate commands with `-c`; it defaults to
`sh`. Git Bash therefore provides the POSIX shell expected by the default
configuration:

```js
export default {
  shell: 'sh',
  setup: ['npm ci'],
  gate: ['npm test'],
};
```

## Windows command execution

The shared command runner resolves extensionless commands through the Windows
`PATH` and `PATHEXT` environment variables. Executables are tried in path and
extension order. Direct `.exe` commands run as-is; `.cmd` and `.bat` shims run
through `ComSpec`, and `.ps1` scripts run through Windows PowerShell with a
non-interactive profile and execution-policy bypass. This lets configured agent
CLIs and the default shell work when their Windows launchers are on `PATH`.

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

The platform seams are covered by `test/platform.test.mjs`. CI runs the full
regression suite on Ubuntu and the native Windows platform suite on Windows.
The Windows job is invoked through the runner's Bash shell, and the platform
suite includes a real `.cmd` launch through `ComSpec`; POSIX-only integration
fixtures remain in the Ubuntu suite.
