// Responsibilities:
//  - Track tab editor activity and submission results
//  - Detect "stuck" (1 fail OR 3 minutes idle) aggressively
//  - Handle popup messages: request_hint, request_code_snippet, reset_hints
//  - Maintain per-problem hint counters (max 3 hints)
//  - Optionally send code to server if user allows (sendCodeToServer)
//  - Persist hint counts and settings in chrome.storage.local

// extension/background.js — server-first background service worker

const LOG_PREFIX = '[LeetMentor:BG]';
function LOG(...args) { console.log(LOG_PREFIX, ...args); }

const hintsGivenMap = new Map(); // tabId -> number (hints shown)
const DEFAULT_SERVER = 'http://localhost:3000/hint';

// Minimal local fallback (tiny, intentionally limited)
function localFallbackHint(problemId = '', failure = '', level = 1) {
  if (level === 1) return 'Think about the high-level pattern (array vs. map vs. two-pointers).';
  if (level === 2) return 'Consider an algorithmic pattern (hash map for complements or two pointers after sort).';
  return 'Try recording seen values (map) and checking complements in a single pass.';
}

function localFallbackSnippet(snippetRaw = '') {
  if (!snippetRaw) return '';
  const lines = snippetRaw.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  return (lines.length <= 3 ? lines : lines.slice(0,3)).join('\n');
}

// POST helper with timeout
async function postToServer(serverUrl, payload, timeoutMs = 8000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(serverUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    clearTimeout(id);
    if (!resp.ok) {
      const txt = await resp.text().catch(() => '');
      throw new Error(`server_http_${resp.status}: ${txt}`);
    }
    return await resp.json();
  } catch (err) {
    clearTimeout(id);
    throw err;
  }
}

// read settings
function loadSettings() {
  return new Promise(res => {
    chrome.storage.local.get(['leetmentor_settings'], data => {
      const s = (data && data.leetmentor_settings) || {};
      s.allowSendCodeToServer = !!s.allowSendCodeToServer;
      s.serverUrl = s.serverUrl || DEFAULT_SERVER;
      res(s);
    });
  });
}

// content collection with injection fallback
function collectContextWithRetry(tabId, timeoutMs = 700) {
  return new Promise(res => {
    try {
      chrome.tabs.sendMessage(tabId, { type: 'collect_context' }, async (resp) => {
        if (resp) return res(resp);

        LOG('collect_context: no response, injecting content-script and retrying for tab', tabId);
        chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['content-script.js'] }, (results) => {
          if (chrome.runtime.lastError) {
            LOG('collect_context: executeScript error:', chrome.runtime.lastError.message);
          } else {
            LOG('collect_context: injected into', (results && results.length) || 0, 'frames for tab', tabId);
          }
          setTimeout(() => {
            try {
              chrome.tabs.sendMessage(tabId, { type: 'collect_context' }, resp2 => {
                if (resp2) return res(resp2);
                LOG('collect_context: retry failed (no response) for tab', tabId);
                res(null);
              });
            } catch (e) {
              LOG('collect_context: retry sendMessage threw', e && e.message ? e.message : e);
              res(null);
            }
          }, timeoutMs);
        });
      });
    } catch (e) {
      LOG('collectContextWithRetry unexpected error', e && e.message ? e.message : e);
      res(null);
    }
  });
}

// message handling
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;
  LOG('onMessage received:', msg.type, 'from', sender && sender.tab && sender.tab.id);

