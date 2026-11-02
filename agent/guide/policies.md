# Built-in policies (Sepolia deployments)

The guard picks ONE policy per access selector `(target, function selector, operation)`. If
there's no exact match, it falls back to the operation-only entry. With neither, the call is
denied. Policies apply to every module and to owners alike: they are per Safe, not per role.

| Policy               | What it checks                                                                        | What it does NOT check                                          |
| -------------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| AllowPolicy          | nothing: the call is allowed for anyone                                               | any argument                                                    |
| DenyPolicy           | always denies                                                                         | —                                                               |
| AllowedModulePolicy  | the caller is an allowlisted module (one list per Safe)                               | any argument: recipients, amounts, swap outputs                 |
| ERC20TransferPolicy  | the `transfer` recipient is on the token's allowlist (`always`, or `once` then spent) | the amount                                                      |
| ERC20ApprovePolicy   | the `approve` spender is on the token's allowlist; revoking (0) is always allowed     | the amount                                                      |
| NativeTransferPolicy | a plain ETH send (empty calldata) to that target                                      | the amount                                                      |
| MultiSendPolicy      | a MultiSend batch, each inner call checked against its own policy                     | —                                                               |
| CoSignerPolicy       | a co-signature in the transaction context                                             | the module path carries no context, so it always denies modules |

## Gaps to mention when relevant

- **No amount caps.** Once a recipient is allowed, any amount can go to them.
- **AllowedModulePolicy is a blank cheque for that function.** For example, CoW
  `setPreSignature` can sign an order with any receiver and any price. `swap` plans pay the
  Safe, but the policy itself doesn't enforce it.
- **Configuration is owners-only.** Calls from a module to the guard are denied
  (`ModuleConfigurationDenied`). Calls to the Safe itself (enableModule, setGuard, addOwner…)
  need an explicit policy, which should never exist.
- **Changes are delayed.** New policies go through `requestConfiguration` → guard delay →
  `applyConfiguration` by the owners. `safe_role_policies` only shows applied ones; pending
  requests are visible in the Safe App.
- `safe_role_policies` rebuilds the list from guard events over the last ~4 weeks. If the Safe
  was configured earlier, pass `fromBlock`.
