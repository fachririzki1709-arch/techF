require('dotenv').config();

const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const jwt = require('jsonwebtoken'); 
const path = require('path'); 
const http = require('http');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const { Server } = require('socket.io');
const multer = require('multer');
const rateLimit = require('express-rate-limit');

// Konfigurasi Admin & Middleware JWT
const JWT_SECRET = process.env.JWT_SECRET || "kunci_rahasia_admin_123";
const ADMIN_HASH = bcrypt.hashSync(process.env.ADMIN_PASSWORD || "admin123", 8);


// 🔥 Inisialisasi Google Gemini AI 🔥
const { GoogleGenerativeAI } = require("@google/generative-ai");
const genAI = process.env.GEMINI_API_KEY ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY) : null;

const app = express();
const server = http.createServer(app);
const io = new Server(server, { 
    cors: { 
        origin: "*",
        methods: ["GET", "POST", "PUT", "DELETE"]
    } 
});

app.set('trust proxy', 1); 

// Middleware Keamanan & Parsing
app.use(cors());
app.use(express.json({ limit: '50mb' })); 
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Rate Limiter untuk Mencegah Spam API
const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, 
    max: 500, 
    message: { error: "Terlalu banyak request dari IP ini, coba beberapa saat lagi." },
    standardHeaders: true,
    legacyHeaders: false,
});
app.use('/api', apiLimiter);

// Header Anti-Cache untuk API
app.use('/api', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    next();
});

// Konfigurasi Direktori Statis & Uploads
const publicPath = path.join(__dirname, 'public');
const uploadPath = path.join(publicPath, 'uploads');
app.use(express.static(publicPath));

if (!fs.existsSync(uploadPath)) {
    fs.mkdirSync(uploadPath, { recursive: true });
}

// Konfigurasi Penyimpanan File dengan Multer
const storage = multer.diskStorage({
    destination: function (req, file, cb) { 
        cb(null, uploadPath); 
    },
    filename: function (req, file, cb) {
        const ext = path.extname(file.originalname) || '.jpg';
        cb(null, file.fieldname + '_' + Date.now() + ext);
    }
});
const upload = multer({ 
    storage: storage,
    limits: { fileSize: 50 * 1024 * 1024 }
});
// --- KONFIGURASI CLOUDINARY ---
const cloudinary = require('cloudinary').v2;
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});
// MIDDLEWARE AUTENTIKASI ADMIN
function verifyAdmin(req, res, next) {
    const authHeader = req.headers['authorization'];
    // Ambil token dari header 'Bearer <token>'
    const token = authHeader && authHeader.split(' ')[1]; 
    
    if (!token) return res.status(401).json({ message: "Akses Ditolak: Token admin tidak ditemukan" });
    
    jwt.verify(token, JWT_SECRET, (err, decoded) => {
        if (err) return res.status(403).json({ message: "Token Tidak Valid atau Kadaluarsa" });
        
        // Memastikan payload token memiliki role admin (Berdasarkan token yang di-generate di endpoint login Admin)
        if (decoded.role !== "admin") {
            return res.status(403).json({ message: "Akses Ditolak: Akun ini bukan admin" });
        }
        
        req.admin = decoded;
        next(); // Lanjut ke proses berikutnya
    });
}

// Helper: Fungsi upload dari lokal langsung dilempar ke Cloudinary
async function uploadKeCloudinary(filePath) {
    try {
        // Lewati dan kembalikan null jika Cloudinary belum disetting
        if (!process.env.CLOUDINARY_API_KEY) return null; 
        
        const result = await cloudinary.uploader.upload(filePath, { folder: "sftech_teknisi" });
        
        // Hapus file lokal HANYA jika upload ke cloud berhasil
        const fs = require('fs');
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath); 
        
        return result.secure_url;
    } catch (err) {
        console.error("Cloudinary Error:", err.message);
        return null; // Kembalikan null agar bisa menggunakan fallback lokal
    }
}

// Update Endpoint POST Tambah Teknisi oleh Admin
app.post('/api/teknisi', verifyAdmin, upload.single('fotoTeknisi'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: "Foto wajib diunggah" });
        
        let fotoUrl = await uploadKeCloudinary(req.file.path);
        
        // 🔥 FALLBACK: Gunakan path lokal jika Cloudinary gagal/kosong
        if (!fotoUrl) {
            fotoUrl = `/uploads/${req.file.filename}`;
        }

        const hashedPassword = bcrypt.hashSync(req.body.password || "teknisi123", 8);
        const arrayKeahlian = req.body.keahlian ? req.body.keahlian.split(',').map(s => s.trim().toLowerCase()) : [];

        const teknisiBaru = new Teknisi({
            nama: req.body.nama,
            username: req.body.username,
            password: hashedPassword,
            wa: req.body.wa,
            foto: fotoUrl,
            keahlian: arrayKeahlian
        });
        
        await teknisiBaru.save();
        res.status(201).json({ message: "Teknisi berhasil ditambahkan dengan akun login" });
        
    } catch (error) { 
        // Tangkap kegagalan (misalnya karena duplicate username) dan hapus file sampah
        const fs = require('fs');
        if (req.file && fs.existsSync(req.file.path)) {
            fs.unlinkSync(req.file.path);
        }
        
        // Format pesan error Mongoose agar lebih mudah dibaca admin
        if (error.code === 11000) {
            return res.status(400).json({ error: "Username sudah digunakan oleh teknisi lain. Silakan pilih username berbeda." });
        }
        
        res.status(500).json({ error: "Gagal menyimpan teknisi: " + error.message }); 
    }
});

