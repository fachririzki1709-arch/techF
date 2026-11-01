const fs = require('fs');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// 1. Mengambil API Key dan Instruksi dari environment variables
const apiKey = process.env.GEMINI_API_KEY;
const instruction = process.env.INSTRUCTION;

const genAI = new GoogleGenerativeAI(apiKey);

async function autoEditCode() {
  try {
    // 2. Tentukan file yang akan diedit (Bisa disesuaikan dengan struktur folder Anda)
    const targetFile = 'server.js'; 
    const originalCode = fs.readFileSync(targetFile, 'utf8');

    // Menggunakan model Gemini terbaru
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-pro' });

    // 3. Merancang Prompt yang ketat
    const prompt = `
    Anda adalah asisten AI programmer.
    Instruksi modifikasi dari GitHub Issue: "${instruction}"

    Berikut adalah kode saat ini dari file ${targetFile}:
    \n\n${originalCode}\n\n

    Tugas Anda:
    Tulis ulang seluruh kode tersebut dengan menerapkan instruksi modifikasi.
    ATURAN KETAT: Berikan HANYA kode utuh yang sudah direvisi. JANGAN sertakan penjelasan apa pun. JANGAN gunakan format markdown atau backticks (\`\`\`). Output Anda akan langsung disimpan menjadi file.
    `;

    console.log('Mengirim kode ke Gemini untuk direvisi...');
    const result = await model.generateContent(prompt);
    let newCode = result.response.text();

    // 4. Membersihkan sisa markdown (Jaga-jaga jika AI tetap menyertakan backticks)
    newCode = newCode.replace(/^```[\s\S]*?\n/g, '').replace(/```$/g, '').trim();

    // 5. Menimpa (overwrite) file lama dengan kode baru
    fs.writeFileSync(targetFile, newCode);
    console.log(`Berhasil! File ${targetFile} telah diperbarui oleh Gemini.`);

  } catch (error) {
    console.error("Gagal memproses kode:", error);
    process.exit(1);
  }
}

autoEditCode();
