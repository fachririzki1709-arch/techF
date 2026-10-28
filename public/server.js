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

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// --- MIDDLEWARE ---
app.use(express.json({ limit: '50mb' })); 
app.use(cors());

// Middleware Anti-Cache agar data selalu fresh saat di-refresh
app.use('/api', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    next();
});

// --- WEBSOCKET ---
io.on('connection', (socket) => {
    console.log("🟢 Klien terhubung ke WebSocket");
});

// --- KONFIGURASI FOLDER FRONTEND & UPLOADS ---
const publicPath = path.join(__dirname, 'public');
const uploadPath = path.join(publicPath, 'uploads');
app.use(express.static(publicPath));

if (!fs.existsSync(uploadPath)) {
    fs.mkdirSync(uploadPath, { recursive: true });
}

// --- FUNGSI HELPER: KONVERSI BASE64 KE FILE FISIK ---
function simpanBase64KeFile(base64String, prefix) {
    if (!base64String || !base64String.startsWith('data:')) return base64String;
    try {
        const matches = base64String.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
        if (!matches || matches.length !== 3) return "";
        let ext = matches[1].split('/')[1] || 'png';
        if (ext === 'jpeg') ext = 'jpg';
        
        const buffer = Buffer.from(matches[2], 'base64');
        const filename = `${prefix}_${Date.now()}.${ext}`;
        const filepath = path.join(uploadPath, filename);
        
        fs.writeFileSync(filepath, buffer);
        return `/uploads/${filename}`;
    } catch (err) {
        console.error("Gagal simpan file:", err);
        return "";
    }
}

// --- KONEKSI MONGODB ---
const MONGO_URI = process.env.MONGO_URI || "mongodb://localhost:27017/db_servis_hp"; 
mongoose.connect(MONGO_URI)
  .then(() => console.log("✅ Sukses Terhubung ke MongoDB!"))
  .catch(err => console.error("❌ Gagal Koneksi MongoDB:", err));

// --- SCHEMA & MODEL ---
const OrderSchema = new mongoose.Schema({
    kode: String, nama: String, wa: String, merek: String, tipe: String, kerusakan: String, layanan: String,
    shareloc: { type: String, default: "" }, 
    status: { type: String, default: "baru" },
    tanggalInput: { type: String, default: () => new Date().toISOString().split('T')[0] },
    teknisi: String, jadwal: String, lokasiServis: String,
    buktiDP: String, buktiPelunasan: String,  
    etaTeknisi: { type: String, default: "" },
    rating: { type: Number, default: 0 },
    ulasan: { type: String, default: "" },
    biayaSuku: { type: Number, default: 0 },
    biayaJasa: { type: Number, default: 0 },
    metodePembayaran: String, metodeDP: String,
    dpValid: { type: Boolean, default: false },
    dpTerbayar: { type: Boolean, default: false },
    pembayaranDikonfirmasi: { type: Boolean, default: false },
    pembayaranValid: { type: Boolean, default: false },
    adaKerusakanTambahan: { type: Boolean, default: false },
    infoKerusakanTambahan: String,
    biayaSukuTambahan: { type: Number, default: 0 },
    statusPersetujuanTambahan: { type: String, default: "pending" },
    kondisiHP: String,
    tipeKondisi: { type: String, default: "" }
}, { strict: false });

const Order = mongoose.model('Order', OrderSchema, 'orders');

const ChatSchema = new mongoose.Schema({
    kode: String, pengirim: String, teks: String, waktu: String
});
const Chat = mongoose.model('Chat', ChatSchema, 'chats');

// --- ROUTE API ADMIN & AUTH ---
const JWT_SECRET = process.env.JWT_SECRET || "kunci_rahasia_admin_123";
const ADMIN_HASH = bcrypt.hashSync(process.env.ADMIN_PASSWORD || "admin123", 8);

function verifyAdmin(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1]; 
    if (!token) return res.status(401).json({ message: "Akses Ditolak" });
    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ message: "Token Tidak Valid" });
        next(); 
    });
}

