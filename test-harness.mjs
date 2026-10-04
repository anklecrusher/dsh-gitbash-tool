/**
 * Standalone harness: exercise the plugin's tool without the DSH runtime.
 * Mocks ctx.tools.register to capture the definition, then executes it.
 *
 * Run with: node test-harness.mjs
 */
import { apply } from './index.js'

let captured = null
const ctx = {
  tools: {
    register(definition) {
      captured = definition
      return () => {}
    },
  },
}

// No bashPath: exercise the plugin's own probing, so the test also proves
// auto-discovery works on a normal machine.
apply(ctx, {})

if (!captured) {
  console.error('FAIL: no tool registered')
  process.exit(1)
}
console.log('registered tool name:', captured.name)
console.log('param keys:', Object.keys(captured.parameters.properties).join(','))
console.log('output required:', captured.output.schema.required.join(','))
console.log('---')

let failures = 0
const check = (label, condition, detail) => {
  if (condition) {
    console.log(`  PASS  ${label}`)
  } else {
    failures += 1
    console.log(`  FAIL  ${label} :: ${detail}`)
  }
}

const cases = [
  {
    label: 'CJK fidelity',
    args: { command: 'echo "中文测试 ABC"; echo "第二行：中文标点，。「」"; echo "emoji 🙂 全角ＡＢＣ"' },
    verify: (v) => {
      check('exact CJK line 1', v.stdout.includes('中文测试 ABC'), JSON.stringify(v.stdout))
      check('exact CJK line 2', v.stdout.includes('第二行：中文标点，。「」'), JSON.stringify(v.stdout))
      check('emoji + fullwidth', v.stdout.includes('emoji 🙂 全角ＡＢＣ'), JSON.stringify(v.stdout))
      check('exit 0', v.exitCode === 0, String(v.exitCode))
    },
  },
  {
    label: 'exit code 7',
    args: { command: 'echo before; exit 7' },
    verify: (v) => check('exitCode is 7', v.exitCode === 7, String(v.exitCode)),
  },
  {
    label: 'stderr split',
    args: { command: 'echo to-stdout; echo to-stderr >&2' },
    verify: (v) => {
      check('stdout only', v.stdout === 'to-stdout\n', JSON.stringify(v.stdout))
      check('stderr only', v.stderr === 'to-stderr\n', JSON.stringify(v.stderr))
    },
  },
  {
    label: 'pipe through sed/awk',
    args: { command: 'printf "%s\\n" 中文一 中文二 | sed "s/中文/汉字/" | awk \'{print NR": "$0}\'' },
    verify: (v) => check('pipeline CJK', v.stdout === '1: 汉字一\n2: 汉字二\n', JSON.stringify(v.stdout)),
  },
  {
    label: 'workdir',
    args: { command: 'pwd', workdir: 'E:/GitHubWorkspace/own/opensource/dsh-gitbash-tool' },
    verify: (v) => check('cwd honored', v.stdout.includes('/e/GitHubWorkspace/own/opensource/dsh-gitbash-tool'), JSON.stringify(v.stdout)),
  },
  {
    label: 'stdin passthrough',
    args: { command: 'cat', stdin: '来自 stdin 的中文\n' },
    verify: (v) => check('stdin CJK round-trip', v.stdout === '来自 stdin 的中文\n', JSON.stringify(v.stdout)),
  },
  {
    label: 'timeout kills tree (limit 1500ms)',
    args: { command: 'echo START; sleep 30; echo NEVER', timeoutMs: 1500 },
    verify: (v, elapsed) => {
      check('timedOut flag', v.timedOut === true, String(v.timedOut))
      check('did NOT print post-deadline output', !v.stdout.includes('NEVER'), JSON.stringify(v.stdout))
      check('returned promptly (< 6s)', elapsed < 6000, `${elapsed}ms`)
      check('nonzero exit / killed', v.exitCode !== 0, String(v.exitCode))
    },
  },
  {
    label: 'env is UTF-8',
    args: { command: 'echo "LANG=$LANG LC_ALL=$LC_ALL"; locale charmap 2>/dev/null || true' },
    verify: (v) => {
      check('LANG=C.UTF-8', v.stdout.includes('LANG=C.UTF-8'), JSON.stringify(v.stdout))
      check('charmap UTF-8', v.stdout.includes('UTF-8'), JSON.stringify(v.stdout))
    },
  },
  {
    label: 'non-ASCII in the COMMAND TEXT itself',
    args: { command: 'printf "%s\\n" "命令里的中文" "第二个"' },
    verify: (v) => check('command-text CJK intact', v.stdout === '命令里的中文\n第二个\n', JSON.stringify(v.stdout)),
  },
]

for (const testCase of cases) {
  const started = Date.now()
  console.log(`### ${testCase.label}`)
  try {
    const value = await captured.execute(testCase.args, { signal: undefined })
    const elapsed = Date.now() - started
    console.log(`   (${elapsed}ms) exitCode=%s signal=%s timedOut=%s truncated=%s`,
      value.exitCode, value.signal, value.timedOut, value.truncated)
    testCase.verify(value, elapsed)
  } catch (error) {
    failures += 1
    console.log('   THREW: %s', String(error && error.message ? error.message : error))
  }
  console.log('')
}

console.log('=== render() formatting ===')
console.log(captured.output.render({}, {
  exitCode: 3, signal: null, timedOut: false, aborted: false, truncated: false,
  stdout: '中文输出\n', stderr: '中文错误\n',
})[0].text)
console.log('')
console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
