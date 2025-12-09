// // Responsibilities:
// //  - Track per-tab activity (edits, failures) and detect "stuck" (1 fail OR idle)
// //  - Persist per-problem hint counts so limits survive service worker restarts
// //  - Respond to popup hint requests, call backend to generate hints (with cache + rate limiting)
// //  - Respect user privacy setting: allowSendCodeToServer (default: false)
// //  - Provide robust error handling & fallback hints

// // ========== CONFIG ==========
// const IDLE_MS = 3 * 60 * 1000;
// const FAILURE_WINDOW_MS = 10 * 60 * 1000;
// const HINT_LIMIT = 3;
// const HINT_CACHE_TTL_MS = 5 * 60 * 1000;
// const MIN_TIME_BETWEEN_SERVER_CALLS_MS = 30 * 1000;
// const HINT_SERVER_URL = "http://localhost:3000/api/generate-hint"; // change to production URL

// // Storage keys
// const STORAGE_KEYS = {
//   HINTS_MAP: "leetmentor_hints_map",
//   HINT_CACHE: "leetmentor_hint_cache",
//   SETTINGS: "leetmentor_settings"
// };

// // ========== IN-MEM STATE ==========
// const tabState = {};
// let persistedHints = {};
// let hintCache = {};
// const recentServerCalls = {};
// let settings = { allowSendCodeToServer: false }; // default: false

// function log(...a) { console.log("[LeetMentor]", ...a); }
// function warn(...a) { console.warn("[LeetMentor]", ...a); }

// function ensureTab(tabId) {
//   if (!tabState[tabId]) {
//     tabState[tabId] = { lastInputTs: 0, failures: [], isStuck: false };
//   }
//   return tabState[tabId];
// }

// // ========== PERSISTENCE HELPERS ==========
// function persistHints() {
//   chrome.storage.local.set({ [STORAGE_KEYS.HINTS_MAP]: persistedHints });
// }
// function persistHintCache() {
//   chrome.storage.local.set({ [STORAGE_KEYS.HINT_CACHE]: hintCache });
// }
// function persistSettings() {
//   chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: settings });
// }

// async function loadPersistedState() {
//   return new Promise((resolve) => {
//     chrome.storage.local.get([STORAGE_KEYS.HINTS_MAP, STORAGE_KEYS.HINT_CACHE, STORAGE_KEYS.SETTINGS], (data) => {
//       if (chrome.runtime.lastError) warn("loadPersistedState error", chrome.runtime.lastError);
//       persistedHints = data[STORAGE_KEYS.HINTS_MAP] || {};
//       hintCache = data[STORAGE_KEYS.HINT_CACHE] || {};
//       settings = data[STORAGE_KEYS.SETTINGS] || { allowSendCodeToServer: false };
//       log("rehydrated state:", { hints: Object.keys(persistedHints).length, cache: Object.keys(hintCache).length, settings });
//       resolve();
//     });
//   });
// }

// // load at worker start
// loadPersistedState().catch(e => warn("initial load failed", e));

// // ========== ALARMS FOR IDLE DETECTION ==========
// chrome.alarms.create("idle_check", { periodInMinutes: 1 });
// chrome.alarms.onAlarm.addListener((alarm) => {
//   if (!alarm || alarm.name !== "idle_check") return;
//   performIdleCheck();
// });

// function performIdleCheck() {
//   const now = Date.now();
//   chrome.tabs.query({}, (tabs) => {
//     tabs.forEach(t => {
//       const id = t.id;
//       if (!id) return;
//       const s = ensureTab(id);
//       if (s.lastInputTs && (now - s.lastInputTs >= IDLE_MS) && !s.isStuck) {
//         s.isStuck = true;
//         log(`tab ${id} marked stuck by idle`);
//       }
//     });
//   });
// }

// // ========== MESSAGE HANDLER ==========
// chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
//   if (!msg || !msg.type) return;
//   const tabId = sender && sender.tab && sender.tab.id;

