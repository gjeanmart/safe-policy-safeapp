import { expect } from 'chai'
import { ethers } from 'hardhat'
import { expectAnyRevert, expectEvent, expectRevert } from './helpers'

describe('V2 test helpers', () => {
  it('matches custom errors and events from MockPolicyV2', async () => {
    const mock = await ethers.deployContract('MockPolicyV2', [0])
    const [, safe] = await ethers.getSigners()
    const id = ethers.id('a')
    const scope = { actor: ethers.ZeroAddress, to: ethers.ZeroAddress, selector: '0x00000000', callMatch: 0 }
    const settings = ethers.AbiCoder.defaultAbiCoder().encode(['uint8', 'uint256'], [1, 0])
    const tx = await mock.configure(safe.address, id, scope, 1, settings)
    await expectEvent(tx, mock, 'Configured')
    expect(mock.interface.getError('MockDenied')).to.not.equal(null)
    await expectAnyRevert(ethers.provider.call({ to: await mock.getAddress(), data: '0xdeadbeef' }))
    await expectRevert(
      Promise.reject({ data: mock.interface.encodeErrorResult('MockDenied', [id]) }),
      mock,
      'MockDenied',
      [id],
    )
  })
})