// WebSocket Connection Handler
io.on('connection', (socket) => {
    console.log("🟢 Klien terhubung ke WebSocket:", socket.id);
    
    // Menerima update koordinat real-time dari pelanggan lalu mem-broadcast ke Admin
    socket.on('updateLocation', (data) => { 
        io.emit('updateLocationAdmin', data); 
    });

    // Menyamakan penamaan event pengiriman lokasi GPS dari form sisi User
    socket.on('streamLokasiUser', (data) => { 
        io.emit('updateLocationAdmin', data); 
    });

    // Menerima sinyal 'mengetik' lalu mem-broadcast ke pihak lawan
    socket.on('typing', (data) => { 
        io.emit('typing', data); 
        io.emit('userTyping', data); 
    });

    // Menangani event stopTyping indikator chat
    socket.on('stopTyping', (data) => { 
        io.emit('userStopTyping', data); 
    });
    // 👇 TAMBAHKAN BLOK INI: Listener saat teknisi klik Ambil Order
    socket.on('teknisiAmbilOrder', async (data) => {
        try {
            const { kodeOrder, namaTeknisi } = data;
            const order = await Order.findOne({ kode: kodeOrder });
            
            // First-to-claim logic: Hanya berhasil jika pesanan belum memiliki teknisi
            if (order && (order.teknisi === "" || !order.teknisi)) {
                order.teknisi = namaTeknisi;
                order.status = "dijadwalkan"; // Otomatis naik status menjadi dijadwalkan
                order.riwayatStatus.push({ status: "dijadwalkan", detail: `Diambil oleh Teknisi ${namaTeknisi}`, waktu: new Date().toISOString() });
                
                await order.save();
                
                // Hapus kartu pesanan di panel teknisi lainnya
                io.emit('orderSudahDiambil', { kodeOrder, oleh: namaTeknisi });
                // Update tabel di panel Admin
                io.emit("updateDashboardAdmin");
                // Update notifikasi live tracking Pelanggan
                io.emit("updateDataPelanggan", kodeOrder);
            }
        } catch (err) {
            console.error("Gagal memproses teknisiAmbilOrder:", err);
        }
    });
    
    socket.on('disconnect', () => {
        // console.log("🔴 Klien terputus dari WebSocket:", socket.id);
    });
});

// Koneksi Database MongoDB
const MONGO_URI = process.env.MONGO_URI || "mongodb://localhost:27017/db_servis_hp"; 
mongoose.connect(MONGO_URI)
  .then(() => console.log("✅ Sukses Terhubung ke MongoDB!"))
  .catch(err => console.error("❌ Gagal Koneksi MongoDB:", err));

