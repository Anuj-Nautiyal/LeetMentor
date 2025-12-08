
(() => {
  console.log('[LeetMentor] content script starting (robust)');

  // inject styles (styles.css must exist in extension root and be in manifest web_accessible_resources)
  (function injectStyles() {
    if (document.getElementById('leetmentor-styles')) return;
    const link = document.createElement('link');
    link.id = 'leetmentor-styles';
    link.rel = 'stylesheet';
    link.href = chrome.runtime.getURL('styles.css');
    document.head && document.head.appendChild(link);
  })();

  // Globals
  let latestSnippet = '';
  let lastFailureMessage = '';
  let editorAttached = false;
  let attachedFrame = null; // if we attach inside an iframe
  let mutationObservers = [];

  const SNIPPET_LIMIT = 3000;

  // Helper: send editor_input with time + snippet
  function sendEditorInput(snippet) {
    const payloadSnippet = (snippet || '').slice(0, SNIPPET_LIMIT);
    latestSnippet = payloadSnippet;
    try {
      chrome.runtime.sendMessage({
        type: 'editor_input',
        payload: { snippet: payloadSnippet, time: Date.now() }
      });
    } catch (e) {
      // ignore
    }
  }

  // Debounce helper
  function debounce(fn, ms = 250) {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
  }

  // Attempt many selectors inside a root (document or iframe document)
  function tryAttachToRoot(rootDoc) {
    if (!rootDoc) return false;
    // Monaco: .view-line contains per-line spans; container .monaco-editor
    const selectors = [
      '.view-line',          // Monaco content lines (we read textContent)
      '.monaco-editor',      // Monaco container
      '.CodeMirror',         // CodeMirror
      '.ace_editor',         // ACE editor
      'textarea',            // plain textarea
      '[contenteditable="true"]' // contenteditable fallback
    ];

    for (const s of selectors) {
      const node = rootDoc.querySelector(s);
      if (node) {
        attachToNode(rootDoc, s, node);
        return true;
      }
    }
    return false;
  }

  // Attach to node: set up listeners appropriate to node type
  function attachToNode(rootDoc, selector, node) {
    if (editorAttached) return;
    console.log('[LeetMentor] Attaching to editor selector', selector, node);

    // Monaco-style: read from .view-line elements
    if (selector === '.view-line' || selector === '.monaco-editor') {
      // observe container for new view-line content
      const viewLines = rootDoc.querySelectorAll('.view-line');
      const collect = () => {
        const lines = Array.from(rootDoc.querySelectorAll('.view-line')).map(l => l.textContent || '');
        const text = lines.join('\n');
        sendEditorInput(text);
      };
      const obs = new MutationObserver(debounce(collect, 200));
      obs.observe(rootDoc.body || node, { subtree: true, childList: true, characterData: true });
      mutationObservers.push(obs);
      // initial collect
      collect();
      editorAttached = true;
      console.log('[LeetMentor] Attached to Monaco-like editor');
      return;
    }

    // CodeMirror
    if (selector === '.CodeMirror') {
      // CodeMirror updates innerText; observe node
      const collect = () => {
        // CodeMirror stores code in .CodeMirror-code lines or innerText
        const codeEl = node.querySelector('.CodeMirror-code') || node;
        const text = codeEl.innerText || node.innerText || '';
        sendEditorInput(text);
      };
      const obs = new MutationObserver(debounce(collect, 200));
      obs.observe(node, { subtree: true, childList: true, characterData: true });
      mutationObservers.push(obs);
      collect();
      editorAttached = true;
      console.log('[LeetMentor] Attached to CodeMirror');
      return;
    }

    // ACE
    if (selector === '.ace_editor') {
      const collect = () => {
        const text = node.innerText || '';
        sendEditorInput(text);
      };
      const obs = new MutationObserver(debounce(collect, 200));
      obs.observe(node, { subtree: true, childList: true, characterData: true });
      mutationObservers.push(obs);
      collect();
      editorAttached = true;
      console.log('[LeetMentor] Attached to ACE editor');
      return;
    }

    // textarea or contenteditable
    if (selector === 'textarea' || selector === '[contenteditable="true"]') {
      // attach input event
      node.addEventListener('input', debounce(() => {
        const text = node.value || node.innerText || node.textContent || '';
        sendEditorInput(text);
      }, 150), { passive: true });
      // initial
      const initial = node.value || node.innerText || node.textContent || '';
      sendEditorInput(initial);
      editorAttached = true;
      console.log('[LeetMentor] Attached to textarea/contenteditable');
      return;
    }

    // fallback: attach keydown on node
    node.addEventListener('keydown', debounce(() => {
      const text = node.innerText || node.value || rootDoc.body.innerText || '';
      sendEditorInput(text);
    }, 200), { passive: true });
    editorAttached = true;
    console.log('[LeetMentor] Attached via generic keydown listener');
  }

  // Try to attach to top-level doc first
  function attemptAttachTopLevel() {
    if (tryAttachToRoot(document)) return true;
    // if not found, check iframes (editor sometimes in iframe)
    const iframes = Array.from(document.querySelectorAll('iframe'));
    for (const f of iframes) {
      try {
        const fd = f.contentDocument || f.contentWindow && f.contentWindow.document;
        if (fd && tryAttachToRoot(fd)) {
          attachedFrame = f;
          console.log('[LeetMentor] Attached to editor inside iframe', f);
          return true;
        }
      } catch (e) {
        // cross-origin iframe -> cannot access
        continue;
      }
    }
    return false;
  }

  // If we can't find editor, fall back to document-level listeners (best-effort)
  function fallbackDocumentListeners() {
    if (editorAttached) return;
    console.log('[LeetMentor] Falling back to document-level keydown/input listeners');
    // input on document
    const onInput = debounce(() => {
      const text = (document.activeElement && (document.activeElement.value || document.activeElement.innerText)) || document.body.innerText || '';
      sendEditorInput(text);
    }, 200);
    document.addEventListener('keydown', onInput, { passive: true });
    document.addEventListener('input', onInput, { passive: true });
  }

  // Retry loop using MutationObserver to pick up dynamic editors
  function startAttachRetry() {
    // try immediately
    if (attemptAttachTopLevel()) return;

    // Observe DOM additions and try again
    const mo = new MutationObserver(debounce(() => {
      if (attemptAttachTopLevel()) {
        mo.disconnect();
      }
    }, 500));
    mo.observe(document.documentElement || document.body, { childList: true, subtree: true });
    mutationObservers.push(mo);

    // After some time, give up and attach fallback listeners
    setTimeout(() => {
      if (!editorAttached) fallbackDocumentListeners();
    }, 8000); // wait 8s before fallback
  }

  startAttachRetry();

  // ========== Run/Submit detection ==========
  // Try common buttons; if not found periodically re-scan
  function bindRunSubmit() {
    const runSelectors = [
      "button[data-cy='run-code-btn']",
      "button[data-cy='submit-code-btn']",
      "button[aria-label='Run Code']",
      "button[aria-label='Submit']",
      "button:contains('Run')",
      "button:contains('Submit')"
    ];
    // Basic approach: find buttons with 'Run' or 'Submit' in innerText
    const buttons = Array.from(document.querySelectorAll('button'));
    buttons.forEach(b => {
      const txt = (b.innerText || '').trim().toLowerCase();
      if (txt.includes('run') || txt.includes('submit')) {
        if (!b.__leetMentorAttached) {
          b.__leetMentorAttached = true;
          b.addEventListener('click', () => {
            try {
              chrome.runtime.sendMessage({ type: 'run_or_submit_clicked', payload: { time: Date.now() }});
            } catch (e) {}
            // small delay then parse result
            setTimeout(parseSubmissionResult, 1500);
          });
        }
      }
    });
    // re-run later in case LeetCode re-renders
    setTimeout(bindRunSubmit, 2000);
  }
  bindRunSubmit();

  // ========== Parse submission results (best-effort) ==========
  function getFailureText() {
    // try common containers for failure messages
    const selectors = [
      '.submission-result', '.result-status', '.status', '.status__text',
      '.error__2FtR', '.error', '.ant-message', '.execution-result'
    ];
    for (const s of selectors) {
      const el = document.querySelector(s);
      if (el && el.innerText && /wrong answer|runtime error|time limit|error/i.test(el.innerText)) {
        return el.innerText.trim();
      }
    }
    // fallback: scan body for keywords
    const body = document.body.innerText || '';
    const idx = body.toLowerCase().indexOf('wrong answer');
    if (idx >= 0) return body.slice(Math.max(0, idx - 200), idx + 400).trim();
    return '';
  }

  function getPassText() {
    const body = document.body.innerText || '';
    if (/\baccepted\b/i.test(body) || /\bpassed\b/i.test(body)) return 'accepted';
    return '';
  }

  function parseSubmissionResult() {
    const fail = getFailureText();
    const pass = getPassText();
    if (fail) {
      lastFailureMessage = fail;
      try {
        chrome.runtime.sendMessage({ type: 'submission_result', payload: { status: 'fail', raw: fail, time: Date.now() }});
      } catch (e) {}
    } else if (pass) {
      try {
        chrome.runtime.sendMessage({ type: 'submission_result', payload: { status: 'pass', raw: pass, time: Date.now() }});
      } catch (e) {}
    } else {
      // no clear result
    }
  }

  // run periodically to catch dynamic updates
  setInterval(parseSubmissionResult, 2500);

  // ========== Background message handler ==========
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.type) return;

    if (msg.type === 'collect_context') {
      const problemId = location.pathname.replace(/\/+$/, '');
      sendResponse({
        problemId,
        snippet: latestSnippet ? latestSnippet.slice(0, 2000) : '',
        url: location.href,
        failure: lastFailureMessage || ''
      });
      return; // synchronous reply
    }

    if (msg.type === 'show_hint_in_page') {
      // accept multiple payload shapes
      const hintText =
        (msg.payload && (msg.payload.hintText || msg.payload.hint)) ||
        msg.hint ||
        '';
      showHintBubble(hintText);
      // no async response required
      return;
    }
  });

  // ========== In-page hint UI (plain CSS dependent) ==========
  function showHintBubble(hintText) {
    try {
      const old = document.getElementById('leetmentor-hint-bubble');
      if (old) old.remove();

      const bubble = document.createElement('div');
      bubble.id = 'leetmentor-hint-bubble';
      bubble.className = 'lm-hint-bubble';

      const closeBtn = document.createElement('button');
      closeBtn.className = 'lm-hint-close';
      closeBtn.textContent = '✕';
      closeBtn.onclick = () => bubble.remove();

      const content = document.createElement('div');
      content.className = 'lm-hint-text';
      content.textContent = hintText;

      bubble.appendChild(closeBtn);
      bubble.appendChild(content);
      document.body.appendChild(bubble);
    } catch (e) {
      console.warn('[LeetMentor] showHintBubble error', e);
    }
  }

  // Debug helpers available in page context for quick testing
  window.__leetMentorDebug = {
    getContext: () => ({ snippet: latestSnippet, failure: lastFailureMessage }),
    simulateFail: (msg = 'Wrong Answer on test 3') => {
      lastFailureMessage = msg;
      chrome.runtime.sendMessage({ type: 'submission_result', payload: { status: 'fail', raw: msg, time: Date.now() }});
    },
    simulateHint: (text = 'Test hint') => showHintBubble(text),
  };

  console.log('[LeetMentor] content script ready (robust). Debug API: window.__leetMentorDebug');
})();
