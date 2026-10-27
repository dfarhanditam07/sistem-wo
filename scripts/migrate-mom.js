require('dotenv').config();
const mysql = require('mysql2/promise');

const departments = [
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

function quoteEnumValue(value) {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
}

// Label tim lama ('HW'/'JGC') diganti ke nama resmi MOM ('HW (Area)'/'JGC (Area)').
// Idempoten: hanya baris yang masih memakai label lama yang disentuh, sehingga
// skrip aman dijalankan berulang tanpa mengubah data yang sudah dinormalkan.
const LEGACY_TEAM_MAPPING = [
  ['HW', 'HW (Area)'],
  ['JGC', 'JGC (Area)'],
];
const TEAM_LABEL_COLUMNS = [
  ['users', 'team'],
  ['users', 'departemen'],
  ['work_orders', 'team'],
];

async function mapLegacyTeamLabels(connection) {
  for (const [legacy, current] of LEGACY_TEAM_MAPPING) {
    for (const [table, column] of TEAM_LABEL_COLUMNS) {
      const [result] = await connection.query(
        `UPDATE \`${table}\` SET \`${column}\` = ? WHERE \`${column}\` = ?`,
        [current, legacy]
      );
      if (result.affectedRows > 0) {
        console.log(
          `Label ${legacy} -> ${current} diterapkan pada ${table}.${column} (${result.affectedRows} baris).`
        );
      }
    }
  }
}

function readEnumValues(columnType) {
  const match = /^enum\((.*)\)$/i.exec(columnType || '');
  if (!match) return null;

  const values = [];
  const valuePattern = /'((?:''|\\.|[^'])*)'/g;
  let valueMatch;
  while ((valueMatch = valuePattern.exec(match[1]))) {
    values.push(valueMatch[1].replace(/''/g, "'").replace(/\\(.)/g, '$1'));
  }
  return values;
}

// MariaDB mengembalikan COLUMN_DEFAULT untuk ENUM dalam bentuk yang sudah dikutip
// ('Draft'), sedangkan MySQL mengembalikan tanpa kutip (Draft). Tanpa dilepas,
// nilai default akan terkirim ganda kutip ('''Draft''') dan ALTER TABLE gagal
// dengan "Invalid default value".
function readEnumDefault(value) {
  if (value === null || value === undefined) return null;
  const text = String(value);
  return /^'.*'$/s.test(text)
    ? text.slice(1, -1).replace(/''/g, "'").replace(/\\(.)/g, '$1')
    : text;
}

async function appendEnumValues(connection, database, table, column, values) {
  const [columns] = await connection.execute(
    `SELECT COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, CHARACTER_SET_NAME,
            COLLATION_NAME, COLUMN_COMMENT
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [database, table, column]
  );
  if (!columns.length) throw new Error(`Kolom ${table}.${column} tidak ditemukan.`);
  const definition = columns[0];
  const existingValues = readEnumValues(definition.COLUMN_TYPE);
  if (!existingValues) {
    if (/^(varchar|char|text|tinytext|mediumtext|longtext)/i.test(definition.COLUMN_TYPE)) return;
    throw new Error(
      `${table}.${column} memiliki tipe ${definition.COLUMN_TYPE} yang tidak didukung.`
    );
  }

  const additions = values.filter((value) => !existingValues.includes(value));
  if (!additions.length) return;
  const enumDefinition = [...existingValues, ...additions].map(quoteEnumValue).join(', ');
  const charset = /^[A-Za-z0-9_]+$/.test(definition.CHARACTER_SET_NAME || '')
    ? ` CHARACTER SET ${definition.CHARACTER_SET_NAME}`
    : '';
  const collation = /^[A-Za-z0-9_]+$/.test(definition.COLLATION_NAME || '')
    ? ` COLLATE ${definition.COLLATION_NAME}`
    : '';
  const nullable = definition.IS_NULLABLE === 'YES' ? ' NULL' : ' NOT NULL';
  const defaultChoice = readEnumDefault(definition.COLUMN_DEFAULT);
  const defaultValue = defaultChoice === null ? '' : ` DEFAULT ${quoteEnumValue(defaultChoice)}`;
  const comment = definition.COLUMN_COMMENT
    ? ` COMMENT ${quoteEnumValue(definition.COLUMN_COMMENT)}`
    : '';
  await connection.query(
    `ALTER TABLE \`${table}\` MODIFY COLUMN \`${column}\` ENUM(${enumDefinition})${charset}${collation}${nullable}${defaultValue}${comment}`
  );
  console.log(`Pilihan baru ditambahkan ke ${table}.${column}; nilai lama dipertahankan.`);
}