//   switch (msg.type) {
//     case "editor_input": {
//       if (!tabId) break;
//       const s = ensureTab(tabId);
//       s.lastInputTs = msg.payload?.time || Date.now();
//       break;
//     }
//     case "run_or_submit_clicked": {
//       if (!tabId) break;
//       const s = ensureTab(tabId);
//       s.lastInputTs = msg.payload?.time || Date.now();
//       break;
//     }
//     case "submission_result": {
//       if (!tabId) break;
//       const s = ensureTab(tabId);
//       if (msg.payload?.status === "fail") {
//         const now = Date.now();
//         s.failures.push(now);
//         s.failures = s.failures.filter(t => now - t <= FAILURE_WINDOW_MS);
//         if (s.failures.length >= 1) {
//           s.isStuck = true;
//           log(`tab ${tabId} marked stuck by failure`);
//         }
//       } else if (msg.payload?.status === "pass") {
//         s.failures = [];
//         s.isStuck = false;
//       }
//       break;
//     }
//     // Popup -> request a hint for active tab
//     case "request_hint": {
//       const reqTab = msg.tabId;
//       handleRequestHint(reqTab, sendResponse);
//       return true;
//     }
//     // Popup -> request code excerpt (local only)
//     case "request_code_snippet": {
//       handleRequestCodeSnippet(msg.tabId, sendResponse);
//       return true;
//     }
//     // Options/popup -> update settings (consent toggle)
//     case "update_settings": {
//       const newSettings = msg.settings || {};
//       settings = Object.assign({}, settings, newSettings);
//       persistSettings();
//       sendResponse({ ok: true, settings });
//       return true;
//     }
//     // Debug: clear persisted state
//     case "debug_clear_state": {
//       persistedHints = {};
//       hintCache = {};
//       chrome.storage.local.remove([STORAGE_KEYS.HINTS_MAP, STORAGE_KEYS.HINT_CACHE]);
//       sendResponse({ ok: true });
//       return true;
//     }
//   }
// });

// // ========== HINT REQUEST FLOW ==========
// function handleRequestHint(tabId, sendResponse) {
//   if (!tabId) {
//     sendResponse({ ok: false, error: "no_tab" });
//     return;
//   }
//   const s = ensureTab(tabId);

//   chrome.tabs.sendMessage(tabId, { type: "collect_context" }, async (context) => {
//     if (chrome.runtime.lastError || !context) {
//       warn("collect_context failed", chrome.runtime.lastError);
//       sendResponse({ ok: false, error: "no_context" });
//       return;
//     }

//     const problemId = context.problemId || context.url || "unknown";
//     const currentCount = persistedHints[problemId] || 0;

//     // If hint cap reached -> ask popup to prompt for code
//     if (currentCount >= HINT_LIMIT) {
//       sendResponse({ ok: true, action: "ask_for_code" });
//       return;
//     }

//     // increment persisted hints
//     persistedHints[problemId] = currentCount + 1;
//     persistHints();

//     // Fetch hint (may send code if user consented)
//     try {
//       const hintText = await getHint(problemId, context.snippet || "", context.failure || "");
//       chrome.tabs.sendMessage(tabId, { type: "show_hint_in_page", payload: { hintText } });
//       sendResponse({ ok: true, action: "show_hint", hint: hintText });
//     } catch (e) {
//       warn("getHint failed", e);
//       const fallback = "Hint: Check boundary conditions and input sizes.";
//       chrome.tabs.sendMessage(tabId, { type: "show_hint_in_page", payload: { hintText: fallback } });
//       sendResponse({ ok: true, action: "show_hint", hint: fallback });
//     }
//   });
// }

// // Show 2-3 line snippet locally (no server)
// function handleRequestCodeSnippet(tabId, sendResponse) {
//   if (!tabId) {
//     sendResponse({ ok: false, error: "no_tab" });
//     return;
//   }
//   chrome.tabs.sendMessage(tabId, { type: "collect_context" }, (context) => {
//     if (chrome.runtime.lastError || !context) {
//       sendResponse({ ok: false, error: "no_context" });
//       return;
//     }
//     const full = context.snippet || "";
//     const lines = full.split(/\r?\n/).filter(l => l.trim() !== "");
//     const excerpt = lines.slice(0, 3).join("\n") || "// Unable to extract small code snippet.";
//     chrome.tabs.sendMessage(tabId, { type: "show_hint_in_page", payload: { hintText: excerpt } });
//     sendResponse({ ok: true, codeSnippet: excerpt });
//   });
// }

// // ========== HINT FETCHING (consent-aware) ==========
// async function getHint(problemId, snippet, failureInfo) {
//   const now = Date.now();

