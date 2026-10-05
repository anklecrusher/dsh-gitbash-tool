/**
 * Real POSIX Git Bash tool for the DeepSeek Harness on Windows.
 *
 * The problem this solves
 * -----------------------
 * The shipped `@deepseek-ai/dsh-tool-bash` composes its POSIX shell executor
 * only off Windows. On Windows its `bash` tool therefore falls back to the
 * platform shell — Windows PowerShell 5.1 — which is not bash and whose
 * non-ASCII output is corrupted end to end:
 *
 *   machine-wide WDAC policy (CiPolicies\Active\*.cip)
 *     -> PowerShell starts in ConstrainedLanguage (cannot be lifted in-process)
 *     -> the harness bootstrap's `[Console]::OutputEncoding = <utf8>` throws
 *     -> the console stays on the host code page (936 / gb2312 here)
 *     -> text leaves as GBK bytes while the harness decodes UTF-8
 *     -> `中文` arrives as `���Ĳ���`
 *
 * A PowerShell-only fix is impossible: the language mode is imposed by
 * machine policy. The only reliable fix is to not route text through
 * PowerShell at all.
 *
 * What this plugin does
 * ---------------------
 *   - resolves a real bash.exe (Git for Windows / Scoop / PATH)
 *   - writes the command to a UTF-8 temp script and runs `bash <script>`
 *   - decodes stdout/stderr as UTF-8, so CJK survives intact
 *   - reports the real exit code, timeout and abort distinctly
 *
 * Passing the command through a *file* rather than argv is deliberate: in
 * testing, non-ASCII text carried through `bash -c '<cmd>'` on this machine
 * was silently truncated, while the same text in a script file was exact.
 *
 * @module @local/dsh-gitbash-tool
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { promises as fsp } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Default command deadline when the caller names none. */
const DEFAULT_TIMEOUT_MS = 120_000
/** Hard ceiling for a caller-supplied deadline. */
const MAX_TIMEOUT_MS = 600_000
/** Per-stream capture cap; beyond this the result is marked truncated. */
const MAX_OUTPUT_BYTES = 128 * 1024
/**
 * After killing the tree, how long to keep waiting for the pipe to close.
 *
 * MSYS bash forks, and the surviving grandchild can hold the stdout pipe
 * open for as long as the original command would have run. Measured here:
 * `bash -l` + `sleep 30` still reported close ~7s after a correct tree kill.
 * Waiting for close would therefore make every timeout return late, so after
 * termination we wait only this long, then report what we captured.
 */
const POST_KILL_GRACE_MS = 300

/**
 * Absolute bash.exe locations to probe, most specific first.
 * @returns candidate absolute paths that may hold a real bash.
 */
function candidateBashPaths() {
  const out = []
  const { ProgramFiles, PROGRAMFILES, LOCALAPPDATA, USERPROFILE, HOME } = process.env
  const pf = ProgramFiles || PROGRAMFILES
  if (pf) out.push(join(pf, 'Git', 'bin', 'bash.exe'))
  if (process.env['ProgramFiles(x86)']) out.push(join(process.env['ProgramFiles(x86)'], 'Git', 'bin', 'bash.exe'))
  if (LOCALAPPDATA) out.push(join(LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe'))
  const home = USERPROFILE || HOME
  if (home) out.push(join(home, 'scoop', 'apps', 'git', 'current', 'bin', 'bash.exe'))
  if (home) out.push(join(home, 'scoop', 'shims', 'bash.exe'))
  return out
}

/**
 * Resolve the bash executable once, preferring explicit configuration.
 * @param configured - optional absolute path from the plugin config.
 * @returns the executable to spawn plus how it was chosen.
 */
function resolveBash(configured) {
  if (typeof configured === 'string' && configured.length > 0) {
    return { path: configured, source: 'config.bashPath' }
  }
  for (const candidate of candidateBashPaths()) {
    if (existsSync(candidate)) return { path: candidate, source: 'probe' }
  }
  // Last resort: let the OS resolve `bash` through PATH. This is normally the
  // WSL launcher, so the model gets a clear diagnostic rather than a mystery.
  return { path: 'bash', source: 'PATH' }
}

/**
 * Start a UTF-8-correct collector over one piped stream.
 * @param stream - the child stream to drain.
 * @returns a function producing the decoded text once the stream has ended.
 */
function collector(stream) {
  const chunks = []
  let total = 0
  let truncated = false
  stream.on('data', (chunk) => {
    if (total >= MAX_OUTPUT_BYTES) {
      truncated = true
      return
    }
    const room = MAX_OUTPUT_BYTES - total
    if (chunk.length > room) {
      chunks.push(chunk.subarray(0, room))
      total = MAX_OUTPUT_BYTES
      truncated = true
      return
    }
    chunks.push(chunk)
    total += chunk.length
  })
  return () => ({
    text: Buffer.concat(chunks).toString('utf8'),
    truncated,
  })
}

/**
 * Kill a process and its descendants.
 *
 * Order matters on Windows: `taskkill /T` walks the child tree, so it must be
 * allowed to finish while the parent is still alive. Killing the parent first
 * reparents or orphans the real work — MSYS bash forks, and the forked
 * grandchild keeps running, which was measured here as a script printing its
 * post-deadline output. This waits (briefly, bounded) for taskkill to settle
 * before the direct kill.
 *
 * `windowsHide` is not cosmetic here. The desktop app is a GUI process with no
 * console of its own, so Windows allocates a fresh console — a visible black
 * window — for every console-subsystem child it spawns, and `taskkill` is one.
 * Without the flag the window flashes on screen each time a command is
 * cancelled or times out. The main bash spawn below already sets it; this one
 * was missed, so the two paths disagreed.
 * @param child - the spawned child process.
 */
async function killTree(child) {
  if (child.pid === undefined) return
  if (process.platform === 'win32') {
    await new Promise((resolve) => {
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        resolve()
      }
      try {
        const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
        })
        killer.on('error', finish)
        killer.on('close', finish)
        setTimeout(finish, 2000)
      } catch {
        finish()
      }
    })
  }
  try {
    child.kill('SIGKILL')
  } catch {
    /* already gone */
  }
}

