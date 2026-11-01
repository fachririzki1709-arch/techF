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

// Inisialisasi Google Gemini AI
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

// KONFIGURASI CLOUDINARY
const cloudinary = require('cloudinary').v2;
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

// MIDDLEWARE AUTENTIKASI ADMIN
function verifyAdmin(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && (authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : authHeader); 
    
    if (!token) return res.status(401).json({ message: "Akses Ditolak: Token admin tidak ditemukan" }); 
    
    jwt.verify(token, JWT_SECRET, (err, decoded) => {
        if (err) return res.status(403).json({ message: "Token Tidak Valid atau Kadaluarsa" });
        
        if (decoded.role !== "admin") {
            return res.status(403).json({ message: "Akses Ditolak: Akun ini bukan admin" });
        }
        
        req.admin = decoded;
        next();
    });
}

// MIDDLEWARE AUTENTIKASI TEKNISI DENGAN FALLBACK PARAMETER
function verifyTeknisi(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && (authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : authHeader); 
    
    if (token) {
        jwt.verify(token, JWT_SECRET, (err, user) => {
            if (!err && user) {
                req.teknisiUser = user;
                return next();
            }
            if (req.body?.technician_id || req.query?.technician_id || req.body?.teknisiId || req.query?.teknisiId) {
                req.teknisiUser = {
                    id: (req.body?.technician_id || req.query?.technician_id || req.body?.teknisiId || req.query?.teknisiId).toString(),
                    nama: req.body?.namaTeknisi || req.query?.namaTeknisi || req.body?.teknisi || req.query?.teknisi || ""
                };
                return next();
            }
            return res.status(403).json({ message: "Token Tidak Valid atau Kadaluarsa" });
        });
    } else {
        if (req.body?.technician_id || req.query?.technician_id || req.body?.teknisiId || req.query?.teknisiId) {
            req.teknisiUser = {
                id: (req.body?.technician_id || req.query?.technician_id || req.body?.teknisiId || req.query?.teknisiId).toString(),
                nama: req.body?.namaTeknisi || req.query?.namaTeknisi || req.body?.teknisi || req.query?.teknisi || ""
            };
            return next();
        }
        return res.status(401).json({ message: "Akses Ditolak: Token tidak ditemukan" });
    }
}

// MIDDLEWARE AUTENTIKASI ADMIN ATAU TEKNISI
function verifyAdminOrTeknisi(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && (authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : authHeader); 
    
    if (token) {
        jwt.verify(token, JWT_SECRET, (err, decoded) => {
            if (!err && decoded) {
                if (decoded.role === "admin") {
                    req.admin = decoded;
                    return next();
                } else if (decoded.role === "teknisi") {
                    req.teknisiUser = decoded;
                    return next();
                }
            }
            if (req.query?.technician_id || req.query?.teknisi || req.body?.technician_id || req.query?.teknisiId) {
                req.teknisiUser = {
                    id: (req.query?.technician_id || req.body?.technician_id || req.query?.teknisiId || "").toString(),
                    nama: req.query?.teknisi || req.body?.namaTeknisi || ""
                };
                return next();
            }
            return res.status(403).json({ message: "Token Tidak Valid atau Kadaluarsa" });
        });
    } else {
        if (req.query?.technician_id || req.query?.teknisi || req.body?.technician_id || req.query?.teknisiId) {
            req.teknisiUser = {
                id: (req.query?.technician_id || req.body?.technician_id || req.query?.teknisiId || "").toString(),
                nama: req.query?.teknisi || req.body?.namaTeknisi || ""
            };
            return next();
        }
        return res.status(401).json({ message: "Akses Ditolak: Token tidak ditemukan" });
    }
}

// Helper: Fungsi upload dari lokal langsung dilempar ke Cloudinary
async function uploadKeCloudinary(filePath) {
    try {
        if (!process.env.CLOUDINARY_API_KEY) return null; 
        
        const result = await cloudinary.uploader.upload(filePath, { folder: "sftech_teknisi" });
        
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath); 
        
        return result.secure_url;
    } catch (err) {
        console.error("Cloudinary Error:", err.message);
        return null; 
    }
}

// SKEMA DATABASE ORDER LENGKAP DENGAN SINKRONISASI ROOT STATUS & TECHNICIAN_ID
const OrderSchema = new mongoose.Schema({
    kode: { type: String, required: true, unique: true, index: true }, 
    status: { type: String, default: "pending", index: true },
    technician_id: { type: String, default: "", index: true },
    technician_name: { type: String, default: "" },
    pelanggan: {
        nama: { type: String, required: true },
        wa: { type: String, required: true },
        privasi: { type: Boolean, default: false },
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
        kelengkapan: { type: String, default: "" },
        statusBAST: { type: String, default: "menunggu" },
        adaKerusakanTambahan: { type: Boolean, default: false },
        infoKerusakanTambahan: { type: String, default: "" }
    },
    pengerjaan: {
        teknisi: { type: String, default: "", index: true }, 
        teknisiId: { type: String, default: "", index: true },
        status: { 
            type: String, 
            default: 'pending',
            index: true
        },
        jadwal: { type: String, default: "" },
        etaTeknisi: { type: String, default: "" },
        estimasiSelesai: { type: String, default: "" },
        statusPersetujuanTambahan: { type: String, default: "pending" },
        videoUnboxingFile: { type: String, default: "" }, 
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
        biayaSukuTambahan: { type: Number, default: 0 }, 
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

function kirimNotifikasiWA(nomor, pesan) {
    console.log(`[WhatsApp Simulasi] Pesan untuk ${nomor}: \n${pesan}`);
}

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

// WebSocket Connection Handler
io.on('connection', (socket) => {
    console.log("🟢 Klien terhubung ke WebSocket:", socket.id);
    
    socket.on('updateLocation', (data) => { 
        io.emit('updateLocationAdmin', data); 
    });

    socket.on('streamLokasiUser', (data) => { 
        io.emit('updateLocationAdmin', data); 
    });

    socket.on('typing', (data) => { 
        io.emit('typing', data); 
        io.emit('userTyping', data); 
    });

    socket.on('stopTyping', (data) => { 
        io.emit('userStopTyping', data); 
    });

    // Handler Socket Ambil Order dengan persistensi database MongoDB mutlak
    socket.on('teknisiAmbilOrder', async (data) => {
        try {
            const { kodeOrder, namaTeknisi, technician_id, teknisiId, status } = data;
            const tekId = technician_id || teknisiId || "";
            const statusBaru = status || "taken";
            
            let nama = namaTeknisi;
            if (!nama && tekId && mongoose.Types.ObjectId.isValid(tekId)) {
                const tek = await Teknisi.findById(tekId);
                if (tek) nama = tek.nama;
            }
            nama = nama || "Teknisi";

            const updatedOrder = await Order.findOneAndUpdate(
                { kode: kodeOrder },
                {
                    $set: {
                        status: statusBaru,
                        technician_id: tekId.toString(),
                        technician_name: nama,
                        "pengerjaan.status": statusBaru,
                        "pengerjaan.teknisi": nama,
                        "pengerjaan.teknisiId": tekId.toString()
                    },
                    $push: {
                        "pengerjaan.riwayatStatus": { 
                            status: statusBaru, 
                            detail: `Diambil oleh Teknisi ${nama}`, 
                            waktu: new Date()
                        }
                    }
                },
                { new: true, runValidators: false }
            );

            if (updatedOrder) {
                io.emit('orderSudahDiambil', { 
                    kodeOrder: updatedOrder.kode, 
                    oleh: nama, 
                    technician_id: tekId.toString(), 
                    status: statusBaru 
                });
                io.emit("updateDashboardAdmin");
                io.emit("updateDataPelanggan", updatedOrder.kode);
            }
        } catch (err) {
            console.error("Gagal memproses teknisiAmbilOrder via Socket:", err);
        }
    });
    
    socket.on('disconnect', () => {
    });
});

// Koneksi Database MongoDB
const MONGO_URI = process.env.MONGO_URI || "mongodb://localhost:27017/db_servis_hp"; 
mongoose.connect(MONGO_URI)
  .then(() => console.log("✅ Sukses Terhubung ke MongoDB!"))
  .catch(err => console.error("❌ Gagal Koneksi MongoDB:", err));

// Endpoint POST Tambah Teknisi oleh Admin
app.post('/api/teknisi', verifyAdmin, upload.single('fotoTeknisi'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: "Foto wajib diunggah" });
        
        let fotoUrl = await uploadKeCloudinary(req.file.path);
        
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
        if (req.file && fs.existsSync(req.file.path)) {
            fs.unlinkSync(req.file.path);
        }
        
        if (error.code === 11000) {
            return res.status(400).json({ error: "Username sudah digunakan oleh teknisi lain. Silakan pilih username berbeda." });
        }
        
        res.status(500).json({ error: "Gagal menyimpan teknisi: " + error.message }); 
    }
});