// GANTI BLOK OrderSchema LAMA DENGAN INI:
const OrderSchema = new mongoose.Schema({
    kode: { type: String, required: true, unique: true, index: true }, 
    pelanggan: {
        nama: { type: String, required: true },
        wa: { type: String, required: true },
        privasi: { type: Boolean, default: false }, // Fitur Jaminan Privasi Data
        lokasi: {
            tipeServis: { type: String, enum: ['home_service', 'cod', 'workshop'], default: 'home_service' },
            lat: { type: String, default: "" },
            lng: { type: String, default: "" },
            shareloc: { type: String, default: "" }
        }
    },
    perangkat: {
        layanan: { type: String, default: "Smartphone" }, 
        merek: { type: String, required: true },
        tipe: { type: String, required: true },
        imeiSerial: { type: String, default: "" },
        kondisiHP: { type: String, default: "" },
        keluhan: { type: String, default: "" },
        kelengkapan: { type: String, default: "" }, // Fitur BAST Kelengkapan
        statusBAST: { type: String, default: "menunggu" },
        adaKerusakanTambahan: { type: Boolean, default: false }, // Fitur Kerusakan Ekstra
        infoKerusakanTambahan: { type: String, default: "" }
    },
    pengerjaan: {
        teknisi: { type: String, default: "", index: true }, 
        status: { 
            type: String, 
            enum: ['pending', 'dijadwalkan', 'diproses', 'menunggu_part', 'selesai_servis', 'selesai', 'batal', 'ditolak_pelanggan'], 
            default: 'pending',
            index: true
        },
        jadwal: { type: String, default: "" },
        etaTeknisi: { type: String, default: "" },
        estimasiSelesai: { type: String, default: "" },
        statusPersetujuanTambahan: { type: String, default: "pending" },
        videoUnboxingFile: { type: String, default: "" }, // Media Transparansi
        fotoPartFile: { type: String, default: "" },
        qcChecklist: { type: Map, of: Boolean, default: {} }, 
        riwayatStatus: [{
            status: String,
            detail: String,
            waktu: { type: Date, default: Date.now }
        }]
    },
    finansial: {
        biayaPengecekan: { type: Number, default: 50000 },
        biayaJasa: { type: Number, default: 0 },
        biayaSukuCadang: { type: Number, default: 0 },
        biayaSukuTambahan: { type: Number, default: 0 }, // Biaya Kerusakan Ekstra
        statusPembayaran: { type: String, enum: ['belum_lunas', 'menunggu_konfirmasi', 'lunas'], default: 'belum_lunas' },
        metodePembayaran: { type: String, default: "" },
        buktiPelunasan: { type: String, default: "" },
        pembayaranDikonfirmasi: { type: Boolean, default: false },
        pembayaranValid: { type: Boolean, default: false },
        inden: {
            statusPart: { type: String, default: "tersedia" },
            buktiBayarInden: { type: String, default: "" },
            indenTerbayar: { type: Boolean, default: false }
        }
    },
    ulasan: {
        rating: { type: Number, min: 0, max: 5, default: 0 },
        teks: { type: String, default: "" }
    }
}, { timestamps: true });
const Order = mongoose.model('Order', OrderSchema, 'orders');

const ChatSchema = new mongoose.Schema({
    kode: String, 
    pengirim: String, 
    teks: String, 
    waktu: String
});
const Chat = mongoose.model('Chat', ChatSchema, 'chats');

// Skema Notifikasi Baru untuk Sinkronisasi DB
const NotificationSchema = new mongoose.Schema({
    pesan: String,
    dibaca: { type: Boolean, default: false },
    waktu: { type: Date, default: Date.now }
});
const Notification = mongoose.model('Notification', NotificationSchema, 'notifications');

async function tambahNotifikasiDB(pesan) {
    try {
        await new Notification({ pesan }).save();
    } catch(err) { console.error("Gagal menyimpan notifikasi", err); }
}
// ==========================================
// HELPER: NOTIFIKASI WHATSAPP
// ==========================================
function kirimNotifikasiWA(nomor, pesan) {
    // Fungsi ini ditambahkan agar server tidak crash saat membuat orderan
    console.log(`[WhatsApp Simulasi] Pesan untuk ${nomor}: \n${pesan}`);
    
    // Catatan: Jika suatu saat Anda ingin menggunakan API WhatsApp asli 
    // (seperti Wablas, Fonnte, atau Baileys), Anda bisa memasukkan kodenya di sini.
}
// --- SKEMA TEKNISI (DIPERBARUI DENGAN USERNAME & PASSWORD) ---
const TeknisiSchema = new mongoose.Schema({
    nama: { type: String, required: true },
    username: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    wa: { type: String, required: true },
    foto: { type: String, required: true },
    statusKerja: { type: String, default: "luang" },
    keahlian: { type: [String], default: [] }
}, { timestamps: true });
const Teknisi = mongoose.model('Teknisi', TeknisiSchema, 'teknisi');

// Endpoint Login Teknisi
app.post('/api/teknisi/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        const teknisi = await Teknisi.findOne({ username });
        
        // 🔥 PERBAIKAN: Tambahkan pelindung password di sini juga
        if (!teknisi || !password || typeof password !== "string" || !bcrypt.compareSync(password, teknisi.password)) {
            return res.status(401).json({ message: "Username atau Password teknisi salah" });
        }
        
        const token = jwt.sign({ id: teknisi._id, nama: teknisi.nama, role: "teknisi" }, JWT_SECRET, { expiresIn: '12h' });
        res.json({ token, nama: teknisi.nama, message: "Login Teknisi Berhasil" });
    } catch (error) {
        res.status(500).json({ error: "Gagal login teknisi: " + error.message });
    }
});
function verifyTeknisi(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1]; 
    if (!token) return res.status(401).json({ message: "Akses Ditolak: Token tidak ditemukan" });
    
    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ message: "Token Tidak Valid atau Kadaluarsa" });
        req.teknisiUser = user;
        next(); 
    });
}
// GET: Ambil daftar order yang "Pending" (Tersedia untuk diambil)
app.get('/api/teknisi/orders/available', verifyTeknisi, async (req, res) => {
    try {
        // Cari order yang belum ada teknisinya dan berstatus pending/baru
        const availableOrders = await Order.find({
            $or: [{ teknisi: "" }, { teknisi: null }],
            status: { $in: ['pending', 'baru'] }
        }).sort({ waktuPesan: -1 });
        
        res.json(availableOrders);
    } catch (error) {
        res.status(500).json({ error: "Gagal memuat daftar pesanan tersedia" });
    }
});