app.post('/api/admin/login', (req, res) => {
    const { username, password } = req.body;
    if (username === "admin" && bcrypt.compareSync(password, ADMIN_HASH)) {
        const token = jwt.sign({ role: "admin" }, JWT_SECRET, { expiresIn: '12h' });
        res.json({ token, message: "Login Berhasil" });
    } else {
        res.status(401).json({ message: "ID atau Password salah" });
    }
});

// --- ROUTE API TEKNISI ---
app.post('/api/teknisi/login', (req, res) => {
    const { username, password } = req.body;
    if (username && password) {
        const token = jwt.sign({ role: "teknisi", nama: username }, JWT_SECRET, { expiresIn: '12h' });
        res.json({ token, nama: username, message: "Login Berhasil" });
    } else {
        res.status(400).json({ message: "Username dan Password wajib diisi" });
    }
});

app.put('/api/teknisi/status', (req, res) => {
    res.json({ message: "Status teknisi diperbarui" });
});

app.get('/api/teknisi/orders/available', async (req, res) => {
    try {
        const availableOrders = await Order.find({ 
            $or: [
                { status: "baru" },
                { status: { $exists: false } },
                { teknisi: { $in: [null, ""] } }
            ]
        }).sort({ _id: -1 });
        res.json(availableOrders);
    } catch (error) {
        res.status(500).json({ error: "Gagal memuat order tersedia" });
    }
});

// FIX PERBAIKAN PENCARIAN TUGAS AKTIF
app.get('/api/teknisi/orders/aktif', async (req, res) => {
    try {
        const rawTeknisi = req.query.teknisi || "";
        const namaTeknisi = rawTeknisi.toString().trim();
        
        if (!namaTeknisi) {
            return res.json([]);
        }
        
        const escapedNama = namaTeknisi.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regexNama = new RegExp("^" + escapedNama + "$", "i");

        // Semua order milik teknisi ini yang belum selesai/batal
        const tugasAktif = await Order.find({ 
            $or: [
                { teknisi: regexNama },
                { "pengerjaan.teknisi": regexNama }
            ],
            status: { $nin: ['selesai_servis', 'batal', 'selesai', 'dibatalkan'] }
        }).sort({ _id: -1 });
        
        res.json(tugasAktif);
    } catch (error) { 
        console.error("Error /api/teknisi/orders/aktif:", error);
        res.status(500).json({ error: "Gagal memuat tugas aktif" }); 
    }
});

// --- ROUTE ORDERS (UMUM & ADMIN) ---
app.get('/api/orders', verifyAdmin, async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 2000; 
        const dataOrders = await Order.find().sort({ _id: -1 }).limit(limit);
        const ordersObject = {};
        dataOrders.forEach(order => { if (order.kode) ordersObject[order.kode] = order; });
        res.json(ordersObject);
    } catch (error) { res.status(500).json({ error: "Gagal memuat data pesanan" }); }
});

app.post('/api/orders', async (req, res) => {
    try {
        if (!req.body.nama || !req.body.wa || !req.body.merek) {
            return res.status(400).json({ error: "Data wajib tidak lengkap" });
        }

        const dataOrder = req.body;
        
        if (dataOrder.kondisiHP && dataOrder.kondisiHP.startsWith('data:')) {
            dataOrder.kondisiHP = simpanBase64KeFile(dataOrder.kondisiHP, 'KONDISI_' + dataOrder.kode);
        }

        const dataBaru = new Order(dataOrder);
        await dataBaru.save();
        
        if(req.body.kodeKonsultasi) {
            await Chat.updateMany(
                { kode: req.body.kodeKonsultasi },
                { $set: { kode: dataBaru.kode } }
            );
        }

        io.emit("updateDashboardAdmin");
        io.emit("orderBaruTersedia", dataBaru);
        res.status(201).json({ message: "Data tersimpan" });
    } catch (error) { res.status(500).json({ error: "Gagal simpan" }); }
});

app.get('/api/orders/:kode', async (req, res) => {
    try {
        const kodeParam = req.params.kode.trim();
        const regexKode = new RegExp("^" + kodeParam.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + "$", "i");
        const pesanan = await Order.findOne({ $or: [{ kode: kodeParam }, { kode: regexKode }] });
        if(!pesanan) return res.status(404).json({ error: "Pesanan tidak ditemukan" });
        res.json(pesanan);
    } catch (error) { res.status(500).json({ error: "Gagal memuat pesanan" }); }
});

