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

// Alur Jadwal Pelaksanaan & Tanggal Jatuh Tempo: hanya Team Tujuan
// (Supervisor/Team Leader dari departemen tujuan WO) atau Super Admin yang
// bertanggung jawab mengisi kedua tanggal tersebut.
const TEAM_TUJUAN_ROLES = ['Supervisor', 'Team Leader'];

function isTeamTujuan(user, wo) {
  if (!user || !wo || !wo.team) return false;
  if (user.role === 'Super Admin') return true;
  return TEAM_TUJUAN_ROLES.includes(user.role) && Boolean(user.team) && wo.team === user.team;
}

// Manager/Super Admin boleh mengoreksi kedua tanggal lewat aksi update data WO;
// Pemohon tidak pernah boleh, baik saat membuat maupun mengedit WO.
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
  canAccessWorkOrder,
  canEditSchedule,
  isTeamTujuan,
  isValidDate,
  isValidDateRange,
  textInput,
  workOrderScope,
};