// PUT: Update Status Online/Offline Teknisi
app.put('/api/teknisi/status', verifyTeknisi, async (req, res) => {
    try {
        const { statusKerja } = req.body;
        await Teknisi.findByIdAndUpdate(req.teknisiUser.id, { $set: { statusKerja } });
        res.json({ message: "Status kerja berhasil diperbarui" });
    } catch (error) {
        res.status(500).json({ error: "Gagal memperbarui status" });
    }
});
// --- API TEKNISI ---

// GET: Tampilkan semua teknisi (Bisa diakses Admin & User) beserta Kalkulasi Antrean
app.get('/api/teknisi', async (req, res) => {
    try {
        const teknisiList = await Teknisi.find().sort({ createdAt: -1 });
        
        // 🔄 LOOPING UNTUK MENGHITUNG QUEUE IN ORDER MASING-MASING TEKNISI
        const teknisiDenganAntrian = await Promise.all(teknisiList.map(async (tek) => {
            const jumlahAntrian = await Order.countDocuments({
                teknisi: tek.nama,
                status: { $in: ['dijadwalkan', 'diproses'] } // Hanya hitung status yang sedang aktif
            });
            // Gabungkan data teknisi dengan jumlah antreannya
            return { ...tek.toObject(), antrianAktif: jumlahAntrian }; 
        }));
        
        res.json(teknisiDenganAntrian);
    } catch (error) { res.status(500).json({ error: "Gagal memuat teknisi" }); }
});

// PUT: Edit Data Teknisi (Hanya Admin)
app.put('/api/teknisi/:id', verifyAdmin, upload.single('fotoTeknisi'), async (req, res) => {
    try {
        const updateData = {
            nama: req.body.nama,
            wa: req.body.wa
        };
        
        // Jika ada unggahan foto baru, perbarui path foto
        if (req.file) {
            updateData.foto = `/uploads/${req.file.filename}`;
            
            // Opsional: Hapus foto lama dari storage
            const tekLama = await Teknisi.findById(req.params.id);
            if (tekLama && tekLama.foto) {
                const fs = require('fs');
                const path = require('path');
                const filePath = path.join(__dirname, 'public', tekLama.foto);
                if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
            }
        }
        
        await Teknisi.findByIdAndUpdate(req.params.id, { $set: updateData });
        res.json({ message: "Data teknisi berhasil diperbarui" });
    } catch (error) { 
        res.status(500).json({ error: "Gagal memperbarui teknisi: " + error.message }); 
    }
});

// DELETE: Bersihkan Riwayat Chat Konsultasi
app.delete('/api/chats/kode/:kode', verifyAdmin, async (req, res) => {
    try {
        await Chat.deleteMany({ kode: req.params.kode });
        res.json({ message: "Riwayat chat berhasil dibersihkan" });
    } catch (error) { 
        res.status(500).json({ error: "Gagal menghapus riwayat chat" }); 
    }
});
// DELETE: Hapus Teknisi (Hanya Admin)
app.delete('/api/teknisi/:id', verifyAdmin, async (req, res) => {
    try {
        const tek = await Teknisi.findById(req.params.id);
        if (tek && tek.foto) {
            if (tek.foto.includes('cloudinary.com')) {
                // Ekstrak public_id dari link Cloudinary
                const urlParts = tek.foto.split('/');
                const publicId = "sftech_teknisi/" + urlParts[urlParts.length - 1].split('.')[0]; 
                await cloudinary.uploader.destroy(publicId);
            } else {
                // Fallback jika foto masih ada di local storage lama
                const fs = require('fs');
                const filePath = path.join(__dirname, 'public', tek.foto);
                if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
            }
        }
        await Teknisi.findByIdAndDelete(req.params.id);
        res.json({ message: "Teknisi berhasil dihapus" });
    } catch (error) { res.status(500).json({ error: "Gagal menghapus teknisi" }); }
});

// 🔥 FUNGSI HELPER KONVERSI GAMBAR UNTUK AI 🔥
function fileToGenerativePart(filePath, mimeType) {
    return {
        inlineData: {
            data: fs.readFileSync(filePath).toString("base64"),
            mimeType
        },
    };
}

