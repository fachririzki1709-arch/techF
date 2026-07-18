require('dotenv').config();

const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const jwt = require('jsonwebtoken'); 
const path = require('path'); 
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// --- MIDDLEWARE ---
// PERBAIKAN: Limit JSON dinaikkan menjadi 50mb untuk menampung gambar Base64 beresolusi tinggi dari HP[span_1](start_span)[span_1](end_span)
app.use(express.json({ limit: '50mb' })); 
app.use(cors());

// --- WEBSOCKET ---
io.on('connection', (socket) => {
    console.log("🟢 Klien terhubung ke WebSocket");
});

// --- KONFIGURASI FOLDER FRONTEND ---
const publicPath = path.join(__dirname, 'public');
app.use(express.static(publicPath));

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
});
const Order = mongoose.model('Order', OrderSchema, 'orders');

const ChatSchema = new mongoose.Schema({
    kode: String, pengirim: String, teks: String, waktu: String
});
const Chat = mongoose.model('Chat', ChatSchema, 'chats');

// --- FUNGSI WA GATEWAY ---
async function kirimWhatsAppGateway(nomor, pesan) {
    let nomorFormatted = nomor.trim();
    if (nomorFormatted.startsWith("0")) nomorFormatted = "62" + nomorFormatted.slice(1);
    const API_URL_GATEWAY = "https://api.providerwagateway.com/send-message"; 
    const API_TOKEN = "ISI_DENGAN_TOKEN_GATEWAY_ANDA"; 
    try {
        await fetch(API_URL_GATEWAY, {
            method: "POST",
            headers: { "Content-Type": "application/json", "Authorization": `Bearer ${API_TOKEN}` },
            body: JSON.stringify({ target: nomorFormatted, message: pesan })
        });
    } catch (err) { console.error("❌ Gagal mengirim WA:", err.message); }
}

// --- ROUTE API ---
const JWT_SECRET = process.env.JWT_SECRET || "kunci_rahasia_admin_123";

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
    if (username === "admin" && password === "admin123") {
        const token = jwt.sign({ role: "admin" }, JWT_SECRET, { expiresIn: '12h' });
        res.json({ token, message: "Login Berhasil" });
    } else {
        res.status(401).json({ message: "ID atau Password salah" });
    }
});

app.get('/api/orders', verifyAdmin, async (req, res) => {
    try {
        const dataOrders = await Order.find();
        const ordersObject = {};
        dataOrders.forEach(order => { if (order.kode) ordersObject[order.kode] = order; });
        res.json(ordersObject);
    } catch (error) { res.status(500).json({ error: "Gagal memuat" }); }
});

app.post('/api/orders', async (req, res) => {
    try {
        const dataBaru = new Order(req.body);
        await dataBaru.save();
        io.emit("updateDashboardAdmin");
        res.status(201).json({ message: "Data tersimpan" });
    } catch (error) { res.status(500).json({ error: "Gagal simpan" }); }
});

app.get('/api/orders/:kode', async (req, res) => {
    try {
        const pesanan = await Order.findOne({ kode: req.params.kode });
        res.json(pesanan);
    } catch (error) { res.status(500).json({ error: "Gagal memuat" }); }
});

app.put('/api/orders/:kode', async (req, res) => {
    try {
        const updateData = await Order.findOneAndUpdate({ kode: req.params.kode }, { $set: req.body }, { new: true });
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

app.post('/api/chats', async (req, res) => {
    try {
        const chatBaru = new Chat(req.body);
        await chatBaru.save();
        io.emit("chatBaruDiterima", chatBaru.kode);
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
