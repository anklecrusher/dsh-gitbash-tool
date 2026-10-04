# dsh-gitbash-tool

A real POSIX **Git Bash** tool for the DeepSeek Harness on Windows, with
UTF-8-correct output.

It exists because the harness's own `bash` tool cannot deliver bash on Windows,
and because PowerShell output is corrupted on this machine in a way that cannot
be fixed from inside PowerShell.

## The problem

Two separate defects, both measured here.

### 1. `@deepseek-ai/dsh-tool-bash` does not give you bash on Windows

The shipped package composes its POSIX shell executor only off Windows — its
own source says so:

> *Profile entry id of the POSIX shell executor; the base bundle composes it
> **off Windows**.*

So on Windows the `bash` tool falls back to the platform shell. Verified after
enabling `include:tool-bash`:

| Probe | Result |
| --- | --- |
| `$PSVersionTable.PSVersion` | `5.1.26100.6584` (bash leaves this empty) |
| `(Get-Process -Id $PID).Path` | `…\WindowsPowerShell\v1.0\powershell.exe` |
| `&&` / `\|\|` | PowerShell 5.1 parser error |
| `test -f /etc/hostname` | not a valid command |

The tool is named `bash` but executes Windows PowerShell. It is not a bash
implementation at all.

### 2. PowerShell corrupts non-ASCII output here, unfixably

```
pwsh tool  →  ���Ĳ���        (corrupted)
read tool  →  测试中文         (correct)
```

The causal chain, each link verified:

1. Machine-wide WDAC policy is present —
   `C:\Windows\System32\CodeIntegrity\CiPolicies\Active\*.cip` (8 policy files).
2. PowerShell therefore starts in **ConstrainedLanguage**. Measured:
   `$ExecutionContext.SessionState.LanguageMode` → `ConstrainedLanguage`, and it
   **cannot be lifted from inside the session**.
3. The harness bootstrap's encoding pin fails as a result:
   `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)`
   → `CannotCreateTypeConstrainedLanguage`.
4. The console stays on the host code page — measured `chcp` → **936 (gb2312)**,
   `[Console]::OutputEncoding` → `gb2312`.
5. Text leaves as GBK bytes while the harness decodes UTF-8, so every non-ASCII
   character is mangled.

The harness documents its own side of this boundary: workspace-write normally
keeps FullLanguage, *"unless host-wide WDAC/AppLocker policy says otherwise"*.
That exception is exactly this machine.

`chcp 65001` does not help: the code page changes, but PowerShell still writes
through its own mangled encoder, and the observed output remained corrupted.

**Conclusion: no PowerShell-side fix exists.** The only reliable remedy is to
keep text out of PowerShell entirely.

## What this plugin does

Registers one `bash` tool that:

- resolves a real `bash.exe` (explicit config → standard Git locations → Scoop → `PATH`);
- writes the command to a UTF-8 temp script and runs `bash <script>`;
- decodes stdout/stderr as UTF-8, so CJK survives intact;
- forces `LANG`/`LC_ALL` to `C.UTF-8`;
- reports exit code, timeout and abort as distinct, structured fields;
- kills the **whole process tree** on timeout, and bounds the wait afterwards.

Passing the command through a **file** rather than `argv` is deliberate.
Measured on this machine, non-ASCII carried through `bash -c '<cmd>'` was
silently truncated:

```
bash -c 'echo "中文 A B C"; echo "second ascii line"'
  → 中文                      (rest lost)
same text in a script file
  → 中文 A B C / second ascii line   (exact)
```

## Verification

`test-harness.mjs` exercises the tool with a mocked registry, so it runs without
the harness:

```powershell
& "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" `
  test-harness.mjs
```

Current result — **all checks pass**:

| Case | Result |
| --- | --- |
| CJK line 1 / line 2 | exact, including `，。「」` |
| emoji + fullwidth | `emoji 🙂 全角ＡＢＣ` exact |
| exit code 7 | `exitCode: 7` |
| stdout/stderr split | separated correctly |
| `sed`/`awk` pipeline | `1: 汉字一` … exact |
| `workdir` | honored |
| stdin round-trip | CJK exact |
| non-ASCII **in the command text** | exact |
| `LANG` / `locale charmap` | `C.UTF-8` / `UTF-8` |
| timeout (limit 1500 ms) | settles ~1.9 s, `timedOut: true`, **no post-deadline output** |

### The timeout bug that testing caught

The first implementation killed the wrong thing. Measured, `sleep 8` with a
1 s deadline:

| Strategy | Outcome |
| --- | --- |
| `child.kill('SIGKILL')` only | **script survived and printed its post-deadline output**; took 8.4 s |
| `taskkill /T /F`, then kill | tree genuinely died, but close lagged ~7.4 s |
| kill parent first, then taskkill | orphans — the forked grandchild keeps running |

Two real defects, both fixed:

1. **MSYS bash forks**, so killing `bash.exe` orphans the process actually doing
   the work. `taskkill /T /F` must be allowed to finish *while the parent is
   still alive*, or it has no tree to walk. The code now awaits it before the
   direct kill.
2. **A surviving grandchild holds the stdout pipe open** for the command's full
   original duration, so waiting for `close` makes every timeout return late.
   The code now settles a bounded `POST_KILL_GRACE_MS` after a confirmed kill.

## Install

```powershell
# from the harness plugin manager, pointing at this directory
plugin_manager install_bundle E:\GitHubWorkspace\own\opensource\dsh-gitbash-tool
```

`cordis.patch.yml` declares `bashPath` explicitly. Omit it to use probing.

## Why there are two files

`entry.js` exists to work around **permanent ESM caching**. Node caches modules
by resolved URL for the process lifetime, and Cordis re-runs `apply` without
re-importing. Observed directly: after fixing a schema error in `index.js`, every
reload still reported the *old* source location, because the runtime kept
executing its first import.

`entry.js` imports the implementation through a unique URL (`?t=<timestamp>`),
so an edit plus a plugin toggle takes effect immediately. `inject` stays a static
export there, because the DI declaration must be readable without executing the
implementation.

## Known limits

- **A restart is required the first time.** The harness resolves the bare
  specifier `@local/dsh-gitbash-tool` once at boot, so the very first activation
  after install needs a restart. Once the corrected entry is cached, later edits
  reload through `entry.js`.
- **Windows-only.** On POSIX the shipped `dsh-tool-bash` is already correct.
- **No PTY.** There is no TTY and no interactive stdin; pass the `stdin` argument
  for piped input. Non-interactive flags (`-y`, `--no-edit`) are required.
- **Output is capped** at 128 KiB per stream and marked `truncated`; redirect to
  a file for the full text.
- **`pwsh` is not removed.** Windows-native work — services, registry, ACLs,
  CIM, process metadata — still belongs there. Only text and CJK work moves here.
- The timeout path is correct but not instant: expect roughly the deadline plus
  the ~300 ms post-kill grace.