// 🔥 ENDPOINT AI AUTO-SCAN PERANGKAT (VISION) 🔥
// 🔥 ENDPOINT AI AUTO-SCAN PERANGKAT (VISION) 🔥
app.post('/api/ai/scan-device', upload.single('deviceImage'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: "Tidak ada gambar yang diunggah" });
        if (!genAI) return res.status(500).json({ error: "API Key AI belum dikonfigurasi pada server" });

        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

        // PROMPT DIUBAH: Fokus ke pengenalan fisik (backdoor, modul kamera) alih-alih screenshot teks
        const prompt = `Anda adalah asisten teknisi smartphone tingkat lanjut. 
        Tugas Anda adalah menganalisis foto fisik perangkat ini (bisa berupa backdoor, susunan modul kamera, logo, atau tampak depan).
        
        Tentukan merek dan model/tipe perangkat tersebut. Jika tidak bisa memastikan seri pastinya (karena desain identik, misal iPhone 13 dan 14), berikan tebakan terbaik atau rentang serinya.
        
        KEMBALIKAN HANYA FORMAT JSON VALID SEPERTI DI BAWAH INI, TANPA TEKS ATAU PENJELASAN LAIN (tanpa blok kode markdown):
        {
            "merek": "Nama Merek (misal: Samsung, Asus, Xiaomi, Apple)",
            "tipe": "Nama Tipe Detail (misal: Galaxy S23 Ultra, iPhone 13 Pro)",
            "imeiSerial": "null"
        }`;

        const imagePart = fileToGenerativePart(req.file.path, req.file.mimetype);

        const result = await model.generateContent([prompt, imagePart]);
        let textResult = result.response.text();
        
        // Memaksa mengambil pola JSON yang aman untuk mencegah Crash 500
        const jsonMatch = textResult.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error("Format JSON gagal diekstrak dari AI");
        
        // Cukup parse JSON hasil ekstraksi regex (tanpa mendeklarasikan ulang parsedData)
        const parsedData = JSON.parse(jsonMatch[0]);
        
        // Hapus foto dari server setelah diproses agar storage tidak penuh
        fs.unlinkSync(req.file.path);
        res.json(parsedData);
    } catch (error) {
        console.error("AI Scan Error:", error);
        if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        res.status(500).json({ error: "Gagal memproses gambar dengan AI" });
    }
});

// API ROUTES ADMIN

// Endpoint Login Admin
app.post('/api/admin/login', (req, res) => {
    const { username, password } = req.body;
    
    // 🔥 PERBAIKAN: Tambahkan validasi tipe data password agar server tidak crash
    if (username === "admin" && password && typeof password === "string" && bcrypt.compareSync(password, ADMIN_HASH)) {
        const token = jwt.sign({ role: "admin" }, JWT_SECRET, { expiresIn: '12h' });
        res.json({ token, message: "Login Berhasil" });
    } else {
        res.status(401).json({ message: "ID atau Password salah" });
    }
});

// Endpoint Statistik untuk Dashboard Admin
app.get('/api/admin/stats', verifyAdmin, async (req, res) => {
    try {
        const totalPesanan = await Order.countDocuments();
        const pesananPending = await Order.countDocuments({ status: { $in: ['pending', 'baru'] } });
        const pesananDiproses = await Order.countDocuments({ status: 'diproses' });
        const pesananSelesai = await Order.countDocuments({ status: 'selesai' });
        
        res.json({
            totalPesanan,
            pesananPending,
            pesananDiproses,
            pesananSelesai
        });
    } catch (error) {
        res.status(500).json({ error: "Gagal memuat statistik dashboard" });
    }
});

// Endpoint Fetch & Update Notifikasi
app.get('/api/admin/notifications', verifyAdmin, async (req, res) => {
    try {
        const notifs = await Notification.find().sort({ _id: -1 }).limit(50);
        res.json(notifs);
    } catch (error) { res.status(500).json({ error: "Gagal memuat notifikasi" }); }
});

app.put('/api/admin/notifications/read', verifyAdmin, async (req, res) => {
    try {
        await Notification.updateMany({ dibaca: false }, { $set: { dibaca: true } });
        res.json({ message: "Semua notifikasi ditandai dibaca" });
    } catch (error) { res.status(500).json({ error: "Gagal update notifikasi" }); }
});

// Endpoint Menampilkan Ulasan Publik di Homepage
app.get('/api/reviews', async (req, res) => {
    try {
        const reviews = await Order.find({ rating: { $gt: 0 } }).select('nama merek tipe rating ulasan waktuPesan').sort({ _id: -1 }).limit(10);
        res.json(reviews);
    } catch (error) {
        res.status(500).json({ error: "Gagal memuat ulasan pelanggan" });
    }
});

// Endpoint Mengambil Seluruh Daftar Pesanan (Admin Only)
app.get('/api/orders', verifyAdmin, async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 2000; 
        const dataOrders = await Order.find().sort({ _id: -1 }).limit(limit);
        res.json(dataOrders); 
    } catch (error) { 
        res.status(500).json({ error: "Gagal memuat data pesanan" }); 
    }
});