//   // cached?
//   const cached = hintCache[problemId];
//   if (cached && (now - cached.ts <= HINT_CACHE_TTL_MS)) {
//     log(`returning cached hint for ${problemId}`);
//     return cached.hint;
//   }

//   // rate-limit
//   const lastCall = recentServerCalls[problemId] || 0;
//   if (now - lastCall < MIN_TIME_BETWEEN_SERVER_CALLS_MS) {
//     if (cached) return cached.hint;
//     return "Hint: consider edge cases and algorithmic complexity (throttled).";
//   }
//   recentServerCalls[problemId] = now;

//   // determine payload snippet: only send code if user consented
//   const payloadSnippet = settings.allowSendCodeToServer ? snippet.slice(0, 2000) : "";

//   const payload = { problemId, snippet: payloadSnippet, failureInfo };

//   try {
//     // timeout guard
//     const controller = new AbortController();
//     const timeout = setTimeout(() => controller.abort(), 10_000);
//     const resp = await fetch(HINT_SERVER_URL, {
//       method: "POST",
//       headers: { "Content-Type": "application/json" },
//       body: JSON.stringify(payload),
//       signal: controller.signal
//     });
//     clearTimeout(timeout);

//     if (!resp.ok) throw new Error(`hint server error ${resp.status}`);
//     const json = await resp.json();
//     if (json && json.hint) {
//       hintCache[problemId] = { hint: json.hint, ts: Date.now() };
//       persistHintCache();
//       return json.hint;
//     }
//     throw new Error("invalid hint response");
//   } catch (e) {
//     warn("fetch hint error", e);
//     // fallback
//     return generateTemplateHint(problemId, snippet, failureInfo);
//   }
// }

// function generateTemplateHint(problemId, snippet, failureInfo) {
//   if (failureInfo && /time limit/i.test(failureInfo)) {
//     return "Hint: your approach may be too slow—consider improving time complexity.";
//   }
//   if (failureInfo && /runtime error/i.test(failureInfo)) {
//     return "Hint: check index/access and null values; validate assumptions.";
//   }
//   if (snippet && /recurs|dfs|bfs/i.test(snippet)) {
//     return "Hint: verify base case and recursion limits.";
//   }
//   return "Hint: test small and edge-case inputs; verify indices and boundaries.";
// }

// // persist on suspend (best-effort)
// chrome.runtime.onSuspend && chrome.runtime.onSuspend.addListener(() => {
//   persistHints();
//   persistHintCache();
//   persistSettings();
// });
// background.js — LeetMentor production-ready background service worker
// Responsibilities:
//  - Track tab editor activity and submission results
//  - Detect "stuck" (1 fail OR 3 minutes idle) aggressively
//  - Handle popup messages: request_hint, request_code_snippet, reset_hints
//  - Maintain per-problem hint counters (max 3 hints)
//  - Optionally send code to server if user allows (sendCodeToServer)
//  - Persist hint counts and settings in chrome.storage.local

const LOG = (...args) => {
  try { console.log('[LeetMentor:BG]', ...args); } catch(e) {}
};

// ---------- Configuration ----------
const IDLE_MS = 3 * 60 * 1000; // 3 minutes
const MAX_HINTS_PER_PROBLEM = 3;
const HINT_CACHE_TTL_MS = 1000 * 60 * 60 * 24; // 24h (for locally cached hints, if any)

// Default settings (can be changed via options UI)
const DEFAULT_SETTINGS = {
  allowSendCodeToServer: false,
  serverUrl: 'http://localhost:3000/hint' // default dev stub; only used if allowSendCodeToServer is true
};

// ---------- In-memory state ----------
/*
tabState = {
  [tabId]: {
    lastInputTs: number,
    lastSubmitTs: number,
    stuck: boolean,
    failureReason: string|null,
    hintRequestTs: number|null
  }
}
*/
const tabState = {};

// hint counts and cache persisted to storage.local
// storage keys: 'leetmentor_hints_map' (object problemId -> count), 'leetmentor_hint_cache' (optional)
async function storageGet(keys) {
  return new Promise(res => chrome.storage.local.get(keys, r => res(r)));
}
async function storageSet(obj) {
  return new Promise(res => chrome.storage.local.set(obj, () => res()));
}
async function storageRemove(keys) {
  return new Promise(res => chrome.storage.local.remove(keys, () => res()));
}