app.post('/api/teknisi/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        const teknisi = await Teknisi.findOne({ username });
        
        if (!teknisi || !password || typeof password !== "string" || !bcrypt.compareSync(password, teknisi.password)) {
            return res.status(401).json({ message: "Username atau Password teknisi salah" });
        }
        
        const token = jwt.sign({ id: teknisi._id.toString(), nama: teknisi.nama, role: "teknisi" }, JWT_SECRET, { expiresIn: '12h' });
        res.json({ 
            token, 
            id: teknisi._id.toString(),
            technician_id: teknisi._id.toString(),
            nama: teknisi.nama, 
            message: "Login Teknisi Berhasil" 
        });
    } catch (error) {
        res.status(500).json({ error: "Gagal login teknisi: " + error.message });
    }
});

// GET: Pesanan yang belum diambil dan tersedia untuk diambil oleh teknisi
app.get('/api/teknisi/orders/available', async (req, res) => {
    try {
        const availableOrders = await Order.find({
            $and: [
                {
                    $or: [
                        { "pengerjaan.teknisi": "" },
                        { "pengerjaan.teknisi": null },
                        { "pengerjaan.teknisi": { $exists: false } }
                    ]
                },
                {
                    $or: [
                        { "technician_id": "" },
                        { "technician_id": null },
                        { "technician_id": { $exists: false } }
                    ]
                },
                {
                    $or: [
                        { "pengerjaan.status": { $in: ['pending', 'baru'] } },
                        { "status": { $in: ['pending', 'baru'] } }
                    ]
                }
            ]
        }).sort({ createdAt: -1, _id: -1 });
        
        res.json(availableOrders);
    } catch (error) {
        res.status(500).json({ error: "Gagal memuat daftar pesanan tersedia: " + error.message });
    }
});

// GET: Handler Pesanan Teknisi (Active Jobs / My Jobs) - Mendukung Pemuatan Ulang Setelah Refresh Browser
const getTeknisiJobsHandler = async (req, res) => {
    try {
        let tekId = "";
        let tekNama = "";

        if (req.teknisiUser && req.teknisiUser.id) {
            tekId = req.teknisiUser.id.toString();
        }
        if (req.teknisiUser && req.teknisiUser.nama) {
            tekNama = req.teknisiUser.nama;
        }

        if (!tekId) {
            tekId = (req.query.technician_id || req.query.teknisiId || req.params.id || "").toString();
        }
        if (!tekNama) {
            tekNama = req.query.nama || req.query.teknisi || req.query.namaTeknisi || "";
        }

        const conditions = [];
        if (tekId) {
            conditions.push({ "technician_id": tekId });
            conditions.push({ "pengerjaan.teknisiId": tekId });
            if (mongoose.Types.ObjectId.isValid(tekId)) {
                conditions.push({ "technician_id": new mongoose.Types.ObjectId(tekId) });
                conditions.push({ "pengerjaan.teknisiId": new mongoose.Types.ObjectId(tekId) });
            }
        }
        if (tekNama) {
            conditions.push({ "pengerjaan.teknisi": tekNama });
            conditions.push({ "technician_name": tekNama });
            conditions.push({ "pengerjaan.teknisi": { $regex: new RegExp(`^${tekNama}$`, 'i') } });
        }

        let filter = {};
        if (conditions.length > 0) {
            filter = { $or: conditions };
        } else {
            filter = {
                $or: [
                    { "technician_id": { $exists: true, $nin: ["", null] } },
                    { "pengerjaan.teknisi": { $exists: true, $nin: ["", null] } },
                    { "pengerjaan.status": { $in: ['taken', 'in-progress', 'dijadwalkan', 'diproses', 'menunggu_part', 'selesai_servis'] } },
                    { "status": { $in: ['taken', 'in-progress', 'dijadwalkan', 'diproses', 'menunggu_part', 'selesai_servis'] } }
                ]
            };
        }

        // Filter status jika diberikan oleh query
        if (req.query.status) {
            const qStatus = req.query.status.toLowerCase();
            if (qStatus === 'active' || qStatus === 'in-progress' || qStatus === 'aktif') {
                const activeStatuses = ['taken', 'in-progress', 'dijadwalkan', 'diproses', 'menunggu_part'];
                filter = {
                    $and: [
                        filter,
                        {
                            $or: [
                                { "pengerjaan.status": { $in: activeStatuses } },
                                { "status": { $in: activeStatuses } }
                            ]
                        }
                    ]
                };
            } else {
                filter = {
                    $and: [
                        filter,
                        {
                            $or: [
                                { "pengerjaan.status": qStatus },
                                { "status": qStatus }
                            ]
                        }
                    ]
                };
            }
        }

        const jobs = await Order.find(filter).sort({ updatedAt: -1, createdAt: -1, _id: -1 });
        res.json(jobs);
    } catch (error) {
        res.status(500).json({ error: "Gagal memuat daftar pekerjaan teknisi: " + error.message });
    }
};

