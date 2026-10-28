// 1. Memanggil library yang sudah kita instal
require('dotenv').config();
const express = require('express');
const mysql = require('mysql2');
const path = require('path');
const session = require('express-session');
const multer = require('multer');
const fs = require('fs');
const crypto = require('crypto');
const {
  DEPARTMENTS,
  STATUS_FLOW,
  actionLabel,
  canAccessWorkOrder,
  canEditSchedule,
  isTeamTujuan,
  isValidDateRange,
  statusLabel,
  textInput,
  workOrderScope,
} = require('./lib/work-order');

const uploadDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

// ---------- UTILITY FUNCTIONS ----------
function formatRupiah(angka) {
  return 'Rp ' + parseFloat(angka || 0).toLocaleString('id-ID');
}

function dateInputValue(value) {
  if (!value) return '';
  if (!(value instanceof Date)) return String(value).slice(0, 10);
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function padZero(n, len = 3) {
  return String(n).padStart(len, '0');
}

function redirectBack(req, res, fallback = '/') {
  const referer = req.get('Referer');
  res.redirect(referer && referer.trim() ? referer : fallback);
}

// Login attempts limiter (sederhana in-memory)
const loginAttempts = new Map();
function isLoginBlocked(ip) {
  const data = loginAttempts.get(ip);
  if (!data) return false;
  if (data.count >= 5 && Date.now() - data.firstAt < 15 * 60 * 1000) return true;
  if (Date.now() - data.firstAt >= 15 * 60 * 1000) {
    loginAttempts.delete(ip);
    return false;
  }
  return false;
}
function recordLoginFail(ip) {
  const existing = loginAttempts.get(ip);
  if (!existing) loginAttempts.set(ip, { count: 1, firstAt: Date.now() });
  else existing.count++;
}

// Inisialisasi aplikasi Express
const app = express();
const PORT = process.env.PORT || 3005;

app.locals.formatRupiah = formatRupiah;
app.locals.dateInputValue = dateInputValue;
app.locals.statusLabel = statusLabel;
app.locals.actionLabel = actionLabel;
app.locals.statusFlow = STATUS_FLOW;

function normalizePublicAssetPath(filePath) {
  if (!filePath) return filePath;
  if (/^(https?:)?\/\//i.test(filePath) || filePath.startsWith('data:')) {
    return filePath;
  }

  const normalizedPath = filePath.replace(/\\/g, '/').replace(/^\.?\//, '');

  if (normalizedPath.startsWith('public/')) {
    return '/' + normalizedPath.slice('public/'.length);
  }

  return normalizedPath.startsWith('/') ? normalizedPath : '/' + normalizedPath;
}

// 2. Konfigurasi Koneksi Database (Ambil dari .env)
const db = mysql.createPool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
});

db.getConnection((err, connection) => {
  if (err) {
    console.error('Gagal terhubung ke database:', err.message);
    return;
  }
  console.log('Database terhubung dengan sukses melalui Pool!');
  connection.release();
});

// 3. Konfigurasi Sistem (Middleware)
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use(
  session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: true,
    cookie: {
      httpOnly: true,
      maxAge: 4 * 60 * 60 * 1000, // 4 jam
    },
  })
);

app.use((req, res, next) => {
  res.locals.flash = req.session.flash || null;
  delete req.session.flash;

  const user = req.session.user || null;
  res.locals.currentUser = user;
  res.locals.canCreate = Boolean(user) && ['Pemohon', 'Manager', 'Super Admin'].includes(user.role);
  next();
});

app.get('/uploads/:filename', (req, res) => {
  if (!req.session.user) return res.status(401).send('Login diperlukan untuk membuka lampiran.');
  const filename = req.params.filename;
  if (!filename || path.basename(filename) !== filename || filename === '.' || filename === '..') {
    return res.status(404).send('File tidak ditemukan.');
  }
  const assetPath = `/uploads/${filename}`;
  db.query(
    'SELECT * FROM work_orders WHERE evidence = ? OR FIND_IN_SET(?, lampiran) > 0',
    [assetPath, assetPath],
    (err, workOrders) => {
      if (err) return handleErr(req, res, err);
      if (workOrders.some((wo) => canAccessWorkOrder(req.session.user, wo))) {
        return res.sendFile(path.join(uploadDir, filename));
      }
      db.query(
        'SELECT id, team FROM users WHERE ttd IN (?, ?, ?)',
        [assetPath, `uploads/${filename}`, `public/uploads/${filename}`],
        (userErr, signatureOwners) => {
          if (userErr) return handleErr(req, res, userErr);
          const canViewSignature = signatureOwners.some(
            (owner) =>
              ['Manager', 'Super Admin'].includes(req.session.user.role) ||
              String(owner.id) === String(req.session.user.id) ||
              Boolean(req.session.user.team && owner.team === req.session.user.team)
          );
          if (!canViewSignature) return res.status(404).send('File tidak ditemukan.');
          res.sendFile(path.join(uploadDir, filename));
        }
      );
    }
  );
});

