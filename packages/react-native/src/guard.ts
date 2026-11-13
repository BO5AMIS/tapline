import { toElement } from './inspect';
import { TaplineError, isRecord } from './types';
import type { Entry } from './inspect';

/**
 * AGENT-TOOLS 1.13 §18.4: what the host's policy checked, field by field. `null` means the field was absent, and it must
 * still be absent when the touch happens: a missing field is never a wildcard.
 */
export interface RecipientGuard {
  id: string | null;
  label: string | null;
  text: string | null;
  role: string | null;
}

const FIELDS = ['id', 'label', 'text', 'role'] as const;

function bad(message: string): TaplineError {
  return new TaplineError('bad_params', message);
}

/** A guard from the wire: each field a string or null, and a field left out means absent. */
export function parseRecipientGuard(raw: unknown): RecipientGuard {
  if (!isRecord(raw)) throw bad('guard must be an object with id, label, text and role');
  if (Object.keys(raw).length === 0) throw bad('guard needs at least one of id, label, text or role');
  const guard: RecipientGuard = { id: null, label: null, text: null, role: null };
  for (const field of FIELDS) {
    const value = raw[field];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string') throw bad(`guard.${field} must be a string or null`);
    guard[field] = value === '' ? null : value;
  }
  return guard;
}

const nonEmpty = (value: string | null | undefined): string | null => (typeof value === 'string' && value !== '' ? value : null);

/** The fields as the host sees them: `toElement`'s text (cut, display-normalised), and empty means absent. */
export function recipientFields(entry: Entry): RecipientGuard {
  const info = toElement(entry, null, '');
  return { id: nonEmpty(info.testID), label: nonEmpty(info.label), text: nonEmpty(info.text), role: nonEmpty(info.role) };
}

/** Refuses with `stale` when the element that will receive the touch is not exactly the one the policy checked. */
export function assertRecipient(guard: RecipientGuard | undefined, recipient: Entry): void {
  if (guard === undefined) return;
  const actual = recipientFields(recipient);
  if (FIELDS.some((field) => guard[field] !== actual[field])) {
    throw new TaplineError('stale', 'stale: the target is another element now than the one the policy checked; look again.');
  }
}
