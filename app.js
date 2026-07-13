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

// 2. Konfigurasi Koneksi Database (Ambil dari .env)
const db = mysql.createConnection({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
});

// Mengecek apakah database berhasil terhubung
db.connect((err) => {
  if (err) {
    console.error('Gagal terhubung ke database:', err);
  } else {
    console.log('✅ Berhasil terhubung ke database MySQL!');
  }
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
app.use(express.static('public'));

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
      req.session.user = results[0];
      console.log(`🔑 ${req.session.user.nama} berhasil login!`);
      res.redirect('/'); // Arahkan ke form WO
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

  res.render('form-wo', { user: req.session.user, wo: null });
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

  // Query untuk mengambil data WO beserta nama-nama yang sudah tanda tangan (jika ada)
  const sql = ` 
         SELECT wo.*, 
                u1.nama AS nama_prepared, u1.departemen AS dept_prepared, 
                u2.nama AS nama_reviewed, 
                u3.nama AS nama_approved 
         FROM work_orders wo 
         LEFT JOIN users u1 ON wo.prepared_by = u1.id 
         LEFT JOIN users u2 ON wo.reviewed_by = u2.id 
         LEFT JOIN users u3 ON wo.approved_by = u3.id 
         WHERE wo.id = ? 
     `;

  db.query(sql, [woId], (err, results) => {
    if (err) throw err;
    if (results.length === 0) return res.send('Work Order tidak ditemukan.');

    // Render form-wo dengan mengirimkan data user login DAN data WO hasil query
    res.render('form-wo', {
      user: req.session.user,
      wo: results[0],
    });
  });
});

// 5. PROSES AKSI: Menangani tombol Review, Approve, atau Reject
app.post('/action-wo/:id', upload.any(), (req, res) => {
  if (!req.session.user) return res.redirect('/login');

  const woId = req.params.id;
  const role = req.session.user.role;
  const userId = req.session.user.id;
  const action = req.body.action; // Menangkap tombol mana yang diklik

  let updateData = {};
  let message = '';

  if ((role === 'Manager' || role === 'Super Admin') && action === 'review') {
    updateData = { status: 'Reviewed', reviewed_by: userId };
    message = 'Work Order berhasil diverifikasi dan diteruskan ke Supervisor!';
  } else if ((role === 'Supervisor' || role === 'Super Admin') && action === 'approve') {
    updateData = { status: 'Approved', approved_by: userId };
    message = 'Work Order resmi disetujui (Approved)!';
  } else if ((role === 'Pemohon' || role === 'Super Admin') && action === 'complete') {
    // Mengira jumlah kos automatik
    const total =
      parseFloat(req.body.biaya_manpower || 0) +
      parseFloat(req.body.biaya_material || 0) +
      parseFloat(req.body.biaya_lain || 0);

    updateData = {
      status: 'Completed',
      performed_by: userId, // Budi (Pemohon) menjadi pelaksana
      detail_pekerjaan: req.body.detail_pekerjaan,
      completion_status: req.body.completion_status,
      biaya_manpower: req.body.biaya_manpower || 0,
      biaya_material: req.body.biaya_material || 0,
      biaya_lain: req.body.biaya_lain || 0,
      total_biaya: total,
    };
    message = 'Pekerjaan telah diselesaikan! Menunggu verifikasi Supervisor.';
  } else if ((role === 'Supervisor' || role === 'Super Admin') && action === 'verify') {
    updateData = {
      verified_by: userId,
    };
    message = 'Hasil pekerjaan telah diverifikasi!';
  } else if ((role === 'Pemohon' || role === 'Super Admin') && action === 'close') {
    updateData = { status: 'Closed', received_by: userId };
    message = 'Work Order Resmi DITUTUP (Closed). Terima kasih!';
  } else if (action === 'reject') {
    updateData = { status: 'Draft' }; // Dikembalikan jadi draft agar bisa diedit pemohon lagi
    message = 'Work Order ditolak dan dikembalikan ke Pemohon.';
  } else if ((role === 'Pemohon' || role === 'Super Admin') && action === 'resubmit') {
    // Tangkap nama file lama dari input tersembunyi
    let finalLampiran = req.body.old_lampiran || null;

    // Jika user mengunggah file baru, proses filenya dan TIMPA file yang lama
    if (req.files && req.files.length > 0) {
      // Filter hanya file dengan fieldname 'lampiran_file'
      const lampiranFiles = req.files.filter((file) => file.fieldname === 'lampiran_file');
      if (lampiranFiles.length > 0) {
        const paths = lampiranFiles.map((file) => '/uploads/' + file.filename);
        finalLampiran = paths.join(',');
      }
    }

    updateData = {
      uraian_pekerjaan: req.body.uraian_pekerjaan,
      lokasi: req.body.lokasi,
      lampiran: finalLampiran, // <--- Menyimpan update lampiran ke database
      status: 'Submitted',
    };
    message = 'Work Order berhasil diperbaiki dan diajukan ulang!';
  }

  const sql = 'UPDATE work_orders SET ? WHERE id = ?';
  db.query(sql, [updateData, woId], (err) => {
    if (err) throw err;
    res.send(`<script>alert("${message}"); window.location.href="/";</script>`);
  });
});

// ==========================================
// 5. Menyalakan Server
// ==========================================
app.listen(PORT, () => {
  console.log(`🚀 Server berjalan! Buka browser dan ketik: http://localhost:${PORT}`);
});
