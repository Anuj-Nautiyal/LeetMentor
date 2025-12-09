// content-script.js — Robust content script with reliable messaging and debug API
// - Injects styles.css
// - Detects editors (Monaco/CodeMirror/ACE/textarea/contenteditable) with iframe support
// - Sends editor_input with timestamp
// - Handles collect_context and show_hint_in_page (responds and returns true)
// - Exposes window.__leetMentorDebug for testing

(() => {
  const LOG = (...args) => { try { console.log('[LeetMentor]', ...args); } catch(e){} };
  LOG('content script initializing');

  // Inject extension stylesheet (styles.css) into page (web_accessible_resources)
  (function injectStyles() {
    try {
      if (document.getElementById('leetmentor-styles')) return;
      const link = document.createElement('link');
      link.id = 'leetmentor-styles';
      link.rel = 'stylesheet';
      link.href = chrome.runtime.getURL('styles.css');
      (document.head || document.documentElement).appendChild(link);
      LOG('styles injected');
    } catch (e) {
      console.warn('[LeetMentor] injectStyles error', e);
    }
  })();

  // State
  let latestSnippet = '';
  let lastFailureMessage = '';
  let editorAttached = false;
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

  function debounce(fn, ms = 250) {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
  }

  // Attach logic
  function attachToNode(rootDoc, selector, node) {
    if (editorAttached) return;
    LOG('attachToNode', selector);

    try {
      if (selector === '.view-line' || selector === '.monaco-editor') {
        const collect = () => {
          const lines = Array.from(rootDoc.querySelectorAll('.view-line')).map(l => l.textContent || '');
          const text = lines.join('\n');
          sendEditorInput(text);
        };
        const obs = new MutationObserver(debounce(collect, 200));
        obs.observe(rootDoc.body || node, { subtree: true, childList: true, characterData: true });
        mutationObservers.push(obs);
        collect();
        editorAttached = true;
        LOG('Attached to Monaco-like editor');
        return;
      }

      if (selector === '.CodeMirror') {
        const collect = () => {
          const codeEl = node.querySelector('.CodeMirror-code') || node;
          const text = codeEl.innerText || node.innerText || '';
          sendEditorInput(text);
        };
        const obs = new MutationObserver(debounce(collect, 200));
        obs.observe(node, { subtree: true, childList: true, characterData: true });
        mutationObservers.push(obs);
        collect();
        editorAttached = true;
        LOG('Attached to CodeMirror');
        return;
      }

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
        LOG('Attached to ACE editor');
        return;
      }

      if (selector === 'textarea' || selector === '[contenteditable="true"]') {
        node.addEventListener('input', debounce(() => {
          const text = node.value || node.innerText || node.textContent || '';
          sendEditorInput(text);
        }, 150), { passive: true });
        const initial = node.value || node.innerText || node.textContent || '';
        sendEditorInput(initial);
        editorAttached = true;
        LOG('Attached to textarea/contenteditable');
        return;
      }

      // fallback generic
      node.addEventListener('keydown', debounce(() => {
        const text = node.innerText || node.value || rootDoc.body.innerText || '';
        sendEditorInput(text);
      }, 200), { passive: true });
      editorAttached = true;
      LOG('Attached via generic keydown listener');
    } catch (e) {
      console.warn('[LeetMentor] attachToNode error', e);
    }
  }

  function tryAttachToRoot(rootDoc) {
    if (!rootDoc) return false;
    const selectors = [
      '.view-line',
      '.monaco-editor',
      '.CodeMirror',
      '.ace_editor',
      'textarea',
      '[contenteditable="true"]'
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

  function attemptAttachTopLevel() {
    if (tryAttachToRoot(document)) return true;
    const iframes = Array.from(document.querySelectorAll('iframe'));
    for (const f of iframes) {
      try {
        const fd = f.contentDocument || (f.contentWindow && f.contentWindow.document);
        if (fd && tryAttachToRoot(fd)) {
          LOG('Attached to editor inside iframe', f.src || f);
          return true;
        }
      } catch (e) {
        continue;
      }
    }
    return false;
  }

  function fallbackDocumentListeners() {
    if (editorAttached) return;
    LOG('Falling back to document-level keydown/input listeners');
    const onInput = debounce(() => {
      const text = (document.activeElement && (document.activeElement.value || document.activeElement.innerText)) || document.body.innerText || '';
      sendEditorInput(text);
    }, 200);
    document.addEventListener('keydown', onInput, { passive: true });
    document.addEventListener('input', onInput, { passive: true });
  }

  function startAttachRetry() {
    if (attemptAttachTopLevel()) return;
    const mo = new MutationObserver(debounce(() => {
      if (attemptAttachTopLevel()) {
        mo.disconnect();
      }
    }, 500));
    mo.observe(document.documentElement || document.body, { childList: true, subtree: true });
    mutationObservers.push(mo);
    setTimeout(() => {
      if (!editorAttached) fallbackDocumentListeners();
    }, 8000);
  }

  startAttachRetry();

  // Run/Submit detection
  function bindRunSubmit() {
    const buttons = Array.from(document.querySelectorAll('button'));
    buttons.forEach(b => {
      const txt = (b.innerText || '').trim().toLowerCase();
      if (txt.includes('run') || txt.includes('submit')) {
        if (!b.__leetMentorAttached) {
          b.__leetMentorAttached = true;
          b.addEventListener('click', () => {
            try { chrome.runtime.sendMessage({ type: 'run_or_submit_clicked', payload: { time: Date.now() } }); } catch(e){}
            setTimeout(parseSubmissionResult, 1500);
          });
        }
      }
    });
    setTimeout(bindRunSubmit, 2000);
  }
  bindRunSubmit();

  // Parse submission
  function getFailureText() {
    const selectors = ['.submission-result', '.result-status', '.status', '.status__text', '.error__2FtR', '.error', '.ant-message', '.execution-result'];
    for (const s of selectors) {
      const el = document.querySelector(s);
      if (el && el.innerText && /wrong answer|runtime error|time limit|error/i.test(el.innerText)) {
        return el.innerText.trim();
      }
    }
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
      try { chrome.runtime.sendMessage({ type: 'submission_result', payload: { status: 'fail', raw: fail, time: Date.now() } }); } catch(e){}
    } else if (pass) {
      try { chrome.runtime.sendMessage({ type: 'submission_result', payload: { status: 'pass', raw: pass, time: Date.now() } }); } catch(e){}
    }
  }
  setInterval(parseSubmissionResult, 2500);

  // onMessage handler — robust and replies to sender
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    try {
      LOG('onMessage', msg && msg.type, 'from', sender && sender.tab && sender.tab.id);
    } catch(e){}

    if (!msg || !msg.type) return;

    if (msg.type === 'collect_context') {
      const problemId = location.pathname.replace(/\/+$/, '');
      sendResponse({
        problemId,
        snippet: latestSnippet ? latestSnippet.slice(0, 2000) : '',
        url: location.href,
        failure: lastFailureMessage || ''
      });
      return; // synchronous
    }

    if (msg.type === 'show_hint_in_page') {
      const hintText =
        (msg.payload && (msg.payload.hintText || msg.payload.hint)) ||
        msg.hint ||
        '';
      try {
        showHintBubble(hintText);
        sendResponse({ ok: true });
      } catch (e) {
        console.error('[LeetMentor] show_hint_in_page handler error', e);
        sendResponse({ ok: false, error: String(e) });
      }
      return true; // signal async/steady response (we already responded synchronously but keep safe)
    }
  });

  // show hint bubble
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
      LOG('Hint bubble shown');
    } catch (e) {
      console.warn('[LeetMentor] showHintBubble error', e);
    }
  }

  // Debug API (exposed in content-script isolated world)
  window.__leetMentorDebug = {
    getContext: () => ({ snippet: latestSnippet, failure: lastFailureMessage }),
    simulateFail: (msg = 'Wrong Answer on test 3') => {
      lastFailureMessage = msg;
      try { chrome.runtime.sendMessage({ type: 'submission_result', payload: { status: 'fail', raw: msg, time: Date.now() } }); } catch(e){}
    },
    simulateHint: (text = 'Test hint') => {
      try { showHintBubble(text); } catch(e){ console.warn(e); }
    }
  };

  LOG('content script ready. Debug API: window.__leetMentorDebug');
})();
