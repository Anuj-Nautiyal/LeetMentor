// popup.js — handles request_hint and request_code_snippet

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

function setStatus(msg) {
  statusEl.textContent = msg;
}

function hideAll() {
  hintArea.classList.add("hidden");
  askCode.classList.add("hidden");
  snippetArea.classList.add("hidden");
  snippetBox.textContent = "";
  hintBox.textContent = "";
}

async function getActiveTab() {
  return new Promise(res => {
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      res(tabs?.[0] || null);
    });
  });
}

showBtn.addEventListener("click", async () => {
  hideAll();
  showBtn.disabled = true;
  setStatus("Requesting hint...");

  const tab = await getActiveTab();
  if (!tab) {
    setStatus("No active LeetCode tab.");
    showBtn.disabled = false;
    return;
  }

  chrome.runtime.sendMessage({ type: "request_hint", tabId: tab.id }, resp => {
    if (!resp) {
      setStatus("No response from background.");
      showBtn.disabled = false;
      return;
    }

    if (resp.ok === false) {
      setStatus("Error: " + (resp.error || "Unknown"));
      showBtn.disabled = false;
      return;
    }

    // hint delivered (background may also show in-page popup)
    hintArea.classList.remove("hidden");
    hintBox.textContent = resp.hint || "Hint shown on the page.";
    setStatus("Hint delivered.");

    // Ask-for-code flow
    if (resp.action === "ask_for_code") {
      askCode.classList.remove("hidden");
    }

    showBtn.disabled = false;
  });
});

showCodeYes.addEventListener("click", async () => {
  const tab = await getActiveTab();
  if (!tab) return;

  setStatus("Requesting code excerpt...");
  chrome.runtime.sendMessage({ type: "request_code_snippet", tabId: tab.id }, resp => {
    if (!resp || resp.ok === false) {
      setStatus("Failed to get code snippet.");
      return;
    }

    snippetArea.classList.remove("hidden");
    snippetBox.textContent = resp.snippet || "(no snippet)";
    askCode.classList.add("hidden");
    setStatus("Snippet displayed.");
  });
});

showCodeNo.addEventListener("click", () => {
  askCode.classList.add("hidden");
  setStatus("Continuing without code excerpt.");
});

resetBtn.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "reset_hints" });
  setStatus("Hint counters reset.");
});
