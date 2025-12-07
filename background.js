// Responsibilities:
//  - Track per-tab activity (edits, failures) and detect "stuck" (1 fail OR idle)
//  - Persist per-problem hint counts so limits survive service worker restarts
//  - Respond to popup hint requests, call backend to generate hints (with cache + rate limiting)
//  - Respect user privacy setting: allowSendCodeToServer (default: false)
//  - Provide robust error handling & fallback hints

// ========== CONFIG ==========
const IDLE_MS = 3 * 60 * 1000;
const FAILURE_WINDOW_MS = 10 * 60 * 1000;
const HINT_LIMIT = 3;
const HINT_CACHE_TTL_MS = 5 * 60 * 1000;
const MIN_TIME_BETWEEN_SERVER_CALLS_MS = 30 * 1000;
const HINT_SERVER_URL = "http://localhost:3000/api/generate-hint"; // change to production URL

// Storage keys
const STORAGE_KEYS = {
  HINTS_MAP: "leetmentor_hints_map",
  HINT_CACHE: "leetmentor_hint_cache",
  SETTINGS: "leetmentor_settings"
};

// ========== IN-MEM STATE ==========
const tabState = {};
let persistedHints = {};
let hintCache = {};
const recentServerCalls = {};
let settings = { allowSendCodeToServer: false }; // default: false

function log(...a) { console.log("[LeetMentor]", ...a); }
function warn(...a) { console.warn("[LeetMentor]", ...a); }

function ensureTab(tabId) {
  if (!tabState[tabId]) {
    tabState[tabId] = { lastInputTs: 0, failures: [], isStuck: false };
  }
  return tabState[tabId];
}

// ========== PERSISTENCE HELPERS ==========
function persistHints() {
  chrome.storage.local.set({ [STORAGE_KEYS.HINTS_MAP]: persistedHints });
}
function persistHintCache() {
  chrome.storage.local.set({ [STORAGE_KEYS.HINT_CACHE]: hintCache });
}
function persistSettings() {
  chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: settings });
}

async function loadPersistedState() {
  return new Promise((resolve) => {
    chrome.storage.local.get([STORAGE_KEYS.HINTS_MAP, STORAGE_KEYS.HINT_CACHE, STORAGE_KEYS.SETTINGS], (data) => {
      if (chrome.runtime.lastError) warn("loadPersistedState error", chrome.runtime.lastError);
      persistedHints = data[STORAGE_KEYS.HINTS_MAP] || {};
      hintCache = data[STORAGE_KEYS.HINT_CACHE] || {};
      settings = data[STORAGE_KEYS.SETTINGS] || { allowSendCodeToServer: false };
      log("rehydrated state:", { hints: Object.keys(persistedHints).length, cache: Object.keys(hintCache).length, settings });
      resolve();
    });
  });
}

// load at worker start
loadPersistedState().catch(e => warn("initial load failed", e));

// ========== ALARMS FOR IDLE DETECTION ==========
chrome.alarms.create("idle_check", { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (!alarm || alarm.name !== "idle_check") return;
  performIdleCheck();
});

function performIdleCheck() {
  const now = Date.now();
  chrome.tabs.query({}, (tabs) => {
    tabs.forEach(t => {
      const id = t.id;
      if (!id) return;
      const s = ensureTab(id);
      if (s.lastInputTs && (now - s.lastInputTs >= IDLE_MS) && !s.isStuck) {
        s.isStuck = true;
        log(`tab ${id} marked stuck by idle`);
      }
    });
  });
}

// ========== MESSAGE HANDLER ==========
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;
  const tabId = sender && sender.tab && sender.tab.id;

  switch (msg.type) {
    case "editor_input": {
      if (!tabId) break;
      const s = ensureTab(tabId);
      s.lastInputTs = msg.payload?.time || Date.now();
      break;
    }
    case "run_or_submit_clicked": {
      if (!tabId) break;
      const s = ensureTab(tabId);
      s.lastInputTs = msg.payload?.time || Date.now();
      break;
    }
    case "submission_result": {
      if (!tabId) break;
      const s = ensureTab(tabId);
      if (msg.payload?.status === "fail") {
        const now = Date.now();
        s.failures.push(now);
        s.failures = s.failures.filter(t => now - t <= FAILURE_WINDOW_MS);
        if (s.failures.length >= 1) {
          s.isStuck = true;
          log(`tab ${tabId} marked stuck by failure`);
        }
      } else if (msg.payload?.status === "pass") {
        s.failures = [];
        s.isStuck = false;
      }
      break;
    }
    // Popup -> request a hint for active tab
    case "request_hint": {
      const reqTab = msg.tabId;
      handleRequestHint(reqTab, sendResponse);
      return true;
    }
    // Popup -> request code excerpt (local only)
    case "request_code_snippet": {
      handleRequestCodeSnippet(msg.tabId, sendResponse);
      return true;
    }
    // Options/popup -> update settings (consent toggle)
    case "update_settings": {
      const newSettings = msg.settings || {};
      settings = Object.assign({}, settings, newSettings);
      persistSettings();
      sendResponse({ ok: true, settings });
      return true;
    }
    // Debug: clear persisted state
    case "debug_clear_state": {
      persistedHints = {};
      hintCache = {};
      chrome.storage.local.remove([STORAGE_KEYS.HINTS_MAP, STORAGE_KEYS.HINT_CACHE]);
      sendResponse({ ok: true });
      return true;
    }
  }
});

