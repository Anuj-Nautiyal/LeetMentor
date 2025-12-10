
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// Config via env
const PORT = process.env.PORT || 3000;
const LLM_PROVIDER = (process.env.LLM_PROVIDER || 'ollama').toLowerCase(); // 'ollama' or ''
const OLLAMA_BASE = process.env.OLLAMA_BASE || 'http://localhost:11434';
const LLM_MODEL = process.env.LLM_MODEL || 'llama3.2:3b';
const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX || '120', 10); // per minute per ip

// --- Simple in-memory rate limiter (per-ip, minute window) ---
const rateMap = new Map();
function isRateLimited(ip) {
  try {
    const now = Date.now();
    const windowStart = now - 60_000;
    const entry = rateMap.get(ip) || { calls: [] };
    entry.calls = (entry.calls || []).filter(t => t >= windowStart);
    if (entry.calls.length >= RATE_LIMIT_MAX) {
      rateMap.set(ip, entry);
      return true;
    }
    entry.calls.push(now);
    rateMap.set(ip, entry);
    return false;
  } catch (e) {
    return false; // fail open
  }
}

// --- Local fallback hint/snippet generators ---
function localGenerateHint({ problemId = '', failure = '', level = 1 }) {
  const pid = (problemId || '').toLowerCase();
  const fail = (failure || '').toLowerCase();

  // quick tailored heuristics
  if (pid.includes('two-sum') || pid.includes('two_sum')) {
    if (level === 1) return 'Think about using a data structure that allows constant-time lookups to avoid nested loops.';
    if (level === 2) return 'Consider using a hash map to store seen numbers and check complements in a single pass.';
    return 'Track seen numbers in a hash map; when you find a complement, return indices (ensure 0-based indexing).';
  }

  if (fail.includes('index') || fail.includes('range')) {
    if (level === 1) return 'Check array index boundaries — arrays are usually 0-indexed.';
    if (level === 2) return 'Verify index calculations and off-by-one errors; confirm loop bounds.';
    return 'Inspect index arithmetic and ensure loop end conditions use < not <= and indices are within [0, n-1].';
  }

  if (fail.includes('time limit') || fail.includes('tle')) {
    if (level === 1) return 'Consider whether your approach is doing repeated work — can it be reduced?';
    if (level === 2) return 'Try optimizing to O(n) or O(n log n) by using a hash map or sorting instead of nested loops.';
    return 'Replace nested loops with a single-pass approach using a hash map to record and lookup values.';
  }

  // generic fallback
  if (level === 1) return 'Break the problem into smaller parts and think about the data structure that fits best.';
  if (level === 2) return 'Identify the algorithmic pattern (two pointers, hash map, BFS/DFS, dynamic programming) and consider its complexity.';
  return 'Focus on the core invariant — can you record seen states (in a set/map) and check complements in O(1)?';
}

function localGenerateSnippet(snippetRaw) {
  if (!snippetRaw) return '';
  const lines = snippetRaw.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (!lines.length) return '';
  return (lines.length <= 3 ? lines : lines.slice(0, 3)).join('\n').slice(0, 500);
}

// Starter template used only when LLM is NOT enabled or LLM fails
function starterTemplate(problemId) {
  const pid = (problemId || '').toLowerCase();
  if (pid.includes('two-sum') || pid.includes('two_sum')) {
    return [
      'int twoSum(int* nums, int numsSize, int target) {',
      '    // prepare a map/hashtable to record seen numbers and their indices',
      '    // iterate and check complements'
    ].join('\n');
  }
  // generic starter (C-style)
  return [
    'int solve() {',
    '    // parse input and choose the data structure you need (array/list/hash map)',
    '    // implement main algorithm here'
  ].join('\n');
}

// --- Utilities ---
function sanitizeModelText(text, maxChars = 1200) {
  if (!text) return '';
  let t = String(text);
  // remove fenced code blocks
  t = t.replace(/```[\s\S]*?```/g, '');
  // collapse many newlines
  t = t.replace(/\n{3,}/g, '\n\n');
  return t.trim().slice(0, maxChars);
}

