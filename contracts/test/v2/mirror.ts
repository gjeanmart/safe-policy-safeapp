import { readFileSync } from 'fs'
import { join } from 'path'
import { ModuleKind, transpileModule } from 'typescript'
import { runInNewContext } from 'vm'
import type * as Cover from '../../../src/lib/v2/rev3/cover'
import type * as OpMask from '../../../src/lib/v2/rev3/opmask'
import type * as Types from '../../../src/lib/v2/rev3/types'

/**
 * The app's import-free mirrors (`src/lib/v2/rev3/*.ts`), loaded so the tests check them against
 * the contracts. The root package is ESM and this one CommonJS, so each file is transpiled and
 * evaluated here instead of required; `cover.ts` and `opmask.ts` may only import `./types`.
 */

const DIR = join(__dirname, '../../../src/lib/v2/rev3')

function load(file: string, modules: Record<string, unknown> = {}): unknown {
  const { outputText } = transpileModule(readFileSync(join(DIR, file), 'utf8'), {
    compilerOptions: { module: ModuleKind.CommonJS },
  })
  const exports = {}
  const require = (name: string) => {
    if (!(name in modules)) throw new Error(`${file} may not import ${name}`)
    return modules[name]
  }
  runInNewContext(outputText, { exports, require })
  return exports
}

export const types = load('types.ts') as typeof Types
export const cover = load('cover.ts', { './types': types }) as typeof Cover
export const opmask = load('opmask.ts', { './types': types }) as typeof OpMask