/**
 * Run one bash command to completion.
 * @param bash - resolved bash executable.
 * @param args - validated tool arguments.
 * @param exec - the harness tool run context, for cancellation.
 * @returns the tool's structured value.
 */
async function runCommand(bash, args, exec) {
  const timeoutMs = Math.min(
    Number.isFinite(args.timeoutMs) && args.timeoutMs > 0 ? args.timeoutMs : DEFAULT_TIMEOUT_MS,
    MAX_TIMEOUT_MS,
  )
  const workdir = args.workdir && args.workdir.length > 0 ? args.workdir : process.cwd()

  const scriptPath = join(
    tmpdir(),
    `dsh-bash-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 10)}.sh`,
  )
  // LF endings and no BOM: bash treats a CR as part of the command otherwise.
  await fsp.writeFile(scriptPath, `${args.command}\n`, { encoding: 'utf8' })

  const argv = args.loginShell === false ? [scriptPath] : ['-l', scriptPath]

  let child
  try {
    child = spawn(bash.path, argv, {
      cwd: workdir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        // Force a UTF-8 locale so Git's own tools stop emitting GBK.
        LANG: 'C.UTF-8',
        LC_ALL: 'C.UTF-8',
      },
      windowsHide: true,
    })
  } catch (error) {
    await fsp.rm(scriptPath, { force: true })
    throw new Error(`gitbash: could not start "${bash.path}" (${bash.source}): ${String(error)}`)
  }

  const readStdout = collector(child.stdout)
  const readStderr = collector(child.stderr)

  let timedOut = false
  let aborted = false
  let killPromise = null

  /**
   * Settle exactly once, whichever signal arrives first: the process closing,
   * a spawn error, or the post-kill grace expiring.
   */
  let settle
  const settled = new Promise((resolve) => {
    settle = resolve
  })

  child.on('error', (error) => settle({ spawnError: error }))
  child.on('close', (exitCode, signal) => settle({ exitCode, signal }))

  const terminate = (reason) => {
    if (reason === 'timeout') timedOut = true
    if (reason === 'abort') aborted = true
    if (killPromise !== null) return
    killPromise = killTree(child).then(() => {
      // The tree is dead. A forked grandchild can still hold the stdout pipe
      // open for the command's full original duration, so give the close event
      // only a brief grace period before reporting what was captured.
      setTimeout(() => settle({ exitCode: null, signal: 'SIGKILL' }), POST_KILL_GRACE_MS)
    })
  }

  const timer = setTimeout(() => terminate('timeout'), timeoutMs)
  const onAbort = () => terminate('abort')
  if (exec?.signal) {
    if (exec.signal.aborted) onAbort()
    else exec.signal.addEventListener('abort', onAbort, { once: true })
  }

  // Feed caller-supplied stdin, then close it so programs see EOF.
  if (typeof args.stdin === 'string' && args.stdin.length > 0) {
    child.stdin.end(args.stdin)
  } else {
    child.stdin.end()
  }

  const outcome = await settled

  clearTimeout(timer)
  exec?.signal?.removeEventListener?.('abort', onAbort)
  await fsp.rm(scriptPath, { force: true })

  if (outcome.spawnError) {
    const code = outcome.spawnError.code
    const hint =
      code === 'ENOENT'
        ? ` No bash found at "${bash.path}" (${bash.source}). Install Git for Windows or set config.bashPath in the bundle patch.`
        : ''
    throw new Error(`gitbash: failed to run bash: ${outcome.spawnError.message}.${hint}`)
  }

  const stdout = readStdout()
  const stderr = readStderr()

  return {
    exitCode: outcome.exitCode ?? null,
    signal: outcome.signal ?? null,
    timedOut,
    aborted,
    truncated: stdout.truncated || stderr.truncated,
    stdout: stdout.text,
    stderr: stderr.text,
  }
}

