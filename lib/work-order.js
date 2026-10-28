const DEPARTMENTS = [
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
];

const STATUS_LABELS = {
  Draft: 'Draft',
  Submitted: 'Diajukan',
  Reviewed: 'Disetujui Manager',
  Approved: 'Disetujui SPV/TL',
  'In Progress': 'Dikerjakan',
  Completed: 'Selesai',
  Verified: 'Diverifikasi',
  Closed: 'Closed',
};

const STATUS_FLOW = [
  'Draft',
  'Submitted',
  'Reviewed',
  'Approved',
  'In Progress',
  'Completed',
  'Verified',
  'Closed',
];

const ACTION_LABELS = {
  submitted: 'Diajukan',
  manager_approve: 'Disetujui Manager',
  spv_approve: 'Disetujui SPV/TL',
  start_work: 'Pekerjaan Dimulai',
  complete: 'Pekerjaan Selesai',
  verify: 'Diverifikasi',
  close: 'Ditutup',
  reject: 'Ditolak',
  resubmit: 'Diajukan Ulang',
  update: 'Data Diperbarui',
  deleted: 'Dihapus',
};

function statusLabel(status) {
  return STATUS_LABELS[status] || status;
}

function actionLabel(action) {
  return ACTION_LABELS[action] || action;
}

function isValidDate(value) {
  if (!value) return true;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function isValidDateRange(scheduleDate, dueDate) {
  return (
    isValidDate(scheduleDate) &&
    isValidDate(dueDate) &&
    !(scheduleDate && dueDate && dueDate < scheduleDate)
  );
}

function textInput(value, maxLength = 2000) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function workOrderScope(user, alias = 'wo') {
  if (user.role === 'Super Admin' || user.role === 'Manager') {
    return { sql: '', params: [] };
  }
  if (user.role === 'Supervisor' || user.role === 'Team Leader') {
    return user.team
      ? { sql: `${alias}.team = ?`, params: [user.team] }
      : { sql: '1 = 0', params: [] };
  }
  if (user.role === 'Pemohon') {
    return user.team
      ? {
          sql: `(${alias}.prepared_by = ? OR ${alias}.team = ?)`,
          params: [user.id, user.team],
        }
      : { sql: `${alias}.prepared_by = ?`, params: [user.id] };
  }
  return { sql: '1 = 0', params: [] };
}

const TEAM_TUJUAN_ROLES = ['Supervisor', 'Team Leader'];

function isTeamTujuan(user, wo) {
  if (!user || !wo || !wo.team) return false;
  if (user.role === 'Super Admin') return true;
  return TEAM_TUJUAN_ROLES.includes(user.role) && Boolean(user.team) && wo.team === user.team;
}

function canEditSchedule(user, wo) {
  if (!user || !wo) return false;
  if (user.role === 'Manager' || user.role === 'Super Admin') return true;
  return isTeamTujuan(user, wo);
}

function canAccessWorkOrder(user, wo) {
  if (user.role === 'Super Admin' || user.role === 'Manager') return true;
  if (user.role === 'Supervisor' || user.role === 'Team Leader') {
    return Boolean(user.team && wo.team === user.team);
  }
  if (user.role === 'Pemohon') {
    return (
      String(wo.prepared_by) === String(user.id) || Boolean(user.team && wo.team === user.team)
    );
  }
  return false;
}

module.exports = {
  DEPARTMENTS,
  STATUS_FLOW,
  STATUS_LABELS,
  ACTION_LABELS,
  actionLabel,
  canAccessWorkOrder,
  canEditSchedule,
  isTeamTujuan,
  isValidDate,
  isValidDateRange,
  statusLabel,
  textInput,
  workOrderScope,
};
