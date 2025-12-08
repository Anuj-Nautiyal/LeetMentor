// 1. Inject extension stylesheet (styles.css)
(function injectStyles() {
  if (document.getElementById("leetmentor-styles")) return;
  const link = document.createElement("link");
  link.id = "leetmentor-styles";
  link.rel = "stylesheet";
  link.href = chrome.runtime.getURL("styles.css");
  document.head.appendChild(link);
})();

// Global state
let latestSnippet = "";
let lastFailureMessage = "";
let observing = false;

// Utility: safely debounce (small delay to avoid oversending)
function debounce(func, delay = 300) {
  let timeout;
  return (...args) => {
    clearTimeout(timeout);
    timeout = setTimeout(() => func(...args), delay);
  };
}

// ==============================
// 2. Observe LeetCode Editor Text
// ==============================
function startObservingEditor() {
  if (observing) return;
  observing = true;

  const editor = document.querySelector(".monaco-editor");

  if (!editor) {
    console.log("[LeetMentor] Editor not found yet, retrying...");
    setTimeout(startObservingEditor, 1000);
    return;
  }

  console.log("[LeetMentor] Editor found. Observing...");

  const observer = new MutationObserver(
    debounce(() => {
      const text = getEditorText();
      if (!text) return;

      latestSnippet = text.slice(0, 3000); // limit size
      chrome.runtime.sendMessage({
        type: "editor_input",
        payload: { snippet: latestSnippet, time: Date.now() }
      });
    }, 400)
  );

  observer.observe(editor, { childList: true, subtree: true });
}

// Extract LeetCode editor text from monaco
function getEditorText() {
  try {
    const lines = Array.from(document.querySelectorAll(".view-line"));
    return lines.map(line => line.textContent).join("\n");
  } catch (err) {
    console.warn("[LeetMentor] Could not read editor text:", err);
    return "";
  }
}

startObservingEditor();

// ==============================
// 3. Detect Run and Submit clicks
// ==============================
function bindRunSubmitDetection() {
  const runBtn = document.querySelector("button[data-cy='run-code-btn']");
  const submitBtn = document.querySelector("button[data-cy='submit-code-btn']");

  if (!runBtn || !submitBtn) {
    setTimeout(bindRunSubmitDetection, 1000);
    return;
  }

  runBtn.addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "run_or_submit_clicked" });
  });

  submitBtn.addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "run_or_submit_clicked" });
  });

  console.log("[LeetMentor] Bound run & submit button listeners");
}

bindRunSubmitDetection();

// ==============================
// 4. Observe Result Panel for Fail / Pass
// ==============================
function observeResult() {
  const panel = document.querySelector(".submission-result, .container__3z-");

  if (!panel) {
    setTimeout(observeResult, 1000);
    return;
  }

  const observer = new MutationObserver(() => {
    const failMsg = getFailureMessage();
    const passMsg = getPassMessage();

    if (failMsg) {
      lastFailureMessage = failMsg;
      chrome.runtime.sendMessage({
        type: "submission_result",
        payload: { status: "fail", raw: failMsg }
      });
    } else if (passMsg) {
      chrome.runtime.sendMessage({
        type: "submission_result",
        payload: { status: "pass", raw: passMsg }
      });
    }
  });

  observer.observe(panel, { childList: true, subtree: true });
  console.log("[LeetMentor] Observing result panel...");
}

observeResult();

function getFailureMessage() {
  const failEl = document.querySelector(".error__2FtR, .error");
  if (failEl) return failEl.innerText.trim();
  return null;
}

function getPassMessage() {
  const passEl = document.querySelector(".success__1KMN, .success");
  if (passEl) return passEl.innerText.trim();
  return null;
}

// ==============================
// 5. Respond to background → collect context
// ==============================
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;

  if (msg.type === "collect_context") {
    const problemId = location.pathname.replace(/\/+$/, "");
    sendResponse({
      problemId,
      snippet: latestSnippet ? latestSnippet.slice(0, 1800) : "",
      url: location.href,
      failure: lastFailureMessage || ""
    });
    return; // synchronous response
  }

  if (msg.type === "show_hint_in_page") {
    const hintText =
      (msg.payload && (msg.payload.hintText || msg.payload.hint)) ||
      msg.hint ||
      (typeof msg === "string" ? msg : "") ||
      "";
    showHintBubble(hintText);
    return;
  }
});

// ==============================
// 6. UI: Show hint bubble on LeetCode page
// ==============================
function showHintBubble(hintText) {
  // Remove previous bubble
  const old = document.getElementById("leetmentor-hint-bubble");
  if (old) old.remove();

  const bubble = document.createElement("div");
  bubble.id = "leetmentor-hint-bubble";
  bubble.className = "lm-hint-bubble";

  const closeBtn = document.createElement("button");
  closeBtn.className = "lm-hint-close";
  closeBtn.textContent = "✕";
  closeBtn.onclick = () => bubble.remove();

  const text = document.createElement("div");
  text.textContent = hintText;

  bubble.appendChild(closeBtn);
  bubble.appendChild(text);
  document.body.appendChild(bubble);

  console.log("[LeetMentor] Hint bubble shown");
}