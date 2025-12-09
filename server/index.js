// server/index.js — Minimal backend stub for LeetMentor
const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

// --- Hint generator (replace with LLM later) ---
function generateHint({ problemId, failure }) {
  const pid = (problemId || "").toLowerCase();
  const fail = (failure || "").toLowerCase();

  if (pid.includes("two-sum") || pid.includes("two_sum")) {
    return "Try using a hash map to store seen numbers and check complements in O(1).";
  }

  if (fail.includes("index") || fail.includes("range")) {
    return "Check your array boundaries. Use 0-based indexing carefully.";
  }

  if (fail.includes("time limit") || fail.includes("tle")) {
    return "Try reducing nested loops or switching to a more efficient data structure.";
  }

  return "Break the problem into smaller parts. Identify repeated work you can optimize.";
}

// --- Snippet generator (very simple) ---
function generateSnippet(snippetRaw) {
  if (!snippetRaw) return "";

  const lines = snippetRaw
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l.length > 0);

  if (lines.length === 0) return "";

  const excerpt =
    lines.length <= 3 ? lines : lines.slice(0, 3);

  return excerpt.join("\n").slice(0, 250); // safety trim
}

// --- Route ---
app.post("/hint", (req, res) => {
  const body = req.body || {};
  console.log("[SERVER] Received request:", {
    problemId: body.problemId,
    url: body.url,
    failure: body.failure && body.failure.slice(0, 200)
  });

  // Snippet mode
  if (body.request === "snippet") {
    const snippet = generateSnippet(body.snippet);
    return res.json({ snippet });
  }

  // Hint mode
  const hint = generateHint(body);
  const snippetExcerpt = generateSnippet(body.snippet);

  return res.json({
    hint,
    snippet: snippetExcerpt
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`LeetMentor server running on http://localhost:${PORT}`);
});