// ========== HINT REQUEST FLOW ==========
function handleRequestHint(tabId, sendResponse) {
  if (!tabId) {
    sendResponse({ ok: false, error: "no_tab" });
    return;
  }
  const s = ensureTab(tabId);

  chrome.tabs.sendMessage(tabId, { type: "collect_context" }, async (context) => {
    if (chrome.runtime.lastError || !context) {
      warn("collect_context failed", chrome.runtime.lastError);
      sendResponse({ ok: false, error: "no_context" });
      return;
    }

    const problemId = context.problemId || context.url || "unknown";
    const currentCount = persistedHints[problemId] || 0;

    // If hint cap reached -> ask popup to prompt for code
    if (currentCount >= HINT_LIMIT) {
      sendResponse({ ok: true, action: "ask_for_code" });
      return;
    }

    // increment persisted hints
    persistedHints[problemId] = currentCount + 1;
    persistHints();

    // Fetch hint (may send code if user consented)
    try {
      const hintText = await getHint(problemId, context.snippet || "", context.failure || "");
      chrome.tabs.sendMessage(tabId, { type: "show_hint_in_page", payload: { hintText } });
      sendResponse({ ok: true, action: "show_hint", hint: hintText });
    } catch (e) {
      warn("getHint failed", e);
      const fallback = "Hint: Check boundary conditions and input sizes.";
      chrome.tabs.sendMessage(tabId, { type: "show_hint_in_page", payload: { hintText: fallback } });
      sendResponse({ ok: true, action: "show_hint", hint: fallback });
    }
  });
}

// Show 2-3 line snippet locally (no server)
function handleRequestCodeSnippet(tabId, sendResponse) {
  if (!tabId) {
    sendResponse({ ok: false, error: "no_tab" });
    return;
  }
  chrome.tabs.sendMessage(tabId, { type: "collect_context" }, (context) => {
    if (chrome.runtime.lastError || !context) {
      sendResponse({ ok: false, error: "no_context" });
      return;
    }
    const full = context.snippet || "";
    const lines = full.split(/\r?\n/).filter(l => l.trim() !== "");
    const excerpt = lines.slice(0, 3).join("\n") || "// Unable to extract small code snippet.";
    chrome.tabs.sendMessage(tabId, { type: "show_hint_in_page", payload: { hintText: excerpt } });
    sendResponse({ ok: true, codeSnippet: excerpt });
  });
}

// ========== HINT FETCHING (consent-aware) ==========
async function getHint(problemId, snippet, failureInfo) {
  const now = Date.now();

  // cached?
  const cached = hintCache[problemId];
  if (cached && (now - cached.ts <= HINT_CACHE_TTL_MS)) {
    log(`returning cached hint for ${problemId}`);
    return cached.hint;
  }

  // rate-limit
  const lastCall = recentServerCalls[problemId] || 0;
  if (now - lastCall < MIN_TIME_BETWEEN_SERVER_CALLS_MS) {
    if (cached) return cached.hint;
    return "Hint: consider edge cases and algorithmic complexity (throttled).";
  }
  recentServerCalls[problemId] = now;

  // determine payload snippet: only send code if user consented
  const payloadSnippet = settings.allowSendCodeToServer ? snippet.slice(0, 2000) : "";

  const payload = { problemId, snippet: payloadSnippet, failureInfo };

  try {
    // timeout guard
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    const resp = await fetch(HINT_SERVER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    clearTimeout(timeout);

    if (!resp.ok) throw new Error(`hint server error ${resp.status}`);
    const json = await resp.json();
    if (json && json.hint) {
      hintCache[problemId] = { hint: json.hint, ts: Date.now() };
      persistHintCache();
      return json.hint;
    }
    throw new Error("invalid hint response");
  } catch (e) {
    warn("fetch hint error", e);
    // fallback
    return generateTemplateHint(problemId, snippet, failureInfo);
  }
}

function generateTemplateHint(problemId, snippet, failureInfo) {
  if (failureInfo && /time limit/i.test(failureInfo)) {
    return "Hint: your approach may be too slow—consider improving time complexity.";
  }
  if (failureInfo && /runtime error/i.test(failureInfo)) {
    return "Hint: check index/access and null values; validate assumptions.";
  }
  if (snippet && /recurs|dfs|bfs/i.test(snippet)) {
    return "Hint: verify base case and recursion limits.";
  }
  return "Hint: test small and edge-case inputs; verify indices and boundaries.";
}

// persist on suspend (best-effort)
chrome.runtime.onSuspend && chrome.runtime.onSuspend.addListener(() => {
  persistHints();
  persistHintCache();
  persistSettings();
});
