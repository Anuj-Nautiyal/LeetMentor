# 📘 LeetMentor — Your AI-Powered LeetCode Mentor (Chrome Extension)

LeetMentor is a Chrome extension that helps you solve LeetCode problems more effectively.  
It watches your solving process, detects when you’re stuck, and provides **progressive hints** (Level 1 → Level 3).  
After the third hint, it can optionally provide a **2–3 line code excerpt** to nudge you in the right direction — never the full solution.

LeetMentor supports two modes:

- **Local Hints Only (no AI)** — works out of the box  
- **AI-Generated Hints (optional)** — powered by **Ollama + Llama 3.2 (3B)** running locally on your machine  

This repo contains both:

🔹 `extension/` — The Chrome Extension  
🔹 `server/` — A Node.js server that communicates with Ollama to generate AI hints/excerpts

---

## ✨ Features

✔ Smart hinting system (3 levels)  
✔ Optional AI hints and code excerpts via Ollama  
✔ Detects when the user is stuck (1 fail → 3 min idle)  
✔ Works directly inside the LeetCode editor  
✔ No full solutions — only structured hints + small code excerpts  
✔ Privacy-first: Code is never sent anywhere unless you enable the toggle  
✔ Reset system resets all hint-progress cleanly  
✔ Debug and auto-inject fallback system for reliable content-script injection  

---

# 🧪 Install & Test Locally (Chrome Load Unpacked)

### 1️⃣ Clone repo

```bash
git clone https://github.com/YOUR_USERNAME/LeetMentor.git
cd LeetMentor
```

### 2️⃣ Load the extension in Chrome

**1.** Open chrome://extensions/

**2.** Turn on Developer mode

**3.** Click Load unpacked

**4.** Select the extension/ folder

You should now see the LeetMentor extension in your toolbar.

---
# 🤖 Optional — Enable AI-Generated Hints (Local Ollama)

LeetMentor can generate smarter hints using a local LLM, but only if you enable and run the server + Ollama. 

This is 100% optional — without this, the extension still works using local fallback hints.

---

### 🟦 Step 1 — Install Ollama

Ollama lets you run LLMs like Llama 3 locally.

**Windows / Linux / macOS:**

Download from:

➡ https://ollama.com

After installation, verify:

```bash
ollama --version
```
---
### 🟩 Step 2 — Pull the model llama3.2:3b
```
ollama pull llama3.2:3b
```
This downloads the 3B model.

---
### 🟧 Step 3 — Start the Ollama server
```
ollama serve
```
or
``` 
ollama daemon
```
check it's running:
```bash
curl http://localhost:11434/health
```
---
### 🟥 Step 4 — Run the Node.js backend server
Open a new terminal:
```bash
cd server
npm install
node index.js
```
If everything works, you'll see:
```
LeetMentor server running on http://localhost:3000
```
The extension will now be able to request AI hints and code excerpts.

---
# ⚙️ Extension Settings (from Popup)

The popup contains:

### ✔ Show Hint

Shows Hint Level 1 → Level 3

After Level 3, the bubble shows:

```
Reached maximum hint limit. Do you want a code excerpt?
```

### ✔ Allow code to server

When ON → extension can send code snippets to `http://localhost:3000/hint`

When OFF → no code is sent; local fallback hints are used

### ✔ Reset All

Resets:

* hint progress

* per-problem hint levels

* in-page hint bubbles

Does NOT reset your server settings (privacy-preserving).

---

# 🔒 Privacy Notes

* Code is NEVER sent to the server unless you enable the toggle

* By default, send-to-server is OFF

* The AI backend runs locally unless you host it elsewhere

* No data is stored long-term by the extension

* No analytics or tracking exist

If you later publish to the Chrome Web Store, you must include a privacy policy that reflects these points.

---
# ❗ Troubleshooting
###  ❌ AI hints not working

* Check if Ollama is running

* Check server logs

* Check that popup toggle "Allow code to server" is ON

* Check background console for errors

### ❌ “Could not establish connection”

* Content script failed to inject — manually refresh LeetCode page

* Background auto-inject fallback will try again

### ❌ Code excerpt shows unexpected content

* AI model may need stronger prompt rules

* Restart Ollama if streaming output freezes

---
# 🤝 Contributing

Contributions welcome!

Feel free to open issues or submit PRs for new features, bug fixes, or model improvements.

---
📄 License

MIT License

Copyright © 2025

---