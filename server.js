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

app.use(express.json({ limit: '10mb' })); 
app.use(cors());

// --- WEBSOCKET REALTIME MULTI-INTERFACE ---
io.on('connection', (socket) => {
    console.log("🟢 Klien terhubung ke WebSocket");
});

const publicPath = path.join(__dirname, 'public');
app.use(express.static(publicPath));

// --- KONEKSI MONGODB ---
const MONGO_URI = process.env.MONGO_URI || "mongodb://localhost:27017/db_servis_hp"; 
mongoose.connect(MONGO_URI)
  .then(() => console.log("✅ Sukses Terhubung ke MongoDB!"))
  .catch(err => console.error("❌ Gagal Koneksi MongoDB:", err));

// --- SCHEMA ---
const OrderSchema = new mongoose.Schema({
    kode: String, nama: String, wa: String, merek: String, tipe: String, kerusakan: String, layanan: String,
    status: { type: String, default: "baru" }, // baru -> jadwal -> diproses -> selesai_servis -> selesai
    tanggalInput: { type: String, default: () => new Date().toISOString().split('T')[0] },
    
    // Otoritas Admin
    teknisi: String, jadwal: String, lokasiServis: String, biayaJasa: { type: Number, default: 0 },
    dpTerbayar: { type: Boolean, default: false }, dpValid: { type: Boolean, default: false },
    pembayaranDikonfirmasi: { type: Boolean, default: false }, pembayaranValid: { type: Boolean, default: false },
    buktiDP: String, buktiPelunasan: String, metodePembayaran: String, metodeDP: String,
    
    // Otoritas Teknisi
    biayaSuku: { type: Number, default: 0 }, // Biaya part asli di lapangan
    adaKerusakanTambahan: { type: Boolean, default: false },
    infoKerusakanTambahan: { type: String, default: "" },
    biayaSukuTambahan: { type: Number, default: 0 },
    
    // Lainnya
    rating: { type: Number, default: 0 }, ulasan: { type: String, default: "" },
    kondisiHP: String, tipeKondisi: { type: String, default: "" }
});
const Order = mongoose.model('Order', OrderSchema, 'orders');

const ChatSchema = new mongoose.Schema({ kode: String, pengirim: String, teks: String, waktu: String });
const Chat = mongoose.model('Chat', ChatSchema, 'chats');

const JWT_SECRET = process.env.JWT_SECRET || "kunci_rahasia_123";

// --- MIDDLEWARE AUTH ---
function verifyToken(req, res, next) {
    const token = req.headers['authorization']?.split(' ')[1]; 
    if (!token) return res.status(401).json({ message: "Akses Ditolak" });
    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ message: "Token Tidak Valid" });
        req.user = user; next(); 
    });
}

// --- AUTH ENDPOINTS ---
app.post('/api/admin/login', (req, res) => {
    if (req.body.username === "admin" && req.body.password === "admin123") 
        res.json({ token: jwt.sign({ role: "admin" }, JWT_SECRET, { expiresIn: '12h' }) });
    else res.status(401).json({ message: "ID/Pass salah" });
});

app.post('/api/teknisi/login', (req, res) => {
    if (req.body.username === "teknisi" && req.body.password === "teknisi123") 
        res.json({ token: jwt.sign({ role: "teknisi" }, JWT_SECRET, { expiresIn: '12h' }) });
    else res.status(401).json({ message: "ID/Pass salah" });
});

// --- ORDER ENDPOINTS ---
app.post('/api/orders', async (req, res) => {
    try {
        await new Order(req.body).save();
        io.emit("updateSistem"); // Beri tahu admin ada order baru
        res.status(201).json({ message: "Tersimpan" });
    } catch (err) { res.status(500).json({ error: "Gagal" }); }
});

app.get('/api/orders', verifyToken, async (req, res) => {
    try {
        const orders = await Order.find();
        const obj = {}; orders.forEach(o => obj[o.kode] = o);
        res.json(obj);
    } catch (err) { res.status(500).json({ error: "Gagal" }); }
});

app.get('/api/orders/:kode', async (req, res) => {
    try { res.json(await Order.findOne({ kode: req.params.kode })); } 
    catch (err) { res.status(500).json({ error: "Gagal" }); }
});

// Update Terpusat dengan Notifikasi Real-Time ke 3 Sisi
app.put('/api/orders/:kode', async (req, res) => {
    try {
        await Order.findOneAndUpdate({ kode: req.params.kode }, { $set: req.body });
        io.emit("updateSistem"); // Notif Admin & Teknisi
        io.emit("updateDataPelanggan", req.params.kode); // Notif Pelanggan
        res.json({ message: "Update berhasil" });
    } catch (err) { res.status(500).json({ error: "Gagal" }); }
});

// --- CHAT ENDPOINTS ---
app.post('/api/chats', async (req, res) => {
    try {
        const chatBaru = new Chat(req.body); await chatBaru.save();
        io.emit("chatBaruDiterima", chatBaru.kode);
        res.status(201).json({ message: "Terkirim" });
    } catch (err) { res.status(500).json({ error: "Gagal" }); }
});

app.get('/api/chats/:kode', async (req, res) => {
    try { res.json(await Chat.find({ kode: req.params.kode })); } 
    catch (err) { res.status(500).json({ error: "Gagal" }); }
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`🚀 Server berjalan di http://localhost:${PORT}`));