/**
 * Build the tool definition.
 * @param bash - resolved bash executable.
 * @returns the tool definition to register.
 */
function createTool(bash) {
  return {
    name: 'bash',
    description:
      'Execute a POSIX bash command (real Git Bash, never PowerShell) and return its stdout/stderr. '
      + 'Use this for text processing, grep/sed/awk pipelines, git, and any command whose output may '
      + 'contain non-ASCII text — PowerShell on this machine corrupts such output. Use the `pwsh` tool '
      + 'instead only for Windows-native objects (services, registry, ACLs, CIM). '
      + 'Write POSIX shell, not PowerShell. The command runs from a UTF-8 script file, so quoting is '
      + 'literal; there is no TTY and no stdin unless you pass `stdin`. '
      + 'Each call runs in a fresh shell; pass `workdir` instead of using `cd`. '
      + 'Long output is truncated to its tail and marked truncated — redirect to a file and read it '
      + 'when you need everything.',
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'The POSIX bash command to run.',
        },
        workdir: {
          type: 'string',
          description: 'Absolute working directory. Omit for the session working directory.',
        },
        timeoutMs: {
          type: 'number',
          description: `Deadline in milliseconds (default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS}). On expiry the whole process tree is killed and timedOut is true.`,
        },
        loginShell: {
          type: 'boolean',
          description: 'Load the login profile (PATH for nvm/cargo/pyenv). Defaults to true.',
        },
        stdin: {
          type: 'string',
          description: 'Text written to the command\'s standard input.',
        },
      },
      required: ['command'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          exitCode: {
            // The harness enforces a strict schema subset: one scalar `type`
            // per node, and nullability via `oneOf` rather than a type array.
            oneOf: [{ type: 'integer' }, { type: 'null' }],
            description: 'Process exit code, or null when killed by a signal.',
          },
          signal: {
            oneOf: [{ type: 'string' }, { type: 'null' }],
            description: 'Terminating signal name, when one ended the process.',
          },
          timedOut: { type: 'boolean', description: 'True when the deadline killed the command.' },
          aborted: { type: 'boolean', description: 'True when the call itself was cancelled.' },
          truncated: { type: 'boolean', description: 'True when captured output hit the byte cap.' },
          stdout: { type: 'string', description: 'Standard output, decoded as UTF-8.' },
          stderr: { type: 'string', description: 'Standard error, decoded as UTF-8.' },
        },
        required: ['exitCode', 'signal', 'timedOut', 'aborted', 'truncated', 'stdout', 'stderr'],
        additionalProperties: false,
      },
      render(_args, value) {
        const parts = []
        if (value.stdout.length > 0) parts.push(value.stdout.replace(/\n$/, ''))
        if (value.stderr.length > 0) {
          parts.push(`${value.stdout.length > 0 ? '\n' : ''}[stderr]\n${value.stderr.replace(/\n$/, '')}`)
        }
        const notes = []
        if (value.timedOut) notes.push('timed out — process tree killed')
        if (value.aborted) notes.push('aborted')
        if (value.truncated) notes.push('output truncated — redirect to a file for the full text')
        if (value.exitCode !== 0 && !value.timedOut && !value.aborted) notes.push(`exit code ${value.exitCode}`)
        if (notes.length > 0) parts.push(`\n[${notes.join('; ')}]`)
        if (parts.length === 0) parts.push('(no output)')
        return [{ type: 'text', text: parts.join('') }]
      },
    },
    presentCall(args) {
      return {
        card: 'terminal',
        title: args.command,
        ...(args.workdir ? { cwd: args.workdir } : {}),
      }
    },
    async execute(args, exec) {
      if (typeof args.command !== 'string' || args.command.trim().length === 0) {
        throw new Error('gitbash: `command` must be a non-empty string.')
      }
      return runCommand(bash, args, exec)
    },
  }
}

/**
 * Plugin entry point.
 * @param ctx - the plugin context (requires the `tools` service).
 * @param config - optional plugin config carrying `bashPath`.
 */
export function apply(ctx, config) {
  const bash = resolveBash(config?.bashPath)
  // Cordis disposes registrations made here when the plugin unloads.
  ctx.tools.register(createTool(bash))
}

/** Service dependency: this plugin only contributes a tool. */
export const inject = ['tools']

/** Package identity, for diagnostics. */
export const name = 'dsh-gitbash-tool'