// ---------- Utility helpers ----------
function now() { return Date.now(); }

async function ensureSettings() {
  const s = await storageGet(['leetmentor_settings']);
  const settings = s.leetmentor_settings || {};
  // fill defaults
  for (const k of Object.keys(DEFAULT_SETTINGS)) {
    if (settings[k] === undefined) settings[k] = DEFAULT_SETTINGS[k];
  }
  await storageSet({ leetmentor_settings: settings });
  return settings;
}

async function getHintCounts() {
  const s = await storageGet(['leetmentor_hints_map']);
  return s.leetmentor_hints_map || {};
}
async function setHintCounts(map) {
  await storageSet({ leetmentor_hints_map: map });
}
async function resetHintCounts() {
  await storageRemove(['leetmentor_hints_map', 'leetmentor_hint_cache']);
  LOG('persisted hints reset');
}

// Mark a tab stuck (for one of the reasons)
function markTabStuck(tabId, reason) {
  if (!tabState[tabId]) tabState[tabId] = {};
  tabState[tabId].stuck = true;
  tabState[tabId].failureReason = reason || 'stuck';
  LOG('tab', tabId, 'marked stuck by', reason);
}

// Clear stuck state for a tab
function clearTabStuck(tabId) {
  if (!tabState[tabId]) return;
  tabState[tabId].stuck = false;
  tabState[tabId].failureReason = null;
  LOG('tab', tabId, 'cleared stuck state');
}

// Check idle across tabs periodically
function checkIdleLoop() {
  const nowTs = now();
  for (const tabIdStr of Object.keys(tabState)) {
    const tabId = Number(tabIdStr);
    const s = tabState[tabId];
    if (!s) continue;
    const lastInput = s.lastInputTs || 0;
    const lastSubmit = s.lastSubmitTs || 0;
    const lastActivity = Math.max(lastInput, lastSubmit);
    if (!s.stuck && lastActivity > 0 && (nowTs - lastActivity) >= IDLE_MS) {
      markTabStuck(tabId, 'idle');
    }
  }
}
// interval for idle checking
setInterval(checkIdleLoop, 30 * 1000); // check every 30s

// ---------- Hint generation (stub) ----------
/**
 * generateHint(context): produce a hint string
 * You should replace this with an LLM call or sophisticated logic later.
 * Context contains: { problemId, snippet, url, failure }
 */
async function generateHint(context) {
  // simple heuristic stub: if failure mentions "index", hint about bounds; if two-sum, hint about hash
  const p = (context.problemId || '').toLowerCase();
  if (p.includes('two-sum') || (context.url && context.url.toLowerCase().includes('two-sum'))) {
    return 'Hint: Use a hash map to store seen values and check complements in one pass.';
  }
  const fail = (context.failure || '').toLowerCase();
  if (fail.includes('index') || fail.includes('out of range') || fail.includes('indexerror')) {
    return 'Hint: Check your indices and boundary conditions — arrays are 0-indexed.';
  }
  if (fail.includes('time limit') || fail.includes('tle')) {
    return 'Hint: Consider using a more efficient data structure or reduce nested loops (aim for O(n) or O(n log n)).';
  }
  // fallback generic hint
  return 'Hint: Break the problem into smaller subproblems. Write down examples and consider data structures that give O(1) lookups.';
}

// ---------- Server posting (optional) ----------
/**
 * sendCodeToServer(context)
 * - context: { problemId, snippet, url, failure }
 * - respects user setting allowSendCodeToServer and serverUrl
 * - returns server response or throws
 */
async function sendCodeToServer(context) {
  const settings = await ensureSettings();
  if (!settings.allowSendCodeToServer) {
    throw new Error('send_disabled');
  }
  if (!settings.serverUrl) {
    throw new Error('no_server_url');
  }
  try {
    const resp = await fetch(settings.serverUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(context),
    });
    if (!resp.ok) throw new Error('server_error_' + resp.status);
    const data = await resp.json();
    return data; // expecting { hint: '...', snippet: '...' } or similar
  } catch (err) {
    LOG('sendCodeToServer error', err);
    throw err;
  }
}