// Robust Ollama caller: supports both non-stream JSON and NDJSON fragments and returns combined string
async function callOllama(promptText, opts = {}) {
  const url = `${OLLAMA_BASE.replace(/\/$/, '')}/api/generate`;
  const body = {
    model: opts.model || LLM_MODEL,
    prompt: promptText,
    max_tokens: opts.maxTokens ?? 200,
    temperature: opts.temperature ?? 0.2,
    stream: false // ask Ollama for non-stream by default (we still handle NDJSON)
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`ollama_error_${res.status}: ${txt}`);
  }

  const contentType = (res.headers.get('content-type') || '').toLowerCase();
  const text = await res.text();

  // Try JSON first
  try {
    if (contentType.includes('application/json')) {
      const j = JSON.parse(text);
      const candidate = j.generated || j.output || j.text || j.response || (j.choices && j.choices[0] && (j.choices[0].text || (j.choices[0].message && j.choices[0].message.content)));
      return sanitizeModelText(candidate || '', 2000);
    }
  } catch (e) {
    // fallthrough to NDJSON handling
  }

  // NDJSON: many JSON objects separated by newline
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (lines.length > 1) {
    const parts = [];
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        const piece = obj.response || obj.generated || obj.output || obj.text || (obj.choices && obj.choices[0] && (obj.choices[0].text || (obj.choices[0].message && obj.choices[0].message.content)));
        if (piece) parts.push(String(piece));
      } catch (e) {
        parts.push(line);
      }
    }
    return sanitizeModelText(parts.join(''), 2000);
  }

  // fallback: plain text
  return sanitizeModelText(text, 2000);
}

// --- Prompt builders ---

// Multi-level hint prompt (level 1..3)
function buildHintPrompt({ problemId, snippet, url, failure, level = 1 }) {
  const snippetPreview = (snippet || '').slice(0, 2000);
  const snippetEmpty = !snippetPreview.trim();
  const lvl = Math.max(1, Math.min(3, Number(level || 1)));

  const base = [
    'You are an expert competitive programming mentor.',
    'Your job: produce a hint (NOT the full solution) tailored to the requested hint level.',
    'STRICT RULES:',
    '- NEVER provide the complete solution.',
    '- NEVER ask for more code or ask clarifying questions.',
    '- Keep language concise and actionable.',
    '- When asked for code lines (level 3 only), produce only 2–3 short lines (no full solution).'
  ].join('\n');

  const levelInstr = lvl === 1
    ? 'LEVEL 1 (Conceptual): Output 1 short sentence that points to the high-level idea (no code).'
    : lvl === 2
      ? 'LEVEL 2 (Algorithmic): Output 1–2 short sentences describing the approach; you may include a single short pseudo-line (not runnable code).'
      : 'LEVEL 3 (Near-fix): Output up to 2–3 short lines of code or concise pseudo-code pointing to the likely fix; do NOT output the full solution.';

  return [
    base,
    '',
    levelInstr,
    '',
    snippetEmpty ? 'NOTE: The user has provided NO code.' : 'User provided code (may be short).',
    '',
    `PROBLEM: ${problemId || url || 'unknown'}`,
    `FAILURE: ${failure || 'none provided'}`,
    '',
    'USER CODE (first 2000 chars):',
    snippetPreview,
    '',
    lvl === 1
      ? 'Now produce EXACTLY one short sentence as the hint (no code).'
      : lvl === 2
        ? 'Now produce 1–2 short sentences describing the algorithmic approach. You may optionally include one short pseudo-line.'
        : 'Now output up to 2–3 short lines of code or concise pseudo-code pointing to the likely fix. Do NOT output the full solution.'
  ].join('\n');
}

// Snippet prompt: LLM should return 2-3 lines or starter lines if snippet empty
function buildSnippetPrompt({ problemId, snippet, url, failure, hintLevel = 1 }) {
  return [
    'You are an expert coding mentor.',
    '',
    'TASK: Output ONLY 2–3 lines of code (no explanation).',
    '',
    'STRICT RULES:',
    '- Output only 2 or 3 lines of code (no comments, no explanation).',
    '- If the provided user code is MISSING or INSUFFICIENT, produce a concise 2–3 line STARTER fragment for the problem (a skeleton showing how to begin).',
    '- NEVER provide a full solution or more than 3 lines.',
    '- DO NOT ask the user for code or ask any clarifying questions.',
    '- DO NOT output natural language; output only code lines (or an empty string if unsafe).',
    '',
    `PROBLEM: ${problemId || url || 'unknown'}`,
    `FAILURE: ${failure || 'none'}`,
    `HINT_LEVEL: ${hintLevel}`,
    '',
    'USER CODE (may be empty):',
    (snippet || '').slice(0, 4000),
    '',
    'Output exactly 2–3 code lines or an empty string if you cannot safely produce such an excerpt.'
  ].join('\n');
}

