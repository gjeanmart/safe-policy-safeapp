import '@nomicfoundation/hardhat-toolbox'
import { type HardhatUserConfig, vars } from 'hardhat/config'

/**
 * Sepolia deployment reads its secrets from Hardhat configuration variables (stored outside the
 * repo): `npx hardhat vars set SEPOLIA_RPC_URL` and `npx hardhat vars set SEPOLIA_DEPLOYER_KEY`.
 */
const sepoliaKey = vars.has('SEPOLIA_DEPLOYER_KEY') ? [vars.get('SEPOLIA_DEPLOYER_KEY')] : []

const config: HardhatUserConfig = {
  solidity: {
    // Same compiler settings as safe-research/policy-engine.
    version: '0.8.30',
    settings: { evmVersion: 'cancun', optimizer: { enabled: true, runs: 10_000 }, viaIR: true },
  },
  networks: {
    sepolia: {
      url: vars.get('SEPOLIA_RPC_URL', 'https://ethereum-sepolia-rpc.publicnode.com'),
      accounts: sepoliaKey,
    },
  },
}

export default config
