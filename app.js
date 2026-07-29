// 1. Memanggil library yang sudah kita instal
require('dotenv').config();
const express = require('express');
const mysql = require('mysql2');
const path = require('path');
const session = require('express-session');
const multer = require('multer');

// Inisialisasi aplikasi Express
const app = express();
const PORT = 3005;

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
  })
);

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
  const { username, password } = req.body;

  // Cek ke database apakah user ada
  const sql = 'SELECT * FROM users WHERE username = ? AND password = ?';
  db.query(sql, [username, password], (err, results) => {
    if (err) throw err;

    if (results.length > 0) {
      // Jika sukses, simpan data user ke dalam Session
      results[0].ttd = normalizePublicAssetPath(results[0].ttd);
      req.session.user = results[0];
      console.log(`🔑 ${req.session.user.nama} berhasil login!`);
      res.redirect('/');
    } else {
      res.send(
        '<script>alert("Username atau Password salah!"); window.location.href="/login";</script>'
      );
    }
  });
});

// Fitur Logout
app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login');
});

// 1. HALAMAN UTAMA: Dashboard (Menampilkan daftar semua WO)
app.get('/', (req, res) => {
  if (!req.session.user) {
    return res.redirect('/login');
  }

  // Mengambil data WO sekaligus menggabungkan (JOIN) dengan nama pemohon dari tabel users
  const sql = ` 
         SELECT work_orders.*, users.nama AS nama_pemohon 
         FROM work_orders 
         LEFT JOIN users ON work_orders.prepared_by = users.id 
         ORDER BY work_orders.id DESC 
     `;

  db.query(sql, (err, results) => {
    if (err) throw err;

    // Render halaman dashboard dengan membawa data user dan data list WO
    res.render('dashboard', {
      user: req.session.user,
      workOrders: results,
    });
  });
});

// 2. HALAMAN TAMBAH WO: Menampilkan form pembuatan WO baru
app.get('/create-wo', (req, res) => {
  if (!req.session.user) {
    return res.redirect('/login');
  }

  // Hanya Pemohon yang boleh membuat WO baru
  if (req.session.user.role !== 'Pemohon') {
    return res.send(
      '<script>alert("Hanya Pemohon yang dapat membuat WO baru!"); window.location.href="/";</script>'
    );
  }

  const selectedTeam = req.query.team || null;
  const validTeams = ['Team Sipil', 'Team Electric', 'Team Operation', 'Team Lainnya'];

  if (!selectedTeam || !validTeams.includes(selectedTeam)) {
    // If no valid team, redirect back to dashboard
    return res.redirect('/');
  }

  const teams = validTeams;
  res.render('form-wo', { user: req.session.user, wo: null, teams, selectedTeam });
});

// 3. JALUR UPDATE: Menangkap data dan FILE dari form
app.post('/submit-wo', upload.array('lampiran_file', 5), (req, res) => {
  if (!req.session.user) return res.redirect('/login');

  let lampiranPath = null;

  // Jika ada file yang diupload (lebih dari 0)
  if (req.files && req.files.length > 0) {
    // Kumpulkan semua jalur file, lalu gabungkan dengan tanda koma
    const paths = req.files.map((file) => '/uploads/' + file.filename);
    lampiranPath = paths.join(','); // Hasilnya misal: "/uploads/file1.jpg,/uploads/file2.pdf"
  }

  const dataPengajuan = {
    no_wo: req.body.no_wo,
    uraian_pekerjaan: req.body.uraian_pekerjaan,
    lokasi: req.body.lokasi,
    lampiran: lampiranPath,
    status: 'Submitted',
    prepared_by: req.session.user.id,
    team: req.body.team,
  };

  const sql = 'INSERT INTO work_orders SET ?';
  db.query(sql, dataPengajuan, (err) => {
    if (err) throw err;
    res.send(`<script>alert("Work Order berhasil diajukan!"); window.location.href="/";</script>`);
  });
});

