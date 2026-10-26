const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DEPARTMENTS,
  canAccessWorkOrder,
  canEditSchedule,
  isTeamTujuan,
  isValidDate,
  isValidDateRange,
  textInput,
  workOrderScope,
} = require('../lib/work-order');

test('department list matches the MOM department and area names', () => {
  assert.deepEqual(DEPARTMENTS, [
    'Civil',
    'Electrical',
    'Ops KJ 1-2',
    'Ops KJ 4',
    'Ops KJ 5',
    'QHSSE',
    'Mekanik',
    'IT',
    'Procurement',
    'HW (Area)',
    'JGC (Area)',
  ]);
});

test('Super Admin and Manager can access every work order', () => {
  const wo = { prepared_by: 9, team: 'Electrical' };
  assert.equal(canAccessWorkOrder({ role: 'Super Admin' }, wo), true);
  assert.equal(canAccessWorkOrder({ role: 'Manager' }, wo), true);
  assert.deepEqual(workOrderScope({ role: 'Manager' }), { sql: '', params: [] });
});

test('Supervisor and Team Leader scope work orders to their assigned department', () => {
  const wo = { prepared_by: 9, team: 'Electrical' };
  for (const role of ['Supervisor', 'Team Leader']) {
    assert.equal(canAccessWorkOrder({ role, team: 'Electrical' }, wo), true);
    assert.equal(canAccessWorkOrder({ role, team: 'Civil' }, wo), false);
    assert.deepEqual(workOrderScope({ role, team: 'Electrical' }), {
      sql: 'wo.team = ?',
      params: ['Electrical'],
    });
    assert.deepEqual(workOrderScope({ role }), { sql: '1 = 0', params: [] });
  }
});

test('Pemohon can access own work orders or work orders for the same department', () => {
  const user = { id: 12, role: 'Pemohon', team: 'Civil' };
  assert.equal(canAccessWorkOrder(user, { prepared_by: '12', team: 'Electrical' }), true);
  assert.equal(canAccessWorkOrder(user, { prepared_by: 99, team: 'Civil' }), true);
  assert.equal(canAccessWorkOrder(user, { prepared_by: 99, team: 'Electrical' }), false);
  assert.deepEqual(workOrderScope(user), {
    sql: '(wo.prepared_by = ? OR wo.team = ?)',
    params: [12, 'Civil'],
  });
});

test('unknown roles and unassigned applicants do not get broad access', () => {
  assert.equal(
    canAccessWorkOrder({ id: 12, role: 'Unknown' }, { prepared_by: 12, team: 'Civil' }),
    false
  );
  assert.equal(
    canAccessWorkOrder({ id: 12, role: 'Pemohon' }, { prepared_by: 99, team: 'Civil' }),
    false
  );
  assert.deepEqual(workOrderScope({ id: 12, role: 'Pemohon' }), {
    sql: 'wo.prepared_by = ?',
    params: [12],
  });
});

test('date validation accepts optional dates and real ISO calendar dates only', () => {
  assert.equal(isValidDate(''), true);
  assert.equal(isValidDate(null), true);
  assert.equal(isValidDate('2024-02-29'), true);
  assert.equal(isValidDate('2025-02-29'), false);
  assert.equal(isValidDate('2025-13-01'), false);
  assert.equal(isValidDate('01-02-2025'), false);
  assert.equal(isValidDate(['2025-01-01']), false);
});

test('schedule and due date validation rejects due dates before the schedule', () => {
  assert.equal(isValidDateRange('2025-04-10', '2025-04-10'), true);
  assert.equal(isValidDateRange('2025-04-10', '2025-04-11'), true);
  assert.equal(isValidDateRange('2025-04-11', '2025-04-10'), false);
  assert.equal(isValidDateRange('2025-02-29', '2025-03-01'), false);
});

test('text input is trimmed, bounded, and rejects non-string values', () => {
  assert.equal(textInput('  catatan  '), 'catatan');
  assert.equal(textInput('abcdef', 3), 'abc');
  assert.equal(textInput({ value: 'unexpected' }), '');
});

test('only the target team and Super Admin are responsible for the WO schedule', () => {
  const wo = { team: 'Electrical' };
  assert.equal(isTeamTujuan({ role: 'Super Admin', team: 'Civil' }, wo), true);
  assert.equal(isTeamTujuan({ role: 'Supervisor', team: 'Electrical' }, wo), true);
  assert.equal(isTeamTujuan({ role: 'Team Leader', team: 'Electrical' }, wo), true);
  assert.equal(isTeamTujuan({ role: 'Supervisor', team: 'Civil' }, wo), false);
  assert.equal(isTeamTujuan({ role: 'Team Leader', team: 'Civil' }, wo), false);
});

test('applicants can never edit the schedule and due date of their work orders', () => {
  const wo = { team: 'Civil', prepared_by: 12 };
  assert.equal(isTeamTujuan({ id: 12, role: 'Pemohon', team: 'Civil' }, wo), false);
  assert.equal(canEditSchedule({ id: 12, role: 'Pemohon', team: 'Civil' }, wo), false);
});

test('managers and super admins may correct the schedule of any work order', () => {
  const wo = { team: 'Civil' };
  assert.equal(canEditSchedule({ role: 'Manager' }, wo), true);
  assert.equal(canEditSchedule({ role: 'Super Admin' }, wo), true);
  assert.equal(canEditSchedule({ role: 'Supervisor', team: 'Electrical' }, wo), false);
});

test('unassigned supervisors cannot claim a work order schedule', () => {
  assert.equal(isTeamTujuan({ role: 'Supervisor' }, { team: 'Civil' }), false);
  assert.equal(isTeamTujuan({ role: 'Supervisor', team: 'Civil' }, { team: null }), false);
  assert.equal(canEditSchedule({ role: 'Pemohon' }, null), false);
  assert.equal(canEditSchedule(null, { team: 'Civil' }), false);
});