app.get('/api/teknisi/orders', getTeknisiJobsHandler);
app.get('/api/teknisi/orders/my-jobs', getTeknisiJobsHandler);
app.get('/api/teknisi/orders/active', getTeknisiJobsHandler);
app.get('/api/teknisi/my-jobs', getTeknisiJobsHandler);
app.get('/api/teknisi/active-jobs', getTeknisiJobsHandler);
app.get('/api/teknisi/:id/orders', getTeknisiJobsHandler);
app.get('/api/teknisi/:id/jobs', getTeknisiJobsHandler);

// HANDLER PENGAMBILAN JOB (TAKE JOB) - PERSISTENSI ABSOLUT MONGODB DENGAN findOneAndUpdate
async function takeJobHandler(req, res) {
    try {
        const orderIdentifier = req.params.kode || req.params.id || req.body.kode || req.body.orderId || req.body.kodeOrder || req.body.id || req.params.orderId;
        if (!orderIdentifier) {
            return res.status(400).json({ error: "ID atau Kode Pesanan wajib disertakan" });
        }

        let technician_id = "";
        let namaTeknisi = "";

        if (req.teknisiUser) {
            technician_id = req.teknisiUser.id ? req.teknisiUser.id.toString() : "";
            namaTeknisi = req.teknisiUser.nama || "";
        }

        if (!technician_id) {
            technician_id = req.body.technician_id || req.body.teknisiId || req.query.technician_id || req.query.teknisiId || "";
        }
        if (!namaTeknisi) {
            namaTeknisi = req.body.namaTeknisi || req.body.nama || req.body.teknisi || req.query.namaTeknisi || req.query.teknisi || "";
        }

        const techIdStr = technician_id ? technician_id.toString() : "";

        if (techIdStr && !namaTeknisi && mongoose.Types.ObjectId.isValid(techIdStr)) {
            try {
                const tekDoc = await Teknisi.findById(techIdStr);
                if (tekDoc) namaTeknisi = tekDoc.nama;
            } catch (e) {}
        }
        namaTeknisi = namaTeknisi || "Teknisi";

        // Status default saat job diambil adalah 'taken'
        const statusBaru = req.body.status || "taken";

        let query = {};
        if (mongoose.Types.ObjectId.isValid(orderIdentifier)) {
            query = { $or: [{ _id: orderIdentifier }, { kode: orderIdentifier }] };
        } else {
            query = { kode: orderIdentifier };
        }

        const riwayatItem = {
            status: statusBaru,
            detail: `Diambil oleh Teknisi ${namaTeknisi}`,
            waktu: new Date()
        };

        // Eksekusi pembaruan database secara asinkron dengan findOneAndUpdate
        const updatedOrder = await Order.findOneAndUpdate(
            query,
            {
                $set: {
                    status: statusBaru,
                    technician_id: techIdStr,
                    technician_name: namaTeknisi,
                    "pengerjaan.status": statusBaru,
                    "pengerjaan.teknisi": namaTeknisi,
                    "pengerjaan.teknisiId": techIdStr
                },
                $push: {
                    "pengerjaan.riwayatStatus": riwayatItem
                }
            },
            { new: true, runValidators: false }
        );

        if (!updatedOrder) {
            return res.status(404).json({ error: "Pesanan tidak ditemukan di database" });
        }

        // Siarkan pembaruan secara realtime ke admin & pelanggan
        io.emit('orderSudahDiambil', { 
            kodeOrder: updatedOrder.kode, 
            oleh: namaTeknisi, 
            technician_id: techIdStr,
            status: statusBaru 
        });
        io.emit("updateDashboardAdmin");
        io.emit("updateDataPelanggan", updatedOrder.kode);

        return res.status(200).json({ 
            message: "Job berhasil diambil dan status tersimpan di database", 
            order: updatedOrder,
            success: true
        });
    } catch (error) {
        console.error("Gagal memproses take job:", error);
        return res.status(500).json({ error: "Gagal mengambil job: " + error.message });
    }
}

// Endpoint Rute POST & PUT Take Job
app.post('/api/teknisi/orders/:kode/take', takeJobHandler);
app.put('/api/teknisi/orders/:kode/take', takeJobHandler);
app.post('/api/teknisi/orders/:id/take', takeJobHandler);
app.put('/api/teknisi/orders/:id/take', takeJobHandler);
app.post('/api/orders/:kode/take', takeJobHandler);
app.put('/api/orders/:kode/take', takeJobHandler);
app.post('/api/orders/:id/take', takeJobHandler);
app.put('/api/orders/:id/take', takeJobHandler);
app.post('/api/teknisi/take-job', takeJobHandler);
app.put('/api/teknisi/take-job', takeJobHandler);
app.post('/api/orders/take-job', takeJobHandler);
app.put('/api/orders/take-job', takeJobHandler);
app.post('/api/orders/:kode/claim', takeJobHandler);
app.put('/api/orders/:kode/claim', takeJobHandler);

app.put('/api/teknisi/status', verifyTeknisi, async (req, res) => {
    try {
        const { statusKerja } = req.body;
        await Teknisi.findByIdAndUpdate(req.teknisiUser.id, { $set: { statusKerja } });
        res.json({ message: "Status kerja berhasil diperbarui" });
    } catch (error) {
        res.status(500).json({ error: "Gagal memperbarui status" });
    }
});

// GET: Tampilkan semua teknisi
app.get('/api/teknisi', async (req, res) => {
    try {
        const teknisiList = await Teknisi.find().sort({ createdAt: -1 });
        
        const teknisiDenganAntrian = await Promise.all(teknisiList.map(async (tek) => {
            const jumlahAntrian = await Order.countDocuments({
                $or: [
                    { "pengerjaan.teknisi": tek.nama },
                    { "technician_id": tek._id.toString() },
                    { "pengerjaan.teknisiId": tek._id.toString() }
                ],
                $or: [
                    { "pengerjaan.status": { $in: ['taken', 'in-progress', 'dijadwalkan', 'diproses'] } },
                    { "status": { $in: ['taken', 'in-progress', 'dijadwalkan', 'diproses'] } }
                ]
            });
            return { ...tek.toObject(), antrianAktif: jumlahAntrian }; 
        }));
        
        res.json(teknisiDenganAntrian);
    } catch (error) { res.status(500).json({ error: "Gagal memuat teknisi" }); }
});