// 4. HALAMAN DETAIL WO: Membuka form asli yang sudah terisi data untuk di-review/approve
app.get('/view-wo/:id', (req, res) => {
  if (!req.session.user) return res.redirect('/login');

  const woId = req.params.id;
  const teams = ['Team Sipil', 'Team Electric', 'Team Operation', 'Team Lainnya'];

  // Ambil data WO beserta Nama & TTD dari masing-masing User
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
    if (err) throw err;
    if (results.length === 0) return res.send('Work Order tidak ditemukan.');

    const workOrder = results[0];
    const ttdFields = [
      'ttd_prepared',
      'ttd_reviewed',
      'ttd_approved',
      'ttd_performed',
      'ttd_verified',
      'ttd_received',
    ];

    ttdFields.forEach((field) => {
      workOrder[field] = normalizePublicAssetPath(workOrder[field]);
    });

    res.render('form-wo', {
      user: req.session.user,
      wo: workOrder,
      teams,
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
      updateData = {
        status: 'Reviewed', // atau ApprovedByManager
        approved_by: userId, // Mengisi Hartono Purwanto (Manager) di kolom "Approved by"
      };
      message =
        'Approve Tahap 1 (Shorebase Manager) berhasil! WO diteruskan ke Team Leader/Supervisor.';

      // TAHAP 2: TEAM LEADER / SUPERVISOR APPROVAL (Dibatasi per Team)
    } else if (
      (role === 'Supervisor' || role === 'Team Leader' || role === 'Super Admin') &&
      action === 'spv_approve'
    ) {
      // Pengecekan Team untuk Supervisor / Team Leader
      if (role !== 'Super Admin' && wo.team && userTeam && wo.team !== userTeam) {
        return res.send(
          `<script>alert("Anda hanya bisa menyetujui WO untuk team ${userTeam}!"); window.location.href="/";</script>`
        );
      }
      updateData = {
        status: 'Approved',
        reviewed_by: userId, // Mengisi Supervisor di kolom "Reviewed by"
      };
      message = 'Approve Tahap 2 (Team Leader/Supervisor) berhasil! Status WO resmi Approved.';

      // AKSI PENYELESAIAN PEKERJAAN (LEMBAR PERSETUJUAN / PENYELESAIAN)
    } else if ((role === 'Pemohon' || role === 'Super Admin') && action === 'complete') {
      const total =
        parseFloat(req.body.biaya_manpower || 0) +
        parseFloat(req.body.biaya_material || 0) +
        parseFloat(req.body.biaya_lain || 0);

      updateData = {
        status: 'Completed',
        performed_by: userId,
        detail_pekerjaan: req.body.detail_pekerjaan,
        completion_status: req.body.completion_status,
        biaya_manpower: req.body.biaya_manpower || 0,
        biaya_material: req.body.biaya_material || 0,
        biaya_lain: req.body.biaya_lain || 0,
        total_biaya: total,
      };
      message = 'Pekerjaan telah diselesaikan! Menunggu verifikasi Team Leader.';
    } else if (
      (role === 'Supervisor' || role === 'Team Leader' || role === 'Super Admin') &&
      action === 'verify'
    ) {
      if (role !== 'Super Admin' && wo.team && userTeam && wo.team !== userTeam) {
        return res.send(
          `<script>alert("Anda hanya bisa memverifikasi WO untuk team ${userTeam}!"); window.location.href="/";</script>`
        );
      }
      updateData = {
        verified_by: userId,
      };
      message = 'Hasil pekerjaan telah diverifikasi!';
    } else if ((role === 'Pemohon' || role === 'Super Admin') && action === 'close') {
      updateData = { status: 'Closed', received_by: userId };
      message = 'Work Order Resmi DITUTUP (Closed). Terima kasih!';
    } else if (action === 'reject') {
      updateData = { status: 'Draft' };
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
        uraian_pekerjaan: req.body.uraian_pekerjaan,
        lokasi: req.body.lokasi,
        lampiran: finalLampiran,
        status: 'Submitted',
        team: req.body.team || wo.team,
      };
      message = 'Work Order berhasil diperbaiki dan diajukan ulang!';
    }

    const sql = 'UPDATE work_orders SET ? WHERE id = ?';
    db.query(sql, [updateData, woId], (err) => {
      if (err) throw err;
      res.send(`<script>alert("${message}"); window.location.href="/";</script>`);
    });
  });
});

// ==========================================
// 5. Menyalakan Server
// ==========================================
app.listen(PORT, () => {
  console.log(`🚀 Server berjalan! Buka browser dan ketik: http://localhost:${PORT}`);
});
