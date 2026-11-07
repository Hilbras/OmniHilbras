import { useState } from 'react';
import { KeyRound, Plus, Power, Save, Trash2 } from 'lucide-react';
import type { GatewayConnection } from '../lib/gatewayClient';
import { removeGatewayConnection, saveGatewayConnectionResponsibility } from '../lib/gatewayClient';
import { useToast } from './Toast';

/**
 * Every account signed in for this provider, one row each.
 *
 * ## Why this exists
 *
 * A provider can hold more than one connection — the `addAccount` sign-in creates a second one rather than
 * overwriting the first — and until now the page rendered only `connections[0]`. The second account was
 * real, billable, and invisible. Two accounts also could not be told apart: both said "Kiro".
 *
 * ## What makes an account recognisable
 *
 * The `owner`/`purpose` note, editable per row. That is deliberately free text rather than a structured
 * account id: a connection is often a team's, not a person's, and the fact a reader needs when a key stops
 * working is *who to ask* and *what it is for* — not a subject claim an identity provider happened to issue.
 *
 * ## What this deliberately does not do
 *
 * It does not offer a traffic policy here. Failover vs share is a property of the provider's **routing**,
 * already edited in the Routing policy panel; a second control for it in this table would give two places to
 * change one thing, which is how the panels drift apart.
 */

export function ProviderAccountsPanel({
  connections,
  providerName,
  onSaved,
  onAddAccount,
}: {
  connections: readonly GatewayConnection[];
  providerName: string;
  onSaved: () => void;
  /**
   * Opens the connect dialog in add-account mode: a second sign-in that saves beside these rows
   * instead of repairing the first. Offered only when the provider's flow can carry it, so it is
   * absent — and the button with it — for providers that connect one account at a time.
   */
  onAddAccount?: () => void;
}) {
  if (connections.length === 0) return null;

  return (
    <section id="accounts" className="card mt-4 p-3.5 sm:mt-5 sm:p-5">
      <div className="flex flex-col justify-between gap-3 border-b border-line pb-3 sm:flex-row sm:items-center">
        <div className="flex items-center gap-2">
          <span className="grid h-8 w-8 place-items-center rounded-lg border border-gold/25 bg-gold-soft text-gold-text">
            <KeyRound className="h-4 w-4" aria-hidden="true" />
          </span>
          <div>
            <h2 className="text-sm font-semibold">{providerName} accounts</h2>
            <p className="muted mt-0.5 text-xs">
              {connections.length === 1
                ? 'One account is signed in.'
                : `${connections.length} accounts are signed in. Traffic follows the routing policy above.`}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="rounded-full border border-line bg-bg-soft px-2.5 py-1 font-mono text-[10px] text-muted">
            {connections.length === 1 ? '1 account' : `${connections.length} accounts`}
          </span>
          {onAddAccount && (
            <button type="button" onClick={onAddAccount} className="btn-ghost !px-2.5 !py-1.5 !text-xs">
              <Plus className="h-3.5 w-3.5" aria-hidden="true" />
              Add account
            </button>
          )}
        </div>
      </div>

      <div className="mt-4 flex flex-col gap-3">
        {connections.map((connection, index) => (
          <AccountRow key={connection.id} connection={connection} index={index} onSaved={onSaved} />
        ))}
      </div>
    </section>
  );
}

/**
 * What a row calls its account: the note a person wrote, else the name the sign-in recorded, else the
 * credential's own email, else the id. The old project ordered them this way and it is the order that
 * makes two accounts of one vendor tellable apart.
 */
function accountTitle(connection: GatewayConnection): string {
  return connection.responsibility?.owner?.trim() || connection.name?.trim() || connection.email?.trim() || connection.id;
}

/** The second line, only when it adds something the title does not already say. */
function accountSubtitle(connection: GatewayConnection): string | null {
  const title = accountTitle(connection);
  const email = connection.email?.trim();
  if (email && email !== title) return email;
  const name = connection.name?.trim();
  if (name && name !== title) return name;
  return null;
}

