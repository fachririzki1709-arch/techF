const fs = require('fs');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const apiKey = process.env.GEMINI_API_KEY;
const instruction = process.env.INSTRUCTION;
const genAI = new GoogleGenerativeAI(apiKey);

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Fungsi pembantu untuk memindai seluruh file di dalam repositori
function getRepoFiles(dir, fileList = []) {
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const filePath = path.join(dir, file);
    if (fs.statSync(filePath).isDirectory()) {
      // Abaikan folder sistem agar tidak membingungkan AI
      if (file !== 'node_modules' && file !== '.git' && file !== '.github') {
        getRepoFiles(filePath, fileList);
      }
    } else {
      fileList.push(filePath);
    }
  }
  return fileList;
}

// Fungsi eksekusi ke API Gemini dengan Auto-Retry
async function fetchWithRetry(model, prompt) {
  let retries = 3;
  while (retries > 0) {
    try {
      const result = await model.generateContent(prompt);
      return result.response.text();
    } catch (err) {
      if (err.status === 503) {
        console.log(`Server 503 (Sibuk). Mencoba ulang dalam 10 detik... (Sisa: ${retries - 1})`);
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
    
    // TAHAP 1: AI MENCARI NAMA FILE
    const allFiles = getRepoFiles('./').join('\n');
    const promptCariFile = `
    Tugas Anda adalah menemukan 1 target file berdasarkan instruksi dari GitHub Issue.
    Instruksi: "${instruction}"
    
    Berikut adalah daftar semua file di repositori:
    ${allFiles}
    
    ATURAN: Balas HANYA dengan path file yang paling relevan untuk diedit. Jangan tambahkan teks apa pun atau backticks.
    `;
    
    console.log('Tahap 1: Meminta Gemini menganalisis repositori untuk mencari file yang tepat...');
    let rawTarget = await fetchWithRetry(model, promptCariFile);
    let targetFile = rawTarget.replace(/^```[\s\S]*?\n/g, '').replace(/```$/g, '').trim();

    if (!fs.existsSync(targetFile)) {
       console.error(`Error: Gemini memilih file yang tidak valid atau tidak ada (${targetFile})`);
       process.exit(1);
    }
    console.log(`Tahap 1 Selesai. Gemini memilih untuk mengedit file: ${targetFile}`);

    // TAHAP 2: AI MENGEDIT FILE
    const originalCode = fs.readFileSync(targetFile, 'utf8');
    const promptEdit = `
    Instruksi modifikasi: "${instruction}"
    
    Berikut adalah isi dari file ${targetFile}:
    \n\n${originalCode}\n\n
    
    Tugas: Tulis ulang seluruh kode tersebut dengan menerapkan instruksi di atas. 
    ATURAN KETAT: Berikan HANYA kode utuh yang sudah direvisi. JANGAN gunakan markdown atau backticks (\`\`\`).
    `;

    console.log(`Tahap 2: Mengirim kode ${targetFile} untuk direvisi oleh Gemini...`);
    let codeResult = await fetchWithRetry(model, promptEdit);
    let newCode = codeResult.replace(/^```[\s\S]*?\n/g, '').replace(/```$/g, '').trim();

    fs.writeFileSync(targetFile, newCode);
    console.log(`Berhasil! File ${targetFile} telah diperbarui secara otomatis.`);

  } catch (error) {
    console.error("Gagal memproses operasi dinamis:", error);
    process.exit(1);
  }
}

autoEditCode();
