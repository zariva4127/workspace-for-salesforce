/**
 * Turns raw permission query results into conservative, labelled conclusions.
 *
 * Principles:
 * - Only "confirmed" when the API data directly proves it.
 * - Field-level access never implies record-level access; record access is only
 *   confirmed via UserRecordAccess.
 * - Missing or failed queries produce "unknown", never "denied".
 */

export type AccessStatus = 'granted' | 'denied' | 'unknown' | 'notEvaluated' | 'notApplicable';
export type Confidence = 'confirmed' | 'likely' | 'uncertain';

export interface Verdict {
  status: AccessStatus;
  confidence: Confidence;
  reason: string;
  grantedBy: string[];
}

export interface PermissionSource {
  id: string;
  /** Display label, e.g. "Profile: System Administrator" or "Permission set: Sales Ops". */
  label: string;
  kind: 'profile' | 'permissionSet' | 'permissionSetGroup' | 'session';
  /** Session-based permission sets only apply once activated in a session. */
  requiresActivation?: boolean;
}

export interface ObjectPermRow {
  parentId: string;
  read: boolean;
  create: boolean;
  edit: boolean;
  delete: boolean;
  viewAll: boolean;
  modifyAll: boolean;
  /** "View All Fields" (API 58+), undefined when unavailable. */
  viewAllFields?: boolean;
}

export interface FieldPermRow {
  parentId: string;
  read: boolean;
  edit: boolean;
}

export interface SystemPermRow {
  parentId: string;
  viewAllData: boolean;
  modifyAllData: boolean;
}

export interface RecordAccessRow {
  read: boolean;
  edit: boolean;
  delete: boolean;
  transfer: boolean;
  all: boolean;
  maxAccessLevel: string;
}

/** A query result that may have failed. */
export type Fetched<T> = { ok: true; value: T } | { ok: false; error: string };

export interface AccessInput {
  user: { isActive: boolean; name: string; profileName?: string };
  sources: Fetched<PermissionSource[]>;
  objectApiName: string;
  objectPerms: Fetched<ObjectPermRow[]>;
  /** False when the object has no ObjectPermissions rows at all in the org (not permissionable). */
  objectPermissionable?: boolean;
  systemPerms: Fetched<SystemPermRow[]>;
  field?: {
    apiName: string;
    permissionable: boolean;
    calculated: boolean;
    updateable: boolean;
    perms: Fetched<FieldPermRow[]>;
  };
  record?: { id: string; access: Fetched<RecordAccessRow | null> };
}

export interface AccessResult {
  object: { read: Verdict; create: Verdict; edit: Verdict; delete: Verdict; viewAll: Verdict; modifyAll: Verdict };
  field?: { read: Verdict; edit: Verdict };
  record: { read: Verdict; edit: Verdict; delete: Verdict };
  notes: string[];
  summary: string;
}

const v = (status: AccessStatus, confidence: Confidence, reason: string, grantedBy: string[] = []): Verdict => ({
  status,
  confidence,
  reason,
  grantedBy,
});

function labelFor(sources: PermissionSource[], ids: string[]): string[] {
  const byId = new Map(sources.map((s) => [s.id, s]));
  return ids.map((id) => {
    const s = byId.get(id);
    if (!s) return id;
    return s.requiresActivation ? `${s.label} (session activation required)` : s.label;
  });
}

function activeIds(sources: PermissionSource[]): Set<string> {
  return new Set(sources.filter((s) => !s.requiresActivation).map((s) => s.id));
}