function AccountRow({ connection, index, onSaved }: { connection: GatewayConnection; index: number; onSaved: () => void }) {
  const { notify } = useToast();
  const [owner, setOwner] = useState(connection.responsibility?.owner ?? '');
  const [purpose, setPurpose] = useState(connection.responsibility?.purpose ?? '');
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);

  const dirty = owner.trim() !== (connection.responsibility?.owner ?? '') || purpose.trim() !== (connection.responsibility?.purpose ?? '');

  async function save() {
    setSaving(true);
    try {
      await saveGatewayConnectionResponsibility(connection.id, {
        ...(owner.trim() ? { owner: owner.trim() } : {}),
        ...(purpose.trim() ? { purpose: purpose.trim() } : {}),
      });
      notify(`Saved the note on account ${index + 1}.`, 'success');
      onSaved();
    } catch (error) {
      notify(error instanceof Error ? error.message : 'The note could not be saved.', 'error');
    } finally {
      setSaving(false);
    }
  }

  /**
   * Retires this account. Deliberate, confirmed, and named: rows are created by "Add connection" now,
   * so a row a user no longer wants — a replaced key, a duplicate sign-in — needs a way out that is
   * not the gateway's API.
   */
  async function remove() {
    if (!window.confirm(`Remove account ${index + 1} (${connection.responsibility?.owner || connection.name})? Its credential is deleted and its traffic stops.`)) return;
    setRemoving(true);
    try {
      await removeGatewayConnection(connection.id);
      notify(`Removed account ${index + 1}.`, 'success');
      onSaved();
    } catch (error) {
      notify(error instanceof Error ? error.message : 'The account could not be removed.', 'error');
    } finally {
      setRemoving(false);
    }
  }

  return (
    <div className="rounded-xl border border-line bg-bg-soft p-3 sm:p-3.5">
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-start gap-2.5">
          <span className="mt-0.5 shrink-0 font-mono text-[10px] text-muted">{index + 1}</span>
          {/* The account's own identity, in the old project's order: the written note, then the name,
              then the credential's email — and the email as a second line when it is not already the
              first. Two accounts of one vendor are told apart by this, which a bare id never did. */}
          <div className="min-w-0">
            <span className="text-xs font-medium">{accountTitle(connection)}</span>
            {accountSubtitle(connection) ? (
              <p className="muted mt-0.5 truncate text-[11px]" title={accountSubtitle(connection) ?? undefined}>{accountSubtitle(connection)}</p>
            ) : null}
            {connection.responsibility?.purpose && (
              <p className="muted mt-0.5 text-[11px]">— {connection.responsibility.purpose}</p>
            )}
          </div>
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {connection.credentialType && (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-line bg-surface px-2 py-0.5 font-mono text-[10px] text-muted">
              {connection.credentialType === 'oauth' ? 'OAuth' : connection.credentialType === 'api-key' ? 'API Key' : 'No key'}
            </span>
          )}
          <span
            className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] ${connection.enabled ? 'border-success/30 bg-success/10 text-success' : 'border-line text-muted'}`}
            title={connection.enabled ? 'This account takes traffic' : 'This account is paused'}
          >
            <Power className="h-2.5 w-2.5" aria-hidden="true" />
            {connection.enabled ? 'Active' : 'Paused'}
          </span>
          <code className="min-w-0 max-w-full truncate rounded border border-line bg-surface px-1.5 py-0.5 font-mono text-[10px] text-muted sm:max-w-[200px]" title={connection.id}>
            {connection.id}
          </code>
        </div>
      </div>

      <div className="mt-3 grid gap-2.5 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto]">
        <label className="flex flex-col gap-1">
          <span className="muted text-[10px] uppercase tracking-wide">Owner</span>
          <input
            value={owner}
            onChange={(event) => setOwner(event.target.value)}
            maxLength={120}
            placeholder="Who to ask about this key"
            className="h-8 w-full min-w-0 rounded-md border border-line bg-surface px-2 text-xs sm:h-7"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="muted text-[10px] uppercase tracking-wide">Purpose</span>
          <input
            value={purpose}
            onChange={(event) => setPurpose(event.target.value)}
            maxLength={500}
            placeholder="What this account is for"
            className="h-8 w-full min-w-0 rounded-md border border-line bg-surface px-2 text-xs sm:h-7"
          />
        </label>
        <button
          type="button"
          onClick={() => void save()}
          disabled={!dirty || saving}
          className="btn-ghost inline-flex h-8 w-full items-center justify-center gap-1.5 px-2.5 text-[11px] disabled:opacity-40 sm:h-7 sm:w-auto md:mt-auto"
        >
          <Save className="h-3 w-3" aria-hidden="true" />
          Save
        </button>
        <button
          type="button"
          onClick={() => void remove()}
          disabled={removing}
          className="btn-ghost inline-flex h-8 w-full items-center justify-center gap-1.5 px-2.5 text-[11px] text-danger disabled:opacity-40 sm:h-7 sm:w-auto md:mt-auto"
          title="Remove this account and delete its credential"
        >
          <Trash2 className="h-3 w-3" aria-hidden="true" />
          Remove
        </button>
      </div>
    </div>
  );
}