// ---------- Message handling ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  try {
    LOG('onMessage received:', msg && msg.type, 'from tab', sender && sender.tab && sender.tab.id);
  } catch (e) {}

  if (!msg || !msg.type) {
    // nothing to do
    return;
  }

  // --- Simple pings / debug
  if (msg.type === 'ping_from_page') {
    sendResponse({ ok: true, ts: now() });
    return;
  }

  // --- Editor input updates (content script)
  if (msg.type === 'editor_input') {
    const tabId = sender && sender.tab && sender.tab.id;
    const ts = (msg.payload && msg.payload.time) || now();
    if (tabId) {
      if (!tabState[tabId]) tabState[tabId] = {};
      tabState[tabId].lastInputTs = ts;
      // if previously stuck due to idle, clear stuck on new input
      if (tabState[tabId].stuck && tabState[tabId].failureReason === 'idle') {
        clearTabStuck(tabId);
      }
    }
    return;
  }

  // --- Run or submit clicked (content script)
  if (msg.type === 'run_or_submit_clicked') {
    const tabId = sender && sender.tab && sender.tab.id;
    const ts = (msg.payload && msg.payload.time) || now();
    if (tabId) {
      if (!tabState[tabId]) tabState[tabId] = {};
      tabState[tabId].lastSubmitTs = ts;
    }
    return;
  }

  // --- Submission result (content script)
  if (msg.type === 'submission_result') {
    const tabId = sender && sender.tab && sender.tab.id;
    const payload = msg.payload || {};
    if (tabId) {
      // if fail -> immediately mark stuck (aggressive)
      if (payload.status === 'fail') {
        tabState[tabId] = tabState[tabId] || {};
        tabState[tabId].stuck = true;
        tabState[tabId].failureReason = payload.raw || 'failure';
        tabState[tabId].lastSubmitTs = (payload.time || now());
        LOG('tab', tabId, 'marked stuck by failure:', payload.raw || '');
      } else if (payload.status === 'pass') {
        // On pass, clear stuck state for that tab
        clearTabStuck(tabId);
        LOG('tab', tabId, 'submission passed -> cleared stuck');
      }
    }
    return;
  }

  // --- Collect context (background asks content script)
  if (msg.type === 'collect_context') {
    // This message is expected to be handled by content scripts - background doesn't run this branch
    sendResponse({ ok: false, error: 'not_background' });
    return;
  }

  // --- Reset hints (dev)
  if (msg.type === 'reset_hints') {
    (async () => {
      await resetHintCounts();
      sendResponse && sendResponse({ ok: true });
    })();
    return true;
  }

  // --- request_hint (from popup or content script)
  if (msg.type === 'request_hint') {
    // We'll respond async
    (async () => {
      try {
        // find tabId: prefer provided tabId, then sender.tab, then active tab
        let tabId = msg.tabId || (sender && sender.tab && sender.tab.id);
        if (!tabId) {
          const tabs = await new Promise(res => chrome.tabs.query({ active: true, currentWindow: true }, res));
          tabId = tabs && tabs[0] && tabs[0].id;
        }
        if (!tabId) {
          LOG('request_hint failed: no tab');
          sendResponse && sendResponse({ ok: false, error: 'no_tab' });
          return;
        }

        // get context from content script
        const ctx = await new Promise(res => {
          chrome.tabs.sendMessage(tabId, { type: 'collect_context' }, resp => {
            // if runtime.lastError, resp may be undefined
            if (chrome.runtime.lastError) {
              LOG('collect_context err', chrome.runtime.lastError.message);
            }
            res(resp);
          });
        });

        if (!ctx) {
          LOG('request_hint: no context from content script for tab', tabId);
          sendResponse && sendResponse({ ok: false, error: 'no_context' });
          return;
        }

        const problemId = ctx.problemId || ctx.url || 'unknown';
        // load persisted hint counts
        const hintCounts = await getHintCounts();
        const current = Number(hintCounts[problemId] || 0);

        if (current >= MAX_HINTS_PER_PROBLEM) {
          LOG('request_hint: hint cap reached for', problemId);
          // ask for code flow - do not send hint automatically
          sendResponse && sendResponse({ ok: true, action: 'ask_for_code' });
          return;
        }

        // If allowed, attempt to fetch a hint from server (preferred). If failure or not allowed, use generateHint().
        const settings = await ensureSettings();
        let hintText = null;

        if (settings.allowSendCodeToServer) {
          try {
            const srvResp = await sendCodeToServer({ problemId: problemId, snippet: ctx.snippet, url: ctx.url, failure: ctx.failure });
            // server should return { hint: '...' } ideally
            if (srvResp && srvResp.hint) hintText = srvResp.hint;
          } catch (err) {
            LOG('server hint fetch failed, falling back to local generateHint', err && err.message);
            hintText = null;
          }
        }

        if (!hintText) {
          hintText = await generateHint({ problemId: problemId, snippet: ctx.snippet, url: ctx.url, failure: ctx.failure });
        }

        // increment hint counter
        hintCounts[problemId] = current + 1;
        await setHintCounts(hintCounts);

        // send the hint to the page
        chrome.tabs.sendMessage(tabId, { type: 'show_hint_in_page', payload: { hintText } }, resp => {
          if (chrome.runtime.lastError) {
            LOG('send show_hint_in_page failed:', chrome.runtime.lastError.message);
          } else {
            LOG('show_hint_in_page sent to tab', tabId);
          }
        });

        // respond to popup caller; include hint text and ok
        sendResponse && sendResponse({ ok: true, hint: hintText });
      } catch (err) {
        LOG('request_hint error', err);
        sendResponse && sendResponse({ ok: false, error: String(err && err.message ? err.message : err) });
      }
    })();
    return true; // we will call sendResponse asynchronously
  }

  // --- request_code_snippet (popup user consent to show code excerpt)
  if (msg.type === 'request_code_snippet') {
    (async () => {
      try {
        // pick tab
        let tabId = msg.tabId || (sender && sender.tab && sender.tab.id);
        if (!tabId) {
          const tabs = await new Promise(res => chrome.tabs.query({ active: true, currentWindow: true }, res));
          tabId = tabs && tabs[0] && tabs[0].id;
        }
        if (!tabId) {
          LOG('request_code_snippet: no tab');
          sendResponse && sendResponse({ ok: false, error: 'no_tab' });
          return;
        }

        // collect context from content script
        const ctx = await new Promise(res => {
          chrome.tabs.sendMessage(tabId, { type: 'collect_context' }, resp => {
            if (chrome.runtime.lastError) {
              LOG('collect_context err for snippet', chrome.runtime.lastError.message);
            }
            res(resp);
          });
        });

        if (!ctx) {
          sendResponse && sendResponse({ ok: false, error: 'no_context' });
          return;
        }

        // If user allowed server send, try to get a short excerpt or curated snippet from server
        const settings = await ensureSettings();
        if (settings.allowSendCodeToServer) {
          try {
            const srv = await sendCodeToServer({ problemId: ctx.problemId, snippet: ctx.snippet, url: ctx.url, failure: ctx.failure, request: 'snippet' });
            if (srv && srv.snippet) {
              sendResponse && sendResponse({ ok: true, snippet: srv.snippet });
              return;
            }
            // else fallthrough to local excerpt
          } catch (err) {
            LOG('server snippet request failed', err);
          }
        }

        // Create a safe local excerpt: pick first non-empty 2-3 lines from the snippet (limit line length)
        const raw = (ctx.snippet || '').split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
        let excerpt = '';
        if (raw.length === 0) {
          excerpt = '';
        } else if (raw.length <= 3) {
          excerpt = raw.join('\n');
        } else {
          excerpt = raw.slice(0, 3).join('\n');
        }

        // optionally limit line length
        excerpt = excerpt.split('\n').map(l => l.length > 200 ? l.slice(0, 200) + '...' : l).join('\n');

        sendResponse && sendResponse({ ok: true, snippet: excerpt });
      } catch (err) {
        LOG('request_code_snippet error', err);
        sendResponse && sendResponse({ ok: false, error: String(err && err.message ? err.message : err) });
      }
    })();
    return true;
  }

  // --- Fallback: unknown type
  LOG('unknown message type', msg.type);
});

// ---------- Cleanup when tabs removed ----------
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabState[tabId]) delete tabState[tabId];
  LOG('tab removed cleanup', tabId);
});

// ---------- Optional: expose a simple runtime command to get internal state (for debugging) ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === '__leetmentor_debug_state') {
    // don't return actual code/snippets here; only show counters & stuck flags
    (async () => {
      const hintCounts = await getHintCounts();
      sendResponse({ tabState, hintCounts });
    })();
    return true;
  }
});

// ---------- Service worker startup log ----------
LOG('service worker started at', new Date().toISOString());
