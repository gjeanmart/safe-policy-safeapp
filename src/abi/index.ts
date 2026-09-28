import { parseAbi } from 'viem'

export const safeAbi = parseAbi([
  'function VERSION() view returns (string)',
  'function getOwners() view returns (address[])',
  'function getThreshold() view returns (uint256)',
  'function getModulesPaginated(address start, uint256 pageSize) view returns (address[] array, address next)',
  'function enableModule(address module)',
  'function disableModule(address prevModule, address module)',
  'function setGuard(address guard)',
  'function setModuleGuard(address moduleGuard)',
  'function execTransactionFromModule(address to, uint256 value, bytes data, uint8 operation) returns (bool success)',
  'function nonce() view returns (uint256)',
  'function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool success)',
])

export const guardAbi = parseAbi([
  'struct Configuration { address target; bytes4 selector; uint8 operation; address policy; bytes data; }',
  'function DELAY() view returns (uint256)',
  'function EXPIRY() view returns (uint256)',
  'function rootConfigured(address safe, bytes32 root) view returns (uint256)',
  'function getPolicy(address safe, address to, bytes data, uint8 operation) view returns (uint256 access, address policy)',
  'function configureImmediately(Configuration[] configurations)',
  'function requestConfiguration(bytes32 configureRoot)',
  'function invalidateRoot(bytes32 configureRoot)',
  'function applyConfiguration(Configuration[] configurations)',
  'event PolicyConfirmed(address indexed safe, address indexed target, bytes4 selector, uint8 operation, address policy, bytes data)',
  'event RootApplied(address indexed safe, bytes32 indexed root)',
  'event RootInvalidated(address indexed safe, bytes32 indexed root)',
])

/**
 * Every custom error that can bubble up from a module transaction: the guard, the engine and the
 * deployed policies. Merged into call ABIs so viem decodes reverts by name.
 */
export const policyErrorsAbi = parseAbi([
  // SafePolicyGuard / PolicyEngine
  'error AccessDenied(address policy)',
  'error PolicyReverted(address policy, bytes reason)',
  'error InvalidSelector()',
  'error Reentrancy()',
  'error NotChecking()',
  'error CrossSafeCheck()',
  'error ModuleConfigurationDenied()',
  'error PolicyConfigurationFailed()',
  'error GuardTargetDenied()',
  'error RootAlreadyConfigured(bytes32 root)',
  'error RootNotConfigured(bytes32 root)',
  'error RootConfigurationPending()',
  'error RootConfigurationExpired()',
  'error GuardAlreadyEnabled()',
  'error NonZeroGasPrice()',
  'error NonZeroSafeTxGas()',
  'error ExecutionFailed()',
  'error ModuleExecutionFailed()',
  // Policies
  'error Unauthorized()',
  'error InvalidTransfer()',
  'error InvalidApproval()',
  'error InvalidOperation()',
  'error InvalidModule()',
  'error UnauthorizedModule()',
  'error InvalidMultiSend()',
  'error NoCosignerConfigured()',
  'error CoSignatureAlreadySpent()',
])

export const policyViewsAbi = parseAbi([
  'function getRecipientPermission(address policyGuard, address safe, address token, address recipient) view returns (uint8)',
  'function getSpenderPermission(address policyGuard, address safe, address token, address spender) view returns (uint8)',
  'function isModuleAllowed(address policyGuard, address safe, address module) view returns (bool)',
])

export const erc20Abi = parseAbi([
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function approve(address spender, uint256 amount) returns (bool)',
])

export const cowSettlementAbi = parseAbi(['function setPreSignature(bytes orderUid, bool signed)'])