// Endpoint Membuat Pesanan Baru (Pelanggan)
app.post('/api/orders', upload.any(), async (req, res) => {
    try {
        const dataOrder = req.body;

        // Menangkap koordinat langsung dari berbagai format input Form
        const latInput = req.body.lat || req.body['koordinat[lat]'] || (req.body.koordinat && req.body.koordinat.lat);
        const lngInput = req.body.lng || req.body['koordinat[lng]'] || (req.body.koordinat && req.body.koordinat.lng);
        
        dataOrder.lat = latInput || "";
        dataOrder.lng = lngInput || "";
        
        // Memastikan field tambahan tertangkap dari Form
        dataOrder.imeiSerial = req.body.imeiSerial || ""; 
        dataOrder.lokasiServis = req.body.lokasiServis || "home_service";
        
        if (req.files && req.files.length > 0) {
            const fileKondisi = req.files.find(f => f.fieldname === 'kondisiHPFile');
            if (fileKondisi) {
                dataOrder.kondisiHP = `/uploads/${fileKondisi.filename}`;
            }
        }

        dataOrder.biayaPengecekan = 50000;
        dataOrder.waktuPesan = new Date(); 
        dataOrder.riwayatStatus = [{ status: "pending", detail: "Pesanan masuk ke sistem", waktu: new Date().toISOString() }];

        const dataBaru = new Order(dataOrder);
        await dataBaru.save(); 
        
        const pesanWA = `Halo ${dataBaru.nama},\n\nTerima kasih telah memesan servis di SF Tech.\nKode Resi Anda: *${dataBaru.kode}*\n\nSilakan lacak status perbaikan Anda melalui website kami.`;
        kirimNotifikasiWA(dataBaru.wa, pesanWA);

        await tambahNotifikasiDB(`Pesanan Baru: ${dataBaru.kode} oleh ${dataBaru.nama}`);
        io.emit("updateDashboardAdmin");
        try {
            const semuaTeknisi = await Teknisi.find();
            const daftarNamaTeknisi = semuaTeknisi.map(t => t.nama);
            io.emit('orderBaruTersedia', {
                order: dataBaru,
                targetTeknisi: daftarNamaTeknisi
            });
        } catch(e) { console.error("Gagal broadcast ke teknisi", e); }
        res.status(201).json({ message: "Data pesanan berhasil disimpan", kode: dataBaru.kode });
    } catch (error) {
        res.status(500).json({ error: "Gagal menyimpan pesanan: " + error.message }); 
    }
});

// Endpoint Detail Pesanan Berdasarkan Kode Resi
app.get('/api/orders/:kode', async (req, res) => {
    try {
        const pesanan = await Order.findOne({ kode: req.params.kode });
        if(!pesanan) return res.status(404).json({ error: "Pesanan tidak ditemukan" });
        res.json(pesanan);
    } catch (error) { 
        res.status(500).json({ error: "Gagal memuat detail pesanan" }); 
    }
});

// Endpoint Bulk Actions (Admin Only)
app.post('/api/orders/bulk', verifyAdmin, async (req, res) => {
    try {
        const { ids, action } = req.body;
        if (!ids || ids.length === 0) return res.status(400).json({ error: "Tidak ada ID yang dipilih" });

        if (action === 'selesai') {
            await Order.updateMany(
                { kode: { $in: ids } },
                { $set: { pembayaranValid: true, status: 'selesai' } }
            );
            await tambahNotifikasiDB(`Aksi Massal: ${ids.length} pesanan ditandai selesai.`);
        } else if (action === 'hapus') {
            await Order.deleteMany({ kode: { $in: ids } });
            await tambahNotifikasiDB(`Aksi Massal: ${ids.length} pesanan dihapus.`);
        }

        io.emit("updateDashboardAdmin");
        res.json({ message: "Aksi massal berhasil diterapkan" });
    } catch (error) {
        res.status(500).json({ error: "Gagal mengeksekusi aksi massal: " + error.message });
    }
});

