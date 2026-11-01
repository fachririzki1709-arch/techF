const fs = require('fs');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const apiKey = process.env.GEMINI_API_KEY;
const instruction = process.env.INSTRUCTION;
const genAI = new GoogleGenerativeAI(apiKey);

// Fungsi untuk memberi jeda waktu
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function autoEditCode() {
  try {
    const targetFile = 'server.js'; 
    const originalCode = fs.readFileSync(targetFile, 'utf8');

    // Menggunakan versi yang wajib di-support oleh server Anda
    const model = genAI.getGenerativeModel({ model: 'gemini-3.8-flash' });

    const prompt = `
    Anda adalah asisten AI programmer.
    Instruksi modifikasi dari GitHub Issue: "${instruction}"

    Berikut adalah kode saat ini dari file ${targetFile}:
    \n\n${originalCode}\n\n

    Tugas Anda:
    Tulis ulang seluruh kode tersebut. HANYA kode utuh yang sudah direvisi. JANGAN gunakan markdown atau backticks (\`\`\`).
    `;

    console.log('Mengirim kode ke Gemini...');
    
    let result;
    let retries = 3; // Sistem akan mencoba hingga 3 kali jika server sibuk
    
    while (retries > 0) {
      try {
        result = await model.generateContent(prompt);
        break; // Jika berhasil, langsung keluar dari loop
      } catch (err) {
        if (err.status === 503) {
          console.log(`Server Google sibuk (503). Mencoba ulang dalam 10 detik... (Sisa percobaan: ${retries - 1})`);
          retries--;
          if (retries === 0) throw err;
          await delay(10000); // Jeda 10 detik sebelum mencoba lagi
        } else {
          throw err; // Lempar error jika masalahnya bukan 503
        }
      }
    }

    let newCode = result.response.text();
    newCode = newCode.replace(/^```[\s\S]*?\n/g, '').replace(/```$/g, '').trim();

    fs.writeFileSync(targetFile, newCode);
    console.log(`Berhasil! File ${targetFile} telah diperbarui.`);

  } catch (error) {
    console.error("Gagal memproses kode:", error);
    process.exit(1);
  }
}

autoEditCode();