async function migrate() {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
  });

  try {
    const [columns] = await connection.execute(
      `SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, CHARACTER_SET_NAME,
              COLLATION_NAME, COLUMN_COMMENT
       FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'users' AND COLUMN_NAME = 'role'`,
      [process.env.DB_NAME]
    );
    if (!columns.length) throw new Error('Kolom users.role tidak ditemukan; migrasi dihentikan.');

    const roleColumn = columns[0];
    const roles = readEnumValues(roleColumn.COLUMN_TYPE);
    if (!roles) {
      throw new Error(
        `users.role bertipe ${roleColumn.COLUMN_TYPE}, bukan ENUM. Tidak ada perubahan otomatis dilakukan.`
      );
    }
    if (!roles.includes('Team Leader')) {
      roles.push('Team Leader');
      const enumDefinition = roles.map(quoteEnumValue).join(', ');
      const charset = /^[A-Za-z0-9_]+$/.test(roleColumn.CHARACTER_SET_NAME || '')
        ? ` CHARACTER SET ${roleColumn.CHARACTER_SET_NAME}`
        : '';
      const collation = /^[A-Za-z0-9_]+$/.test(roleColumn.COLLATION_NAME || '')
        ? ` COLLATE ${roleColumn.COLLATION_NAME}`
        : '';
      const nullable = roleColumn.IS_NULLABLE === 'YES' ? ' NULL' : ' NOT NULL';
      const roleDefault = readEnumDefault(roleColumn.COLUMN_DEFAULT);
      const defaultValue = roleDefault === null ? '' : ` DEFAULT ${quoteEnumValue(roleDefault)}`;
      const comment = roleColumn.COLUMN_COMMENT
        ? ` COMMENT ${quoteEnumValue(roleColumn.COLUMN_COMMENT)}`
        : '';
      await connection.query(
        `ALTER TABLE users MODIFY COLUMN role ENUM(${enumDefinition})${charset}${collation}${nullable}${defaultValue}${comment}`
      );
      console.log('Role Team Leader ditambahkan tanpa menghapus pilihan role yang ada.');
    }

    await appendEnumValues(connection, process.env.DB_NAME, 'users', 'team', departments);
    await appendEnumValues(connection, process.env.DB_NAME, 'work_orders', 'team', departments);
    // Tahap 'Verified' (SPV/TL memeriksa hasil pekerjaan) butuh nilai enum baru.
    // 'In Progress' sudah ada di skema sejak awal dan kini benar-benar dipakai.
    await appendEnumValues(connection, process.env.DB_NAME, 'work_orders', 'status', ['Verified']);

    // Setelah nilai enum memuat nama area resmi, normalkan baris lama yang masih
    // memakai label 'HW'/'JGC' agar cocok dengan daftar departemen aplikasi.
    await mapLegacyTeamLabels(connection);

    const workOrderColumns = [
      ['schedule_date', 'DATE NULL'],
      ['due_date', 'DATE NULL'],
      ['material_request_note', 'TEXT NULL'],
      ['manager_approval_note', 'TEXT NULL'],
      ['supervisor_approval_note', 'TEXT NULL'],
      ['evidence', 'VARCHAR(512) NULL'],
      ['started_at', 'DATETIME NULL'],
    ];
    const [existingColumns] = await connection.execute(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'work_orders'`,
      [process.env.DB_NAME]
    );
    if (!existingColumns.length) {
      throw new Error('Tabel work_orders tidak ditemukan; migrasi dihentikan.');
    }
    const existingColumnNames = new Set(existingColumns.map((column) => column.COLUMN_NAME));
    for (const [name, definition] of workOrderColumns) {
      if (!existingColumnNames.has(name)) {
        await connection.query(`ALTER TABLE work_orders ADD COLUMN ${name} ${definition}`);
        console.log(`Kolom work_orders.${name} ditambahkan.`);
      }
    }

    await connection.query(`
      CREATE TABLE IF NOT EXISTS work_order_history (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        work_order_id VARCHAR(64) NOT NULL,
        actor_user_id VARCHAR(64) NOT NULL,
        actor_name VARCHAR(255) NOT NULL,
        actor_role VARCHAR(64) NOT NULL,
        action VARCHAR(64) NOT NULL,
        note TEXT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_work_order_history_wo (work_order_id, created_at)
      ) ENGINE=InnoDB
    `);
    console.log('Tabel work_order_history tersedia.');
    console.log('Migrasi MOM selesai.');
  } finally {
    await connection.end();
  }
}

migrate().catch((error) => {
  console.error('Migrasi MOM gagal:', error.message);
  process.exitCode = 1;
});