if (msg.type === 'request_hint') {
  (async () => {
    const tabId = msg.tabId || (sender && sender.tab && sender.tab.id);
    if (!tabId) {
      const tabs = await new Promise(r => chrome.tabs.query({ active: true, currentWindow: true }, r));
      if (!tabs || !tabs[0]) {
        sendResponse({ ok: false, error: 'no_tab' });
        return;
      }
      msg.tabId = tabs[0].id;
    }
    const targetTabId = msg.tabId;

    const ctx = await collectContextWithRetry(targetTabId);
    if (!ctx) {
      LOG('request_hint: no context for tab', targetTabId);
      sendResponse({ ok: false, error: 'no_context' });
      return;
    }

    const prev = hintsGivenMap.get(targetTabId) || 0;
    const newCount = prev + 1;             // number of hints *after* this one
    const hintLevel = Math.min(newCount, 3);

    const settings = await loadSettings();

    // helper to send hint to page and popup
    const deliverHint = (rawHintText, usedServer = false) => {
      const askForCode = newCount > 3;

      // For the popup:
      //   - when askForCode is true, we want resp.hint to be empty
      //     so popup.js shows "Reached Maximum hint limit."
      const hintForPopup = askForCode ? '' : (rawHintText || '');

      // For the in-page bubble:
      //   - when askForCode is true, we show the "Reached Maximum hint limit." text directly
      const hintForPage = askForCode
        ? 'Reached Maximum hint limit.'
        : (rawHintText || '');

      // send to content script (in-page bubble)
      chrome.tabs.sendMessage(targetTabId, {
        type: 'show_hint_in_page',
        payload: { hintText: hintForPage, level: hintLevel, askForCode }
      }, () => {
        if (chrome.runtime.lastError) {
          LOG('deliverHint: sendMessage error', chrome.runtime.lastError.message);
        }
      });

      // increment in-memory counter now that the hint was delivered
      hintsGivenMap.set(targetTabId, newCount);

      // respond to popup so it can render
      const resp = { ok: true, hint: hintForPopup };
      if (askForCode) resp.action = 'ask_for_code';
      return resp;
    };

    if (settings.allowSendCodeToServer) {
      try {
        const payload = {
          problemId: ctx.problemId,
          snippet: ctx.snippet,
          url: ctx.url,
          failure: ctx.failure,
          hintLevel
        };
        LOG('request_hint: calling server', settings.serverUrl, 'payload hintLevel=', hintLevel);
        const serverResp = await postToServer(settings.serverUrl, payload, 9000);
        LOG('request_hint: server reply', serverResp);

        const rawHint = (serverResp && (serverResp.hint || serverResp.snippet)) || '';
        const responseToPopup = deliverHint(rawHint, true);
        sendResponse(responseToPopup);
        return;
      } catch (err) {
        LOG('request_hint: server call failed, falling back to local', err && err.message ? err.message : err);
        // fall through to local fallback
      }
    }

    // fallback: small local hint
    const localHint = localFallbackHint(ctx.problemId, ctx.failure, hintLevel);
    const responseToPopup = deliverHint(localHint, false);
    sendResponse(responseToPopup);
  })();
  return true;
}



  if (msg.type === 'request_code_snippet') {
    (async () => {
      const tabId = msg.tabId || (sender && sender.tab && sender.tab.id);
      if (!tabId) {
        sendResponse({ ok: false, error: 'no_tab' });
        return;
      }
      const ctx = await collectContextWithRetry(tabId);
      if (!ctx) {
        sendResponse({ ok: false, error: 'no_context' });
        return;
      }

      const prev = hintsGivenMap.get(tabId) || 0;
      const hintLevel = Math.min(prev + 1, 3);

      const settings = await loadSettings();
      if (settings.allowSendCodeToServer) {
        try {
          const payload = { problemId: ctx.problemId, snippet: ctx.snippet, url: ctx.url, failure: ctx.failure, request: 'snippet', hintLevel };
          const serverResp = await postToServer(settings.serverUrl, payload, 9000);
          const snippetText = serverResp.snippet || '';
          sendResponse({ ok: true, snippet: snippetText });
          return;
        } catch (err) {
          LOG('request_code_snippet: server call failed', err && err.message ? err.message : err);
        }
      }

      // fallback: local snippet
      const localSnippet = localFallbackSnippet(ctx.snippet || '');
      sendResponse({ ok: true, snippet: localSnippet });
    })();
    return true;
  }

  if (msg.type === 'hide_hint_in_page') {
    const tabId = msg.tabId || (sender && sender.tab && sender.tab.id);
    if (tabId) {
      chrome.tabs.sendMessage(tabId, { type: 'hide_hint_in_page' }, resp => {
        if (chrome.runtime.lastError) {
          LOG('hide_hint_in_page: no content script in tab', chrome.runtime.lastError.message);
          sendResponse && sendResponse({ ok: false, error: 'no_content_script' });
        } else {
          sendResponse && sendResponse({ ok: true });
        }
      });
      return true;
    } else {
      sendResponse && sendResponse({ ok: false, error: 'no_tab' });
      return;
    }
  }

  if (msg.type === 'reset_hints') {
    (async () => {
      try {
        chrome.storage.local.remove(['leetmentor_hints_map', 'leetmentor_hint_cache'], () => {
          LOG('persisted hints and settings removed from storage');
        });
        hintsGivenMap.clear();
        sendResponse && sendResponse({ ok: true });
      } catch (e) {
        LOG('reset_hints error', e && e.message ? e.message : e);
        sendResponse && sendResponse({ ok: false, error: String(e) });
      }
    })();
    return true;
  }

  if (msg.type === 'ping_for_leetmentor') {
    sendResponse({ ok: true, version: 'bg-1.0' });
    return;
  }

  return;
});

// initialization
LOG('background initialized');
