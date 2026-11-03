import { ethers } from 'hardhat'
import { expectAnyRevert, expectEvent, expectRevert } from './helpers'

describe('V2 test helpers', () => {
  it('matches custom errors and events', async () => {
    const [deployer] = await ethers.getSigners()
    const token = await ethers.deployContract('E2eToken')
    const tx = await token.mint(deployer.address, 1n)
    await expectEvent(tx, token, 'Transfer')

    const guard = await ethers.deployContract('PolicyGuard')
    await expectRevert(guard.levelsUsed(deployer.address), guard, 'NotImplemented', [])
    await expectAnyRevert(ethers.provider.call({ to: await guard.getAddress(), data: '0xdeadbeef' }))
    const id = ethers.id('a')
    await expectRevert(
      Promise.reject({ data: guard.interface.encodeErrorResult('Denied', [0, id]) }),
      guard,
      'Denied',
      [0, id],
    )
  })
})
