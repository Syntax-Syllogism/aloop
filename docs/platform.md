---
title: Platform support
description: Supported host environments and platform-specific command and terminal behavior.
---

# Platform support

aloop runs directly on Linux and macOS. Windows is fully supported in two modes: from Git Bash (with a POSIX `sh`), or natively under PowerShell with no POSIX shell on `PATH`. WSL works through its Linux environment.

## Windows: Git Bash mode

Install Git for Windows, make sure its `sh.exe` is on `PATH`, and start aloop from a Git Bash terminal. Use `--yes` for unattended runs or when there's no interactive console.

A plain command string in `gate`, `setup`, or `phase.commands` runs through `sh -c`, as on POSIX:

```js
export default {
  setup: ['npm ci'],
  gate: ['npm test'],
};
```

## Windows: native PowerShell mode

If no Git Bash or other POSIX shell is on `PATH`, aloop runs setup and gate commands under PowerShell 7+ (`pwsh`). It falls back to Windows PowerShell (`powershell.exe`) if `pwsh` isn't installed. To override the detected shell, set `shell` in the config, for example `shell: 'cmd.exe'`.

A plain POSIX command string often won't work here. `&&` with `$VAR`, `[[ ]]`, `2>&1`, single-quote rules, and `foo=bar cmd` env prefixes all behave differently or fail in PowerShell. Two structured forms let one config target both POSIX and native Windows:

- **`{ argv: [...] }`** runs the argv directly, with no shell. It's portable by design, but can't express pipes, `&&`, or redirection.
- **`{ posix, windows, pwsh, cmd }`** is a per-platform object. On Windows, aloop uses `windows` if present, then `pwsh`, then `cmd`. On POSIX it uses `posix`. If the variant for the current host is missing, config loading fails up front with an error naming the phase and command index, instead of failing mid-run.

```js
export default {
  setup: [{ argv: ['npm', 'ci'] }],
  gate: [{ posix: 'npm test 2>&1', windows: 'npm test *>&1' }],
};
```

Plain strings still work everywhere, including native Windows through the shell above, as long as the command is simple enough.

## Windows command execution

The command runner finds extensionless commands through the Windows `PATH` and `PATHEXT` variables, trying executables in path and extension order:

- `.exe` files run directly.
- `.cmd` and `.bat` shims run through `ComSpec`.
- `.ps1` scripts run through Windows PowerShell with a non-interactive profile and execution-policy bypass.

This lets agent CLIs and the default shell work when their Windows launchers are on `PATH`.

A `.cmd` or `.bat` shim runs through `cmd.exe`. That limits the command line to about 8191 characters and mangles newlines and metacharacters (`% ! & | < >`). A large prompt passed as an argument through such a shim arrives truncated or garbled. The Gemini adapter avoids this by sending its prompt on stdin instead. An adapter can return an `input` string, and the runner writes it to the child's stdin. Gemini's Windows launcher is a shim, so a prompt on the command line would be corrupted.

On timeout, aloop ends the Windows process tree with `taskkill /PID /T /F`. On POSIX it uses detached process groups and group signals. Either way, a timeout or cancellation cleans up child processes.

## Interactive confirmation

When aloop needs confirmation, it reads from standard input if that's a TTY. On Windows under Git Bash without a TTY, it falls back to the console input device (`CONIN$`). If no terminal can be opened, it reports an error and asks you to rerun with `--yes`.

Piped task input doesn't provide confirmation input. A piped run can stay interactive if Git Bash exposes its console, or it can run unattended with `--yes`:

```sh
some-task-source fetch 123 | aloop --task-file - --name my-spec --yes
```

## Verification

`test/platform.test.mjs` covers the platform seams, and `test/loop.test.mjs` covers the structured and per-platform command model. CI runs three jobs:

- The full regression suite on Ubuntu.
- A Git Bash Windows job, run through the runner's Bash shell. It runs the native Windows platform suite, including a real `.cmd` launch through `ComSpec`, with Git Bash's `sh` present.
- A `windows-native` job. It strips Git's `usr\bin` from `PATH`, asserts that `sh` can't be found, then runs the same platform suite and the command-model tests entirely under `pwsh`.

POSIX-only integration fixtures (bash-syntax gate and setup strings) run only on Ubuntu.
