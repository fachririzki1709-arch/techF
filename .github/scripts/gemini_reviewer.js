const { GoogleGenerativeAI } = require('@google/generative-ai');
const github = require('@actions/github');

const apiKey = process.env.GEMINI_API_KEY;
const githubToken = process.env.GITHUB_TOKEN;

const genAI = new GoogleGenerativeAI(apiKey);
const octokit = github.getOctokit(githubToken);

async function reviewCode() {
  try {
    const context = github.context;
    // Pastikan script hanya berjalan pada event Pull Request
    if (!context.payload.pull_request) return;

    const prNumber = context.payload.pull_request.number;
    const owner = context.repo.owner;
    const repo = context.repo.repo;

    console.log(`Mengambil detail perubahan (diff) dari PR #${prNumber}...`);
    
    // Meminta data perubahan kode dari API GitHub
    const { data: diff } = await octokit.rest.pulls.get({
      owner, repo, pull_number: prNumber,
      mediaType: { format: 'diff' }
    });

    // Menggunakan model yang sudah terbukti stabil di akun Anda
    const model = genAI.getGenerativeModel({ model: 'gemini-3.8-flash' });
    
    const prompt = `
    Anda adalah Senior Developer. Tugas Anda adalah melakukan Code Review pada perubahan (git diff) berikut:
    \n\n${diff}\n\n
    Berikan komentar menggunakan Markdown. Fokus pada:
    1. Bug potensial atau kebocoran memori.
    2. Celah keamanan.
    3. Efisiensi kode yang bisa ditingkatkan.
    Jika kodenya sangat bagus, berikan pujian singkat.
    `;

    console.log("Mengirim diff ke Gemini untuk dianalisis...");
    const result = await model.generateContent(prompt);
    const reviewText = result.response.text();

    console.log("Memposting komentar ke Pull Request...");
    await octokit.rest.issues.createComment({
      owner, repo, issue_number: prNumber,
      body: "### 🤖 Gemini AI Code Review\n\n" + reviewText
    });

    console.log("Selesai! Komentar berhasil ditambahkan.");

  } catch (error) {
    console.error("Gagal melakukan review:", error);
    process.exit(1);
  }
}

reviewCode();
