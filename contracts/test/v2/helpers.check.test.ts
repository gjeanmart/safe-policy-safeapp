import { ethers } from 'hardhat'
import { expectAnyRevert, expectEvent, expectRevert } from './helpers'

describe('V2 test helpers', () => {
  it('matches custom errors and events', async () => {
    const [deployer] = await ethers.getSigners()
    const token = await ethers.deployContract('E2eToken')
    const tx = await token.mint(deployer.address, 1n)
    await expectEvent(tx, token, 'Transfer')

    const config = await ethers.deployContract('PolicyGuardConfig')
    const batch = await ethers.deployContract('EngineMultiSend')
    const deployed = await ethers.deployContract('PolicyGuard', [
      [await batch.getAddress()],
      await config.getAddress(),
    ])
    // The guard's own ABI is partial (Config is reached through its fallback): use the full interface.
    const guard = await ethers.getContractAt('IPolicyGuard', await deployed.getAddress())
    await expectRevert(
      ethers.deployContract('PolicyGuard', [[], await config.getAddress()]),
      guard,
      'InvalidDeployment',
      [],
    )
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
