// Test/diagnostic isolation wrapper: argv is `<dumpPath> <realCommand...>`;
// it dumps the real command and the environment it received, then execs the
// real command with stdio inherited so the ACP pipes pass straight through.
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'

const argv = process.argv.slice(2)
if (argv.length < 2) {
  process.exit(2)
}
const dumpPath = argv[0]
const real = argv.slice(1)
writeFileSync(dumpPath, JSON.stringify({ argv: real, env: process.env }))
const child = spawn(real[0], real.slice(1), { stdio: 'inherit', env: process.env })
child.on('exit', (code, signal) => {
  if (signal !== null) process.kill(process.pid, signal)
  else process.exit(code ?? 0)
})
