// 1. Memanggil library yang sudah kita instal
require('dotenv').config();
const express = require('express');
const mysql = require('mysql2');
const path = require('path');
const session = require('express-session');
const multer = require('multer');

// ---------- UTILITY FUNCTIONS ----------
function formatRupiah(angka) {
  return 'Rp ' + parseFloat(angka || 0).toLocaleString('id-ID');
}

function padZero(n, len = 3) {
  return String(n).padStart(len, '0');
}

// Login attempts limiter (sederhana in-memory)
const loginAttempts = new Map();
function isLoginBlocked(ip) {
  const data = loginAttempts.get(ip);
  if (!data) return false;
  if (data.count >= 5 && Date.now() - data.firstAt < 15 * 60 * 1000) return true;
  if (Date.now() - data.firstAt >= 15 * 60 * 1000) { loginAttempts.delete(ip); return false; }
  return false;
}
function recordLoginFail(ip) {
  const existing = loginAttempts.get(ip);
  if (!existing) loginAttempts.set(ip, { count: 1, firstAt: Date.now() });
  else existing.count++;
}

app.locals.formatRupiah = formatRupiah;

// Inisialisasi aplikasi Express
const app = express();
const PORT = process.env.PORT || 3005;

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
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
});

// BENAR untuk mysql.createPool
db.getConnection((err, connection) => {
  if (err) {
    console.error('Gagal terhubung ke database:', err.message);
    return;
  }
  console.log('Database terhubung dengan sukses melalui Pool!');
  connection.release();
});

// 3. Konfigurasi Sistem (Middleware)
// Memberi tahu sistem bahwa kita menggunakan EJS untuk tampilan HTML
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Mengizinkan sistem membaca data yang dikirim dari Form HTML
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Mengaktifkan sistem Session untuk Login nanti
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

// Flash message middleware (simpan pesan untuk 1 redirect)
app.use((req, res, next) => {
  res.locals.flash = req.session.flash || null;
  delete req.session.flash;
  next();
});

// Mengizinkan folder public diakses oleh browser (untuk melihat foto/file)
app.use(express.static(path.join(__dirname, 'public')));

app.use((req, res, next) => {
  if (req.session?.user?.ttd) {
    req.session.user.ttd = normalizePublicAssetPath(req.session.user.ttd);
  }
  next();
});

// Konfigurasi penyimpanan Multer
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, './public/uploads/'); // Simpan ke folder ini
  },
  filename: (req, file, cb) => {
    // Ganti nama file agar unik (menghindari nama file yang sama)
    cb(null, Date.now() + '-' + file.originalname);
  },
});
const upload = multer({ storage: storage });

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
    req.session.flash = { type: 'error', message: 'Terlalu banyak percobaan login. Coba lagi 15 menit lagi.' };
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

    // TEMP: plain compare sampai bcrypt diaktifkan (sesuai rencana upgrade #12)
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

// Helper: kirim notifikasi + redirect (tanpa alert inline JS)
function flashRedirect(req, res, url, type, message) {
  req.session.flash = { type, message };
  res.redirect(url);
}

