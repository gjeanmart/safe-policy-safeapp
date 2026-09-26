import { Card } from './ui'

/** Background notes on the model this sandbox demonstrates, and its sharp edges. */
export function Notes() {
  return (
    <>
      <Card title="The idea">
        <p>
          A Safe has two entrypoints: <code>execTransaction</code> (owners, multisig quorum) and{' '}
          <code>execTransactionFromModule</code> (any enabled module, no quorum). A module does not have to be
          a contract: any EOA can be enabled. On its own that hands the EOA full control of the Safe.
          Installing the <code>SafePolicyGuard</code> as <strong>module guard</strong> makes every module
          transaction go through the policy engine first, so the EOA gets a narrow capability instead:
          transfer USDC to X, pre-sign CoW orders, …
        </p>
      </Card>

      <Card title="How the engine decides">
        <ul>
          <li>
            Each transaction maps to an <em>access selector</em> <code>(target, selector, operation)</code>.
            The guard looks up exactly one policy for it, else the fallback for that operation, else denies (
            <code>AccessDenied(0x0)</code>). Default-deny.
          </li>
          <li>
            Policies are bound <strong>per Safe</strong>, not per module. Two roles cannot have different
            recipients for the same token: the ERC20TransferPolicy allowlist applies to whoever is checked.
          </li>
          <li>
            Shipped policies check <em>either</em> the caller (AllowedModulePolicy) <em>or</em> the parameters
            (ERC20Transfer/Approve, NativeTransfer), never both. There is no cascading; combining needs a
            custom policy.
          </li>
          <li>
            AllowedModulePolicy has one allowlist per Safe: allowing a module on one selector allows it on
            every selector bound to AllowedModulePolicy.
          </li>
          <li>
            <code>once</code> grants are spent during the check; the guard reverts failed module executions so
            a failed call does not burn a grant.
          </li>
        </ul>
      </Card>

      <Card title="Module guard only vs. both guards">
        <ul>
          <li>
            <strong>Module guard only</strong> (default here): owners are unchecked, the multisig works
            exactly as before. Modules can never touch the configuration: calls to the guard from a module
            revert with <code>ModuleConfigurationDenied</code> / <code>GuardTargetDenied</code>, and Safe
            admin functions (<code>enableModule</code>, <code>setModuleGuard</code>, …) have no policy, so
            they are denied.
          </li>
          <li>
            Trade-off: the configuration delay then protects against modules only. Owners can remove the
            module guard at once (it is an unchecked owner transaction), so the delay is not a defence against
            compromised owners.
          </li>
          <li>
            <strong>Both guards</strong>: owner transactions are default-denied too. Owners keep the
            configuration entry points (<code>requestConfiguration</code>, <code>applyConfiguration</code>,{' '}
            <code>invalidateRoot</code>) and everything else needs a policy, including the MultiSend
            DELEGATECALL that Safe{'{Wallet}'} uses for batches. Guard removal then needs an AllowPolicy on{' '}
            <code>setGuard</code>/<code>setModuleGuard</code> applied through the delay. This is the
            configuration the delay is designed for.
          </li>
          <li>Never install the transaction guard alone: every module would then be completely unchecked.</li>
        </ul>
      </Card>

      <Card title="Configuration lifecycle">
        <ol>
          <li>
            Before any guard is installed, <code>configureImmediately</code> applies policies with no delay.
            The bootstrap batch does that and installs the guard atomically.
          </li>
          <li>
            Afterwards, owners <code>requestConfiguration(root)</code> with{' '}
            <code>root = keccak256(abi.encode(configs))</code>, wait <code>DELAY</code>, then{' '}
            <code>applyConfiguration(configs)</code> within <code>EXPIRY</code> (7 days). Only the root is
            on-chain, which is why this app keeps pending policy changes in localStorage.
          </li>
          <li>
            A pending root can be cancelled at any time with <code>invalidateRoot</code>.
          </li>
          <li>
            There is no getter listing a Safe&apos;s policies; the Setup tab rebuilds them from{' '}
            <code>PolicyConfirmed</code> events.
          </li>
        </ol>
      </Card>

      <Card title="CoW swaps: what is and is not enforced">
        <p>
          A CoW swap from a Safe is <code>approve(VaultRelayer)</code> on the sell token plus{' '}
          <code>setPreSignature(orderUid, true)</code> on GPv2Settlement. The order UID is a hash of the order
          including its <code>receiver</code>, and no deployed policy can see inside it. With the template
          used here, a role can pre-sign an order that pays out to itself. A real swap-only permission needs a
          CoW-aware policy, e.g. one that takes the order struct as input, recomputes the UID and requires{' '}
          <code>receiver == safe</code>.
        </p>
      </Card>

      <Card title="Other caveats">
        <ul>
          <li>
            Requires Safe 1.5.0 (module guard). On 1.4.1, module transactions bypass the engine entirely.
          </li>
          <li>Modules enabled before the module guard was installed were unconstrained until then.</li>
          <li>The contracts are unaudited research code; the role keys here are in plain localStorage.</li>
          <li>
            Contracts with a fallback function (e.g. WETH <code>deposit()</code>) can be reached through
            calldata whose selector has no exact binding, which then resolves to the fallback policy if one is
            set.
          </li>
        </ul>
      </Card>
    </>
  )
}
