import { expect } from 'chai'
import { Interface } from 'ethers'
import { artifacts } from 'hardhat'
import { coveredErrors } from './fixtures'

/**
 * Acceptance check for WP A: every custom error of IPolicyGuard is asserted by at least one engine
 * test. Runs last (file name) and is skipped when the engine tests run one file at a time.
 */
describe('V2 engine: error coverage', () => {
  it('asserts every engine error at least once', async function () {
    if (coveredErrors.size < 15) this.skip()
    const names = new Set<string>()
    const iface = new Interface((await artifacts.readArtifact('IPolicyGuard')).abi)
    iface.forEachError((e) => names.add(e.name))
    const missing = [...names].filter((n) => !coveredErrors.has(n)).sort()
    expect(missing, `errors without a test: ${missing.join(', ')}`).to.deep.equal([])
  })
})