// Endpoint Pembaruan Status & Data Pesanan
app.put('/api/orders/:kode', upload.any(), async (req, res) => {
    try {
        const dataUpdate = req.body;
        
        if (req.files && req.files.length > 0) {
            const fInden = req.files.find(f => f.fieldname === 'buktiInden');
            if (fInden) dataUpdate.buktiBayarInden = `/uploads/${fInden.filename}`;
            
            const fLunas = req.files.find(f => f.fieldname === 'buktiPelunasan');
            if (fLunas) dataUpdate.buktiPelunasan = `/uploads/${fLunas.filename}`;
        }

        const existing = await Order.findOne({ kode: req.params.kode });
        
        if (existing && dataUpdate.status && existing.status !== dataUpdate.status) {
            await Order.updateOne(
                { kode: req.params.kode }, 
                { $push: { riwayatStatus: { status: dataUpdate.status, detail: "Pembaruan progres", waktu: new Date().toISOString() } } }
            );

            let statusTeks = dataUpdate.status;
            if(statusTeks === 'dijadwalkan') statusTeks = 'DIJADWALKAN - Teknisi akan segera meluncur';
            if(statusTeks === 'diproses') statusTeks = 'SEDANG DIPROSES';
            if(statusTeks === 'selesai_servis') statusTeks = 'SELESAI DIPERBAIKI - Menunggu Pelunasan';

            const pesanUpdate = `Pembaruan Status Servis SF Tech!\n\nPesanan dengan kode *${req.params.kode}* Anda saat ini berstatus:\n*${statusTeks.toUpperCase()}*\n\nSilakan cek website untuk rincian lebih lanjut.`;
            kirimNotifikasiWA(existing.wa, pesanUpdate);
        }

        const updateData = await Order.findOneAndUpdate(
            { kode: req.params.kode }, 
            { $set: dataUpdate }, 
            { new: true }
        );
        
        io.emit("updateDataPelanggan", updateData.kode);
        io.emit("updateDashboardAdmin");
        res.json({ message: "Update pesanan berhasil", updateData });
    } catch (error) { 
        res.status(500).json({ error: "Gagal memperbarui pesanan: " + error.message }); 
    }
});

// Endpoint Unggah Bukti Transfer Suku Cadang Inden
app.put('/api/orders/:kode/inden', upload.single('buktiInden'), async (req, res) => {
    try {
        let updateFields = {};
        if (req.file) {
            updateFields.buktiBayarInden = `/uploads/${req.file.filename}`;
        }
        const updated = await Order.findOneAndUpdate(
            { kode: req.params.kode },
            { $set: updateFields },
            { new: true }
        );
        await tambahNotifikasiDB(`Pembayaran Inden Masuk: ${req.params.kode}`);
        io.emit("updateDashboardAdmin");
        res.json({ message: "Bukti inden berhasil diunggah", updated });
    } catch (error) {
        res.status(500).json({ error: "Gagal mengunggah bukti inden" });
    }
});
// Endpoint Unggah Media Transparansi (Video Unboxing & Foto Part)
app.put('/api/orders/:kode/transparansi', verifyAdmin, upload.any(), async (req, res) => {
    try {
        let updateFields = {};
        if (req.files && req.files.length > 0) {
            const fVideo = req.files.find(f => f.fieldname === 'videoUnboxing');
            if (fVideo) updateFields.videoUnboxingFile = `/uploads/${fVideo.filename}`;

            const fFoto = req.files.find(f => f.fieldname === 'fotoPart');
            if (fFoto) updateFields.fotoPartFile = `/uploads/${fFoto.filename}`;
        }

        const updated = await Order.findOneAndUpdate(
            { kode: req.params.kode },
            { $set: updateFields },
            { new: true }
        );

        io.emit("updateDataPelanggan", req.params.kode);
        res.json({ message: "Media transparansi berhasil diunggah", updated });
    } catch (error) {
        res.status(500).json({ error: "Gagal mengunggah media transparansi" });
    }
});

// Endpoint Pembatalan Pesanan oleh Pelanggan
app.put('/api/orders/:kode/cancel', async (req, res) => {
    try {
        const { status } = req.body;
        const existing = await Order.findOne({ kode: req.params.kode });
        
        if (existing && (existing.status === 'baru' || existing.status === 'pending')) {
            await Order.updateOne(
                { kode: req.params.kode }, 
                { 
                    $set: { status: status || 'ditolak_pelanggan' },
                    $push: { riwayatStatus: { status: status || 'ditolak_pelanggan', detail: "Dibatalkan oleh Pelanggan via Website", waktu: new Date().toISOString() } } 
                }
            );
            
            await tambahNotifikasiDB(`Pesanan Dibatalkan User: ${req.params.kode}`);
            io.emit("updateDashboardAdmin");
            res.json({ message: "Pembatalan pesanan berhasil" });
        } else {
            res.status(400).json({ error: "Pesanan ini sudah diproses dan tidak dapat dibatalkan secara mandiri." });
        }
    } catch (error) { 
        res.status(500).json({ error: "Gagal membatalkan pesanan" }); 
    }
});

// Endpoint Memberikan Rating & Ulasan Pelayanan
app.post('/api/orders/:kode/rating', async (req, res) => {
    try {
        const { rating, ulasan } = req.body;
        const updated = await Order.findOneAndUpdate(
            { kode: req.params.kode },
            { $set: { rating: Number(rating), ulasan: ulasan || "" } },
            { new: true }
        );
        await tambahNotifikasiDB(`Ulasan Baru (${rating} Bintang): ${req.params.kode}`);
        io.emit("updateDashboardAdmin");
        res.json({ message: "Rating dan ulasan berhasil disimpan", updated });
    } catch (error) {
        res.status(500).json({ error: "Gagal menyimpan rating" });
    }
});

