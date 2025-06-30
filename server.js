const express = require("express");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const OpenAI = require("openai");
const nodemailer = require("nodemailer");
const bcrypt = require("bcrypt");
const { Pool } = require("pg");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 5000;
const SECRET = process.env.JWT_SECRET;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

app.use(cors());
app.use(express.json());

// Middleware to check auth token
function authMiddleware(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).send("Missing token");

  const token = auth.split(" ")[1];
  try {
    const decoded = jwt.verify(token, SECRET);
    req.user = decoded;
    next();
  } catch {
    res.status(403).send("Invalid token");
  }
}

// Register
app.post("/register", async (req, res) => {
  const { email, password } = req.body;
  const hashed = await bcrypt.hash(password, 10);

  const existing = await pool.query("SELECT * FROM users WHERE email = $1", [email]);
  if (existing.rows.length > 0) return res.status(400).send("User exists");

  await pool.query("INSERT INTO users (email, password) VALUES ($1, $2)", [email, hashed]);
  res.send("Registered");
});

// Login
app.post("/login", async (req, res) => {
  const { email, password } = req.body;
  const result = await pool.query("SELECT * FROM users WHERE email = $1", [email]);
  const user = result.rows[0];

  if (!user || !(await bcrypt.compare(password, user.password))) {
    return res.status(403).send("Invalid credentials");
  }

  const token = jwt.sign({ email: user.email }, SECRET);
  res.json({ token });
});

// Add job
app.post("/jobs", authMiddleware, async (req, res) => {
  const { title, company, description, deadline } = req.body;
  await pool.query(
    "INSERT INTO jobs (email, title, company, description, deadline) VALUES ($1, $2, $3, $4, $5)",
    [req.user.email, title, company, description, deadline]
  );
  res.send("Job added");
});

// Get all jobs with optional search
app.get("/jobs", authMiddleware, async (req, res) => {
  const { search = "" } = req.query;
  const result = await pool.query(
    `SELECT * FROM jobs WHERE email = $1 AND 
      (title ILIKE $2 OR company ILIKE $2 OR description ILIKE $2)
     ORDER BY created_at DESC`,
    [req.user.email, `%${search}%`]
  );
  res.json(result.rows);
});

// Delete job
app.delete("/jobs/:id", authMiddleware, async (req, res) => {
  await pool.query("DELETE FROM jobs WHERE id = $1 AND email = $2", [req.params.id, req.user.email]);
  res.send("Job deleted");
});

// ✅ Correct OpenAI usage
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Resume improvement suggestion
app.post("/suggest", authMiddleware, async (req, res) => {
  const { resume, job } = req.body;

  const prompt = `Improve the following resume to better match the job description.\n\nResume:\n${resume}\n\nJob Description:\n${job}\n\nSuggestions:`;

  const aiRes = await openai.chat.completions.create({
    model: "gpt-4",
    messages: [{ role: "user", content: prompt }]
  });

  const suggestion = aiRes.choices[0]?.message?.content || "No suggestion generated.";

  await pool.query(
    "INSERT INTO ai_logs (email, resume, job_description, suggestion) VALUES ($1, $2, $3, $4)",
    [req.user.email, resume, job, suggestion]
  );

  res.json({ suggestion });
});

// Get AI suggestion history
app.get("/ai/history", authMiddleware, async (req, res) => {
  const result = await pool.query(
    "SELECT * FROM ai_logs WHERE email = $1 ORDER BY created_at DESC",
    [req.user.email]
  );
  res.json(result.rows);
});

// Send email reminders manually
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

app.get("/reminders/send", async (req, res) => {
  const today = new Date().toISOString().split("T")[0];
  const result = await pool.query("SELECT * FROM jobs WHERE deadline = $1", [today]);

  for (const job of result.rows) {
    await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to: job.email,
      subject: `Reminder: ${job.title} at ${job.company}`,
      text: `Don't forget to apply for ${job.title} at ${job.company}. Deadline is today.`,
    });
  }

  res.send("Reminders sent");
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