export function interpretAccess(input: AccessInput): AccessResult {
  const notes: string[] = [];
  const sources = input.sources.ok ? input.sources.value : [];
  const active = activeIds(sources);

  if (!input.user.isActive) notes.push('This user is inactive and cannot log in, regardless of permissions.');
  if (!input.sources.ok) notes.push(`Could not read permission set assignments: ${input.sources.error}`);
  if (sources.some((s) => s.requiresActivation)) {
    notes.push('Some permission sets require session activation; permissions granted only by them are shown as "likely".');
  }

  // ---- System permissions -------------------------------------------------
  let viewAllData: string[] = [];
  let modifyAllData: string[] = [];
  if (input.systemPerms.ok) {
    viewAllData = input.systemPerms.value.filter((r) => r.viewAllData || r.modifyAllData).map((r) => r.parentId);
    modifyAllData = input.systemPerms.value.filter((r) => r.modifyAllData).map((r) => r.parentId);
  }
  const vadActive = viewAllData.filter((id) => active.has(id));
  const madActive = modifyAllData.filter((id) => active.has(id));

  // ---- Object permissions -------------------------------------------------
  const objVerdict = (pick: (r: ObjectPermRow) => boolean, label: string, override: string[] = []): Verdict => {
    if (override.length) {
      return v('granted', 'confirmed', `${label} granted by a system permission (View/Modify All Data).`, labelFor(sources, override));
    }
    if (!input.objectPerms.ok) return v('unknown', 'uncertain', `Object permissions could not be read: ${input.objectPerms.error}`);
    const rows = input.objectPerms.value.filter(pick);
    const confirmedRows = rows.filter((r) => active.has(r.parentId));
    if (confirmedRows.length) {
      return v('granted', 'confirmed', `${label} is granted on ${input.objectApiName}.`, labelFor(sources, confirmedRows.map((r) => r.parentId)));
    }
    if (rows.length) {
      return v('granted', 'likely', `${label} is granted only by a session-activated permission set.`, labelFor(sources, rows.map((r) => r.parentId)));
    }
    if (input.objectPermissionable === false) {
      return v(
        'unknown',
        'uncertain',
        `${input.objectApiName} is not controlled by object permissions (no ObjectPermissions rows exist). Access depends on other settings.`,
      );
    }
    if (!input.sources.ok) return v('unknown', 'uncertain', 'Assignments could not be read, so a missing grant cannot be confirmed.');
    return v('denied', 'confirmed', `No assigned profile, permission set, or group grants ${label.toLowerCase()} on ${input.objectApiName}.`);
  };

  const object = {
    read: objVerdict((r) => r.read, 'Read', vadActive),
    create: objVerdict((r) => r.create, 'Create', madActive),
    edit: objVerdict((r) => r.edit, 'Edit', madActive),
    delete: objVerdict((r) => r.delete, 'Delete', madActive),
    viewAll: objVerdict((r) => r.viewAll || r.modifyAll, 'View All', vadActive),
    modifyAll: objVerdict((r) => r.modifyAll, 'Modify All', madActive),
  };

  // ---- Field permissions --------------------------------------------------
  let field: AccessResult['field'];
  if (input.field) {
    const f = input.field;
    const objectReadDenied = object.read.status === 'denied';
    const viewAllFieldsIds = input.objectPerms.ok
      ? input.objectPerms.value.filter((r) => r.viewAllFields && active.has(r.parentId)).map((r) => r.parentId)
      : [];

    let read: Verdict;
    let edit: Verdict;
    if (objectReadDenied) {
      read = v('denied', 'confirmed', 'The user cannot read the object, so the field is not accessible.');
      edit = v('denied', 'confirmed', 'The user cannot read the object, so the field is not accessible.');
    } else if (!f.permissionable) {
      read = v(
        object.read.status === 'granted' ? 'granted' : 'unknown',
        object.read.status === 'granted' ? 'likely' : 'uncertain',
        'This field is not controlled by field-level security (for example, a required or system field). It follows object access.',
      );
      edit = f.calculated || !f.updateable
        ? v('notApplicable', 'confirmed', 'This field is read-only by definition (formula, system, or non-updateable).')
        : v(object.edit.status === 'granted' ? 'granted' : 'unknown', 'uncertain', 'Not controlled by field-level security; follows object edit access.');
    } else if (!f.perms.ok) {
      read = v('unknown', 'uncertain', `Field permissions could not be read: ${f.perms.error}`);
      edit = v('unknown', 'uncertain', `Field permissions could not be read: ${f.perms.error}`);
    } else {
      const rows = f.perms.value;
      const readIds = rows.filter((r) => r.read || r.edit).map((r) => r.parentId);
      const editIds = rows.filter((r) => r.edit).map((r) => r.parentId);
      const readActive = readIds.filter((id) => active.has(id));
      const editActive = editIds.filter((id) => active.has(id));
      const objNote = object.read.status === 'granted' ? '' : ' Object read access is not confirmed, so this may not be usable.';

      if (readActive.length) read = v('granted', object.read.status === 'granted' ? 'confirmed' : 'uncertain', `Field-level security grants Read.${objNote}`, labelFor(sources, readActive));
      else if (viewAllFieldsIds.length) read = v('granted', 'confirmed', '"View All Fields" on the object grants read on every field.', labelFor(sources, viewAllFieldsIds));
      else if (readIds.length) read = v('granted', 'likely', 'Read is granted only by a session-activated permission set.', labelFor(sources, readIds));
      else read = v('denied', 'confirmed', 'No assigned profile or permission set grants Read on this field.');

      if (f.calculated || !f.updateable) edit = v('notApplicable', 'confirmed', 'This field is read-only by definition (formula or non-updateable).');
      else if (editActive.length) {
        const objEdit = object.edit.status === 'granted';
        edit = v('granted', objEdit ? 'confirmed' : 'uncertain', objEdit ? 'Field-level security grants Edit.' : 'Field-level security grants Edit, but object Edit is not confirmed.', labelFor(sources, editActive));
      } else if (editIds.length) edit = v('granted', 'likely', 'Edit is granted only by a session-activated permission set.', labelFor(sources, editIds));
      else edit = v('denied', 'confirmed', 'No assigned profile or permission set grants Edit on this field.');
    }
    field = { read, edit };
    notes.push('Field-level security controls which fields are visible on records the user can already access. It does not grant access to any record.');
  }

  // ---- Record access -------------------------------------------------------
  let record: AccessResult['record'];
  if (!input.record) {
    const reason = 'No record selected. Object and field permissions do not show whether the user can see a specific record; sharing settings decide that.';
    record = { read: v('notEvaluated', 'uncertain', reason), edit: v('notEvaluated', 'uncertain', reason), delete: v('notEvaluated', 'uncertain', reason) };
  } else if (!input.record.access.ok) {
    const reason = `Record access could not be read: ${input.record.access.error}`;
    record = { read: v('unknown', 'uncertain', reason), edit: v('unknown', 'uncertain', reason), delete: v('unknown', 'uncertain', reason) };
  } else if (!input.record.access.value) {
    const reason = 'Salesforce returned no UserRecordAccess row for this record (it may not exist or you may not be able to see it).';
    record = { read: v('unknown', 'uncertain', reason), edit: v('unknown', 'uncertain', reason), delete: v('unknown', 'uncertain', reason) };
  } else {
    const ra = input.record.access.value;
    const rec = (has: boolean, objVerdictFor: Verdict, label: string): Verdict => {
      const src = [`UserRecordAccess (max level: ${ra.maxAccessLevel})`];
      if (has && objVerdictFor.status === 'denied') {
        return v('denied', 'likely', `Sharing grants ${label}, but the user lacks ${label} permission on the object, so they cannot actually ${label.toLowerCase()} it.`, src);
      }
      return has
        ? v('granted', 'confirmed', `Salesforce confirms the user has ${label} access to this record.`, src)
        : v('denied', 'confirmed', `Salesforce confirms the user does not have ${label} access to this record.`, src);
    };
    record = { read: rec(ra.read, object.read, 'Read'), edit: rec(ra.edit, object.edit, 'Edit'), delete: rec(ra.delete, object.delete, 'Delete') };
  }

  return { object, field, record, notes, summary: summarize(input, object, field, record) };
}

function summarize(input: AccessInput, object: AccessResult['object'], field: AccessResult['field'], record: AccessResult['record']): string {
  const parts: string[] = [];
  const word = (vv: Verdict) =>
    vv.status === 'granted' ? (vv.confidence === 'confirmed' ? 'can' : 'likely can') : vv.status === 'denied' ? 'cannot' : 'may or may not be able to';
  parts.push(`${input.user.name} ${word(object.read)} read ${input.objectApiName} records in general`);
  if (field && input.field) parts.push(`${word(field.read)} see the ${input.field.apiName} field`);
  if (record.read.status === 'notEvaluated') parts.push('record-level access was not checked');
  else parts.push(`${word(record.read)} open record ${input.record?.id}`);
  return `${parts.join('; ')}.`;
}