// Endpoint Hapus Pesanan (Admin Only)
app.delete('/api/orders/:kode', verifyAdmin, async (req, res) => {
    try {
        await Order.findOneAndDelete({ kode: req.params.kode });
        io.emit("updateDashboardAdmin");
        res.json({ message: "Pesanan berhasil dihapus" });
    } catch (error) { 
        res.status(500).json({ error: "Gagal menghapus pesanan" }); 
    }
});

// Endpoint untuk menarik semua riwayat chat
app.get('/api/chats', verifyAdmin, async (req, res) => {
    try {
        const allChats = await Chat.find().sort({ _id: 1 });
        const grouped = {};
        allChats.forEach(c => {
            if (!grouped[c.kode]) grouped[c.kode] = [];
            grouped[c.kode].push(c);
        });
        res.json(grouped);
    } catch (error) { 
        res.status(500).json({ error: "Gagal memuat daftar chat" }); 
    }
});

// 🔥 Endpoint Kirim Pesan Chat (Telah Diinjeksi Logika AI Bot) 🔥
app.post('/api/chats', async (req, res) => {
    try {
        const chatBaru = new Chat(req.body);
        await chatBaru.save();
        
        if(chatBaru.pengirim === 'user') {
            await tambahNotifikasiDB(`Pesan Chat Baru dari ${chatBaru.kode}`);
        }
        
        io.emit("chatBaruDiterima", { kode: chatBaru.kode, pengirim: chatBaru.pengirim });
        res.status(201).json({ message: "Pesan chat terkirim" });

        // Jika API Key AI dikonfigurasi dan pesan dari pengguna, aktifkan Bot
        if (chatBaru.pengirim === 'user' && genAI) {
            prosesBalasanBot(chatBaru.kode, chatBaru.teks).catch(err => console.error("Error Bot AI:", err));
        }

    } catch (error) { 
        res.status(500).json({ error: "Gagal mengirim pesan chat" }); 
    }
});


// Endpoint Ambil Log Chat Berdasarkan Kode Pesanan/Konsultasi
app.get('/api/chats/:kode', async (req, res) => {
    try {
        const logChat = await Chat.find({ kode: req.params.kode });
        res.json(logChat);
    } catch (error) { 
        res.status(500).json({ error: "Gagal memuat log chat" }); 
    }
});
// DELETE: Hapus 1 Pesan Berdasarkan ID
app.delete('/api/chats/:id', async (req, res) => {
    try {
        await Chat.findByIdAndDelete(req.params.id);
        res.json({ message: "Pesan berhasil dihapus" });
    } catch (error) { 
        res.status(500).json({ error: "Gagal menghapus pesan" }); 
    }
});

// 🔥 FUNGSI HELPER ASISTEN AI CHATBOT (SF BOT) 🔥
async function prosesBalasanBot(kode, pesanUser) {
    try {
        // Ambil riwayat chat agar bot mengerti konteks
        const riwayatRaw = await Chat.find({ kode: kode }).sort({ _id: 1 }).limit(15);
        const history = riwayatRaw.slice(0, -1).map(chat => ({
            role: chat.pengirim === 'user' ? 'user' : 'model',
            parts: [{ text: chat.teks }]
        }));

        const model = genAI.getGenerativeModel({
            model: "gemini-1.5-flash",
            systemInstruction: "Anda adalah 'SF Bot', asisten virtual dari SF Tech Service (Layanan Servis HP, Laptop, dan Elektronik). Jawablah dengan bahasa Indonesia yang ramah, sopan, dan singkat maksimal 2 paragraf. Informasi dasar: Biaya pengecekan awal adalah Rp 50.000. Jika pelanggan bertanya hal terlalu teknis, ingin bernegosiasi harga, atau Anda tidak tahu jawabannya, mintalah pelanggan menunggu Admin atau Teknisi Manusia membalas."
        });

        const chatSession = model.startChat({ history: history });
        
        // Memicu indikator "Mengetik" ke pelanggan
        io.emit('userTyping', { kode: kode, pengirim: 'admin' });

        const result = await chatSession.sendMessage(pesanUser);
        const balasanAI = result.response.text();

        // Simpan balasan AI ke Database
        const chatAI = new Chat({
            kode: kode,
            pengirim: 'admin',
            teks: "🤖 *SF Bot:*\n" + balasanAI,
            waktu: new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })
        });
        await chatAI.save();

        io.emit('userStopTyping', { kode: kode, pengirim: 'admin' });
        io.emit("chatBaruDiterima", { kode: kode, pengirim: 'admin' });
        
    } catch (error) {
        console.error("Gagal memproses AI Chat:", error);
        io.emit('userStopTyping', { kode: kode, pengirim: 'admin' });
    }
}

// Menjalankan Server Node.js
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
    console.log(`🚀 Server backend aktif di port ${PORT}`);
});
