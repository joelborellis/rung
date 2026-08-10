// The counselor roster and their invite links.
//
// Identity is global and durable: a person is added once, keyed on their
// email, and the same link works for every batch they are enrolled in. Adding
// someone who already exists re-enrols them rather than creating a second
// record — that is the whole point of keying on email.
//
// A minted token is shown exactly once. It is never stored in recoverable
// form, so the copy has to make that plain rather than letting the owner
// assume they can find it again.

import { useEffect, useState } from 'react';
import { admin, type PersonRow } from '../sync/admin';
import { Eyebrow, Labelled, Modal } from './ui';

const STATUS_COPY: Record<PersonRow['linkStatus'], string> = {
  active: 'link used',
  'never-used': 'link not opened yet',
  revoked: 'revoked',
  'no-link': 'no link',
};

export function PeopleAdmin({ onClose }: { onClose: () => void }) {
  const [people, setPeople] = useState<PersonRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [credentials, setCredentials] = useState('');

  /** The one-time reveal. Cleared as soon as the roster reloads. */
  const [freshLink, setFreshLink] = useState<{ name: string; link: string } | null>(null);
  const [copied, setCopied] = useState(false);

  async function reload() {
    try {
      setPeople((await admin.people()).people);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load the roster.');
    }
  }

  useEffect(() => {
    void reload();
  }, []);

  function linkFor(token: string): string {
    return `${window.location.origin}${window.location.pathname}#/t/${token}`;
  }

  async function add(event: React.FormEvent) {
    event.preventDefault();
    if (!email.trim() || !displayName.trim()) return;
    setBusy(true);
    try {
      const result = await admin.addPerson({
        email: email.trim(),
        displayName: displayName.trim(),
        credentials: credentials.trim() || undefined,
      });
      if (result.token) {
        setFreshLink({ name: displayName.trim(), link: linkFor(result.token) });
      } else {
        // They already had a live link; re-adding just re-enrols them.
        setFreshLink(null);
        setError(`${displayName.trim()} already has a link. Use Reissue if they lost it.`);
      }
      setEmail('');
      setDisplayName('');
      setCredentials('');
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not add them.');
    } finally {
      setBusy(false);
    }
  }

  async function reissue(person: PersonRow) {
    setBusy(true);
    try {
      const result = await admin.reissue(person.id);
      setFreshLink({ name: person.displayName, link: linkFor(result.token) });
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not reissue.');
    } finally {
      setBusy(false);
    }
  }

  async function revoke(person: PersonRow) {
    setBusy(true);
    try {
      await admin.revoke(person.id);
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not revoke.');
    } finally {
      setBusy(false);
    }
  }

  async function enrol(person: PersonRow) {
    setBusy(true);
    try {
      await admin.enrol([person.id]);
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not enrol them.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Counselors" onClose={onClose}>
      <div className="flex flex-col gap-6">
        {error && (
          <p className="text-base" style={{ color: 'var(--flag)' }}>
            {error}
          </p>
        )}

        {freshLink && (
          <section
            className="flex flex-col gap-3 rounded-card border px-4 py-3"
            style={{ borderColor: 'var(--accent)' }}
          >
            <p className="text-base">
              <strong className="font-medium">{freshLink.name}'s review link.</strong> Copy it now
              — it can't be shown again. If it's lost, use Reissue to make a new one.
            </p>
            <code
              className="mono block overflow-x-auto rounded-lg border px-3 py-2 text-sm"
              style={{ borderColor: 'var(--line)', background: 'var(--surface)' }}
            >
              {freshLink.link}
            </code>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className="btn"
                onClick={async () => {
                  await navigator.clipboard.writeText(freshLink.link);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2000);
                }}
              >
                {copied ? 'Copied' : 'Copy link'}
              </button>
              <button type="button" className="btn" onClick={() => setFreshLink(null)}>
                Done
              </button>
            </div>
          </section>
        )}

        <section className="flex flex-col gap-3">
          <Eyebrow>Add a counselor</Eyebrow>
          <form className="flex flex-wrap items-end gap-3" onSubmit={add}>
            <Labelled label="Email" htmlFor="person-email">
              <input
                id="person-email"
                className="field"
                type="email"
                value={email}
                placeholder="jane@example.com"
                onChange={(e) => setEmail(e.target.value)}
              />
            </Labelled>
            <Labelled label="Name" htmlFor="person-name">
              <input
                id="person-name"
                className="field"
                value={displayName}
                placeholder="Jane Doe"
                onChange={(e) => setDisplayName(e.target.value)}
              />
            </Labelled>
            <Labelled label="Credentials (optional)" htmlFor="person-creds">
              <input
                id="person-creds"
                className="field"
                value={credentials}
                placeholder="LPC"
                onChange={(e) => setCredentials(e.target.value)}
              />
            </Labelled>
            <button type="submit" className="btn btn-primary" disabled={busy}>
              Add and make a link
            </button>
          </form>
          <p className="text-sm" style={{ color: 'color-mix(in srgb, var(--ink) 60%, transparent)' }}>
            The email is their identity, not a notification address — nothing is sent from here.
            Adding someone who already exists re-enrols them in this batch and keeps their link.
          </p>
        </section>

        <section className="flex flex-col gap-3 border-t pt-5" style={{ borderColor: 'var(--line)' }}>
          <Eyebrow>Roster</Eyebrow>
          {people.length === 0 ? (
            <p className="text-base" style={{ color: 'color-mix(in srgb, var(--ink) 60%, transparent)' }}>
              Nobody yet.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {people.map((person) => (
                <li
                  key={person.id}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t pt-2 text-sm"
                  style={{ borderColor: 'var(--line)' }}
                >
                  <span className="font-medium">{person.displayName}</span>
                  {person.credentials && (
                    <span style={{ color: 'color-mix(in srgb, var(--ink) 55%, transparent)' }}>
                      {person.credentials}
                    </span>
                  )}
                  <span className="mono" style={{ color: 'color-mix(in srgb, var(--ink) 55%, transparent)' }}>
                    {person.email}
                  </span>
                  <span
                    style={{
                      color:
                        person.linkStatus === 'revoked' || person.linkStatus === 'no-link'
                          ? 'var(--flag)'
                          : 'color-mix(in srgb, var(--ink) 55%, transparent)',
                    }}
                  >
                    {STATUS_COPY[person.linkStatus]}
                  </span>
                  {person.roundsJoined > 1 && (
                    <span style={{ color: 'color-mix(in srgb, var(--ink) 55%, transparent)' }}>
                      {person.roundsJoined} batches
                    </span>
                  )}

                  <span className="ml-auto flex flex-wrap gap-2">
                    {!person.inCurrentBatch && !person.revoked && (
                      <button type="button" className="btn" disabled={busy} onClick={() => void enrol(person)}>
                        Add to this batch
                      </button>
                    )}
                    {person.inCurrentBatch && (
                      <span
                        className="chip"
                        style={{ cursor: 'default', color: 'color-mix(in srgb, var(--ink) 60%, transparent)' }}
                      >
                        in this batch
                      </span>
                    )}
                    <button type="button" className="btn" disabled={busy} onClick={() => void reissue(person)}>
                      Reissue link
                    </button>
                    {!person.revoked && person.role !== 'owner' && (
                      <button
                        type="button"
                        className="btn"
                        disabled={busy}
                        style={{ borderColor: 'var(--flag)', color: 'var(--flag)' }}
                        onClick={() => void revoke(person)}
                      >
                        Revoke
                      </button>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <p className="text-sm" style={{ color: 'color-mix(in srgb, var(--ink) 60%, transparent)' }}>
            Revoking stops the link working. It never deletes their verdicts — that work is still
            yours, and it stays in the merge.
          </p>
        </section>
      </div>
    </Modal>
  );
}