// --- Routes ---

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    llm: LLM_PROVIDER || null,
    model: LLM_MODEL || null,
    timestamp: Date.now()
  });
});

app.post('/hint', async (req, res) => {
  try {
    const ip = req.ip || req.headers['x-forwarded-for'] || req.connection?.remoteAddress || 'unknown';
    if (isRateLimited(ip)) return res.status(429).json({ error: 'rate_limited' });

    const body = req.body || {};
    const { problemId, snippet, url, failure, request } = body;
    const hintLevel = Math.max(1, Math.min(3, Number(body.hintLevel || 1)));

    // SNIPPET MODE
    if (request === 'snippet') {
      if (LLM_PROVIDER === 'ollama') {
        try {
          const prompt = buildSnippetPrompt({ problemId, snippet, url, failure, hintLevel });
          const raw = await callOllama(prompt, { maxTokens: 160, temperature: hintLevel === 1 ? 0.0 : 0.2, model: LLM_MODEL });
          let out = String(raw || '').trim();

          // remove code fences, prefixes
          out = out.replace(/```[\s\S]*?```/g, '').replace(/^(?:Response:|Answer:)/i, '').trim();

          // block the model asking-for-code phrases
          const bannedPatterns = /paste|provide|share|send|please provide|did you forget|can't|cannot|need.*code/i;
          if (bannedPatterns.test(out)) out = '';

          const lines = out.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
          const excerptLines = lines.slice(0, 3);

          if (excerptLines.length === 0) {
            // LLM returned nothing useful -> return empty snippet (per config). If LLM call failed we fall back to starter below.
            return res.json({ snippet: '' });
          }

          return res.json({ snippet: excerptLines.join('\n') });
        } catch (err) {
          console.warn('[SERVER] Ollama snippet failed, falling back to local starter:', err && err.message);
          const fallbackStarter = starterTemplate(problemId || url || '');
          return res.json({ snippet: fallbackStarter });
        }
      } else {
        // No LLM: return local starter template
        const localStarter = starterTemplate(problemId || url || '');
        return res.json({ snippet: localStarter });
      }
    }

    // NORMAL HINT MODE
    // Prefer LLM if configured
    if (LLM_PROVIDER === 'ollama') {
      try {
        const prompt = buildHintPrompt({ problemId, snippet, url, failure, level: hintLevel });
        const raw = await callOllama(prompt, { maxTokens: 220, temperature: hintLevel === 1 ? 0.0 : 0.2, model: LLM_MODEL });
        const safe = sanitizeModelText(raw, 1200);

        if (hintLevel === 1) {
          const sent = safe.split(/[.?!]\s+/).map(s => s.trim()).filter(Boolean)[0] || safe;
          return res.json({ hint: sent });
        } else if (hintLevel === 2) {
          const sentences = safe.split(/[.?!]\s+/).map(s => s.trim()).filter(Boolean).slice(0, 2);
          return res.json({ hint: (sentences.join('. ') + (sentences.length ? '.' : '')).trim() });
        } else {
          const lines = safe.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
          const excerpt = (lines.length ? lines.slice(0, 3).join('\n') : safe.split(/[.?!]\s+/).slice(0,3).join('\n'));
          return res.json({ hint: excerpt });
        }
      } catch (err) {
        console.warn('[SERVER] Ollama hint failed, falling back to local:', err && err.message);
        // fall through to local fallback
      }
    }

    // Final fallback: local heuristics tuned by hintLevel
    const fallback = localGenerateHint({ problemId, failure, level: hintLevel });
    const snippetExcerpt = localGenerateSnippet(snippet);
    return res.json({ hint: fallback, snippet: snippetExcerpt });

  } catch (err) {
    console.error('[SERVER] unexpected error', err && (err.stack || err.message) || err);
    return res.status(500).json({ error: 'internal_error', detail: String(err && err.message ? err.message : err) });
  }
});

// start server
app.listen(PORT, () => {
  console.log(`LeetMentor server running on http://localhost:${PORT}`);
  console.log(`LLM_PROVIDER=${LLM_PROVIDER}  LLM_MODEL=${LLM_MODEL}`);
  if (LLM_PROVIDER === 'ollama') console.log(`Ollama base: ${OLLAMA_BASE}`);
  else console.log('No LLM provider configured — using local heuristics only.');
});
