import js from '@eslint/js'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: ['dist', 'agent/dist', 'contracts/artifacts', 'contracts/cache', 'contracts/typechain-types'],
  },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ['**/*.{ts,tsx}'],
    languageOptions: { ecmaVersion: 2022, globals: globals.browser },
    plugins: { 'react-hooks': reactHooks },
    rules: reactHooks.configs.recommended.rules,
  },
  { files: ['agent/**/*.ts'], languageOptions: { globals: globals.node } },
  // Hardhat config, deploy script and mocha tests of the Solidity package.
  { files: ['contracts/**/*.ts'], languageOptions: { globals: { ...globals.node, ...globals.mocha } } },
)
