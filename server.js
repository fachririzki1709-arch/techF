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

// WebSocket Connection Handler
io.on('connection', (socket) => {
    console.log("🟢 Klien terhubung ke WebSocket:", socket.id);
    
    socket.on('disconnect', () => {
        console.log("🔴 Klien terputus dari WebSocket:", socket.id);
    });
});

// Koneksi Database MongoDB
const MONGO_URI = process.env.MONGO_URI || "mongodb://localhost:27017/db_servis_hp"; 
mongoose.connect(MONGO_URI)
  .then(() => console.log("✅ Sukses Terhubung ke MongoDB!"))
  .catch(err => console.error("❌ Gagal Koneksi MongoDB:", err));

// Definisi Skema Database (Mongoose Schemas)
const OrderSchema = new mongoose.Schema({
    kode: { type: String, required: true, unique: true }, 
    nama: { type: String, required: true }, 
    wa: { type: String, required: true }, 
    merek: { type: String, required: true }, 
    tipe: { type: String, required: true }, 
    kerusakan: { type: String, default: "" }, 
    layanan: { type: String, default: "" },
    shareloc: { type: String, default: "" }, 
    lat: { type: String, default: "" },
    lng: { type: String, default: "" },
    status: { type: String, default: "pending" }, 
    tanggalInput: { type: String, default: () => new Date().toISOString().split('T')[0] },
    waktuPesan: { type: Date, default: Date.now }, 
    teknisi: { type: String, default: "" }, 
    jadwal: { type: String, default: "" }, 
    lokasiServis: { type: String, default: "home_service" },
    buktiPelunasan: { type: String, default: "" },  
    etaTeknisi: { type: String, default: "" },
    rating: { type: Number, default: 0 },
    ulasan: { type: String, default: "" },
    biayaSuku: { type: Number, default: 0 },
    biayaJasa: { type: Number, default: 0 },
    biayaPengecekan: { type: Number, default: 50000 },
    metodePembayaran: { type: String, default: "" },
    pembayaranDikonfirmasi: { type: Boolean, default: false },
    pembayaranValid: { type: Boolean, default: false },
    adaKerusakanTambahan: { type: Boolean, default: false },
    infoKerusakanTambahan: { type: String, default: "" },
    biayaSukuTambahan: { type: Number, default: 0 },
    statusPersetujuanTambahan: { type: String, default: "pending" },
    kondisiHP: { type: String, default: "" },
    tipeKondisi: { type: String, default: "" },
    subStatusWorkshop: { type: String, default: "antrean" },
    estimasiSelesai: { type: String, default: "" },
    statusSparepart: { type: String, default: "tersedia" },
    buktiBayarInden: { type: String, default: "" },
    metodeBayarInden: { type: String, default: "" },
    indenTerbayar: { type: Boolean, default: false },
    riwayatStatus: { type: Array, default: [] }
});
const Order = mongoose.model('Order', OrderSchema, 'orders');

const ChatSchema = new mongoose.Schema({
    kode: String, 
    pengirim: String, 
    teks: String, 
    waktu: String
});
const Chat = mongoose.model('Chat', ChatSchema, 'chats');

// --- FUNGSI HELPER WHATSAPP GATEWAY (Webhook) ---
async function kirimNotifikasiWA(noWa, pesanTeks) {
    console.log(`[WA Gateway Simulasi] Mengirim ke ${noWa}: ${pesanTeks}`);
    try {
        /* Uncomment dan sesuaikan token jika menggunakan penyedia layanan Fonnte / Wablas / Watzap
        const response = await fetch('https://api.fonnte.com/send', {
            method: 'POST',
            headers: { 'Authorization': 'TOKEN_ANDA_DISINI' },
            body: new URLSearchParams({ target: noWa, message: pesanTeks, countryCode: '62' })
        });
        const result = await response.json();
        console.log("Status WA Fonnte:", result);
        */
    } catch(err) {
        console.error("Gagal mengirim WA:", err);
    }
}

// Konfigurasi Admin & Middleware JWT
const JWT_SECRET = process.env.JWT_SECRET || "kunci_rahasia_admin_123";
const ADMIN_HASH = bcrypt.hashSync(process.env.ADMIN_PASSWORD || "admin123", 8);

function verifyAdmin(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1]; 
    if (!token) return res.status(401).json({ message: "Akses Ditolak: Token tidak ditemukan" });
    
    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ message: "Token Tidak Valid atau Kadaluarsa" });
        req.adminUser = user;
        next(); 
    });
}

// API ROUTES

// Endpoint Login Admin
app.post('/api/admin/login', (req, res) => {
    const { username, password } = req.body;
    if (username === "admin" && bcrypt.compareSync(password, ADMIN_HASH)) {
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
        if(req.body['koordinat[lat]']) dataOrder.lat = req.body['koordinat[lat]'];
        if(req.body['koordinat[lng]']) dataOrder.lng = req.body['koordinat[lng]'];
        
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

        io.emit("updateDashboardAdmin");
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
        io.emit("updateDashboardAdmin");
        res.json({ message: "Bukti inden berhasil diunggah", updated });
    } catch (error) {
        res.status(500).json({ error: "Gagal mengunggah bukti inden" });
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

// Endpoint Kirim Pesan Chat
app.post('/api/chats', async (req, res) => {
    try {
        const chatBaru = new Chat(req.body);
        await chatBaru.save();
        io.emit("chatBaruDiterima", { kode: chatBaru.kode, pengirim: chatBaru.pengirim });
        res.status(201).json({ message: "Pesan chat terkirim" });
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

// Menjalankan Server Node.js
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
    console.log(`🚀 Server backend berjalan di http://localhost:${PORT}`);
});
