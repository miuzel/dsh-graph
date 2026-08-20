// Minimal third-party cordis host plugin for DSH.
// Named exports only (NO default export: the Loader's unwrapExports would drop `inject`).
import { appendFileSync } from 'node:fs'

const MARKER = new URL('./loaded.log', import.meta.url)
function note(line) {
  try { appendFileSync(MARKER, `${new Date().toISOString()} ${line}\n`) } catch {}
  process.stderr.write(`[dsh-hello-plugin] ${line}\n`)
}

export const name = 'dsh-hello-plugin'
export const inject = ['tools']

export function apply(ctx, config) {
  note(`apply() config=${JSON.stringify(config ?? null)}`)
  note(`ctx.tools=${typeof ctx.tools} register=${typeof ctx.tools?.register}`)

  // Disposer is owned by this fiber: the tool disappears when the plugin unloads.
  ctx.effect(() => ctx.tools.register({
    name: 'hello_marker',
    description: 'Return a fixed marker string proving the third-party plugin is live.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: { type: 'object', properties: { marker: { type: 'string' } }, required: ['marker'], additionalProperties: false },
      render: (_args, value) => [{ type: 'text', text: `marker=${value.marker}` }],
    },
    execute: async () => ({ marker: 'dsh-hello-plugin-alive' }),
  }))

  const names = ctx.tools.schemas().map((s) => s.name)
  note(`registered; tools now visible = ${names.join(',')}`)
  note(`get('hello_marker') = ${ctx.tools.get('hello_marker') ? 'FOUND' : 'MISSING'}`)
  ctx.on('dispose', () => note('dispose()'))
}