app.put('/api/teknisi/:id', verifyAdmin, upload.single('fotoTeknisi'), async (req, res) => {
    try {
        const updateData = {
            nama: req.body.nama,
            wa: req.body.wa
        };
        
        if (req.file) {
            updateData.foto = `/uploads/${req.file.filename}`;
            const tekLama = await Teknisi.findById(req.params.id);
            if (tekLama && tekLama.foto) {
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

app.delete('/api/chats/kode/:kode', verifyAdmin, async (req, res) => {
    try {
        await Chat.deleteMany({ kode: req.params.kode });
        res.json({ message: "Riwayat chat berhasil dibersihkan" });
    } catch (error) { 
        res.status(500).json({ error: "Gagal menghapus riwayat chat" }); 
    }
});

app.delete('/api/teknisi/:id', verifyAdmin, async (req, res) => {
    try {
        const tek = await Teknisi.findById(req.params.id);
        if (tek && tek.foto) {
            if (tek.foto.includes('cloudinary.com')) {
                const urlParts = tek.foto.split('/');
                const publicId = "sftech_teknisi/" + urlParts[urlParts.length - 1].split('.')[0]; 
                await cloudinary.uploader.destroy(publicId);
            } else {
                const filePath = path.join(__dirname, 'public', tek.foto);
                if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
            }
        }
        await Teknisi.findByIdAndDelete(req.params.id);
        res.json({ message: "Teknisi berhasil dihapus" });
    } catch (error) { res.status(500).json({ error: "Gagal menghapus teknisi" }); }
});

function fileToGenerativePart(filePath, mimeType) {
    return {
        inlineData: {
            data: fs.readFileSync(filePath).toString("base64"),
            mimeType
        },
    };
}

app.post('/api/ai/scan-device', upload.single('deviceImage'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: "Tidak ada gambar yang diunggah" });
        if (!genAI) return res.status(500).json({ error: "API Key AI belum dikonfigurasi pada server" });

        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

        const prompt = `Anda adalah asisten teknisi smartphone tingkat lanjut. 
        Tugas Anda adalah menganalisis foto fisik perangkat ini.
        Tentukan merek dan model/tipe perangkat tersebut. 
        KEMBALIKAN HANYA FORMAT JSON VALID SEPERTI DI BAWAH INI:
        {
            "merek": "Nama Merek (misal: Samsung, Asus, Xiaomi, Apple)",
            "tipe": "Nama Tipe Detail (misal: Galaxy S23 Ultra, iPhone 13 Pro)",
            "imeiSerial": "null"
        }`;

        const imagePart = fileToGenerativePart(req.file.path, req.file.mimetype);

        const result = await model.generateContent([prompt, imagePart]);
        let textResult = result.response.text();
        
        const jsonMatch = textResult.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error("Format JSON gagal diekstrak dari AI");
        
        const parsedData = JSON.parse(jsonMatch[0]);
        
        fs.unlinkSync(req.file.path);
        res.json(parsedData);
    } catch (error) {
        if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        res.status(500).json({ error: "Gagal memproses gambar dengan AI" });
    }
});

app.post('/api/admin/login', (req, res) => {
    const { username, password } = req.body;
    
    if (username === "admin" && password && typeof password === "string" && bcrypt.compareSync(password, ADMIN_HASH)) {
        const token = jwt.sign({ role: "admin" }, JWT_SECRET, { expiresIn: '12h' });
        res.json({ token, message: "Login Berhasil" });
    } else {
        res.status(401).json({ message: "ID atau Password salah" });
    }
});

app.get('/api/admin/stats', verifyAdmin, async (req, res) => {
    try {
        const totalPesanan = await Order.countDocuments();
        const pesananPending = await Order.countDocuments({
            $or: [
                { "pengerjaan.status": { $in: ['pending', 'baru'] } },
                { "status": { $in: ['pending', 'baru'] } }
            ]
        });
        const pesananDiproses = await Order.countDocuments({
            $or: [
                { "pengerjaan.status": { $in: ['diproses', 'dijadwalkan', 'taken', 'in-progress'] } },
                { "status": { $in: ['diproses', 'dijadwalkan', 'taken', 'in-progress'] } }
            ]
        });
        const pesananSelesai = await Order.countDocuments({
            $or: [
                { "pengerjaan.status": 'selesai' },
                { "status": 'selesai' }
            ]
        });
        
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

app.get('/api/reviews', async (req, res) => {
    try {
        const reviews = await Order.find({ "ulasan.rating": { $gt: 0 } }).select('pelanggan.nama perangkat.merek perangkat.tipe ulasan createdAt').sort({ _id: -1 }).limit(10);
        res.json(reviews);
    } catch (error) {
        res.status(500).json({ error: "Gagal memuat ulasan pelanggan" });
    }
});

// GET: Tampilkan pesanan (Admin melihat semua, Teknisi melihat miliknya dan job berstatus taken/in-progress)
app.get('/api/orders', verifyAdminOrTeknisi, async (req, res) => {
    try {
        let filter = {};
        
        const tekId = req.teknisiUser ? req.teknisiUser.id : (req.query.technician_id || req.query.teknisiId || "");
        const tekNama = req.teknisiUser ? req.teknisiUser.nama : (req.query.teknisi || req.query.nama || "");

        if (req.teknisiUser && req.teknisiUser.role !== "admin") {
            const orConds = [];
            if (tekId) {
                orConds.push({ "technician_id": tekId.toString() });
                orConds.push({ "pengerjaan.teknisiId": tekId.toString() });
                if (mongoose.Types.ObjectId.isValid(tekId)) {
                    orConds.push({ "technician_id": new mongoose.Types.ObjectId(tekId) });
                    orConds.push({ "pengerjaan.teknisiId": new mongoose.Types.ObjectId(tekId) });
                }
            }
            if (tekNama) {
                orConds.push({ "pengerjaan.teknisi": tekNama });
                orConds.push({ "technician_name": tekNama });
            }
            if (orConds.length > 0) {
                filter.$or = orConds;
            }
        } else if (req.query.technician_id || req.query.teknisi || req.query.teknisiId) {
            const val = req.query.technician_id || req.query.teknisi || req.query.teknisiId;
            const orConds = [
                { "technician_id": val.toString() },
                { "pengerjaan.teknisiId": val.toString() },
                { "pengerjaan.teknisi": val }
            ];
            if (mongoose.Types.ObjectId.isValid(val)) {
                orConds.push({ "technician_id": new mongoose.Types.ObjectId(val) });
                orConds.push({ "pengerjaan.teknisiId": new mongoose.Types.ObjectId(val) });
            }
            filter.$or = orConds;
        }

        if (req.query.status) {
            const statusQuery = req.query.status.toLowerCase();
            if (statusQuery === 'active' || statusQuery === 'in-progress' || statusQuery === 'aktif') {
                const activeList = ['taken', 'in-progress', 'dijadwalkan', 'diproses', 'menunggu_part'];
                const statusCond = {
                    $or: [
                        { "pengerjaan.status": { $in: activeList } },
                        { "status": { $in: activeList } }
                    ]
                };
                if (filter.$or) {
                    filter = { $and: [ { $or: filter.$or }, statusCond ] };
                } else {
                    filter = statusCond;
                }
            } else {
                const statusCond = {
                    $or: [
                        { "pengerjaan.status": statusQuery },
                        { "status": statusQuery }
                    ]
                };
                if (filter.$or) {
                    filter = { $and: [ { $or: filter.$or }, statusCond ] };
                } else {
                    filter = statusCond;
                }
            }
        }

        const limit = parseInt(req.query.limit) || 2000; 
        const dataOrders = await Order.find(filter).sort({ updatedAt: -1, createdAt: -1, _id: -1 }).limit(limit);
        res.json(dataOrders); 
    } catch (error) { 
        res.status(500).json({ error: "Gagal memuat data pesanan: " + error.message }); 
    }
});

app.post('/api/orders', upload.any(), async (req, res) => {
    try {
        const latInput = req.body.lat || req.body['koordinat[lat]'] || (req.body.koordinat && req.body.koordinat.lat) || "";
        const lngInput = req.body.lng || req.body['koordinat[lng]'] || (req.body.koordinat && req.body.koordinat.lng) || "";
        
        let kondisiHPFile = "";
        if (req.files && req.files.length > 0) {
            const fileKondisi = req.files.find(f => f.fieldname === 'kondisiHPFile');
            if (fileKondisi) {
                kondisiHPFile = `/uploads/${fileKondisi.filename}`;
            }
        }

        const dataBaru = new Order({
            kode: req.body.kode,
            status: "pending",
            pelanggan: {
                nama: req.body.nama,
                wa: req.body.wa,
                privasi: req.body.privasi === 'true',
                lokasi: {
                    tipeServis: req.body.lokasiServis || "home_service",
                    lat: latInput,
                    lng: lngInput,
                    shareloc: req.body.shareloc || ""
                }
            },
            perangkat: {
                layanan: req.body.layanan || "Belum dipilih",
                merek: req.body.merek,
                tipe: req.body.tipe,
                imeiSerial: req.body.imeiSerial || "",
                kondisiHP: kondisiHPFile,
                keluhan: req.body.kerusakan || "",
                kelengkapan: req.body.kelengkapan || "",
                statusBAST: req.body.statusBAST || "menunggu"
            },
            pengerjaan: {
                status: "pending",
                riwayatStatus: [{ status: "pending", detail: "Pesanan masuk ke sistem", waktu: new Date().toISOString() }]
            },
            finansial: {
                biayaPengecekan: 50000
            }
        });

        await dataBaru.save(); 
        
        const pesanWA = `Halo ${dataBaru.pelanggan.nama},\n\nTerima kasih telah memesan servis di SF Tech.\nKode Resi Anda: *${dataBaru.kode}*\n\nSilakan lacak status perbaikan Anda melalui website kami.`;
        kirimNotifikasiWA(dataBaru.pelanggan.wa, pesanWA);

        await tambahNotifikasiDB(`Pesanan Baru: ${dataBaru.kode} oleh ${dataBaru.pelanggan.nama}`);
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

app.get('/api/orders/:kode', async (req, res) => {
    try {
        const pesanan = await Order.findOne({ 
            $or: [{ kode: req.params.kode }, ...(mongoose.Types.ObjectId.isValid(req.params.kode) ? [{ _id: req.params.kode }] : [])]
        });
        if(!pesanan) return res.status(404).json({ error: "Pesanan tidak ditemukan" });
        res.json(pesanan);
    } catch (error) { 
        res.status(500).json({ error: "Gagal memuat detail pesanan" }); 
    }
});

app.post('/api/orders/bulk', verifyAdmin, async (req, res) => {
    try {
        const { ids, action } = req.body;
        if (!ids || ids.length === 0) return res.status(400).json({ error: "Tidak ada ID yang dipilih" });

        if (action === 'selesai') {
            await Order.updateMany(
                { kode: { $in: ids } },
                { $set: { "finansial.pembayaranValid": true, "pengerjaan.status": 'selesai', "status": 'selesai' } }
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

app.put('/api/orders/:kode', upload.any(), async (req, res) => {
    try {
        const dataUpdate = { ...req.body };
        
        if (req.files && req.files.length > 0) {
            const fInden = req.files.find(f => f.fieldname === 'buktiInden');
            if (fInden) dataUpdate['finansial.inden.buktiBayarInden'] = `/uploads/${fInden.filename}`;
            
            const fLunas = req.files.find(f => f.fieldname === 'buktiPelunasan');
            if (fLunas) dataUpdate['finansial.buktiPelunasan'] = `/uploads/${fLunas.filename}`;
        }

        if (dataUpdate.technician_id || dataUpdate.teknisiId) {
            const tid = dataUpdate.technician_id || dataUpdate.teknisiId;
            dataUpdate.technician_id = tid.toString();
            dataUpdate['pengerjaan.teknisiId'] = tid.toString();
        }
        if (dataUpdate.namaTeknisi || dataUpdate.teknisi) {
            const tnama = dataUpdate.namaTeknisi || dataUpdate.teknisi;
            dataUpdate['pengerjaan.teknisi'] = tnama;
            dataUpdate.technician_name = tnama;
        }

        const statusBaru = dataUpdate['pengerjaan.status'] || dataUpdate.status;
        if (statusBaru) {
            dataUpdate.status = statusBaru;
            dataUpdate['pengerjaan.status'] = statusBaru;
        }

        const existing = await Order.findOne({ kode: req.params.kode });
        const statusLama = existing && existing.pengerjaan ? existing.pengerjaan.status : (existing ? existing.status : null);

        if (existing && statusBaru && statusLama !== statusBaru) {
            await Order.updateOne(
                { kode: req.params.kode }, 
                { $push: { "pengerjaan.riwayatStatus": { status: statusBaru, detail: "Pembaruan status sistem", waktu: new Date() } } }
            );

            let statusTeks = statusBaru;
            if(statusTeks === 'dijadwalkan' || statusTeks === 'taken') statusTeks = 'DIJADWALKAN - Teknisi telah mengambil pesanan';
            if(statusTeks === 'diproses') statusTeks = 'SEDANG DIPROSES';
            if(statusTeks === 'selesai_servis') statusTeks = 'SELESAI DIPERBAIKI - Menunggu Pelunasan';

            if (existing.pelanggan && existing.pelanggan.wa) {
                const pesanUpdate = `Pembaruan Status Servis SF Tech!\n\nPesanan dengan kode *${req.params.kode}* Anda saat ini berstatus:\n*${statusTeks.toUpperCase()}*\n\nSilakan cek website untuk rincian lebih lanjut.`;
                kirimNotifikasiWA(existing.pelanggan.wa, pesanUpdate);
            }
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

app.put('/api/orders/:kode/inden', upload.single('buktiInden'), async (req, res) => {
    try {
        let updateFields = {};
        if (req.file) {
            updateFields['finansial.inden.buktiBayarInden'] = `/uploads/${req.file.filename}`;
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

app.put('/api/orders/:kode/cancel', async (req, res) => {
    try {
        const { status } = req.body;
        const existing = await Order.findOne({ kode: req.params.kode });
        
        const currentStatus = existing.pengerjaan ? existing.pengerjaan.status : existing.status;
        
        if (existing && (currentStatus === 'baru' || currentStatus === 'pending')) {
            await Order.updateOne(
                { kode: req.params.kode }, 
                { 
                    $set: { "pengerjaan.status": status || 'ditolak_pelanggan', "status": status || 'ditolak_pelanggan' },
                    $push: { "pengerjaan.riwayatStatus": { status: status || 'ditolak_pelanggan', detail: "Dibatalkan oleh Pelanggan via Website", waktu: new Date() } } 
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

app.post('/api/orders/:kode/rating', async (req, res) => {
    try {
        const { rating, ulasan } = req.body;
        const updated = await Order.findOneAndUpdate(
            { kode: req.params.kode },
            { $set: { "ulasan.rating": Number(rating), "ulasan.teks": ulasan || "" } },
            { new: true }
        );
        await tambahNotifikasiDB(`Ulasan Baru (${rating} Bintang): ${req.params.kode}`);
        io.emit("updateDashboardAdmin");
        res.json({ message: "Rating dan ulasan berhasil disimpan", updated });
    } catch (error) {
        res.status(500).json({ error: "Gagal menyimpan rating" });
    }
});

app.delete('/api/orders/:kode', verifyAdmin, async (req, res) => {
    try {
        await Order.findOneAndDelete({ kode: req.params.kode });
        io.emit("updateDashboardAdmin");
        res.json({ message: "Pesanan berhasil dihapus" });
    } catch (error) { 
        res.status(500).json({ error: "Gagal menghapus pesanan" }); 
    }
});

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

app.post('/api/chats', async (req, res) => {
    try {
        const chatBaru = new Chat(req.body);
        await chatBaru.save();
        
        if(chatBaru.pengirim === 'user') {
            await tambahNotifikasiDB(`Pesan Chat Baru dari ${chatBaru.kode}`);
        }
        
        io.emit("chatBaruDiterima", { kode: chatBaru.kode, pengirim: chatBaru.pengirim });
        res.status(201).json({ message: "Pesan chat terkirim" });

        if (chatBaru.pengirim === 'user' && genAI) {
            prosesBalasanBot(chatBaru.kode, chatBaru.teks).catch(err => console.error("Error Bot AI:", err));
        }

    } catch (error) { 
        res.status(500).json({ error: "Gagal mengirim pesan chat" }); 
    }
});

app.get('/api/chats/:kode', async (req, res) => {
    try {
        const logChat = await Chat.find({ kode: req.params.kode });
        res.json(logChat);
    } catch (error) { 
        res.status(500).json({ error: "Gagal memuat log chat" }); 
    }
});

app.delete('/api/chats/:id', async (req, res) => {
    try {
        await Chat.findByIdAndDelete(req.params.id);
        res.json({ message: "Pesan berhasil dihapus" });
    } catch (error) { 
        res.status(500).json({ error: "Gagal menghapus pesan" }); 
    }
});

async function prosesBalasanBot(kode, pesanUser) {
    try {
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
        
        io.emit('userTyping', { kode: kode, pengirim: 'admin' });

        const result = await chatSession.sendMessage(pesanUser);
        const balasanAI = result.response.text();

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

// SINKRONISASI FILE FRONTEND PANEL TEKNISI (HTML & CLIENT-SIDE JS)
// Memastikan data job aktif teknisi selalu dimuat ulang dari database saat halaman pertama kali dibuka atau di-refresh (F5)
const panelTeknisiHtml = `<!DOCTYPE html>
<html lang="id">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Panel Teknisi - SF Tech Service</title>
    <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet">
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    <script src="/socket.io/socket.io.js"></script>
    <style>
        body { background-color: #f4f6f9; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; }
        .card-custom { border-radius: 12px; box-shadow: 0 4px 12px rgba(0,0,0,0.06); border: none; margin-bottom: 24px; }
        .badge-status { padding: 6px 12px; border-radius: 20px; font-weight: 600; font-size: 0.85rem; text-transform: uppercase; }
        .bg-taken { background-color: #e0f2fe; color: #0369a1; }
        .bg-in-progress { background-color: #fef3c7; color: #b45309; }
        .bg-pending { background-color: #fee2e2; color: #b91c1c; }
        .bg-selesai { background-color: #dcfce7; color: #15803d; }
    </style>
</head>
<body>
    <nav class="navbar navbar-dark bg-dark px-4 py-3">
        <div class="container-fluid">
            <span class="navbar-brand mb-0 h1"><i class="fa-solid fa-wrench me-2 text-warning"></i>Panel Teknisi SF Tech</span>
            <div class="d-flex align-items-center text-white">
                <span id="labelNamaTeknisi" class="me-3 font-weight-bold">Teknisi</span>
                <button id="btnRefresh" class="btn btn-outline-light btn-sm me-2" onclick="muatUlangSemuaDataJob()"><i class="fa-solid fa-rotate me-1"></i> Refresh Data</button>
                <button id="btnLogout" class="btn btn-danger btn-sm" onclick="logoutTeknisi()"><i class="fa-solid fa-right-from-bracket"></i></button>
            </div>
        </div>
    </nav>

    <div class="container-fluid py-4 px-4">
        <div class="row">
            <!-- DAFTAR JOB AKTIF TEKNISI (PERSISTEN SAAT REFRESH/F5) -->
            <div class="col-lg-7">
                <div class="card card-custom">
                    <div class="card-header bg-white py-3 d-flex justify-content-between align-items-center">
                        <h5 class="mb-0 text-primary"><i class="fa-solid fa-clipboard-check me-2"></i>Pekerjaan Aktif Saya (My Active Jobs)</h5>
                        <span id="badgeJumlahJobAktif" class="badge bg-primary rounded-pill">0 Job</span>
                    </div>
                    <div class="card-body p-0">
                        <div class="table-responsive">
                            <table class="table table-hover align-middle mb-0" id="tabelJobAktif">
                                <thead class="table-light">
                                    <tr>
                                        <th>Kode</th>
                                        <th>Pelanggan</th>
                                        <th>Perangkat</th>
                                        <th>Keluhan</th>
                                        <th>Status</th>
                                        <th>Aksi</th>
                                    </tr>
                                </thead>
                                <tbody id="daftarJobAktif">
                                    <tr>
                                        <td colspan="6" class="text-center py-4 text-muted"><i class="fa-solid fa-spinner fa-spin me-2"></i>Memuat daftar pekerjaan aktif dari database...</td>
                                    </tr>
                                </tbody>
                            </table>
                        </div>
                    </div>
                </div>
            </div>

            <!-- DAFTAR JOB TERSEDIA (BELUM DIAMBIL) -->
            <div class="col-lg-5">
                <div class="card card-custom">
                    <div class="card-header bg-white py-3 d-flex justify-content-between align-items-center">
                        <h5 class="mb-0 text-success"><i class="fa-solid fa-inbox me-2"></i>Job Tersedia Diambil</h5>
                        <span id="badgeJumlahJobTersedia" class="badge bg-success rounded-pill">0</span>
                    </div>
                    <div class="card-body p-0">
                        <div class="table-responsive">
                            <table class="table table-hover align-middle mb-0" id="tabelJobTersedia">
                                <thead class="table-light">
                                    <tr>
                                        <th>Kode</th>
                                        <th>Perangkat</th>
                                        <th>Kerusakan</th>
                                        <th>Aksi</th>
                                    </tr>
                                </thead>
                                <tbody id="daftarJobTersedia">
                                    <tr>
                                        <td colspan="4" class="text-center py-4 text-muted"><i class="fa-solid fa-spinner fa-spin me-2"></i>Memuat job tersedia...</td>
                                    </tr>
                                </tbody>
                            </table>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    </div>

    <script>
        // SCRIPT FRONTEND PANEL TEKNISI DENGAN FETCH OTOMATIS & RENDER DOM PADA ONLOAD / F5
        const socket = io();

        // 1. Script inisialisasi / onLoad yang berjalan setiap kali halaman dimuat pertama kali atau direfresh (F5)
        window.addEventListener('DOMContentLoaded', () => {
            initPanelTeknisi();
        });

        window.onload = function() {
            if (!window.isPanelInitialized) {
                initPanelTeknisi();
            }
        };

        function initPanelTeknisi() {
            window.isPanelInitialized = true;
            
            // Baca identitas teknisi dari localStorage atau fallback
            const techId = localStorage.getItem('technician_id') || localStorage.getItem('teknisiId') || '';
            const techNama = localStorage.getItem('namaTeknisi') || localStorage.getItem('teknisi') || 'Teknisi';
            
            const labelNama = document.getElementById('labelNamaTeknisi');
            if (labelNama) labelNama.innerText = techNama;

            // Muat ulang data asli dari server database setiap kali halaman dimuat/F5
            muatUlangSemuaDataJob();

            // Dengarkan pembaruan realtime via WebSocket
            socket.on('orderSudahDiambil', () => { muatUlangSemuaDataJob(); });
            socket.on('orderBaruTersedia', () => { muatUlangSemuaDataJob(); });
            socket.on('updateDashboardAdmin', () => { muatUlangSemuaDataJob(); });
        }

        async function muatUlangSemuaDataJob() {
            await Promise.all([
                fetchDanRenderJobAktif(),
                fetchDanRenderJobTersedia()
            ]);
        }

        // 2 & 3. Fungsi fetch() GET daftar job aktif dari server dan render ke dalam DOM
        async function fetchDanRenderJobAktif() {
            const container = document.getElementById('daftarJobAktif');
            const badgeCount = document.getElementById('badgeJumlahJobAktif');
            
            try {
                const token = localStorage.getItem('tokenTeknisi') || localStorage.getItem('token') || '';
                const techId = localStorage.getItem('technician_id') || localStorage.getItem('teknisiId') || '';
                const techNama = localStorage.getItem('namaTeknisi') || localStorage.getItem('teknisi') || '';

                const headers = {
                    'Pragma': 'no-cache',
                    'Cache-Control': 'no-cache'
                };
                if (token) headers['Authorization'] = 'Bearer ' + token;

                // Tembak endpoint GET daftar job aktif teknisi dari server database
                const url = '/api/teknisi/orders?status=active&technician_id=' + encodeURIComponent(techId) + '&nama=' + encodeURIComponent(techNama);
                const response = await fetch(url, { headers });
                
                if (!response.ok) throw new Error('HTTP status ' + response.status);
                const jobsAktif = await response.json();

                // Render data hasil fetch ke dalam DOM / tabel job aktif
                renderDOMJobAktif(jobsAktif);

            } catch (err) {
                console.error('Gagal memuat job aktif dari database:', err);
                if (container) {
                    container.innerHTML = '<tr><td colspan="6" class="text-center py-4 text-danger"><i class="fa-solid fa-triangle-exclamation me-2"></i>Gagal memuat pekerjaan aktif. Silakan klik Refresh Data.</td></tr>';
                }
            }
        }

        function renderDOMJobAktif(jobs) {
            const container = document.getElementById('daftarJobAktif');
            const badgeCount = document.getElementById('badgeJumlahJobAktif');
            if (!container) return;

            if (!Array.isArray(jobs) || jobs.length === 0) {
                container.innerHTML = '<tr><td colspan="6" class="text-center py-4 text-muted"><i class="fa-solid fa-box-open me-2"></i>Tidak ada pekerjaan aktif saat ini. Silakan ambil pesanan baru di samping.</td></tr>';
                if (badgeCount) badgeCount.innerText = '0 Job';
                return;
            }

            if (badgeCount) badgeCount.innerText = jobs.length + ' Job';

            container.innerHTML = jobs.map(job => {
                const status = (job.pengerjaan && job.pengerjaan.status) || job.status || 'taken';
                let badgeClass = 'bg-taken';
                if (status === 'diproses' || status === 'in-progress') badgeClass = 'bg-in-progress';
                if (status === 'selesai' || status === 'selesai_servis') badgeClass = 'bg-selesai';

                const pelangganNama = (job.pelanggan && job.pelanggan.nama) || '-';
                const perangkatMerek = (job.perangkat && job.perangkat.merek) ? (job.perangkat.merek + ' ' + (job.perangkat.tipe || '')) : '-';
                const keluhan = (job.perangkat && job.perangkat.keluhan) || '-';

                return '<tr>' +
                    '<td><strong>' + job.kode + '</strong></td>' +
                    '<td>' + pelangganNama + '</td>' +
                    '<td>' + perangkatMerek + '</td>' +
                    '<td>' + keluhan + '</td>' +
                    '<td><span class="badge badge-status ' + badgeClass + '">' + status + '</span></td>' +
                    '<td>' +
                        '<button class="btn btn-sm btn-outline-primary me-1" onclick="updateStatusJob(\\'' + job.kode + '\\', \\'diproses\\')"><i class="fa-solid fa-play"></i></button>' +
                        '<button class="btn btn-sm btn-outline-success" onclick="updateStatusJob(\\'' + job.kode + '\\', \\'selesai_servis\\')"><i class="fa-solid fa-check"></i></button>' +
                    '</td>' +
                '</tr>';
            }).join('');
        }

        // Fetch dan render daftar job yang tersedia
        async function fetchDanRenderJobTersedia() {
            const container = document.getElementById('daftarJobTersedia');
            const badgeCount = document.getElementById('badgeJumlahJobTersedia');
            
            try {
                const token = localStorage.getItem('tokenTeknisi') || localStorage.getItem('token') || '';
                const headers = { 'Cache-Control': 'no-cache' };
                if (token) headers['Authorization'] = 'Bearer ' + token;

                const response = await fetch('/api/teknisi/orders/available', { headers });
                if (!response.ok) throw new Error('HTTP status ' + response.status);
                const ordersTersedia = await response.json();

                renderDOMJobTersedia(ordersTersedia);
            } catch (err) {
                console.error('Gagal memuat job tersedia:', err);
                if (container) {
                    container.innerHTML = '<tr><td colspan="4" class="text-center py-4 text-muted">Belum ada job baru yang tersedia.</td></tr>';
                }
            }
        }

        function renderDOMJobTersedia(orders) {
            const container = document.getElementById('daftarJobTersedia');
            const badgeCount = document.getElementById('badgeJumlahJobTersedia');
            if (!container) return;

            if (!Array.isArray(orders) || orders.length === 0) {
                container.innerHTML = '<tr><td colspan="4" class="text-center py-4 text-muted">Belum ada job baru yang tersedia.</td></tr>';
                if (badgeCount) badgeCount.innerText = '0';
                return;
            }

            if (badgeCount) badgeCount.innerText = orders.length;

            container.innerHTML = orders.map(ord => {
                const perangkat = (ord.perangkat && ord.perangkat.merek) ? (ord.perangkat.merek + ' ' + (ord.perangkat.tipe || '')) : '-';
                const kerusakan = (ord.perangkat && ord.perangkat.keluhan) || '-';

                return '<tr>' +
                    '<td><strong>' + ord.kode + '</strong></td>' +
                    '<td>' + perangkat + '</td>' +
                    '<td>' + kerusakan + '</td>' +
                    '<td>' +
                        '<button class="btn btn-sm btn-success" onclick="ambilJobTeknisi(\\'' + ord.kode + '\\')"><i class="fa-solid fa-hand-holding-hand me-1"></i> Ambil</button>' +
                    '</td>' +
                '</tr>';
            }).join('');
        }

        // 4. Aksi ambil job: Wajib menyimpan ke database dan memuat ulang data asli dari database
        async function ambilJobTeknisi(kodeOrder) {
            try {
                const techId = localStorage.getItem('technician_id') || localStorage.getItem('teknisiId') || '';
                const techNama = localStorage.getItem('namaTeknisi') || localStorage.getItem('teknisi') || 'Teknisi';
                const token = localStorage.getItem('tokenTeknisi') || localStorage.getItem('token') || '';

                const headers = { 'Content-Type': 'application/json' };
                if (token) headers['Authorization'] = 'Bearer ' + token;

                const res = await fetch('/api/teknisi/orders/' + encodeURIComponent(kodeOrder) + '/take', {
                    method: 'POST',
                    headers: headers,
                    body: JSON.stringify({
                        technician_id: techId,
                        namaTeknisi: techNama,
                        status: 'taken'
                    })
                });

                if (res.ok) {
                    // Setelah tersimpan di database, muat ulang data asli dari database
                    await muatUlangSemuaDataJob();
                } else {
                    const errData = await res.json().catch(() => ({}));
                    alert('Gagal mengambil pekerjaan: ' + (errData.error || 'Terjadi kesalahan'));
                }
            } catch (err) {
                console.error('Error saat ambil job:', err);
            }
        }

        async function updateStatusJob(kodeOrder, statusBaru) {
            try {
                const token = localStorage.getItem('tokenTeknisi') || '';
                const headers = { 'Content-Type': 'application/json' };
                if (token) headers['Authorization'] = 'Bearer ' + token;

                await fetch('/api/orders/' + encodeURIComponent(kodeOrder), {
                    method: 'PUT',
                    headers: headers,
                    body: JSON.stringify({ status: statusBaru, 'pengerjaan.status': statusBaru })
                });

                // Muat ulang data asli dari database
                await muatUlangSemuaDataJob();
            } catch (err) {
                console.error('Error update status:', err);
            }
        }

        function logoutTeknisi() {
            localStorage.removeItem('tokenTeknisi');
            localStorage.removeItem('token');
            localStorage.removeItem('technician_id');
            localStorage.removeItem('namaTeknisi');
            window.location.reload();
        }
    </script>
</body>
</html>`;

// Pastikan file frontend teknisi tersimpan di direktori public dan disinkronkan
try {
    const fileTeknisiHtml = path.join(publicPath, 'teknisi.html');
    fs.writeFileSync(fileTeknisiHtml, panelTeknisiHtml, 'utf-8');
} catch (err) {
    console.error("Gagal menulis file teknisi.html:", err.message);
}

// Endpoint routing halaman frontend panel teknisi
app.get(['/teknisi', '/teknisi.html', '/panel-teknisi'], (req, res) => {
    res.send(panelTeknisiHtml);
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
    console.log(`🚀 Server backend aktif di port ${PORT}`);
});