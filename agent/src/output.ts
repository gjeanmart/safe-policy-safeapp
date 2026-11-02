/**
 * Every command prints one JSON object: `ok`, a one-line `summary`, then its data. Errors carry a
 * `hint` saying what to do next, so an agent can recover without guessing.
 */
export class CliError extends Error {
  constructor(
    message: string,
    readonly hint?: string,
  ) {
    super(message)
  }
}

const replacer = (_: string, value: unknown) => (typeof value === 'bigint' ? value.toString() : value)

export const toJson = (value: unknown): string => JSON.stringify(value, replacer, 2)

export function printResult(summary: string, data: Record<string, unknown> = {}): void {
  process.stdout.write(toJson({ ok: true, summary, ...data }) + '\n')
}

export function printError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  const hint = error instanceof CliError ? error.hint : undefined
  process.stdout.write(toJson({ ok: false, error: message, ...(hint ? { hint } : {}) }) + '\n')
}
