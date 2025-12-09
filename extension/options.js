// options.js — handles saving / loading settings for LeetMentor
const allowEl = document.getElementById('allowSendCode');
const serverEl = document.getElementById('serverUrl');
const saveBtn = document.getElementById('saveBtn');
const resetBtn = document.getElementById('resetBtn');
const statusEl = document.getElementById('status');
const testServerBtn = document.getElementById('testServerBtn');
const clearHintsBtn = document.getElementById('clearHintsBtn');
const exportBtn = document.getElementById('exportBtn');
const testOutput = document.getElementById('testOutput');

const DEFAULTS = {
  allowSendCodeToServer: false,
  serverUrl: 'http://localhost:3000/hint'
};

function setStatus(txt, timeout = 2500) {
  statusEl.textContent = txt;
  if (timeout) {
    setTimeout(() => { statusEl.textContent = 'Ready'; }, timeout);
  }
}

async function loadSettings() {
  const r = await new Promise(res => chrome.storage.local.get(['leetmentor_settings'], res));
  const s = r.leetmentor_settings || {};
  allowEl.checked = !!s.allowSendCodeToServer;
  serverEl.value = s.serverUrl || DEFAULTS.serverUrl;
  setStatus('Loaded settings');
}

async function saveSettings() {
  const s = {
    allowSendCodeToServer: !!allowEl.checked,
    serverUrl: serverEl.value && serverEl.value.trim() ? serverEl.value.trim() : DEFAULTS.serverUrl
  };
  await new Promise(res => chrome.storage.local.set({ leetmentor_settings: s }, res));
  setStatus('Saved settings');
}

async function resetSettings() {
  await new Promise(res => chrome.storage.local.set({ leetmentor_settings: DEFAULTS }, res));
  await new Promise(res => chrome.storage.local.remove(['leetmentor_hints_map','leetmentor_hint_cache'], res));
  await loadSettings();
  setStatus('Reset to defaults');
}

// Test server by POSTing a small sample
async function testServer() {
  const url = serverEl.value && serverEl.value.trim() ? serverEl.value.trim() : DEFAULTS.serverUrl;
  testOutput.style.display = 'block';
  testOutput.textContent = 'Testing ' + url + ' ...';
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        problemId: 'test-problem',
        snippet: 'def test():\n  return 42',
        url: 'about:blank',
        failure: 'test'
      })
    });
    const json = await resp.json();
    testOutput.textContent = JSON.stringify(json, null, 2);
    setStatus('Server responded');
  } catch (err) {
    testOutput.textContent = 'Error: ' + (err && err.message ? err.message : String(err));
    setStatus('Server test failed');
  }
}

async function clearHints() {
  await new Promise(res => chrome.storage.local.remove(['leetmentor_hints_map','leetmentor_hint_cache'], res));
  setStatus('Hint counters cleared');
}

// Export current settings as JSON for teammates
async function exportSettings() {
  const r = await new Promise(res => chrome.storage.local.get(['leetmentor_settings','leetmentor_hints_map'], res));
  const blob = new Blob([JSON.stringify(r, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'leetmentor-settings.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  setStatus('Exported settings');
}

// events
saveBtn.addEventListener('click', async () => {
  await saveSettings();
});

resetBtn.addEventListener('click', async () => {
  if (!confirm('Reset to default settings and clear hint counters?')) return;
  await resetSettings();
});

testServerBtn.addEventListener('click', async () => {
  await testServer();
});

clearHintsBtn.addEventListener('click', async () => {
  if (!confirm('Clear hint counters for all problems?')) return;
  await clearHints();
});

exportBtn.addEventListener('click', exportSettings);

// initial load
loadSettings();