// 1. HALAMAN UTAMA: Dashboard dengan Pagination, Filter Team, Sort
app.get('/', (req, res) => {
  if (!req.session.user) return res.redirect('/login');

  const page = Math.max(1, parseInt(req.query.page) || 1);
  const perPage = 15;
  const offset = (page - 1) * perPage;
  const fStatus = req.query.status || 'all';
  const fTeam = req.query.team || 'all';
  const sortBy = req.query.sortBy || 'id_desc';
  const search = (req.query.q || '').trim();

  // Sort mapping
  const sortMap = {
    id_desc: 'wo.id DESC',
    id_asc: 'wo.id ASC',
    no_wo_asc: 'wo.no_wo ASC',
    no_wo_desc: 'wo.no_wo DESC',
    biaya_desc: 'wo.total_biaya DESC',
  };
  const orderBy = sortMap[sortBy] || sortMap.id_desc;

  // Build WHERE
  const where = [];
  const params = [];
  if (fStatus !== 'all') { where.push('wo.status = ?'); params.push(fStatus); }
  if (fTeam !== 'all') { where.push('wo.team = ?'); params.push(fTeam); }
  if (search) { where.push('(wo.no_wo LIKE ? OR wo.uraian_pekerjaan LIKE ?)'); params.push(`%${search}%`, `%${search}%`); }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

  const listSql = `
    SELECT wo.*, users.nama AS nama_pemohon
    FROM work_orders wo
    LEFT JOIN users ON wo.prepared_by = users.id
    ${whereSql}
    ORDER BY ${orderBy}
    LIMIT ? OFFSET ?
  `;
  const countSql = `SELECT COUNT(*) AS total FROM work_orders wo ${whereSql}`;

  const allStatsSql = `
    SELECT status, COUNT(*) AS cnt, COALESCE(SUM(total_biaya), 0) AS total_biaya
    FROM work_orders
    GROUP BY status
  `;
  const teamStatsSql = `
    SELECT team, status, COUNT(*) AS cnt
    FROM work_orders
    WHERE team IS NOT NULL AND team <> ''
    GROUP BY team, status
  `;

  db.query(countSql, params, (e1, countRes) => {
    if (e1) return handleErr(req, res, e1);
    const totalItems = countRes[0].total;
    const totalPages = Math.max(1, Math.ceil(totalItems / perPage));

    db.query(listSql, [...params, perPage, offset], (e2, listRes) => {
      if (e2) return handleErr(req, res, e2);

      db.query(allStatsSql, (e3, allStats) => {
        if (e3) return handleErr(req, res, e3);
        db.query(teamStatsSql, (e4, teamStats) => {
          if (e4) return handleErr(req, res, e4);

          const statsMap = {};
          allStats.forEach(s => { statsMap[s.status] = s.cnt; });
          let grandTotalBiaya = 0;
          allStats.forEach(s => { grandTotalBiaya += parseFloat(s.totalBiaya || s.total_biaya || 0); });

          const teamStatsAgg = {};
          teamStats.forEach(r => {
            if (!teamStatsAgg[r.team]) teamStatsAgg[r.team] = { total: 0, pending: 0, done: 0 };
            teamStatsAgg[r.team].total += r.cnt;
            if (r.status === 'Submitted' || r.status === 'Reviewed' || r.status === 'Draft') teamStatsAgg[r.team].pending += r.cnt;
            if (r.status === 'Completed' || r.status === 'Closed') teamStatsAgg[r.team].done += r.cnt;
          });

          res.render('dashboard', {
            user: req.session.user,
            workOrders: listRes,
            flash: res.locals.flash,
            formatRupiah,
            pagination: {
              page, totalPages, totalItems, perPage,
              hasPrev: page > 1, hasNext: page < totalPages,
              fStatus, fTeam, sortBy, search,
            },
            statsCounts: statsMap,
            grandTotalBiaya,
            teamStats: teamStatsAgg,
            validTeams: ['Team Sipil', 'Team Electric', 'Team Operation', 'Team Lainnya'],
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
  if (req.session.user.role !== 'Pemohon') {
    req.session.flash = { type: 'warn', message: 'Hanya Pemohon yang dapat membuat WO baru.' };
    return res.redirect('/');
  }

  const selectedTeam = req.query.team || null;
  const validTeams = ['Team Sipil', 'Team Electric', 'Team Operation', 'Team Lainnya'];
  if (!selectedTeam || !validTeams.includes(selectedTeam)) return res.redirect('/');

  // AUTO-GENERATE Nomor WO Format: FM-PS-OM-25/[TEAM-SHORT]/[NNN]/[MM]/[YYYY]
  const teamMap = { 'Team Sipil': 'SIP', 'Team Electric': 'ELC', 'Team Operation': 'OPS', 'Team Lainnya': 'Lain' };
  const now = new Date();
  const mm = padZero(now.getMonth() + 1, 2);
  const yy = now.getFullYear();
  const teamCode = teamMap[selectedTeam] || 'MIS';
  const prefix = `FM-PS-OM-25/${teamCode}/__/${mm}/${yy}`;

  const seqSql = `SELECT COUNT(*) AS seq FROM work_orders WHERE team = ? AND MONTH(COALESCE(submitted_at, created_at, NOW())) = ? AND YEAR(COALESCE(submitted_at, created_at, NOW())) = ?`;
  db.query(seqSql, [selectedTeam, now.getMonth() + 1, yy], (err, seqRes) => {
    if (err) return handleErr(req, res, err);
    const seq = padZero((seqRes[0]?.seq || 0) + 1, 3);
    const noWO = `FM-PS-OM-25/${teamCode}/${seq}/${mm}/${yy}`;

    res.render('form-wo', {
      user: req.session.user,
      wo: null,
      teams: validTeams,
      selectedTeam,
      autoNoWO: noWO,
      flash: res.locals.flash,
      rejectReason: null,
    });
  });
});

// 3. JALUR UPDATE: Menangkap data dan FILE dari form + validasi
app.post('/submit-wo', upload.array('lampiran_file', 5), (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  if (req.session.user.role !== 'Pemohon' && req.session.user.role !== 'Super Admin') {
    req.session.flash = { type: 'error', message: 'Tidak diotorisasi.' };
    return res.redirect('/');
  }

  let lampiranPath = null;
  if (req.files && req.files.length > 0) {
    const paths = req.files.map((file) => '/uploads/' + file.filename);
    lampiranPath = paths.join(',');
  }

  // Basic server-side validation
  const { no_wo, uraian_pekerjaan, lokasi, team } = req.body;
  if (!no_wo || !uraian_pekerjaan || !lokasi || !team) {
    req.session.flash = { type: 'error', message: 'Semua field wajib diisi.' };
    return res.redirect('back');
  }

  const dataPengajuan = {
    no_wo: no_wo.trim(),
    uraian_pekerjaan: uraian_pekerjaan.trim(),
    lokasi: lokasi.trim(),
    lampiran: lampiranPath,
    status: 'Submitted',
    prepared_by: req.session.user.id,
    team: team,
    submitted_at: new Date(),
  };

  db.query('INSERT INTO work_orders SET ?', dataPengajuan, (err) => {
    if (err) return handleErr(req, res, err);
    req.session.flash = { type: 'success', message: `Work Order ${no_wo} berhasil diajukan!` };
    res.redirect('/');
  });
});

// 4. HALAMAN DETAIL WO: Membuka form asli yang sudah terisi data untuk di-review/approve
app.get('/view-wo/:id', (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  const woId = req.params.id;
  const teams = ['Team Sipil', 'Team Electric', 'Team Operation', 'Team Lainnya'];

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
    ['ttd_prepared', 'ttd_reviewed', 'ttd_approved', 'ttd_performed', 'ttd_verified', 'ttd_received']
      .forEach((field) => { workOrder[field] = normalizePublicAssetPath(workOrder[field]); });

    // Hitung step timeline
    const steps = ['Submitted', 'Reviewed', 'Approved', 'Completed', 'Verified', 'Closed'];
    const statusIdx = steps.indexOf(workOrder.status);

    res.render('form-wo', {
      user: req.session.user,
      wo: workOrder,
      teams,
      autoNoWO: null,
      flash: res.locals.flash,
      rejectReason: workOrder.reject_reason || null,
      formatRupiah,
      timeline: { steps, currentIdx: statusIdx },
    });
  });
});

// 5. PROSES AKSI: Menangani tombol Approval & Work Order Flow
app.post('/action-wo/:id', upload.any(), (req, res) => {
  if (!req.session.user) return res.redirect('/login');

  const woId = req.params.id;
  const role = req.session.user.role;
  const userId = req.session.user.id;
  const userTeam = req.session.user.team;
  const action = req.body.action;

  // Take WO details first
  const getWoSql = 'SELECT * FROM work_orders WHERE id = ?';
  db.query(getWoSql, [woId], (err, woResults) => {
    if (err) throw err;
    if (woResults.length === 0) return res.send('Work Order tidak ditemukan.');

    const wo = woResults[0];
    let updateData = {};
    let message = '';

    // =========================================================================
    // ALUR APPROVAL LEMBAR PENGAJUAN:
    // Submitted -> TAHAP 1 (Manager Approve) -> TAHAP 2 (Team Leader/SPV Approve) -> Approved
    // =========================================================================

    // TAHAP 1: MANAGER APPROVAL (Akses Global)
    if ((role === 'Manager' || role === 'Super Admin') && action === 'manager_approve') {
      if (wo.status !== 'Submitted') {
        req.session.flash = { type: 'error', message: 'WO sudah tidak dalam status Submitted.' };
        return res.redirect('/');
      }
      updateData = {
        status: 'Reviewed',
        approved_by: userId,
        approved_at: new Date(),
      };
      message = 'Approve Tahap 1 (Shorebase Manager) berhasil! WO diteruskan ke Team Leader/Supervisor.';

    // TAHAP 2: TEAM LEADER / SUPERVISOR APPROVAL (Dibatasi per Team)
    } else if (
      (role === 'Supervisor' || role === 'Team Leader' || role === 'Super Admin') &&
      action === 'spv_approve'
    ) {
      if (wo.status !== 'Reviewed') {
        req.session.flash = { type: 'error', message: 'WO harus status Reviewed terlebih dahulu.' };
        return res.redirect('/');
      }
      if (role !== 'Super Admin' && wo.team && userTeam && wo.team !== userTeam) {
        req.session.flash = { type: 'error', message: `Anda hanya bisa menyetujui WO untuk team ${userTeam}!` };
        return res.redirect('/');
      }
      updateData = {
        status: 'Approved',
        reviewed_by: userId,
        reviewed_at: new Date(),
      };
      message = 'Approve Tahap 2 (Team Leader/Supervisor) berhasil! Status WO resmi Approved.';

    // AKSI PENYELESAIAN PEKERJAAN
    } else if ((role === 'Pemohon' || role === 'Super Admin') && action === 'complete') {
      if (wo.status !== 'Approved') {
        req.session.flash = { type: 'error', message: 'WO harus status Approved terlebih dahulu.' };
        return res.redirect('/');
      }
      const mp = Math.max(0, parseFloat(req.body.biaya_manpower || 0));
      const mt = Math.max(0, parseFloat(req.body.biaya_material || 0));
      const ll = Math.max(0, parseFloat(req.body.biaya_lain || 0));
      updateData = {
        status: 'Completed',
        performed_by: userId,
        detail_pekerjaan: (req.body.detail_pekerjaan || '').trim(),
        completion_status: (req.body.completion_status || '').trim(),
        biaya_manpower: mp,
        biaya_material: mt,
        biaya_lain: ll,
        total_biaya: mp + mt + ll,
        completed_at: new Date(),
      };
      message = 'Pekerjaan telah diselesaikan! Menunggu verifikasi Team Leader.';

    } else if (
      (role === 'Supervisor' || role === 'Team Leader' || role === 'Super Admin') &&
      action === 'verify'
    ) {
      if (wo.status !== 'Completed') {
        req.session.flash = { type: 'error', message: 'WO harus status Completed terlebih dahulu.' };
        return res.redirect('/');
      }
      if (role !== 'Super Admin' && wo.team && userTeam && wo.team !== userTeam) {
        req.session.flash = { type: 'error', message: `Anda hanya bisa memverifikasi WO untuk team ${userTeam}!` };
        return res.redirect('/');
      }
      updateData = {
        verified_by: userId,
        verified_at: new Date(),
      };
      message = 'Hasil pekerjaan telah diverifikasi!';

    } else if ((role === 'Pemohon' || role === 'Super Admin') && action === 'close') {
      if (wo.status !== 'Completed' || !wo.verified_by) {
        req.session.flash = { type: 'error', message: 'WO harus diverifikasi terlebih dahulu sebelum Close.' };
        return res.redirect('/');
      }
      updateData = { status: 'Closed', received_by: userId, closed_at: new Date() };
      message = 'Work Order Resmi DITUTUP (Closed). Terima kasih!';
    } else if (action === 'reject') {
      const allowedReject = role === 'Manager' || role === 'Supervisor' || role === 'Team Leader' || role === 'Super Admin';
      if (!allowedReject) {
        req.session.flash = { type: 'error', message: 'Aksi ditolak.' };
        return res.redirect('/');
      }
      updateData = {
        status: 'Draft',
        reject_reason: (req.body.reject_reason || '').trim().slice(0, 500),
      };
      message = 'Work Order ditolak dan dikembalikan ke Pemohon.';
    } else if ((role === 'Pemohon' || role === 'Super Admin') && action === 'resubmit') {
      let finalLampiran = req.body.old_lampiran || null;
      if (req.files && req.files.length > 0) {
        const lampiranFiles = req.files.filter((file) => file.fieldname === 'lampiran_file');
        if (lampiranFiles.length > 0) {
          const paths = lampiranFiles.map((file) => '/uploads/' + file.filename);
          finalLampiran = paths.join(',');
        }
      }
      updateData = {
        uraian_pekerjaan: (req.body.uraian_pekerjaan || wo.uraian_pekerjaan).trim(),
        lokasi: (req.body.lokasi || wo.lokasi).trim(),
        lampiran: finalLampiran,
        status: 'Submitted',
        team: req.body.team || wo.team,
        reject_reason: null,
        submitted_at: new Date(), // reset timestamp submit
        reviewed_at: null, approved_at: null, reviewed_by: null, approved_by: null,
      };
      message = 'Work Order berhasil diperbaiki dan diajukan ulang!';
    }

    // Pastikan aksi valid (tidak empty updateData)
    if (Object.keys(updateData).length === 0) {
      req.session.flash = { type: 'warn', message: 'Tidak ada perubahan disimpan.' };
      return res.redirect('/');
    }

    const sql = 'UPDATE work_orders SET ? WHERE id = ?';
    db.query(sql, [updateData, woId], (err) => {
      if (err) return handleErr(req, res, err);
      req.session.flash = { type: 'success', message };
      res.redirect('/');
    });
  });
});

// ==========================================
// 5. Menyalakan Server
// ==========================================
app.listen(PORT, () => {
  console.log(`🚀 Server berjalan! Buka browser dan ketik: http://localhost:${PORT}`);
});
