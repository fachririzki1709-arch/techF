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
const io = new Server(server, { cors: { origin: "*" } });

// --- MIDDLEWARE ---
app.use(express.json({ limit: '50mb' })); 
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(cors());

// Rate Limiting
const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, 
    max: 300, 
    message: { error: "Terlalu banyak request dari IP ini, coba lagi nanti." },
    standardHeaders: true,
    legacyHeaders: false,
});
app.use('/api', apiLimiter);

app.use('/api', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    next();
});

// --- KONFIGURASI FOLDER FRONTEND & UPLOADS ---
const publicPath = path.join(__dirname, 'public');
const uploadPath = path.join(publicPath, 'uploads');
app.use(express.static(publicPath));

if (!fs.existsSync(uploadPath)) {
    fs.mkdirSync(uploadPath, { recursive: true });
}

// Konfigurasi Multer
const storage = multer.diskStorage({
    destination: function (req, file, cb) { cb(null, uploadPath); },
    filename: function (req, file, cb) {
        const ext = path.extname(file.originalname) || '.jpg';
        cb(null, file.fieldname + '_' + Date.now() + ext);
    }
});
const upload = multer({ 
    storage: storage,
    limits: { fileSize: 50 * 1024 * 1024 }
});

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
    } catch (err) { return ""; }
}

// --- WEBSOCKET ---
io.on('connection', (socket) => {
    console.log("🟢 Klien terhubung ke WebSocket");
});

// --- KONEKSI MONGODB ---
const MONGO_URI = process.env.MONGO_URI || "mongodb://localhost:27017/db_servis_hp"; 
mongoose.connect(MONGO_URI)
  .then(() => console.log("✅ Sukses Terhubung ke MongoDB!"))
  .catch(err => console.error("❌ Gagal Koneksi MongoDB:", err));

// --- SCHEMA & MODEL (Dimodifikasi: Hapus DP, Tambah Pengecekan & Inden) ---
const OrderSchema = new mongoose.Schema({
    kode: String, nama: String, wa: String, merek: String, tipe: String, kerusakan: String, layanan: String,
    shareloc: { type: String, default: "" }, 
    status: { type: String, default: "baru" },
    tanggalInput: { type: String, default: () => new Date().toISOString().split('T')[0] },
    teknisi: String, jadwal: String, lokasiServis: String,
    buktiPelunasan: String,  
    etaTeknisi: { type: String, default: "" },
    rating: { type: Number, default: 0 },
    ulasan: { type: String, default: "" },
    biayaSuku: { type: Number, default: 0 },
    biayaJasa: { type: Number, default: 0 },
    biayaPengecekan: { type: Number, default: 50000 },
    metodePembayaran: String,
    pembayaranDikonfirmasi: { type: Boolean, default: false },
    pembayaranValid: { type: Boolean, default: false },
    adaKerusakanTambahan: { type: Boolean, default: false },
    infoKerusakanTambahan: String,
    biayaSukuTambahan: { type: Number, default: 0 },
    statusPersetujuanTambahan: { type: String, default: "pending" },
    kondisiHP: String,
    tipeKondisi: { type: String, default: "" },
    subStatusWorkshop: { type: String, default: "antrean" },
    estimasiSelesai: { type: String, default: "" },
    statusSparepart: { type: String, default: "ready" },
    buktiBayarInden: { type: String, default: "" },
    metodeBayarInden: { type: String, default: "" },
    indenTerbayar: { type: Boolean, default: false },
    riwayatStatus: { type: Array, default: [] }
});
const Order = mongoose.model('Order', OrderSchema, 'orders');

const ChatSchema = new mongoose.Schema({
    kode: String, pengirim: String, teks: String, waktu: String
});
const Chat = mongoose.model('Chat', ChatSchema, 'chats');

// --- ROUTE API ---
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

app.get('/api/orders', verifyAdmin, async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 2000; 
        const dataOrders = await Order.find().sort({ _id: -1 }).limit(limit);
        const ordersObject = {};
        dataOrders.forEach(order => { if (order.kode) ordersObject[order.kode] = order; });
        res.json(ordersObject);
    } catch (error) { res.status(500).json({ error: "Gagal memuat data pesanan" }); }
});

