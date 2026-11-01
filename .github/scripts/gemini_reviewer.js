const { GoogleGenerativeAI } = require('@google/generative-ai');
const github = require('@actions/github');

const apiKey = process.env.GEMINI_API_KEY;
const githubToken = process.env.GITHUB_TOKEN;

const genAI = new GoogleGenerativeAI(apiKey);
const octokit = github.getOctokit(githubToken);

// Daftar Hitam File: AI tidak akan mereview ini
const ignoredFiles = ['package-lock.json', 'yarn.lock'];
// Daftar Hitam Ekstensi: AI tidak akan mereview file binari atau aset
const ignoredExtensions = ['.png', '.jpg', '.jpeg', '.svg', '.ico', '.mp4', '.pdf', '.zip'];

async function reviewCode() {
  try {
    const context = github.context;
    if (!context.payload.pull_request) return;

    const prNumber = context.payload.pull_request.number;
    const owner = context.repo.owner;
    const repo = context.repo.repo;

    console.log(`Mengambil daftar file yang berubah pada PR #${prNumber}...`);
    
    // Mengambil daftar file dari GitHub API (bukan diff mentah)
    const { data: files } = await octokit.rest.pulls.listFiles({
      owner, repo, pull_number: prNumber
    });

    let filteredDiffs = [];

    // Proses penyaringan (Filtering)
    for (const file of files) {
      const fileName = file.filename;
      const fileExtension = fileName.substring(fileName.lastIndexOf('.')).toLowerCase();

      // Cek apakah file masuk daftar hitam nama atau ekstensi
      const isIgnoredFile = ignoredFiles.some(ignored => fileName.includes(ignored));
      const isIgnoredExt = ignoredExtensions.includes(fileExtension);

      if (!isIgnoredFile && !isIgnoredExt && file.patch) {
        // Jika file aman dan memiliki patch (perubahan), masukkan ke daftar
        filteredDiffs.push(`--- a/${fileName}\n+++ b/${fileName}\n${file.patch}`);
      }
    }

    if (filteredDiffs.length === 0) {
      console.log("Tidak ada file yang perlu direview setelah disaring. Menghentikan proses.");
      return; 
    }

    const compiledDiff = filteredDiffs.join('\n\n');

    const model = genAI.getGenerativeModel({ model: 'gemini-3.8-flash' });
    
    const prompt = `
    Anda adalah Senior Developer. Tugas Anda adalah melakukan Code Review pada perubahan (git diff) berikut.
    Hanya file yang relevan yang disertakan:
    \n\n${compiledDiff}\n\n
    Fokus pada:
    1. Potensi bug.
    2. Keamanan.
    3. Efisiensi algoritma.
    Gunakan format Markdown untuk komentar Anda.
    `;

    console.log("Mengirim diff bersih ke Gemini...");
    const result = await model.generateContent(prompt);
    const reviewText = result.response.text();

    await octokit.rest.issues.createComment({
      owner, repo, issue_number: prNumber,
      body: "### 🤖 Gemini Filtered Code Review\n\n" + reviewText
    });

    console.log("Komentar berhasil ditambahkan.");

  } catch (error) {
    console.error("Gagal melakukan review:", error);
    process.exit(1);
  }
}

reviewCode();