app.use('/images', express.static(path.join(__dirname, 'public', 'images')));
app.use('/css', express.static(path.join(__dirname, 'public', 'css')));

app.use((req, res, next) => {
  if (req.session?.user?.ttd) {
    req.session.user.ttd = normalizePublicAssetPath(req.session.user.ttd);
  }
  next();
});

const MAX_FILE_SIZE_MB = Number(process.env.MAX_UPLOAD_SIZE_MB) || 10;
const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024;
const MAX_UPLOAD_FILES = Number(process.env.MAX_UPLOAD_FILES) || 5;
const ALLOWED_UPLOAD_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.pdf']);
const ALLOWED_UPLOAD_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'application/pdf']);

app.locals.maxFileSizeMB = MAX_FILE_SIZE_MB;
app.locals.maxUploadFiles = MAX_UPLOAD_FILES;

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const extension = path.extname(file.originalname).toLowerCase();
    const safeName = path
      .basename(file.originalname, extension)
      .replace(/[^a-zA-Z0-9_-]/g, '_')
      .slice(0, 80);
    const filename = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}-${safeName}${extension}`;
    (req.uploadedFilePaths = req.uploadedFilePaths || []).push(path.join(uploadDir, filename));
    cb(null, filename);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE_BYTES, files: MAX_UPLOAD_FILES },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_UPLOAD_EXTENSIONS.has(ext) || !ALLOWED_UPLOAD_MIME_TYPES.has(file.mimetype)) {
      return cb(new Error('Jenis file harus JPG, PNG, atau PDF.'));
    }
    cb(null, true);
  },
});

function requireLogin(req, res, next) {
  if (!req.session.user) return res.redirect('/login');
  next();
}
function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.session.user.role)) {
      req.session.flash = { type: 'error', message: 'Tidak diotorisasi.' };
      return res.redirect('/');
    }
    next();
  };
}

function handleUpload(multerMiddleware) {
  return (req, res, next) => {
    multerMiddleware(req, res, (err) => {
      if (!err) return next();

      let message = 'Gagal mengunggah file. Silakan coba lagi.';
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          message = `Ukuran setiap file maksimal ${MAX_FILE_SIZE_MB}MB.`;
        } else if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') {
          message = `Maksimal ${MAX_UPLOAD_FILES} file dapat diunggah sekaligus.`;
        } else {
          message = 'Berkas gagal diunggah: ' + err.message;
        }
      } else if (err.message) {
        message = err.message;
      }

      console.error('Upload error:', err.message);
      cleanupUploadedFiles(req);
      req.session.flash = { type: 'error', message };
      return redirectBack(req, res, '/');
    });
  };
}

function cleanupUploadedFiles(req) {
  (req.uploadedFilePaths || []).forEach((filePath) => {
    fs.unlink(filePath, (err) => {
      if (err && err.code !== 'ENOENT') console.error('Gagal menghapus file sisa:', err.message);
    });
  });
  req.uploadedFilePaths = [];
}

// ==========================================
// 4. ROUTING & LOGIN
// ==========================================

// Menampilkan Halaman Login
app.get('/login', (req, res) => {
  res.render('login');
});

// Memproses data Login
app.post('/login', (req, res) => {
  const clientIp = req.ip || req.connection.remoteAddress;
  if (isLoginBlocked(clientIp)) {
    req.session.flash = {
      type: 'error',
      message: 'Terlalu banyak percobaan login. Coba lagi 15 menit lagi.',
    };
    return res.redirect('/login');
  }

  const { username, password } = req.body;
  if (!username || !password) {
    req.session.flash = { type: 'error', message: 'Username dan Password tidak boleh kosong.' };
    return res.redirect('/login');
  }

  const sql = 'SELECT * FROM users WHERE username = ? LIMIT 1';
  db.query(sql, [username], (err, results) => {
    if (err) {
      console.error('Login DB error:', err);
      req.session.flash = { type: 'error', message: 'Error sistem. Coba lagi.' };
      return res.redirect('/login');
    }

    if (results.length > 0 && results[0].password === password) {
      results[0].ttd = normalizePublicAssetPath(results[0].ttd);
      req.session.user = results[0];
      loginAttempts.delete(clientIp);
      console.log(`🔑 ${req.session.user.nama} berhasil login!`);
      res.redirect('/');
    } else {
      recordLoginFail(clientIp);
      req.session.flash = { type: 'error', message: 'Username atau Password salah!' };
      res.redirect('/login');
    }
  });
});

// Halaman login - bawa flash
app.get('/login', (req, res) => {
  res.render('login', { flash: req.session.flash || null });
  delete req.session.flash;
});

// Fitur Logout
app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login');
});

// 1. HALAMAN UTAMA: Dashboard dengan Pagination, Filter Team, Sort
app.get('/', (req, res) => {
  if (!req.session.user) return res.redirect('/login');

  const page = Math.max(1, parseInt(req.query.page) || 1);
  const perPage = 15;
  const offset = (page - 1) * perPage;
  const fStatus = req.query.status || 'all';
  const fTeam = DEPARTMENTS.includes(req.query.team) ? req.query.team : 'all';
  const sortBy = req.query.sortBy || 'id_desc';
  const search = (req.query.q || '').trim();

  // Sort mapping
  const sortMap = {
    id_desc: 'wo.id DESC',
    id_asc: 'wo.id ASC',
    no_wo_asc: 'wo.no_wo ASC',
    no_wo_desc: 'wo.no_wo DESC',
  };
  const orderBy = sortMap[sortBy] || sortMap.id_desc;

  const scope = workOrderScope(req.session.user);
  const where = scope.sql ? [scope.sql] : [];
  const params = [...scope.params];
  if (fStatus !== 'all') {
    where.push('wo.status = ?');
    params.push(fStatus);
  }
  if (fTeam !== 'all') {
    where.push('wo.team = ?');
    params.push(fTeam);
  }
  if (search) {
    where.push('(wo.no_wo LIKE ? OR wo.uraian_pekerjaan LIKE ?)');
    params.push(`%${search}%`, `%${search}%`);
  }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

  const listSql = `
    SELECT wo.*, users.nama AS nama_pemohon,
           CASE WHEN wo.due_date < CURDATE()
             AND wo.status NOT IN ('Completed', 'Verified', 'Closed') THEN 1 ELSE 0 END AS is_overdue
    FROM work_orders wo
    LEFT JOIN users ON wo.prepared_by = users.id
    ${whereSql}
    ORDER BY ${orderBy}
    LIMIT ? OFFSET ?
  `;
  const countSql = `SELECT COUNT(*) AS total FROM work_orders wo ${whereSql}`;

  const statsWhere = scope.sql ? `WHERE ${scope.sql}` : '';
  const allStatsSql = `
    SELECT status, COUNT(*) AS cnt,
           SUM(CASE WHEN due_date < CURDATE() AND status NOT IN ('Completed', 'Verified', 'Closed') THEN 1 ELSE 0 END) AS overdue
    FROM work_orders wo
    ${statsWhere}
    GROUP BY status
  `;
  const teamStatsSql = `
    SELECT team, status, COUNT(*) AS cnt,
           SUM(CASE WHEN due_date < CURDATE() AND status NOT IN ('Completed', 'Verified', 'Closed') THEN 1 ELSE 0 END) AS overdue
    FROM work_orders wo
    ${statsWhere ? `${statsWhere} AND` : 'WHERE'} team IS NOT NULL AND team <> ''
    GROUP BY team, status
  `;

  db.query(countSql, params, (e1, countRes) => {
    if (e1) return handleErr(req, res, e1);
    const totalItems = countRes[0].total;
    const totalPages = Math.max(1, Math.ceil(totalItems / perPage));

    db.query(listSql, [...params, perPage, offset], (e2, listRes) => {
      if (e2) return handleErr(req, res, e2);

      db.query(allStatsSql, scope.params, (e3, allStats) => {
        if (e3) return handleErr(req, res, e3);
        db.query(teamStatsSql, scope.params, (e4, teamStats) => {
          if (e4) return handleErr(req, res, e4);

          const statsMap = {};
          const overdueCount = allStats.reduce((sum, row) => sum + Number(row.overdue || 0), 0);
          allStats.forEach((s) => {
            statsMap[s.status] = s.cnt;
          });
          const teamStatsAgg = {};
          teamStats.forEach((r) => {
            if (!teamStatsAgg[r.team])
              teamStatsAgg[r.team] = { total: 0, pending: 0, done: 0, overdue: 0 };
            teamStatsAgg[r.team].total += r.cnt;
            teamStatsAgg[r.team].overdue += Number(r.overdue || 0);
            if (['Completed', 'Verified', 'Closed'].includes(r.status))
              teamStatsAgg[r.team].done += r.cnt;
            else teamStatsAgg[r.team].pending += r.cnt;
          });

          res.render('dashboard', {
            user: req.session.user,
            workOrders: listRes,
            flash: res.locals.flash,
            formatRupiah,
            pagination: {
              page,
              totalPages,
              totalItems,
              perPage,
              hasPrev: page > 1,
              hasNext: page < totalPages,
              fStatus,
              fTeam,
              sortBy,
              search,
            },
            statsCounts: statsMap,
            overdueCount,
            teamStats: teamStatsAgg,
            validTeams: DEPARTMENTS,
            statusFlow: STATUS_FLOW,
            statusLabel,
            canCreate: ['Pemohon', 'Manager', 'Super Admin'].includes(req.session.user.role),
            canDelete: req.session.user.role === 'Super Admin',
          });
        });
      });
    });
  });
});

function handleErr(req, res, err) {
  console.error('DB ERROR:', err);
  req.session.flash = { type: 'error', message: 'Terjadi kesalahan sistem.' };
  res.redirect('/');
}

// 2. HALAMAN TAMBAH WO + Auto-Generate No. WO
app.get('/create-wo', (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  const user = req.session.user;
  if (!['Pemohon', 'Manager', 'Super Admin'].includes(user.role)) {
    req.session.flash = { type: 'warn', message: 'Anda tidak memiliki akses untuk membuat WO.' };
    return res.redirect('/');
  }

  const requestedTeam = req.query.team;
  const teamIsValid = DEPARTMENTS.includes(requestedTeam);
  const isPemohon = user.role === 'Pemohon';
  const selectedTeam = teamIsValid ? requestedTeam : isPemohon ? user.team : null;
  if (isPemohon && (!selectedTeam || !DEPARTMENTS.includes(selectedTeam))) {
    req.session.flash = {
      type: 'warn',
      message: 'Akun Anda belum ditetapkan ke departemen.',
    };
    return res.redirect('/');
  }

  if (!selectedTeam) {
    return res.render('form-wo', {
      user: req.session.user,
      wo: null,
      teams: DEPARTMENTS,
      selectedTeam: null,
      autoNoWO: null,
      flash: res.locals.flash,
      rejectReason: null,
      canEditSchedule: false,
    });
  }

  const teamCode = selectedTeam
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '')
    .toUpperCase()
    .slice(0, 5);
  const now = new Date();
  const mm = padZero(now.getMonth() + 1, 2);
  const yy = now.getFullYear();

  const seqSql = `SELECT COUNT(*) AS seq FROM work_orders WHERE team = ? AND MONTH(COALESCE(submitted_at, created_at, NOW())) = ? AND YEAR(COALESCE(submitted_at, created_at, NOW())) = ?`;
  db.query(seqSql, [selectedTeam, now.getMonth() + 1, yy], (err, seqRes) => {
    if (err) return handleErr(req, res, err);
    const seq = padZero((seqRes[0]?.seq || 0) + 1, 3);
    const noWO = `FM-PS-OM-25/${teamCode}/${seq}/${mm}/${yy}`;

    res.render('form-wo', {
      user: req.session.user,
      wo: null,
      teams: DEPARTMENTS,
      selectedTeam,
      autoNoWO: noWO,
      flash: res.locals.flash,
      rejectReason: null,
      canEditSchedule: false,
    });
  });
});

// 3. JALUR UPDATE: Menangkap data dan FILE dari form + validasi
app.post(
  '/submit-wo',
  requireLogin,
  requireRole('Pemohon', 'Manager', 'Super Admin'),
  handleUpload(upload.array('lampiran_file', MAX_UPLOAD_FILES)),
  (req, res) => {
    const user = req.session.user;

    let lampiranPath = null;
    if (req.files && req.files.length > 0) {
      const paths = req.files.map((file) => '/uploads/' + file.filename);
      lampiranPath = paths.join(',');
    }

    const { no_wo, uraian_pekerjaan, lokasi, team } = req.body;
    if (
      typeof no_wo !== 'string' ||
      !no_wo.trim() ||
      typeof uraian_pekerjaan !== 'string' ||
      !uraian_pekerjaan.trim() ||
      typeof lokasi !== 'string' ||
      !lokasi.trim() ||
      !DEPARTMENTS.includes(team)
    ) {
      req.session.flash = {
        type: 'error',
        message:
          'Periksa kembali field wajib (No. WO, Uraian Pekerjaan, Lokasi) dan departemen tujuan.',
      };
      return redirectBack(req, res, '/create-wo');
    }

    const dataPengajuan = {
      no_wo: textInput(no_wo, 50),
      uraian_pekerjaan: uraian_pekerjaan.trim(),
      lokasi: lokasi.trim(),
      lampiran: lampiranPath,
      status: 'Submitted',
      prepared_by: user.id,
      team: team,
      submitted_at: new Date(),
      schedule_date: null,
      due_date: null,
    };

    db.getConnection((connectionErr, connection) => {
      if (connectionErr) return handleErr(req, res, connectionErr);
      connection.beginTransaction((transactionErr) => {
        if (transactionErr) {
          connection.release();
          return handleErr(req, res, transactionErr);
        }
        connection.query('INSERT INTO work_orders SET ?', dataPengajuan, (insertErr, result) => {
          if (insertErr) {
            return connection.rollback(() => {
              connection.release();
              handleErr(req, res, insertErr);
            });
          }
          connection.query(
            `INSERT INTO work_order_history
            (work_order_id, actor_user_id, actor_name, actor_role, action, note)
           VALUES (?, ?, ?, ?, ?, ?)`,
            [String(result.insertId), String(user.id), user.nama, user.role, 'submitted', null],
            (historyErr) => {
              if (historyErr) {
                return connection.rollback(() => {
                  connection.release();
                  handleErr(req, res, historyErr);
                });
              }
              connection.commit((commitErr) => {
                if (commitErr) {
                  return connection.rollback(() => {
                    connection.release();
                    handleErr(req, res, commitErr);
                  });
                }
                connection.release();
                req.session.flash = {
                  type: 'success',
                  message: `Work Order ${no_wo} berhasil diajukan!`,
                };
                res.redirect('/');
              });
            }
          );
        });
      });
    });
  }
);

// 4. HALAMAN DETAIL WO: Membuka form asli yang sudah terisi data untuk di-review/approve
app.get('/view-wo/:id', (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  const woId = req.params.id;

  const sql = `
    SELECT wo.*,
           u1.nama AS nama_prepared, u1.team AS team_prepared, u1.ttd AS ttd_prepared,
           u2.nama AS nama_reviewed, u2.ttd AS ttd_reviewed,
           u3.nama AS nama_approved, u3.ttd AS ttd_approved,
           u4.nama AS nama_performed, u4.team AS team_performed, u4.ttd AS ttd_performed,
           u5.nama AS nama_verified, u5.ttd AS ttd_verified,
           u6.nama AS nama_received, u6.team AS team_received, u6.ttd AS ttd_received
    FROM work_orders wo
    LEFT JOIN users u1 ON wo.prepared_by = u1.id
    LEFT JOIN users u2 ON wo.reviewed_by = u2.id
    LEFT JOIN users u3 ON wo.approved_by = u3.id
    LEFT JOIN users u4 ON wo.performed_by = u4.id
    LEFT JOIN users u5 ON wo.verified_by = u5.id
    LEFT JOIN users u6 ON wo.received_by = u6.id
    WHERE wo.id = ?
  `;

  db.query(sql, [woId], (err, results) => {
    if (err) return handleErr(req, res, err);
    if (results.length === 0) return res.status(404).send('Work Order tidak ditemukan.');

    const workOrder = results[0];
    if (!canAccessWorkOrder(req.session.user, workOrder)) {
      return res.status(403).send('Anda tidak memiliki akses ke Work Order ini.');
    }
    delete workOrder.biaya_manpower;
    delete workOrder.biaya_material;
    delete workOrder.biaya_lain;
    delete workOrder.total_biaya;
    [
      'ttd_prepared',
      'ttd_reviewed',
      'ttd_approved',
      'ttd_performed',
      'ttd_verified',
      'ttd_received',
    ].forEach((field) => {
      workOrder[field] = normalizePublicAssetPath(workOrder[field]);
    });

    db.query(
      'SELECT * FROM work_order_history WHERE work_order_id = ? ORDER BY created_at ASC, id ASC',
      [String(workOrder.id)],
      (historyErr, history) => {
        if (historyErr) return handleErr(req, res, historyErr);

        const steps = STATUS_FLOW;
        const statusIdx = steps.indexOf(workOrder.status);

        res.render('form-wo', {
          user: req.session.user,
          wo: workOrder,
          teams: DEPARTMENTS,
          autoNoWO: null,
          flash: res.locals.flash,
          rejectReason: workOrder.reject_reason || null,
          formatRupiah,
          statusLabel,
          timeline: { steps, currentIdx: statusIdx },
          history,
          canManage: ['Manager', 'Super Admin'].includes(req.session.user.role),
          canDelete: req.session.user.role === 'Super Admin',
          canEditSchedule: canEditSchedule(req.session.user, workOrder),
          canHandleWork: isTeamTujuan(req.session.user, workOrder),
        });
      }
    );
  });
});

// 5. PROSES AKSI: Menangani tombol Approval & Work Order Flow
app.post('/action-wo/:id', requireLogin, handleUpload(upload.any()), (req, res) => {
  const woId = req.params.id;
  const user = req.session.user;
  const { role } = user;
  const userId = user.id;
  const action = req.body.action;

  db.query('SELECT * FROM work_orders WHERE id = ?', [woId], (err, woResults) => {
    if (err) return handleErr(req, res, err);
    if (woResults.length === 0) return res.status(404).send('Work Order tidak ditemukan.');

    const wo = woResults[0];
    if (!canAccessWorkOrder(user, wo)) {
      return res.status(403).send('Anda tidak memiliki akses ke Work Order ini.');
    }
    let updateData = {};
    let message = '';
    let historyNote = '';
    let expectedStatus = null;

    if ((role === 'Manager' || role === 'Super Admin') && action === 'manager_approve') {
      if (wo.status !== 'Submitted') {
        req.session.flash = { type: 'error', message: 'WO sudah tidak dalam status Submitted.' };
        return res.redirect('/');
      }
      historyNote = textInput(req.body.approval_note);
      expectedStatus = 'Submitted';
      updateData = {
        status: 'Reviewed',
        approved_by: userId,
        approved_at: new Date(),
        manager_approval_note: historyNote || null,
      };
      message = 'Persetujuan Manager tersimpan dan diteruskan ke Supervisor/Team Leader.';
    } else if (
      (role === 'Supervisor' || role === 'Team Leader' || role === 'Super Admin') &&
      action === 'spv_approve'
    ) {
      if (wo.status !== 'Reviewed') {
        req.session.flash = { type: 'error', message: 'WO harus status Reviewed terlebih dahulu.' };
        return res.redirect('/');
      }
      historyNote = textInput(req.body.approval_note);
      expectedStatus = 'Reviewed';

      const spvScheduleDate = req.body.schedule_date || null;
      const spvDueDate = req.body.due_date || null;
      if (!spvScheduleDate || !spvDueDate || !isValidDateRange(spvScheduleDate, spvDueDate)) {
        req.session.flash = {
          type: 'error',
          message:
            'Jadwal pelaksanaan dan tanggal jatuh tempo wajib diisi dengan rentang yang valid.',
        };
        return redirectBack(req, res, `/view-wo/${woId}`);
      }
      updateData = {
        status: 'Approved',
        reviewed_by: userId,
        reviewed_at: new Date(),
        schedule_date: spvScheduleDate,
        due_date: spvDueDate,
        supervisor_approval_note: historyNote || null,
      };
      message = 'Persetujuan Supervisor/Team Leader tersimpan.';
    } else if (
      (role === 'Supervisor' || role === 'Team Leader' || role === 'Super Admin') &&
      action === 'start_work'
    ) {
      if (wo.status !== 'Approved' || !isTeamTujuan(user, wo)) {
        req.session.flash = {
          type: 'error',
          message: 'WO harus status Approved dan Anda pelaksana departemen tujuan.',
        };
        return res.redirect('/');
      }
      expectedStatus = 'Approved';
      updateData = {
        status: 'In Progress',
        started_at: new Date(),
      };
      historyNote = textInput(req.body.start_note);
      message = 'Pekerjaan dimulai. Status WO menjadi In Progress.';
    } else if (
      (role === 'Supervisor' || role === 'Team Leader' || role === 'Super Admin') &&
      action === 'complete'
    ) {
      if (wo.status !== 'In Progress' || !isTeamTujuan(user, wo)) {
        req.session.flash = {
          type: 'error',
          message: 'WO harus status In Progress dan Anda pelaksana departemen tujuan.',
        };
        return res.redirect('/');
      }
      expectedStatus = 'In Progress';
      updateData = {
        status: 'Completed',
        performed_by: userId,
        detail_pekerjaan: textInput(req.body.detail_pekerjaan),
        completion_status: textInput(req.body.completion_status),
        completed_at: new Date(),
      };
      historyNote = textInput(req.body.completion_status);
      message = 'Pekerjaan dinyatakan selesai. Menunggu verifikasi Supervisor/Team Leader.';
    } else if (
      (role === 'Supervisor' || role === 'Team Leader' || role === 'Super Admin') &&
      action === 'verify'
    ) {
      if (wo.status !== 'Completed' || !isTeamTujuan(user, wo)) {
        req.session.flash = {
          type: 'error',
          message: 'WO harus status Completed dan Anda penanggung jawab departemen tujuan.',
        };
        return res.redirect('/');
      }
      expectedStatus = 'Completed';
      updateData = {
        status: 'Verified',
        verified_by: userId,
        verified_at: new Date(),
      };
      historyNote = textInput(req.body.approval_note);
      message = 'Hasil pekerjaan telah diverifikasi!';
    } else if ((role === 'Pemohon' || role === 'Super Admin') && action === 'close') {
      if (
        wo.status !== 'Verified' ||
        (role === 'Pemohon' && String(wo.prepared_by) !== String(userId))
      ) {
        req.session.flash = {
          type: 'error',
          message: 'WO harus diverifikasi terlebih dahulu sebelum Close.',
        };
        return res.redirect('/');
      }
      expectedStatus = 'Verified';
      const evidence = (req.files || []).find((file) => file.fieldname === 'evidence_file');
      updateData = {
        status: 'Closed',
        received_by: userId,
        closed_at: new Date(),
        evidence: evidence ? '/uploads/' + evidence.filename : wo.evidence,
      };
      historyNote = textInput(req.body.close_note);
      message = 'Work Order Resmi DITUTUP (Closed). Terima kasih!';
    } else if (action === 'reject') {
      const allowedReject =
        (role === 'Manager' && wo.status === 'Submitted') ||
        ((role === 'Supervisor' || role === 'Team Leader') && wo.status === 'Reviewed') ||
        (role === 'Super Admin' && ['Submitted', 'Reviewed'].includes(wo.status));
      if (!allowedReject) {
        req.session.flash = { type: 'error', message: 'Aksi ditolak.' };
        return res.redirect('/');
      }
      historyNote = textInput(req.body.reject_reason, 500);
      if (!historyNote) {
        req.session.flash = { type: 'error', message: 'Alasan penolakan wajib diisi.' };
        return res.redirect('/');
      }
      expectedStatus = wo.status;
      updateData = {
        status: 'Draft',
        reject_reason: historyNote,
        reviewed_by: null,
        reviewed_at: null,
        approved_by: null,
        approved_at: null,
        manager_approval_note: null,
        supervisor_approval_note: null,
      };
      message = 'Work Order ditolak dan dikembalikan ke Pemohon.';
    } else if (
      (role === 'Pemohon' || role === 'Super Admin') &&
      action === 'resubmit' &&
      (role === 'Super Admin' || String(wo.prepared_by) === String(userId)) &&
      wo.status === 'Draft'
    ) {
      let finalLampiran = wo.lampiran;
      if (req.files && req.files.length > 0) {
        const lampiranFiles = req.files.filter((file) => file.fieldname === 'lampiran_file');
        if (lampiranFiles.length > 0) {
          const paths = lampiranFiles.map((file) => '/uploads/' + file.filename);
          finalLampiran = paths.join(',');
        }
      }
      expectedStatus = 'Draft';
      updateData = {
        uraian_pekerjaan: textInput(req.body.uraian_pekerjaan || wo.uraian_pekerjaan),
        lokasi: textInput(req.body.lokasi || wo.lokasi),
        lampiran: finalLampiran,
        status: 'Submitted',
        team: DEPARTMENTS.includes(req.body.team) ? req.body.team : wo.team,
        reject_reason: null,
        submitted_at: new Date(),
        reviewed_at: null,
        approved_at: null,
        reviewed_by: null,
        approved_by: null,
        supervisor_approval_note: null,
        manager_approval_note: null,
      };
      historyNote = 'WO diajukan ulang.';
      message = 'Work Order berhasil diperbaiki dan diajukan ulang!';
    } else if (action === 'update' && ['Manager', 'Super Admin'].includes(role)) {
      const team = req.body.team;
      if (!DEPARTMENTS.includes(team) && team !== wo.team) {
        req.session.flash = { type: 'error', message: 'Departemen tujuan tidak valid.' };
        return res.redirect('/');
      }
      updateData = {
        no_wo: textInput(req.body.no_wo, 50),
        uraian_pekerjaan: textInput(req.body.uraian_pekerjaan),
        lokasi: textInput(req.body.lokasi),
        team,
        schedule_date: req.body.schedule_date || null,
        due_date: req.body.due_date || null,
      };
      if (
        !updateData.no_wo ||
        !updateData.uraian_pekerjaan ||
        !updateData.lokasi ||
        !isValidDateRange(updateData.schedule_date, updateData.due_date)
      ) {
        req.session.flash = {
          type: 'error',
          message: 'Data WO tidak valid; periksa kelengkapan dan tanggal.',
        };
        return res.redirect('/');
      }
      historyNote = 'Data WO diperbarui oleh Manager/Super Admin.';
      message = 'Perubahan Work Order berhasil disimpan.';
    }

    if (Object.keys(updateData).length === 0) {
      req.session.flash = { type: 'warn', message: 'Tidak ada perubahan disimpan.' };
      return res.redirect('/');
    }

    let updateSql = 'UPDATE work_orders SET ? WHERE id = ?';
    const updateParams = [updateData, woId];
    if (expectedStatus) {
      updateSql += ' AND status = ?';
      updateParams.push(expectedStatus);
    }

    db.getConnection((connectionErr, connection) => {
      if (connectionErr) return handleErr(req, res, connectionErr);
      connection.beginTransaction((transactionErr) => {
        if (transactionErr) {
          connection.release();
          return handleErr(req, res, transactionErr);
        }
        connection.query(updateSql, updateParams, (updateErr, updateResult) => {
          if (updateErr || (expectedStatus && updateResult.affectedRows === 0)) {
            return connection.rollback(() => {
              connection.release();
              if (updateErr) return handleErr(req, res, updateErr);
              req.session.flash = {
                type: 'error',
                message: 'Status WO baru saja berubah; muat ulang dan periksa kembali.',
              };
              res.redirect('/');
            });
          }
          connection.query(
            `INSERT INTO work_order_history
              (work_order_id, actor_user_id, actor_name, actor_role, action, note)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [String(woId), String(user.id), user.nama, user.role, action, historyNote || null],
            (historyErr) => {
              if (historyErr) {
                return connection.rollback(() => {
                  connection.release();
                  console.error('Gagal mencatat riwayat WO:', historyErr);
                  req.session.flash = {
                    type: 'error',
                    message: 'Perubahan dibatalkan karena riwayat WO gagal dicatat.',
                  };
                  res.redirect('/');
                });
              }
              connection.commit((commitErr) => {
                if (commitErr) {
                  return connection.rollback(() => {
                    connection.release();
                    handleErr(req, res, commitErr);
                  });
                }
                connection.release();
                req.session.flash = { type: 'success', message };
                res.redirect('/');
              });
            }
          );
        });
      });
    });
  });
});