app.post('/api/orders', upload.fields([{ name: 'kondisiHPFile', maxCount: 1 }]), async (req, res) => {
    try {
        if (!req.body.nama || !req.body.wa || !req.body.merek) {
            return res.status(400).json({ error: "Data wajib tidak lengkap" });
        }

        const dataOrder = req.body;
        
        if (req.files && req.files['kondisiHPFile']) {
            dataOrder.kondisiHP = `/uploads/${req.files['kondisiHPFile'][0].filename}`;
            dataOrder.tipeKondisi = req.files['kondisiHPFile'][0].mimetype;
        } else if (dataOrder.kondisiHP && dataOrder.kondisiHP.startsWith('data:')) {
            dataOrder.kondisiHP = simpanBase64KeFile(dataOrder.kondisiHP, 'KONDISI_' + dataOrder.kode);
        }

        // Default Audit Trail
        dataOrder.biayaPengecekan = 50000;
        dataOrder.riwayatStatus = [{ status: "baru", detail: "Pesanan masuk ke sistem", waktu: new Date().toISOString() }];

        const dataBaru = new Order(dataOrder);
        await dataBaru.save();
        
        if(req.body.kodeKonsultasi) {
            await Chat.updateMany(
                { kode: req.body.kodeKonsultasi },
                { $set: { kode: dataBaru.kode } }
            );
        }

        io.emit("updateDashboardAdmin");
        res.status(201).json({ message: "Data tersimpan" });
    } catch (error) { res.status(500).json({ error: "Gagal simpan" }); }
});

app.get('/api/orders/:kode', async (req, res) => {
    try {
        const pesanan = await Order.findOne({ kode: req.params.kode });
        if(!pesanan) return res.status(404).json({ error: "Pesanan tidak ditemukan" });
        res.json(pesanan);
    } catch (error) { res.status(500).json({ error: "Gagal memuat pesanan" }); }
});

app.put('/api/orders/:kode', upload.fields([{ name: 'buktiIndenFile', maxCount: 1 }, { name: 'buktiPelunasanFile', maxCount: 1 }]), async (req, res) => {
    try {
        const dataUpdate = req.body;

        if (req.files) {
            if (req.files['buktiIndenFile']) dataUpdate.buktiBayarInden = `/uploads/${req.files['buktiIndenFile'][0].filename}`;
            if (req.files['buktiPelunasanFile']) dataUpdate.buktiPelunasan = `/uploads/${req.files['buktiPelunasanFile'][0].filename}`;
        }
        if (dataUpdate.buktiBayarInden && dataUpdate.buktiBayarInden.startsWith('data:')) dataUpdate.buktiBayarInden = simpanBase64KeFile(dataUpdate.buktiBayarInden, 'INDEN_' + req.params.kode);
        if (dataUpdate.buktiPelunasan && dataUpdate.buktiPelunasan.startsWith('data:')) dataUpdate.buktiPelunasan = simpanBase64KeFile(dataUpdate.buktiPelunasan, 'LUNAS_' + req.params.kode);

        // Audit Trail System
        const existing = await Order.findOne({ kode: req.params.kode });
        if (existing) {
            if (dataUpdate.status && existing.status !== dataUpdate.status) {
                await Order.updateOne(
                    { kode: req.params.kode }, 
                    { $push: { riwayatStatus: { status: dataUpdate.status, detail: "Pembaruan progres", waktu: new Date().toISOString() } } }
                );
            }
            if (dataUpdate.statusPersetujuanTambahan && existing.statusPersetujuanTambahan !== dataUpdate.statusPersetujuanTambahan) {
                let det = "Pelanggan mengubah persetujuan";
                if(dataUpdate.statusPersetujuanTambahan === 'disetujui') det = "Pelanggan menyetujui tambahan biaya";
                if(dataUpdate.statusPersetujuanTambahan === 'ditolak_lanjut') det = "Pelanggan menolak biaya tambahan (lanjut servis awal)";
                if(dataUpdate.statusPersetujuanTambahan === 'ditolak_batal') det = "Pelanggan membatalkan seluruh servis (terkena biaya cek)";
                
                await Order.updateOne(
                    { kode: req.params.kode }, 
                    { $push: { riwayatStatus: { status: existing.status, detail: det, waktu: new Date().toISOString() } } }
                );
            }
        }

        const updateData = await Order.findOneAndUpdate(
            { kode: req.params.kode }, 
            { $set: dataUpdate }, 
            { new: true }
        );
        
        io.emit("updateDataPelanggan", updateData.kode);
        io.emit("updateDashboardAdmin");
        res.json({ message: "Update berhasil" });
    } catch (error) { res.status(500).json({ error: "Gagal update" }); }
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

app.get('*', (req, res) => {
    res.sendFile(path.join(publicPath, 'index.html'));
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
    console.log(`🚀 Server berjalan di http://localhost:${PORT}`);
});
