const fs = require('fs');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const apiKey = process.env.GEMINI_API_KEY;
const instruction = process.env.INSTRUCTION;
const genAI = new GoogleGenerativeAI(apiKey);

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function getRepoFiles(dir, fileList = []) {
  const ignoreDirs = ['node_modules', '.git', '.github', 'dist', 'build', 'public'];
  const ignoreFiles = ['.env', 'package.json', 'package-lock.json', '.gitignore', 'README.md'];
  
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const filePath = path.join(dir, file);
    if (fs.statSync(filePath).isDirectory()) {
      if (!ignoreDirs.includes(file)) getRepoFiles(filePath, fileList);
    } else {
      if (!ignoreFiles.includes(file)) fileList.push(filePath);
    }
  }
  return fileList;
}

async function fetchWithRetry(model, prompt) {
  let retries = 3;
  while (retries > 0) {
    try {
      const result = await model.generateContent(prompt);
      return result.response.text();
    } catch (err) {
      const isNetworkError = err.name === 'TypeError' && err.message === 'fetch failed';
      const isServerBusy = err.status === 503;

      if (isServerBusy || isNetworkError) {
        console.log(`Gangguan koneksi/server. Mencoba ulang dalam 10 detik... (Sisa: ${retries - 1})`);
        retries--;
        if (retries === 0) throw err;
        await delay(10000);
      } else {
        throw err;
      }
    }
  }
}

async function autoEditCode() {
  try {
    const model = genAI.getGenerativeModel({ model: 'gemini-3.8-flash' });
    
    // TAHAP 1: MENCARI BANYAK TARGET FILE (Format JSON Array)
    const allFiles = getRepoFiles('./').join('\n');
    const promptCariFile = `
    Tugas Anda adalah menemukan file-file yang perlu diedit berdasarkan instruksi dari GitHub Issue.
    Instruksi: "${instruction}"
    
    Daftar file repositori:
    ${allFiles}
    
    ATURAN MUTLAK: Balas HANYA dengan format JSON Array berisi path file yang relevan (maksimal 3 file agar tidak overload). Jangan ada teks tambahan.
    Contoh: ["server.js", "views/panel_teknisi.html"]
    `;
    
    console.log('Tahap 1: Meminta Gemini menganalisis file yang perlu diubah...');
    let rawTarget = await fetchWithRetry(model, promptCariFile);
    
    // Membersihkan teks dari sisa-sisa markdown agar bisa di-parse
    rawTarget = rawTarget.replace(/^```json[\s\S]*?\n/g, '').replace(/^```[\s\S]*?\n/g, '').replace(/```$/g, '').trim();

    let targetFiles;
    try {
      targetFiles = JSON.parse(rawTarget);
    } catch (e) {
      console.error("Gagal mengurai JSON dari AI. Output AI:", rawTarget);
      process.exit(1);
    }

    if (!Array.isArray(targetFiles) || targetFiles.length === 0) {
       console.log("AI tidak menemukan file yang relevan atau format salah.");
       process.exit(1);
    }

    console.log(`Tahap 1 Selesai. Target file: ${targetFiles.join(', ')}`);

    // TAHAP 2: MENGEDIT FILE SATU PER SATU DARI ARRAY
    for (const targetFile of targetFiles) {
      if (!fs.existsSync(targetFile)) {
        console.warn(`File ${targetFile} tidak ditemukan, melewati file ini...`);
        continue;
      }

      const originalCode = fs.readFileSync(targetFile, 'utf8');
      const promptEdit = `
      Instruksi modifikasi: "${instruction}"
      
      Berikut adalah isi dari file ${targetFile}:
      \n\n${originalCode}\n\n
      
      Tugas: Tulis ulang kode tersebut untuk memperbaiki masalah sesuai instruksi. Sinkronkan logika Anda dengan file lain jika instruksi memintanya.
      ATURAN KETAT: Berikan HANYA kode utuh yang sudah direvisi. JANGAN gunakan markdown atau backticks (\`\`\`).
      `;

      console.log(`Tahap 2: Mengirim ${targetFile} untuk direvisi...`);
      let codeResult = await fetchWithRetry(model, promptEdit);
      let newCode = codeResult.replace(/^```[\s\S]*?\n/g, '').replace(/```$/g, '').trim();

      fs.writeFileSync(targetFile, newCode);
      console.log(`Berhasil! File ${targetFile} diperbarui.`);
    }

    console.log("Semua file selesai diperbarui. Menyiapkan Pull Request...");

  } catch (error) {
    console.error("Gagal memproses operasi dinamis:", error);
    process.exit(1);
  }
}

autoEditCode();
