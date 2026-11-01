const fs = require('fs');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const apiKey = process.env.GEMINI_API_KEY;
const instruction = process.env.INSTRUCTION;
const targetFile = process.env.TARGET_FILE || 'server.js';

if (!apiKey) {
  throw new Error('GEMINI_API_KEY is missing.');
}

if (!instruction) {
  throw new Error('INSTRUCTION is missing.');
}

const genAI = new GoogleGenerativeAI(apiKey);
const MODEL_CANDIDATES = ['gemini-2.0-flash', 'gemini-1.5-flash'];

async function generateWithRetry(prompt, maxAttempts = 3) {
  for (const modelName of MODEL_CANDIDATES) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const model = genAI.getGenerativeModel({ model: modelName });
        const result = await model.generateContent(prompt);
        return { modelName, text: result.response.text() };
      } catch (error) {
        const status = error?.status || error?.response?.status;
        const message = String(error?.message || '');
        const transientError =
          status === 429 ||
          status === 503 ||
          message.includes('Service Unavailable') ||
          message.includes('high demand') ||
          message.includes('Resource exhausted') ||
          message.includes('temporarily');

        const invalidModel =
          status === 404 ||
          message.includes('not found') ||
          message.includes('unsupported') ||
          message.includes('model');

        if (attempt < maxAttempts && transientError) {
          const delayMs = 2000 * attempt;
          console.warn(`Model ${modelName} unavailable (${status || 'network'}), retrying in ${delayMs / 1000}s...`);
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          continue;
        }

        if (invalidModel && modelName !== MODEL_CANDIDATES[MODEL_CANDIDATES.length - 1]) {
          console.warn(`Skipping unsupported model: ${modelName}`);
          break;
        }

        throw error;
      }
    }
  }

  throw new Error('No Gemini model was able to process the request.');
}

async function autoEditCode() {
  try {
    if (!fs.existsSync(targetFile)) {
      throw new Error(`File not found: ${targetFile}`);
    }

    const originalCode = fs.readFileSync(targetFile, 'utf8');

    const prompt = `
    Anda adalah asisten AI programmer.
    Instruksi modifikasi dari GitHub Issue: "${instruction}"

    Berikut adalah kode saat ini dari file ${targetFile}:
    \n\n${originalCode}\n\n
    Tugas Anda:
    Tulis ulang seluruh kode tersebut dengan menerapkan instruksi modifikasi.
    ATURAN KETAT: Berikan HANYA kode utuh yang sudah direvisi. JANGAN sertakan penjelasan apa pun. JANGAN gunakan format markdown atau backticks (\`\`). Output Anda akan langsung disimpan menjadi file ${targetFile}.
    `;

    console.log('Mengirim kode ke Gemini untuk direvisi...');
    const { modelName, text } = await generateWithRetry(prompt);
    console.log(`Menggunakan model Gemini: ${modelName}`);

    let newCode = text.replace(/^```[\s\S]*?\n/g, '').replace(/```$/g, '').trim();

    fs.writeFileSync(targetFile, newCode);
    console.log(`Berhasil! File ${targetFile} telah diperbarui oleh Gemini.`);
  } catch (error) {
    console.error('Gagal memproses kode:', error);
    process.exit(1);
  }
}

autoEditCode();
