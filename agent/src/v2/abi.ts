// Generated from the compiled rev 3 interfaces (contracts/contracts/v2/interfaces): compile in
// contracts/, then regenerate rather than edit. The app keeps its own copy in src/lib/v2; the
// duplication is deliberate while both move.

/** `type(IPolicyGuard).interfaceId`: a rev 3 engine answers `supportsInterface` with true for it. */
export const POLICY_GUARD_INTERFACE_ID = '0x0f8d6033'

/** `type(ITimelockPolicy).interfaceId`: the only policy that reports its own interface. */
export const TIMELOCK_POLICY_INTERFACE_ID = '0x01a547c8'

/** IPolicyGuard: hooks, configure, matches, views. */
export const policyGuardAbi = [
  {
    inputs: [],
    name: 'AllowNotPerActor',
    type: 'error',
  },
  {
    inputs: [],
    name: 'BatchTooLarge',
    type: 'error',
  },
  {
    inputs: [],
    name: 'DelegateCallNotExact',
    type: 'error',
  },
  {
    inputs: [
      {
        name: 'callIndex',
        type: 'uint16',
      },
      {
        name: 'attachmentId',
        type: 'bytes32',
      },
    ],
    name: 'Denied',
    type: 'error',
  },
  {
    inputs: [],
    name: 'ExecutionFailed',
    type: 'error',
  },
  {
    inputs: [
      {
        name: 'callIndex',
        type: 'uint16',
      },
    ],
    name: 'GuardTargetDenied',
    type: 'error',
  },
  {
    inputs: [],
    name: 'InvalidDeployment',
    type: 'error',
  },
  {
    inputs: [
      {
        name: 'opMask',
        type: 'uint8',
      },
    ],
    name: 'InvalidOpMask',
    type: 'error',
  },
  {
    inputs: [
      {
        name: 'policy',
        type: 'address',
      },
    ],
    name: 'InvalidPolicy',
    type: 'error',
  },
  {
    inputs: [],
    name: 'InvalidScope',
    type: 'error',
  },
  {
    inputs: [
      {
        name: 'callIndex',
        type: 'uint16',
      },
    ],
    name: 'InvalidSelector',
    type: 'error',
  },
  {
    inputs: [],
    name: 'MalformedBatch',
    type: 'error',
  },
  {
    inputs: [],
    name: 'ModuleExecutionFailed',
    type: 'error',
  },
  {
    inputs: [
      {
        name: 'callIndex',
        type: 'uint16',
      },
    ],
    name: 'NestedBatch',
    type: 'error',
  },
  {
    inputs: [],
    name: 'NonZeroGasPrice',
    type: 'error',
  },
  {
    inputs: [],
    name: 'NonZeroSafeTxGas',
    type: 'error',
  },
  {
    inputs: [
      {
        name: 'attachmentId',
        type: 'bytes32',
      },
    ],
    name: 'NotAttached',
    type: 'error',
  },
  {
    inputs: [
      {
        name: 'callIndex',
        type: 'uint16',
      },
      {
        name: 'to',
        type: 'address',
      },
      {
        name: 'selector',
        type: 'bytes4',
      },
      {
        name: 'operation',
        type: 'uint8',
      },
    ],
    name: 'NotGranted',
    type: 'error',
  },
  {
    inputs: [
      {
        name: 'policy',
        type: 'address',
      },
      {
        name: 'reason',
        type: 'bytes',
      },
    ],
    name: 'PolicyConfigurationFailed',
    type: 'error',
  },
  {
    inputs: [
      {
        name: 'policy',
        type: 'address',
      },
      {
        name: 'reason',
        type: 'bytes',
      },
    ],
    name: 'PolicyDenied',
    type: 'error',
  },
  {
    inputs: [],
    name: 'Reentrancy',
    type: 'error',
  },
  {
    inputs: [
      {
        name: 'scopeKey',
        type: 'bytes32',
      },
    ],
    name: 'TooManyAttachments',
    type: 'error',
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        name: 'safe',
        type: 'address',
      },
      {
        indexed: true,
        name: 'attachmentId',
        type: 'bytes32',
      },
      {
        indexed: true,
        name: 'scopeKey',
        type: 'bytes32',
      },
      {
        indexed: false,
        name: 'scope',
        type: 'tuple',
        components: [
          {
            name: 'actor',
            type: 'address',
          },
          {
            name: 'to',
            type: 'address',
          },
          {
            name: 'selector',
            type: 'bytes4',
          },
          {
            name: 'callMatch',
            type: 'uint8',
          },
        ],
      },
      {
        indexed: false,
        name: 'kind',
        type: 'uint8',
      },
      {
        indexed: false,
        name: 'policy',
        type: 'address',
      },
      {
        indexed: false,
        name: 'opMask',
        type: 'uint8',
      },
      {
        indexed: false,
        name: 'settings',
        type: 'bytes',
      },
    ],
    name: 'Attached',
    type: 'event',
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        name: 'safe',
        type: 'address',
      },
      {
        indexed: true,
        name: 'attachmentId',
        type: 'bytes32',
      },
      {
        indexed: true,
        name: 'scopeKey',
        type: 'bytes32',
      },
    ],
    name: 'Detached',
    type: 'event',
  },
  {
    inputs: [
      {
        name: 'scopeKey',
        type: 'bytes32',
      },
      {
        name: 'kind',
        type: 'uint8',
      },
      {
        name: 'policy',
        type: 'address',
      },
    ],
    name: 'attachmentId',
    outputs: [
      {
        name: '',
        type: 'bytes32',
      },
    ],
    stateMutability: 'pure',
    type: 'function',
  },
  {
    inputs: [
      {
        name: 'hash',
        type: 'bytes32',
      },
      {
        name: 'success',
        type: 'bool',
      },
    ],
    name: 'checkAfterExecution',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      {
        name: 'txHash',
        type: 'bytes32',
      },
      {
        name: 'success',
        type: 'bool',
      },
    ],
    name: 'checkAfterModuleExecution',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      {
        name: 'to',
        type: 'address',
      },
      {
        name: 'value',
        type: 'uint256',
      },
      {
        name: 'data',
        type: 'bytes',
      },
      {
        name: 'operation',
        type: 'uint8',
      },
      {
        name: 'module',
        type: 'address',
      },
    ],
    name: 'checkModuleTransaction',
    outputs: [
      {
        name: 'moduleTxHash',
        type: 'bytes32',
      },
    ],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      {
        name: 'to',
        type: 'address',
      },
      {
        name: 'value',
        type: 'uint256',
      },
      {
        name: 'data',
        type: 'bytes',
      },
      {
        name: 'operation',
        type: 'uint8',
      },
      {
        name: 'safeTxGas',
        type: 'uint256',
      },
      {
        name: 'baseGas',
        type: 'uint256',
      },
      {
        name: 'gasPrice',
        type: 'uint256',
      },
      {
        name: 'gasToken',
        type: 'address',
      },
      {
        name: 'refundReceiver',
        type: 'address',
      },
      {
        name: 'signatures',
        type: 'bytes',
      },
      {
        name: 'msgSender',
        type: 'address',
      },
    ],
    name: 'checkTransaction',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      {
        name: 'changes',
        type: 'tuple[]',
        components: [
          {
            name: 'detach',
            type: 'bool',
          },
          {
            name: 'scope',
            type: 'tuple',
            components: [
              {
                name: 'actor',
                type: 'address',
              },
              {
                name: 'to',
                type: 'address',
              },
              {
                name: 'selector',
                type: 'bytes4',
              },
              {
                name: 'callMatch',
                type: 'uint8',
              },
            ],
          },
          {
            name: 'kind',
            type: 'uint8',
          },
          {
            name: 'policy',
            type: 'address',
          },
          {
            name: 'opMask',
            type: 'uint8',
          },
          {
            name: 'settings',
            type: 'bytes',
          },
        ],
      },
    ],
    name: 'configure',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      {
        name: 'safe',
        type: 'address',
      },
      {
        name: 'attachmentId',
        type: 'bytes32',
      },
    ],
    name: 'getAttachment',
    outputs: [
      {
        name: 'exists',
        type: 'bool',
      },
      {
        name: 'attachment',
        type: 'tuple',
        components: [
          {
            name: 'attachmentId',
            type: 'bytes32',
          },
          {
            name: 'scopeKey',
            type: 'bytes32',
          },
          {
            name: 'scope',
            type: 'tuple',
            components: [
              {
                name: 'actor',
                type: 'address',
              },
              {
                name: 'to',
                type: 'address',
              },
              {
                name: 'selector',
                type: 'bytes4',
              },
              {
                name: 'callMatch',
                type: 'uint8',
              },
            ],
          },
          {
            name: 'kind',
            type: 'uint8',
          },
          {
            name: 'policy',
            type: 'address',
          },
          {
            name: 'opMask',
            type: 'uint8',
          },
        ],
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      {
        name: 'safe',
        type: 'address',
      },
    ],
    name: 'getAttachments',
    outputs: [
      {
        name: '',
        type: 'tuple[]',
        components: [
          {
            name: 'attachmentId',
            type: 'bytes32',
          },
          {
            name: 'scopeKey',
            type: 'bytes32',
          },
          {
            name: 'scope',
            type: 'tuple',
            components: [
              {
                name: 'actor',
                type: 'address',
              },
              {
                name: 'to',
                type: 'address',
              },
              {
                name: 'selector',
                type: 'bytes4',
              },
              {
                name: 'callMatch',
                type: 'uint8',
              },
            ],
          },
          {
            name: 'kind',
            type: 'uint8',
          },
          {
            name: 'policy',
            type: 'address',
          },
          {
            name: 'opMask',
            type: 'uint8',
          },
        ],
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      {
        name: 'safe',
        type: 'address',
      },
      {
        name: 'scopeKey',
        type: 'bytes32',
      },
    ],
    name: 'getScopeAttachments',
    outputs: [
      {
        name: '',
        type: 'tuple[]',
        components: [
          {
            name: 'attachmentId',
            type: 'bytes32',
          },
          {
            name: 'scopeKey',
            type: 'bytes32',
          },
          {
            name: 'scope',
            type: 'tuple',
            components: [
              {
                name: 'actor',
                type: 'address',
              },
              {
                name: 'to',
                type: 'address',
              },
              {
                name: 'selector',
                type: 'bytes4',
              },
              {
                name: 'callMatch',
                type: 'uint8',
              },
            ],
          },
          {
            name: 'kind',
            type: 'uint8',
          },
          {
            name: 'policy',
            type: 'address',
          },
          {
            name: 'opMask',
            type: 'uint8',
          },
        ],
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      {
        name: 'safe',
        type: 'address',
      },
    ],
    name: 'getScopes',
    outputs: [
      {
        name: 'keys',
        type: 'bytes32[]',
      },
      {
        name: 'scopes',
        type: 'tuple[]',
        components: [
          {
            name: 'actor',
            type: 'address',
          },
          {
            name: 'to',
            type: 'address',
          },
          {
            name: 'selector',
            type: 'bytes4',
          },
          {
            name: 'callMatch',
            type: 'uint8',
          },
        ],
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      {
        name: 'target',
        type: 'address',
      },
    ],
    name: 'isTrustedBatch',
    outputs: [
      {
        name: '',
        type: 'bool',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      {
        name: 'safe',
        type: 'address',
      },
    ],
    name: 'levelsUsed',
    outputs: [
      {
        name: '',
        type: 'uint8',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      {
        name: 'safe',
        type: 'address',
      },
      {
        name: 'actor',
        type: 'address',
      },
      {
        name: 'to',
        type: 'address',
      },
      {
        name: 'value',
        type: 'uint256',
      },
      {
        name: 'data',
        type: 'bytes',
      },
      {
        name: 'operation',
        type: 'uint8',
      },
    ],
    name: 'matches',
    outputs: [
      {
        name: 'calls',
        type: 'tuple[]',
        components: [
          {
            name: 'to',
            type: 'address',
          },
          {
            name: 'value',
            type: 'uint256',
          },
          {
            name: 'data',
            type: 'bytes',
          },
          {
            name: 'operation',
            type: 'uint8',
          },
        ],
      },
      {
        name: 'found',
        type: 'tuple[]',
        components: [
          {
            name: 'callIndex',
            type: 'uint16',
          },
          {
            name: 'level',
            type: 'uint8',
          },
          {
            name: 'attachmentId',
            type: 'bytes32',
          },
          {
            name: 'kind',
            type: 'uint8',
          },
          {
            name: 'policy',
            type: 'address',
          },
          {
            name: 'opMask',
            type: 'uint8',
          },
          {
            name: 'counts',
            type: 'bool',
          },
        ],
      },
      {
        name: 'engineError',
        type: 'bytes',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      {
        name: 'safe',
        type: 'address',
      },
      {
        name: 'actor',
        type: 'address',
      },
      {
        name: 'to',
        type: 'address',
      },
      {
        name: 'value',
        type: 'uint256',
      },
      {
        name: 'data',
        type: 'bytes',
      },
      {
        name: 'operation',
        type: 'uint8',
      },
    ],
    name: 'moduleCallHash',
    outputs: [
      {
        name: '',
        type: 'bytes32',
      },
    ],
    stateMutability: 'pure',
    type: 'function',
  },
  {
    inputs: [
      {
        name: 'scope',
        type: 'tuple',
        components: [
          {
            name: 'actor',
            type: 'address',
          },
          {
            name: 'to',
            type: 'address',
          },
          {
            name: 'selector',
            type: 'bytes4',
          },
          {
            name: 'callMatch',
            type: 'uint8',
          },
        ],
      },
    ],
    name: 'scopeKey',
    outputs: [
      {
        name: '',
        type: 'bytes32',
      },
    ],
    stateMutability: 'pure',
    type: 'function',
  },
  {
    inputs: [
      {
        name: 'interfaceId',
        type: 'bytes4',
      },
    ],
    name: 'supportsInterface',
    outputs: [
      {
        name: '',
        type: 'bool',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'trustedBatches',
    outputs: [
      {
        name: '',
        type: 'address[]',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
] as const

/** IPolicy: what the engine calls on every policy. */
export const policyAbi = [
  {
    inputs: [
      {
        name: 'ctx',
        type: 'tuple',
        components: [
          {
            name: 'safe',
            type: 'address',
          },
          {
            name: 'actor',
            type: 'address',
          },
          {
            name: 'txHash',
            type: 'bytes32',
          },
        ],
      },
      {
        name: 'calls',
        type: 'tuple[]',
        components: [
          {
            name: 'to',
            type: 'address',
          },
          {
            name: 'value',
            type: 'uint256',
          },
          {
            name: 'data',
            type: 'bytes',
          },
          {
            name: 'operation',
            type: 'uint8',
          },
        ],
      },
      {
        name: 'matches',
        type: 'tuple[]',
        components: [
          {
            name: 'callIndex',
            type: 'uint16',
          },
          {
            name: 'level',
            type: 'uint8',
          },
          {
            name: 'attachmentId',
            type: 'bytes32',
          },
        ],
      },
    ],
    name: 'check',
    outputs: [
      {
        name: 'magicValue',
        type: 'bytes4',
      },
    ],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      {
        name: 'safe',
        type: 'address',
      },
      {
        name: 'attachmentId',
        type: 'bytes32',
      },
      {
        name: 'scope',
        type: 'tuple',
        components: [
          {
            name: 'actor',
            type: 'address',
          },
          {
            name: 'to',
            type: 'address',
          },
          {
            name: 'selector',
            type: 'bytes4',
          },
          {
            name: 'callMatch',
            type: 'uint8',
          },
        ],
      },
      {
        name: 'opMask',
        type: 'uint8',
      },
      {
        name: 'settings',
        type: 'bytes',
      },
    ],
    name: 'configure',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      {
        name: 'interfaceId',
        type: 'bytes4',
      },
    ],
    name: 'supportsInterface',
    outputs: [
      {
        name: '',
        type: 'bool',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      {
        name: 'safe',
        type: 'address',
      },
    ],
    name: 'validate',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
] as const

/** ITimelockPolicy: schedule, cancel, freeze, lift, views. */
export const timelockPolicyAbi = [
  {
    inputs: [
      {
        name: 'txHash',
        type: 'bytes32',
      },
    ],
    name: 'AlreadyScheduled',
    type: 'error',
  },
  {
    inputs: [
      {
        name: 'attachmentId',
        type: 'bytes32',
      },
      {
        name: 'until',
        type: 'uint64',
      },
    ],
    name: 'AttachmentFrozen',
    type: 'error',
  },
  {
    inputs: [
      {
        name: 'txHash',
        type: 'bytes32',
      },
    ],
    name: 'CancelledTransaction',
    type: 'error',
  },
  {
    inputs: [],
    name: 'GasFieldsNotZero',
    type: 'error',
  },
  {
    inputs: [],
    name: 'InvalidSettings',
    type: 'error',
  },
  {
    inputs: [
      {
        name: 'txHash',
        type: 'bytes32',
      },
    ],
    name: 'NoTimelock',
    type: 'error',
  },
  {
    inputs: [
      {
        name: 'account',
        type: 'address',
      },
    ],
    name: 'NotCanceller',
    type: 'error',
  },
  {
    inputs: [
      {
        name: 'attachmentId',
        type: 'bytes32',
      },
    ],
    name: 'NotFrozen',
    type: 'error',
  },
  {
    inputs: [
      {
        name: 'attachmentId',
        type: 'bytes32',
      },
    ],
    name: 'NotGuardian',
    type: 'error',
  },
  {
    inputs: [
      {
        name: 'attachmentId',
        type: 'bytes32',
      },
    ],
    name: 'NotGuardianOrLifter',
    type: 'error',
  },
  {
    inputs: [
      {
        name: 'txHash',
        type: 'bytes32',
      },
    ],
    name: 'NotOwnersQueue',
    type: 'error',
  },
  {
    inputs: [
      {
        name: 'txHash',
        type: 'bytes32',
      },
      {
        name: 'readyAt',
        type: 'uint256',
      },
    ],
    name: 'NotReady',
    type: 'error',
  },
  {
    inputs: [
      {
        name: 'txHash',
        type: 'bytes32',
      },
    ],
    name: 'NotScheduled',
    type: 'error',
  },
  {
    inputs: [
      {
        name: 'txHash',
        type: 'bytes32',
      },
      {
        name: 'expiredAt',
        type: 'uint256',
      },
    ],
    name: 'ScheduleExpired',
    type: 'error',
  },
  {
    inputs: [
      {
        name: 'nonce',
        type: 'uint256',
      },
      {
        name: 'current',
        type: 'uint256',
      },
    ],
    name: 'StaleNonce',
    type: 'error',
  },
  {
    inputs: [
      {
        name: 'to',
        type: 'address',
      },
      {
        name: 'selector',
        type: 'bytes4',
      },
      {
        name: 'op',
        type: 'uint8',
      },
      {
        name: 'delay',
        type: 'uint32',
      },
    ],
    name: 'TimelockNotCoveringConfiguration',
    type: 'error',
  },
  {
    inputs: [
      {
        name: 'txHash',
        type: 'bytes32',
      },
      {
        name: 'attachmentId',
        type: 'bytes32',
      },
    ],
    name: 'VoidedByFreeze',
    type: 'error',
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        name: 'engine',
        type: 'address',
      },
      {
        indexed: true,
        name: 'safe',
        type: 'address',
      },
      {
        indexed: true,
        name: 'txHash',
        type: 'bytes32',
      },
      {
        indexed: false,
        name: 'by',
        type: 'address',
      },
    ],
    name: 'Cancelled',
    type: 'event',
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        name: 'engine',
        type: 'address',
      },
      {
        indexed: true,
        name: 'safe',
        type: 'address',
      },
      {
        indexed: true,
        name: 'txHash',
        type: 'bytes32',
      },
    ],
    name: 'Executed',
    type: 'event',
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        name: 'engine',
        type: 'address',
      },
      {
        indexed: true,
        name: 'safe',
        type: 'address',
      },
      {
        indexed: true,
        name: 'attachmentId',
        type: 'bytes32',
      },
      {
        indexed: false,
        name: 'guardian',
        type: 'address',
      },
      {
        indexed: false,
        name: 'until',
        type: 'uint64',
      },
    ],
    name: 'FreezeSkipped',
    type: 'event',
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        name: 'engine',
        type: 'address',
      },
      {
        indexed: true,
        name: 'safe',
        type: 'address',
      },
      {
        indexed: true,
        name: 'attachmentId',
        type: 'bytes32',
      },
      {
        indexed: false,
        name: 'guardian',
        type: 'address',
      },
      {
        indexed: false,
        name: 'until',
        type: 'uint64',
      },
    ],
    name: 'Frozen',
    type: 'event',
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        name: 'engine',
        type: 'address',
      },
      {
        indexed: true,
        name: 'safe',
        type: 'address',
      },
      {
        indexed: true,
        name: 'attachmentId',
        type: 'bytes32',
      },
      {
        indexed: false,
        name: 'by',
        type: 'address',
      },
      {
        indexed: false,
        name: 'cooldownUntil',
        type: 'uint64',
      },
    ],
    name: 'Lifted',
    type: 'event',
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        name: 'engine',
        type: 'address',
      },
      {
        indexed: true,
        name: 'safe',
        type: 'address',
      },
      {
        indexed: true,
        name: 'txHash',
        type: 'bytes32',
      },
      {
        indexed: false,
        name: 'actor',
        type: 'address',
      },
      {
        indexed: false,
        name: 'to',
        type: 'address',
      },
      {
        indexed: false,
        name: 'value',
        type: 'uint256',
      },
      {
        indexed: false,
        name: 'data',
        type: 'bytes',
      },
      {
        indexed: false,
        name: 'operation',
        type: 'uint8',
      },
      {
        indexed: false,
        name: 'nonce',
        type: 'uint256',
      },
      {
        indexed: false,
        name: 'readyAt',
        type: 'uint256',
      },
      {
        indexed: false,
        name: 'isConfiguration',
        type: 'bool',
      },
    ],
    name: 'Scheduled',
    type: 'event',
  },
  {
    inputs: [],
    name: 'COOLDOWN',
    outputs: [
      {
        name: '',
        type: 'uint256',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'MAX_FREEZE',
    outputs: [
      {
        name: '',
        type: 'uint256',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      {
        name: 'engine',
        type: 'address',
      },
      {
        name: 'safe',
        type: 'address',
      },
      {
        name: 'actor',
        type: 'address',
      },
    ],
    name: 'actorWindow',
    outputs: [
      {
        name: 'end',
        type: 'uint64',
      },
      {
        name: 'cooldownUntil',
        type: 'uint64',
      },
      {
        name: 'frozen',
        type: 'uint32',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      {
        name: 'engine',
        type: 'address',
      },
      {
        name: 'safe',
        type: 'address',
      },
      {
        name: 'txHash',
        type: 'bytes32',
      },
    ],
    name: 'cancel',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      {
        name: 'engine',
        type: 'address',
      },
      {
        name: 'safe',
        type: 'address',
      },
      {
        name: 'txHash',
        type: 'bytes32',
      },
      {
        name: 'signatures',
        type: 'bytes',
      },
    ],
    name: 'cancelAsOwners',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      {
        name: 'engine',
        type: 'address',
      },
      {
        name: 'safe',
        type: 'address',
      },
      {
        name: 'txHash',
        type: 'bytes32',
      },
    ],
    name: 'cancelDigest',
    outputs: [
      {
        name: '',
        type: 'bytes32',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      {
        name: 'ctx',
        type: 'tuple',
        components: [
          {
            name: 'safe',
            type: 'address',
          },
          {
            name: 'actor',
            type: 'address',
          },
          {
            name: 'txHash',
            type: 'bytes32',
          },
        ],
      },
      {
        name: 'calls',
        type: 'tuple[]',
        components: [
          {
            name: 'to',
            type: 'address',
          },
          {
            name: 'value',
            type: 'uint256',
          },
          {
            name: 'data',
            type: 'bytes',
          },
          {
            name: 'operation',
            type: 'uint8',
          },
        ],
      },
      {
        name: 'matches',
        type: 'tuple[]',
        components: [
          {
            name: 'callIndex',
            type: 'uint16',
          },
          {
            name: 'level',
            type: 'uint8',
          },
          {
            name: 'attachmentId',
            type: 'bytes32',
          },
        ],
      },
    ],
    name: 'check',
    outputs: [
      {
        name: 'magicValue',
        type: 'bytes4',
      },
    ],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      {
        name: 'safe',
        type: 'address',
      },
      {
        name: 'attachmentId',
        type: 'bytes32',
      },
      {
        name: 'scope',
        type: 'tuple',
        components: [
          {
            name: 'actor',
            type: 'address',
          },
          {
            name: 'to',
            type: 'address',
          },
          {
            name: 'selector',
            type: 'bytes4',
          },
          {
            name: 'callMatch',
            type: 'uint8',
          },
        ],
      },
      {
        name: 'opMask',
        type: 'uint8',
      },
      {
        name: 'settings',
        type: 'bytes',
      },
    ],
    name: 'configure',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      {
        name: 'engine',
        type: 'address',
      },
      {
        name: 'safe',
        type: 'address',
      },
      {
        name: 'attachmentId',
        type: 'bytes32',
      },
    ],
    name: 'configuredAt',
    outputs: [
      {
        name: '',
        type: 'uint256',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      {
        name: 'settings',
        type: 'tuple',
        components: [
          {
            name: 'delay',
            type: 'uint32',
          },
          {
            name: 'window',
            type: 'uint32',
          },
          {
            name: 'guardians',
            type: 'address[]',
          },
          {
            name: 'lifters',
            type: 'address[]',
          },
          {
            name: 'cancellers',
            type: 'address[]',
          },
        ],
      },
    ],
    name: 'encodeSettings',
    outputs: [
      {
        name: '',
        type: 'bytes',
      },
    ],
    stateMutability: 'pure',
    type: 'function',
  },
  {
    inputs: [
      {
        name: 'engine',
        type: 'address',
      },
      {
        name: 'safe',
        type: 'address',
      },
      {
        name: 'attachmentIds',
        type: 'bytes32[]',
      },
    ],
    name: 'freeze',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      {
        name: 'engine',
        type: 'address',
      },
      {
        name: 'safe',
        type: 'address',
      },
      {
        name: 'attachmentId',
        type: 'bytes32',
      },
    ],
    name: 'freezeState',
    outputs: [
      {
        name: 'frozenUntil',
        type: 'uint64',
      },
      {
        name: 'cooldownUntil',
        type: 'uint64',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      {
        name: 'engine',
        type: 'address',
      },
      {
        name: 'safe',
        type: 'address',
      },
      {
        name: 'txHash',
        type: 'bytes32',
      },
    ],
    name: 'getSchedule',
    outputs: [
      {
        name: '',
        type: 'tuple',
        components: [
          {
            name: 'actor',
            type: 'address',
          },
          {
            name: 'scheduledAt',
            type: 'uint64',
          },
          {
            name: 'isConfiguration',
            type: 'bool',
          },
          {
            name: 'attachmentIds',
            type: 'bytes32[]',
          },
        ],
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      {
        name: 'engine',
        type: 'address',
      },
      {
        name: 'safe',
        type: 'address',
      },
      {
        name: 'attachmentId',
        type: 'bytes32',
      },
    ],
    name: 'getSettings',
    outputs: [
      {
        name: '',
        type: 'tuple',
        components: [
          {
            name: 'delay',
            type: 'uint32',
          },
          {
            name: 'window',
            type: 'uint32',
          },
          {
            name: 'guardians',
            type: 'address[]',
          },
          {
            name: 'lifters',
            type: 'address[]',
          },
          {
            name: 'cancellers',
            type: 'address[]',
          },
        ],
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      {
        name: 'engine',
        type: 'address',
      },
      {
        name: 'safe',
        type: 'address',
      },
      {
        name: 'txHash',
        type: 'bytes32',
      },
    ],
    name: 'isCancelled',
    outputs: [
      {
        name: '',
        type: 'bool',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      {
        name: 'engine',
        type: 'address',
      },
      {
        name: 'safe',
        type: 'address',
      },
      {
        name: 'attachmentId',
        type: 'bytes32',
      },
    ],
    name: 'lift',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      {
        name: 'engine',
        type: 'address',
      },
      {
        name: 'safe',
        type: 'address',
      },
      {
        name: 'safeTx',
        type: 'tuple',
        components: [
          {
            name: 'to',
            type: 'address',
          },
          {
            name: 'value',
            type: 'uint256',
          },
          {
            name: 'data',
            type: 'bytes',
          },
          {
            name: 'operation',
            type: 'uint8',
          },
          {
            name: 'safeTxGas',
            type: 'uint256',
          },
          {
            name: 'baseGas',
            type: 'uint256',
          },
          {
            name: 'gasPrice',
            type: 'uint256',
          },
          {
            name: 'gasToken',
            type: 'address',
          },
          {
            name: 'refundReceiver',
            type: 'address',
          },
          {
            name: 'nonce',
            type: 'uint256',
          },
        ],
      },
      {
        name: 'signatures',
        type: 'bytes',
      },
    ],
    name: 'schedule',
    outputs: [
      {
        name: 'txHash',
        type: 'bytes32',
      },
    ],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      {
        name: 'engine',
        type: 'address',
      },
      {
        name: 'safe',
        type: 'address',
      },
      {
        name: 'to',
        type: 'address',
      },
      {
        name: 'value',
        type: 'uint256',
      },
      {
        name: 'data',
        type: 'bytes',
      },
      {
        name: 'operation',
        type: 'uint8',
      },
    ],
    name: 'scheduleModuleTx',
    outputs: [
      {
        name: 'txHash',
        type: 'bytes32',
      },
    ],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      {
        name: 'interfaceId',
        type: 'bytes4',
      },
    ],
    name: 'supportsInterface',
    outputs: [
      {
        name: '',
        type: 'bool',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      {
        name: 'safe',
        type: 'address',
      },
    ],
    name: 'validate',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
] as const

/** ILimitPolicy: budgets. */
export const limitPolicyAbi = [
  {
    inputs: [],
    name: 'InvalidSettings',
    type: 'error',
  },
  {
    inputs: [
      {
        name: 'callIndex',
        type: 'uint16',
      },
      {
        name: 'attachmentId',
        type: 'bytes32',
      },
      {
        name: 'token',
        type: 'address',
      },
      {
        name: 'requested',
        type: 'uint256',
      },
      {
        name: 'available',
        type: 'uint256',
      },
    ],
    name: 'LimitExceeded',
    type: 'error',
  },
  {
    inputs: [
      {
        name: 'callIndex',
        type: 'uint16',
      },
      {
        name: 'attachmentId',
        type: 'bytes32',
      },
      {
        name: 'token',
        type: 'address',
      },
      {
        name: 'selector',
        type: 'bytes4',
      },
    ],
    name: 'Unpriced',
    type: 'error',
  },
  {
    inputs: [
      {
        name: 'ctx',
        type: 'tuple',
        components: [
          {
            name: 'safe',
            type: 'address',
          },
          {
            name: 'actor',
            type: 'address',
          },
          {
            name: 'txHash',
            type: 'bytes32',
          },
        ],
      },
      {
        name: 'calls',
        type: 'tuple[]',
        components: [
          {
            name: 'to',
            type: 'address',
          },
          {
            name: 'value',
            type: 'uint256',
          },
          {
            name: 'data',
            type: 'bytes',
          },
          {
            name: 'operation',
            type: 'uint8',
          },
        ],
      },
      {
        name: 'matches',
        type: 'tuple[]',
        components: [
          {
            name: 'callIndex',
            type: 'uint16',
          },
          {
            name: 'level',
            type: 'uint8',
          },
          {
            name: 'attachmentId',
            type: 'bytes32',
          },
        ],
      },
    ],
    name: 'check',
    outputs: [
      {
        name: 'magicValue',
        type: 'bytes4',
      },
    ],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      {
        name: 'safe',
        type: 'address',
      },
      {
        name: 'attachmentId',
        type: 'bytes32',
      },
      {
        name: 'scope',
        type: 'tuple',
        components: [
          {
            name: 'actor',
            type: 'address',
          },
          {
            name: 'to',
            type: 'address',
          },
          {
            name: 'selector',
            type: 'bytes4',
          },
          {
            name: 'callMatch',
            type: 'uint8',
          },
        ],
      },
      {
        name: 'opMask',
        type: 'uint8',
      },
      {
        name: 'settings',
        type: 'bytes',
      },
    ],
    name: 'configure',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      {
        name: 'settings',
        type: 'tuple',
        components: [
          {
            name: 'limits',
            type: 'tuple[]',
            components: [
              {
                name: 'token',
                type: 'address',
              },
              {
                name: 'amount',
                type: 'uint128',
              },
              {
                name: 'period',
                type: 'uint64',
              },
            ],
          },
          {
            name: 'passUnpriced',
            type: 'bool',
          },
        ],
      },
    ],
    name: 'encodeSettings',
    outputs: [
      {
        name: '',
        type: 'bytes',
      },
    ],
    stateMutability: 'pure',
    type: 'function',
  },
  {
    inputs: [
      {
        name: 'engine',
        type: 'address',
      },
      {
        name: 'safe',
        type: 'address',
      },
      {
        name: 'attachmentId',
        type: 'bytes32',
      },
    ],
    name: 'getSettings',
    outputs: [
      {
        name: '',
        type: 'tuple',
        components: [
          {
            name: 'limits',
            type: 'tuple[]',
            components: [
              {
                name: 'token',
                type: 'address',
              },
              {
                name: 'amount',
                type: 'uint128',
              },
              {
                name: 'period',
                type: 'uint64',
              },
            ],
          },
          {
            name: 'passUnpriced',
            type: 'bool',
          },
        ],
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      {
        name: 'engine',
        type: 'address',
      },
      {
        name: 'safe',
        type: 'address',
      },
      {
        name: 'attachmentId',
        type: 'bytes32',
      },
      {
        name: 'token',
        type: 'address',
      },
    ],
    name: 'remaining',
    outputs: [
      {
        name: '',
        type: 'tuple',
        components: [
          {
            name: 'amount',
            type: 'uint256',
          },
          {
            name: 'spent',
            type: 'uint256',
          },
          {
            name: 'available',
            type: 'uint256',
          },
          {
            name: 'period',
            type: 'uint64',
          },
          {
            name: 'windowStart',
            type: 'uint64',
          },
        ],
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      {
        name: 'interfaceId',
        type: 'bytes4',
      },
    ],
    name: 'supportsInterface',
    outputs: [
      {
        name: '',
        type: 'bool',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      {
        name: 'safe',
        type: 'address',
      },
    ],
    name: 'validate',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
] as const

/** IArgsPolicy: conditions. */
export const argsPolicyAbi = [
  {
    inputs: [
      {
        name: 'callIndex',
        type: 'uint16',
      },
      {
        name: 'attachmentId',
        type: 'bytes32',
      },
      {
        name: 'constraintIndex',
        type: 'uint16',
      },
    ],
    name: 'ArgumentMissing',
    type: 'error',
  },
  {
    inputs: [
      {
        name: 'callIndex',
        type: 'uint16',
      },
      {
        name: 'attachmentId',
        type: 'bytes32',
      },
      {
        name: 'constraintIndex',
        type: 'uint16',
      },
    ],
    name: 'ConstraintFailed',
    type: 'error',
  },
  {
    inputs: [],
    name: 'InvalidSettings',
    type: 'error',
  },
  {
    inputs: [
      {
        name: 'callIndex',
        type: 'uint16',
      },
      {
        name: 'attachmentId',
        type: 'bytes32',
      },
    ],
    name: 'NoConstraint',
    type: 'error',
  },
  {
    inputs: [
      {
        name: 'ctx',
        type: 'tuple',
        components: [
          {
            name: 'safe',
            type: 'address',
          },
          {
            name: 'actor',
            type: 'address',
          },
          {
            name: 'txHash',
            type: 'bytes32',
          },
        ],
      },
      {
        name: 'calls',
        type: 'tuple[]',
        components: [
          {
            name: 'to',
            type: 'address',
          },
          {
            name: 'value',
            type: 'uint256',
          },
          {
            name: 'data',
            type: 'bytes',
          },
          {
            name: 'operation',
            type: 'uint8',
          },
        ],
      },
      {
        name: 'matches',
        type: 'tuple[]',
        components: [
          {
            name: 'callIndex',
            type: 'uint16',
          },
          {
            name: 'level',
            type: 'uint8',
          },
          {
            name: 'attachmentId',
            type: 'bytes32',
          },
        ],
      },
    ],
    name: 'check',
    outputs: [
      {
        name: 'magicValue',
        type: 'bytes4',
      },
    ],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      {
        name: 'safe',
        type: 'address',
      },
      {
        name: 'attachmentId',
        type: 'bytes32',
      },
      {
        name: 'scope',
        type: 'tuple',
        components: [
          {
            name: 'actor',
            type: 'address',
          },
          {
            name: 'to',
            type: 'address',
          },
          {
            name: 'selector',
            type: 'bytes4',
          },
          {
            name: 'callMatch',
            type: 'uint8',
          },
        ],
      },
      {
        name: 'opMask',
        type: 'uint8',
      },
      {
        name: 'settings',
        type: 'bytes',
      },
    ],
    name: 'configure',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      {
        name: 'settings',
        type: 'tuple',
        components: [
          {
            name: 'constraints',
            type: 'tuple[]',
            components: [
              {
                name: 'selector',
                type: 'bytes4',
              },
              {
                name: 'target',
                type: 'uint8',
              },
              {
                name: 'index',
                type: 'uint16',
              },
              {
                name: 'op',
                type: 'uint8',
              },
              {
                name: 'values',
                type: 'bytes32[]',
              },
            ],
          },
          {
            name: 'strict',
            type: 'bool',
          },
        ],
      },
    ],
    name: 'encodeSettings',
    outputs: [
      {
        name: '',
        type: 'bytes',
      },
    ],
    stateMutability: 'pure',
    type: 'function',
  },
  {
    inputs: [
      {
        name: 'engine',
        type: 'address',
      },
      {
        name: 'safe',
        type: 'address',
      },
      {
        name: 'attachmentId',
        type: 'bytes32',
      },
    ],
    name: 'getSettings',
    outputs: [
      {
        name: '',
        type: 'tuple',
        components: [
          {
            name: 'constraints',
            type: 'tuple[]',
            components: [
              {
                name: 'selector',
                type: 'bytes4',
              },
              {
                name: 'target',
                type: 'uint8',
              },
              {
                name: 'index',
                type: 'uint16',
              },
              {
                name: 'op',
                type: 'uint8',
              },
              {
                name: 'values',
                type: 'bytes32[]',
              },
            ],
          },
          {
            name: 'strict',
            type: 'bool',
          },
        ],
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      {
        name: 'interfaceId',
        type: 'bytes4',
      },
    ],
    name: 'supportsInterface',
    outputs: [
      {
        name: '',
        type: 'bool',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      {
        name: 'safe',
        type: 'address',
      },
    ],
    name: 'validate',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
] as const

/** ICoSignerPolicy: approvals. */
export const coSignerPolicyAbi = [
  {
    inputs: [
      {
        name: 'validUntil',
        type: 'uint64',
      },
    ],
    name: 'ApprovalExpired',
    type: 'error',
  },
  {
    inputs: [],
    name: 'InvalidSettings',
    type: 'error',
  },
  {
    inputs: [
      {
        name: 'approver',
        type: 'address',
      },
    ],
    name: 'InvalidSignature',
    type: 'error',
  },
  {
    inputs: [
      {
        name: 'attachmentId',
        type: 'bytes32',
      },
      {
        name: 'required',
        type: 'uint8',
      },
      {
        name: 'have',
        type: 'uint8',
      },
    ],
    name: 'MissingApprovals',
    type: 'error',
  },
  {
    inputs: [
      {
        name: 'digest',
        type: 'bytes32',
      },
    ],
    name: 'SignatureAlreadyUsed',
    type: 'error',
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        name: 'engine',
        type: 'address',
      },
      {
        indexed: true,
        name: 'safe',
        type: 'address',
      },
      {
        indexed: true,
        name: 'txHash',
        type: 'bytes32',
      },
      {
        indexed: false,
        name: 'approver',
        type: 'address',
      },
      {
        indexed: false,
        name: 'validUntil',
        type: 'uint64',
      },
    ],
    name: 'Approved',
    type: 'event',
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        name: 'engine',
        type: 'address',
      },
      {
        indexed: true,
        name: 'safe',
        type: 'address',
      },
      {
        indexed: true,
        name: 'txHash',
        type: 'bytes32',
      },
      {
        indexed: false,
        name: 'useCount',
        type: 'uint256',
      },
    ],
    name: 'Consumed',
    type: 'event',
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        name: 'engine',
        type: 'address',
      },
      {
        indexed: true,
        name: 'safe',
        type: 'address',
      },
      {
        indexed: true,
        name: 'txHash',
        type: 'bytes32',
      },
      {
        indexed: false,
        name: 'approver',
        type: 'address',
      },
    ],
    name: 'Revoked',
    type: 'event',
  },
  {
    inputs: [
      {
        name: 'engine',
        type: 'address',
      },
      {
        name: 'safe',
        type: 'address',
      },
      {
        name: 'txHash',
        type: 'bytes32',
      },
      {
        name: 'approver',
        type: 'address',
      },
      {
        name: 'validUntil',
        type: 'uint64',
      },
    ],
    name: 'approvalDigest',
    outputs: [
      {
        name: '',
        type: 'bytes32',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      {
        name: 'engine',
        type: 'address',
      },
      {
        name: 'safe',
        type: 'address',
      },
      {
        name: 'txHash',
        type: 'bytes32',
      },
      {
        name: 'validUntil',
        type: 'uint64',
      },
    ],
    name: 'approve',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      {
        name: 'engine',
        type: 'address',
      },
      {
        name: 'safe',
        type: 'address',
      },
      {
        name: 'txHash',
        type: 'bytes32',
      },
      {
        name: 'approver',
        type: 'address',
      },
      {
        name: 'validUntil',
        type: 'uint64',
      },
      {
        name: 'signature',
        type: 'bytes',
      },
    ],
    name: 'approveWithSig',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      {
        name: 'engine',
        type: 'address',
      },
      {
        name: 'safe',
        type: 'address',
      },
      {
        name: 'txHash',
        type: 'bytes32',
      },
      {
        name: 'approver',
        type: 'address',
      },
    ],
    name: 'approvedUntil',
    outputs: [
      {
        name: '',
        type: 'uint64',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      {
        name: 'ctx',
        type: 'tuple',
        components: [
          {
            name: 'safe',
            type: 'address',
          },
          {
            name: 'actor',
            type: 'address',
          },
          {
            name: 'txHash',
            type: 'bytes32',
          },
        ],
      },
      {
        name: 'calls',
        type: 'tuple[]',
        components: [
          {
            name: 'to',
            type: 'address',
          },
          {
            name: 'value',
            type: 'uint256',
          },
          {
            name: 'data',
            type: 'bytes',
          },
          {
            name: 'operation',
            type: 'uint8',
          },
        ],
      },
      {
        name: 'matches',
        type: 'tuple[]',
        components: [
          {
            name: 'callIndex',
            type: 'uint16',
          },
          {
            name: 'level',
            type: 'uint8',
          },
          {
            name: 'attachmentId',
            type: 'bytes32',
          },
        ],
      },
    ],
    name: 'check',
    outputs: [
      {
        name: 'magicValue',
        type: 'bytes4',
      },
    ],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      {
        name: 'safe',
        type: 'address',
      },
      {
        name: 'attachmentId',
        type: 'bytes32',
      },
      {
        name: 'scope',
        type: 'tuple',
        components: [
          {
            name: 'actor',
            type: 'address',
          },
          {
            name: 'to',
            type: 'address',
          },
          {
            name: 'selector',
            type: 'bytes4',
          },
          {
            name: 'callMatch',
            type: 'uint8',
          },
        ],
      },
      {
        name: 'opMask',
        type: 'uint8',
      },
      {
        name: 'settings',
        type: 'bytes',
      },
    ],
    name: 'configure',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      {
        name: 'settings',
        type: 'tuple',
        components: [
          {
            name: 'approvers',
            type: 'address[]',
          },
          {
            name: 'required',
            type: 'uint8',
          },
        ],
      },
    ],
    name: 'encodeSettings',
    outputs: [
      {
        name: '',
        type: 'bytes',
      },
    ],
    stateMutability: 'pure',
    type: 'function',
  },
  {
    inputs: [
      {
        name: 'engine',
        type: 'address',
      },
      {
        name: 'safe',
        type: 'address',
      },
      {
        name: 'attachmentId',
        type: 'bytes32',
      },
    ],
    name: 'getSettings',
    outputs: [
      {
        name: '',
        type: 'tuple',
        components: [
          {
            name: 'approvers',
            type: 'address[]',
          },
          {
            name: 'required',
            type: 'uint8',
          },
        ],
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      {
        name: 'engine',
        type: 'address',
      },
      {
        name: 'safe',
        type: 'address',
      },
      {
        name: 'txHash',
        type: 'bytes32',
      },
      {
        name: 'approver',
        type: 'address',
      },
    ],
    name: 'revision',
    outputs: [
      {
        name: '',
        type: 'uint256',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      {
        name: 'engine',
        type: 'address',
      },
      {
        name: 'safe',
        type: 'address',
      },
      {
        name: 'txHash',
        type: 'bytes32',
      },
    ],
    name: 'revoke',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      {
        name: 'interfaceId',
        type: 'bytes4',
      },
    ],
    name: 'supportsInterface',
    outputs: [
      {
        name: '',
        type: 'bool',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      {
        name: 'engine',
        type: 'address',
      },
      {
        name: 'safe',
        type: 'address',
      },
      {
        name: 'txHash',
        type: 'bytes32',
      },
    ],
    name: 'useCount',
    outputs: [
      {
        name: '',
        type: 'uint256',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      {
        name: 'safe',
        type: 'address',
      },
    ],
    name: 'validate',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
] as const

/** ISafenetPolicy: the views the agent reads, and its errors. */
export const safenetPolicyAbi = [
  {
    inputs: [],
    name: 'AttestationAlreadySpent',
    type: 'error',
  },
  {
    inputs: [
      {
        name: 'deadline',
        type: 'uint256',
      },
    ],
    name: 'AttestationExpired',
    type: 'error',
  },
  {
    inputs: [],
    name: 'InvalidAddress',
    type: 'error',
  },
  {
    inputs: [],
    name: 'InvalidSettings',
    type: 'error',
  },
  {
    inputs: [],
    name: 'MalformedAttestation',
    type: 'error',
  },
  {
    inputs: [],
    name: 'MissingAttestation',
    type: 'error',
  },
  {
    inputs: [],
    name: 'UntrustedAttestationKey',
    type: 'error',
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        name: 'engine',
        type: 'address',
      },
      {
        indexed: true,
        name: 'safe',
        type: 'address',
      },
      {
        indexed: true,
        name: 'txHash',
        type: 'bytes32',
      },
      {
        indexed: false,
        name: 'deadline',
        type: 'uint256',
      },
    ],
    name: 'Attested',
    type: 'event',
  },
  {
    inputs: [
      {
        name: 'engine',
        type: 'address',
      },
      {
        name: 'safe',
        type: 'address',
      },
      {
        name: 'txHash',
        type: 'bytes32',
      },
      {
        name: 'deadline',
        type: 'uint256',
      },
    ],
    name: 'attestationDigest',
    outputs: [
      {
        name: '',
        type: 'bytes32',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      {
        name: 'engine',
        type: 'address',
      },
      {
        name: 'safe',
        type: 'address',
      },
      {
        name: 'txHash',
        type: 'bytes32',
      },
    ],
    name: 'isAttested',
    outputs: [
      {
        name: '',
        type: 'bool',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      {
        name: 'interfaceId',
        type: 'bytes4',
      },
    ],
    name: 'supportsInterface',
    outputs: [
      {
        name: '',
        type: 'bool',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
] as const

/** Every custom error a rev 3 engine or policy can raise (for decoding). */
export const v2ErrorsAbi = [
  {
    inputs: [],
    name: 'AllowNotPerActor',
    type: 'error',
  },
  {
    inputs: [],
    name: 'BatchTooLarge',
    type: 'error',
  },
  {
    inputs: [],
    name: 'DelegateCallNotExact',
    type: 'error',
  },
  {
    inputs: [
      {
        name: 'callIndex',
        type: 'uint16',
      },
      {
        name: 'attachmentId',
        type: 'bytes32',
      },
    ],
    name: 'Denied',
    type: 'error',
  },
  {
    inputs: [],
    name: 'ExecutionFailed',
    type: 'error',
  },
  {
    inputs: [
      {
        name: 'callIndex',
        type: 'uint16',
      },
    ],
    name: 'GuardTargetDenied',
    type: 'error',
  },
  {
    inputs: [],
    name: 'InvalidDeployment',
    type: 'error',
  },
  {
    inputs: [
      {
        name: 'opMask',
        type: 'uint8',
      },
    ],
    name: 'InvalidOpMask',
    type: 'error',
  },
  {
    inputs: [
      {
        name: 'policy',
        type: 'address',
      },
    ],
    name: 'InvalidPolicy',
    type: 'error',
  },
  {
    inputs: [],
    name: 'InvalidScope',
    type: 'error',
  },
  {
    inputs: [
      {
        name: 'callIndex',
        type: 'uint16',
      },
    ],
    name: 'InvalidSelector',
    type: 'error',
  },
  {
    inputs: [],
    name: 'MalformedBatch',
    type: 'error',
  },
  {
    inputs: [],
    name: 'ModuleExecutionFailed',
    type: 'error',
  },
  {
    inputs: [
      {
        name: 'callIndex',
        type: 'uint16',
      },
    ],
    name: 'NestedBatch',
    type: 'error',
  },
  {
    inputs: [],
    name: 'NonZeroGasPrice',
    type: 'error',
  },
  {
    inputs: [],
    name: 'NonZeroSafeTxGas',
    type: 'error',
  },
  {
    inputs: [
      {
        name: 'attachmentId',
        type: 'bytes32',
      },
    ],
    name: 'NotAttached',
    type: 'error',
  },
  {
    inputs: [
      {
        name: 'callIndex',
        type: 'uint16',
      },
      {
        name: 'to',
        type: 'address',
      },
      {
        name: 'selector',
        type: 'bytes4',
      },
      {
        name: 'operation',
        type: 'uint8',
      },
    ],
    name: 'NotGranted',
    type: 'error',
  },
  {
    inputs: [
      {
        name: 'policy',
        type: 'address',
      },
      {
        name: 'reason',
        type: 'bytes',
      },
    ],
    name: 'PolicyConfigurationFailed',
    type: 'error',
  },
  {
    inputs: [
      {
        name: 'policy',
        type: 'address',
      },
      {
        name: 'reason',
        type: 'bytes',
      },
    ],
    name: 'PolicyDenied',
    type: 'error',
  },
  {
    inputs: [],
    name: 'Reentrancy',
    type: 'error',
  },
  {
    inputs: [
      {
        name: 'scopeKey',
        type: 'bytes32',
      },
    ],
    name: 'TooManyAttachments',
    type: 'error',
  },
  {
    inputs: [
      {
        name: 'txHash',
        type: 'bytes32',
      },
    ],
    name: 'AlreadyScheduled',
    type: 'error',
  },
  {
    inputs: [
      {
        name: 'attachmentId',
        type: 'bytes32',
      },
      {
        name: 'until',
        type: 'uint64',
      },
    ],
    name: 'AttachmentFrozen',
    type: 'error',
  },
  {
    inputs: [
      {
        name: 'txHash',
        type: 'bytes32',
      },
    ],
    name: 'CancelledTransaction',
    type: 'error',
  },
  {
    inputs: [],
    name: 'GasFieldsNotZero',
    type: 'error',
  },
  {
    inputs: [],
    name: 'InvalidSettings',
    type: 'error',
  },
  {
    inputs: [
      {
        name: 'txHash',
        type: 'bytes32',
      },
    ],
    name: 'NoTimelock',
    type: 'error',
  },
  {
    inputs: [
      {
        name: 'account',
        type: 'address',
      },
    ],
    name: 'NotCanceller',
    type: 'error',
  },
  {
    inputs: [
      {
        name: 'attachmentId',
        type: 'bytes32',
      },
    ],
    name: 'NotFrozen',
    type: 'error',
  },
  {
    inputs: [
      {
        name: 'attachmentId',
        type: 'bytes32',
      },
    ],
    name: 'NotGuardian',
    type: 'error',
  },
  {
    inputs: [
      {
        name: 'attachmentId',
        type: 'bytes32',
      },
    ],
    name: 'NotGuardianOrLifter',
    type: 'error',
  },
  {
    inputs: [
      {
        name: 'txHash',
        type: 'bytes32',
      },
    ],
    name: 'NotOwnersQueue',
    type: 'error',
  },
  {
    inputs: [
      {
        name: 'txHash',
        type: 'bytes32',
      },
      {
        name: 'readyAt',
        type: 'uint256',
      },
    ],
    name: 'NotReady',
    type: 'error',
  },
  {
    inputs: [
      {
        name: 'txHash',
        type: 'bytes32',
      },
    ],
    name: 'NotScheduled',
    type: 'error',
  },
  {
    inputs: [
      {
        name: 'txHash',
        type: 'bytes32',
      },
      {
        name: 'expiredAt',
        type: 'uint256',
      },
    ],
    name: 'ScheduleExpired',
    type: 'error',
  },
  {
    inputs: [
      {
        name: 'nonce',
        type: 'uint256',
      },
      {
        name: 'current',
        type: 'uint256',
      },
    ],
    name: 'StaleNonce',
    type: 'error',
  },
  {
    inputs: [
      {
        name: 'to',
        type: 'address',
      },
      {
        name: 'selector',
        type: 'bytes4',
      },
      {
        name: 'op',
        type: 'uint8',
      },
      {
        name: 'delay',
        type: 'uint32',
      },
    ],
    name: 'TimelockNotCoveringConfiguration',
    type: 'error',
  },
  {
    inputs: [
      {
        name: 'txHash',
        type: 'bytes32',
      },
      {
        name: 'attachmentId',
        type: 'bytes32',
      },
    ],
    name: 'VoidedByFreeze',
    type: 'error',
  },
  {
    inputs: [
      {
        name: 'callIndex',
        type: 'uint16',
      },
      {
        name: 'attachmentId',
        type: 'bytes32',
      },
      {
        name: 'token',
        type: 'address',
      },
      {
        name: 'requested',
        type: 'uint256',
      },
      {
        name: 'available',
        type: 'uint256',
      },
    ],
    name: 'LimitExceeded',
    type: 'error',
  },
  {
    inputs: [
      {
        name: 'callIndex',
        type: 'uint16',
      },
      {
        name: 'attachmentId',
        type: 'bytes32',
      },
      {
        name: 'token',
        type: 'address',
      },
      {
        name: 'selector',
        type: 'bytes4',
      },
    ],
    name: 'Unpriced',
    type: 'error',
  },
  {
    inputs: [
      {
        name: 'callIndex',
        type: 'uint16',
      },
      {
        name: 'attachmentId',
        type: 'bytes32',
      },
      {
        name: 'constraintIndex',
        type: 'uint16',
      },
    ],
    name: 'ArgumentMissing',
    type: 'error',
  },
  {
    inputs: [
      {
        name: 'callIndex',
        type: 'uint16',
      },
      {
        name: 'attachmentId',
        type: 'bytes32',
      },
      {
        name: 'constraintIndex',
        type: 'uint16',
      },
    ],
    name: 'ConstraintFailed',
    type: 'error',
  },
  {
    inputs: [
      {
        name: 'callIndex',
        type: 'uint16',
      },
      {
        name: 'attachmentId',
        type: 'bytes32',
      },
    ],
    name: 'NoConstraint',
    type: 'error',
  },
  {
    inputs: [
      {
        name: 'validUntil',
        type: 'uint64',
      },
    ],
    name: 'ApprovalExpired',
    type: 'error',
  },
  {
    inputs: [
      {
        name: 'approver',
        type: 'address',
      },
    ],
    name: 'InvalidSignature',
    type: 'error',
  },
  {
    inputs: [
      {
        name: 'attachmentId',
        type: 'bytes32',
      },
      {
        name: 'required',
        type: 'uint8',
      },
      {
        name: 'have',
        type: 'uint8',
      },
    ],
    name: 'MissingApprovals',
    type: 'error',
  },
  {
    inputs: [
      {
        name: 'digest',
        type: 'bytes32',
      },
    ],
    name: 'SignatureAlreadyUsed',
    type: 'error',
  },
  {
    inputs: [],
    name: 'AttestationAlreadySpent',
    type: 'error',
  },
  {
    inputs: [
      {
        name: 'deadline',
        type: 'uint256',
      },
    ],
    name: 'AttestationExpired',
    type: 'error',
  },
  {
    inputs: [],
    name: 'InvalidAddress',
    type: 'error',
  },
  {
    inputs: [],
    name: 'MalformedAttestation',
    type: 'error',
  },
  {
    inputs: [],
    name: 'MissingAttestation',
    type: 'error',
  },
  {
    inputs: [],
    name: 'UntrustedAttestationKey',
    type: 'error',
  },
  {
    inputs: [],
    name: 'NoMatches',
    type: 'error',
  },
  {
    inputs: [],
    name: 'NotDelegated',
    type: 'error',
  },
] as const