// FIX PERBAIKAN UPDATE ORDER (PREVENT FALSE 200 OK)
app.put('/api/orders/:kode', async (req, res) => {
    try {
        const dataUpdate = req.body;
        const kodeParam = req.params.kode.trim();

        if (dataUpdate.buktiDP && dataUpdate.buktiDP.startsWith('data:')) {
            dataUpdate.buktiDP = simpanBase64KeFile(dataUpdate.buktiDP, 'DP_' + kodeParam);
        }
        if (dataUpdate.buktiPelunasan && dataUpdate.buktiPelunasan.startsWith('data:')) {
            dataUpdate.buktiPelunasan = simpanBase64KeFile(dataUpdate.buktiPelunasan, 'LUNAS_' + kodeParam);
        }

        let updateData = await Order.findOneAndUpdate(
            { kode: kodeParam }, 
            { $set: dataUpdate }, 
            { new: true }
        );

        // Fallback case-insensitive jika kode order memiliki variasi huruf kapital
        if (!updateData) {
            const regexKode = new RegExp("^" + kodeParam.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + "$", "i");
            updateData = await Order.findOneAndUpdate(
                { kode: regexKode }, 
                { $set: dataUpdate }, 
                { new: true }
            );
        }

        if (!updateData) {
            return res.status(404).json({ error: "Order tidak ditemukan di database" });
        }
        
        io.emit("updateDataPelanggan", updateData.kode);
        io.emit("updateDashboardAdmin");
        res.json({ message: "Update berhasil", order: updateData });
    } catch (error) { 
        console.error("Error PUT /api/orders/:kode:", error);
        res.status(500).json({ error: "Gagal update" }); 
    }
});

app.delete('/api/orders/:kode', verifyAdmin, async (req, res) => {
    try {
        await Order.findOneAndDelete({ kode: req.params.kode });
        io.emit("updateDashboardAdmin");
        res.json({ message: "Hapus berhasil" });
    } catch (error) { res.status(500).json({ error: "Gagal hapus" }); }
});

app.get('/api/chats/konsultasi/list', verifyAdmin, async (req, res) => {
    try {
        const chats = await Chat.find({ kode: { $regex: '^KONSUL-' } }).sort({ _id: 1 });
        const grouped = {};
        chats.forEach(c => {
            if(!grouped[c.kode]) grouped[c.kode] = [];
            grouped[c.kode].push(c);
        });
        res.json(grouped);
    } catch (error) { res.status(500).json({ error: "Gagal memuat konsultasi" }); }
});

app.post('/api/chats', async (req, res) => {
    try {
        const chatBaru = new Chat(req.body);
        await chatBaru.save();
        io.emit("chatBaruDiterima", { kode: chatBaru.kode, pengirim: chatBaru.pengirim });
        res.status(201).json({ message: "Chat terkirim" });
    } catch (error) { res.status(500).json({ error: "Gagal kirim chat" }); }
});

app.get('/api/chats/:kode', async (req, res) => {
    try {
        const logChat = await Chat.find({ kode: req.params.kode });
        res.json(logChat);
    } catch (error) { res.status(500).json({ error: "Gagal memuat chat" }); }
});

app.post('/api/orders/:kode/rating', async (req, res) => {
    try {
        const { rating, ulasan } = req.body;
        await Order.findOneAndUpdate({ kode: req.params.kode }, { $set: { rating, ulasan } });
        res.json({ message: "Rating berhasil disimpan" });
    } catch (error) { res.status(500).json({ error: "Gagal simpan rating" }); }
});

app.get('/api/reviews', async (req, res) => {
    try {
        const reviews = await Order.find({ rating: { $gt: 0 } }).select('nama rating ulasan merek tipe').limit(15).sort({ _id: -1 });
        res.json(reviews);
    } catch (error) { res.status(500).json({ error: "Gagal memuat review" }); }
});

// --- ROUTE FRONTEND (FALLBACK) ---
app.get('*', (req, res) => {
    res.sendFile(path.join(publicPath, 'index.html'));
});

// --- JALANKAN SERVER ---
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
    console.log(`🚀 Server berjalan di http://localhost:${PORT}`);
});