app.post('/delete-wo/:id', (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  if (req.session.user.role !== 'Super Admin') {
    return res.status(403).send('Hanya Super Admin yang dapat menghapus WO.');
  }
  db.query('SELECT * FROM work_orders WHERE id = ?', [req.params.id], (err, results) => {
    if (err) return handleErr(req, res, err);
    if (!results.length) return res.status(404).send('Work Order tidak ditemukan.');
    const wo = results[0];
    db.getConnection((connectionErr, connection) => {
      if (connectionErr) return handleErr(req, res, connectionErr);
      connection.beginTransaction((transactionErr) => {
        if (transactionErr) {
          connection.release();
          return handleErr(req, res, transactionErr);
        }
        connection.query(
          `INSERT INTO work_order_history
            (work_order_id, actor_user_id, actor_name, actor_role, action, note)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [
            String(wo.id),
            String(req.session.user.id),
            req.session.user.nama,
            req.session.user.role,
            'deleted',
            `WO ${wo.no_wo} dihapus`,
          ],
          (historyErr) => {
            if (historyErr) {
              return connection.rollback(() => {
                connection.release();
                handleErr(req, res, historyErr);
              });
            }
            connection.query('DELETE FROM work_orders WHERE id = ?', [wo.id], (deleteErr) => {
              if (deleteErr) {
                return connection.rollback(() => {
                  connection.release();
                  handleErr(req, res, deleteErr);
                });
              }
              connection.commit((commitErr) => {
                if (commitErr) {
                  return connection.rollback(() => {
                    connection.release();
                    handleErr(req, res, commitErr);
                  });
                }
                connection.release();
                req.session.flash = {
                  type: 'success',
                  message: `Work Order ${wo.no_wo} berhasil dihapus; riwayat penghapusan tetap tersimpan.`,
                };
                res.redirect('/');
              });
            });
          }
        );
      });
    });
  });
});

// ==========================================
// 5. Menyalakan Server
// ==========================================
app.listen(PORT, () => {
  console.log(`🚀 Server berjalan! Buka browser dan ketik: http://localhost:${PORT}`);
});
