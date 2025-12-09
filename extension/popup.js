const showBtn = document.getElementById('showHintBtn');
const resetBtn = document.getElementById('resetBtn');
const statusEl = document.getElementById('status');
const hintArea = document.getElementById('hintArea');
const hintBox = document.getElementById('hintBox');
const askCode = document.getElementById('askCode');
const showCodeYes = document.getElementById('showCodeYes');
const showCodeNo = document.getElementById('showCodeNo');
const snippetArea = document.getElementById('snippetArea');
const snippetBox = document.getElementById('snippetBox');

// Menu + toggle
const menuBtn = document.getElementById('menuBtn');
const menu = document.getElementById('menu');
const menuWrapper = document.getElementById('menuWrapper');
const allowSendCodePopup = document.getElementById('allowSendCodePopup');

function setStatus(txt) { statusEl.textContent = txt; }
function hideAll() {
  hintArea.classList.add('hidden');
  askCode.classList.add('hidden');
  snippetArea.classList.add('hidden');
  hintBox.textContent = '';
  snippetBox.textContent = '';
}

// utility to get active tab
function getActiveTab() {
  return new Promise(res => {
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      res(tabs && tabs[0] ? tabs[0] : null);
    });
  });
}

// load allowSendCode setting into the popup toggle
function loadAllowSendToggle() {
  return new Promise(res => {
    chrome.storage.local.get(['leetmentor_settings'], d => {
      const s = (d && d.leetmentor_settings) || {};
      allowSendCodePopup.checked = !!s.allowSendCodeToServer;
      res(s);
    });
  });
}

// save allowSendCode toggle to storage
function saveAllowSendToggle(checked) {
  return new Promise(res => {
    chrome.storage.local.get(['leetmentor_settings'], d => {
      const s = (d && d.leetmentor_settings) || {};
      s.allowSendCodeToServer = !!checked;
      s.serverUrl = s.serverUrl || 'http://localhost:3000/hint';
      chrome.storage.local.set({ leetmentor_settings: s }, () => res(s));
    });
  });
}

// Initialize toggle and listeners
loadAllowSendToggle();

// Keep popup UI in sync if settings change elsewhere
chrome.storage.onChanged.addListener((changes) => {
  if (changes.leetmentor_settings && changes.leetmentor_settings.newValue) {
    const s = changes.leetmentor_settings.newValue;
    allowSendCodePopup.checked = !!s.allowSendCodeToServer;
  }
});

// menu button behavior
menuBtn.addEventListener('click', (e) => {
  const expanded = menuBtn.getAttribute('aria-expanded') === 'true';
  menuBtn.setAttribute('aria-expanded', expanded ? 'false' : 'true');
  menu.classList.toggle('hidden');
  if (!menu.classList.contains('hidden')) {
    // focus first focusable element in menu
    allowSendCodePopup.focus();
  }
});

// close menu when clicking outside or pressing Escape
document.addEventListener('click', (e) => {
  if (!menuWrapper.contains(e.target)) {
    menu.classList.add('hidden');
    menuBtn.setAttribute('aria-expanded', 'false');
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    menu.classList.add('hidden');
    menuBtn.setAttribute('aria-expanded', 'false');
  }
});

// save setting when toggle changes
allowSendCodePopup.addEventListener('change', async (e) => {
  await saveAllowSendToggle(e.target.checked);
  setStatus(e.target.checked ? 'Send-to-server enabled' : 'Send-to-server disabled');
});

// Show hint flow
showBtn.addEventListener('click', async () => {
  hideAll();
  showBtn.disabled = true;
  setStatus('Requesting hint...');

  const tab = await getActiveTab();
  if (!tab) {
    setStatus('No active tab found.');
    showBtn.disabled = false;
    return;
  }

  chrome.runtime.sendMessage({ type: 'request_hint', tabId: tab.id }, resp => {
    if (!resp) {
      setStatus('No response from background.');
      showBtn.disabled = false;
      return;
    }
    if (resp.ok === false) {
      setStatus('Error: ' + (resp.error || 'unknown'));
      showBtn.disabled = false;
      return;
    }

    setStatus('Hint delivered (in-page).');

    if (resp.hint) {
      hintArea.classList.remove('hidden');
      hintBox.textContent = resp.hint;
    } else {
      hintArea.classList.remove('hidden');
      hintBox.textContent = 'Hint shown on the page.';
    }

    if (resp.action === 'ask_for_code') {
      askCode.classList.remove('hidden');
    }

    showBtn.disabled = false;
  });
});

// snippet flow
showCodeYes.addEventListener('click', async () => {
  const tab = await getActiveTab();
  if (!tab) { setStatus('No active tab'); return; }

  setStatus('Requesting code excerpt...');
  chrome.runtime.sendMessage({ type: 'request_code_snippet', tabId: tab.id }, resp => {
    if (!resp || resp.ok === false) {
      setStatus('Failed to get code snippet.');
      return;
    }
    snippetArea.classList.remove('hidden');
    snippetBox.textContent = resp.snippet || '(no snippet)';
    askCode.classList.add('hidden');
    setStatus('Snippet displayed.');
  });
});

showCodeNo.addEventListener('click', () => {
  askCode.classList.add('hidden');
  setStatus('Continuing without code excerpt.');
});

// reset hints (dev)
resetBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'reset_hints' }, () => {
    setStatus('Hint counters reset.');
  });
});

// initialize popup UI
hideAll();
setStatus('Ready');
