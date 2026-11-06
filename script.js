const API_BASE = "";

const $ = id => document.getElementById(id);

let running = false;
let timer = null;
let requestController = null;
let lastScannedMinute = null;
let scanning = false;

function showSignal(signal, reason) {
  const el = $("signal");
  el.textContent = signal;
  el.className = signal.toLowerCase();
  $("signalReason").textContent = reason || "";
}

async function checkHealth() {
  try {
    const r = await fetch(`${API_BASE}/api/health`);
    const d = await r.json();

    const ok = r.ok &&
      d.status === "ok" &&
      d.groqConfigured &&
      d.twelveDataConfigured;

    $("connection").textContent = ok
      ? "● Connected"
      : "● API not ready";

    return ok;
  } catch {
    $("connection").textContent = "● Offline";
    return false;
  }
}

async function scanMarkets() {
  if (!running || scanning) return;

  scanning = true;
  requestController = new AbortController();

  showSignal("WAIT", "Scanning all market pairs...");

  try {
    const response = await fetch(`${API_BASE}/api/scan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
      signal: requestController.signal
    });

    const data = await response.json();

    if (!response.ok || !data.success) {
      throw new Error(data.error || "Market scan failed.");
    }

    if (!running) return;

    $("selectedPair").textContent = data.symbol || "--";
    $("price").textContent = data.market?.price ?? "--";
    $("confidence").textContent =
      `${data.confidence ?? 0}%`;

    showSignal(
      data.signal || "WAIT",
      data.reason || "No analysis explanation."
    );

    $("lastUpdated").textContent =
      "Updated " + new Date().toLocaleTimeString();

  } catch (error) {
    if (error.name !== "AbortError" && running) {
      showSignal("WAIT", error.message);
    }
  } finally {
    scanning = false;
    requestController = null;
  }
}

function updateClock() {
  if (!running) return;

  const now = new Date();
  const seconds = now.getSeconds();
  const remaining = 50 - seconds;

  $("countdown").textContent =
    remaining > 0 ? `${remaining}s` : "Scanning...";

  // প্রতি মিনিটে একবার, সেকেন্ড ৫০-এ স্ক্যান শুরু
  if (seconds >= 50) {
    const minuteKey =
      `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}-${now.getMinutes()}`;

    if (lastScannedMinute !== minuteKey) {
      lastScannedMinute = minuteKey;
      scanMarkets();
    }
  }
}

async function startAnalysis() {
  if (running) return;

  $("startBtn").disabled = true;
  $("signalReason").textContent = "Checking backend...";

  const connected = await checkHealth();

  if (!connected) {
    $("startBtn").disabled = false;
    showSignal("WAIT", "Backend or API configuration is unavailable.");
    return;
  }

  running = true;
  lastScannedMinute = null;

  $("stopBtn").disabled = false;
  $("startBtn").textContent = "RUNNING";

  showSignal("WAIT", "Automatic market scanning started.");

  // পরবর্তী :50 সেকেন্ডের জন্য অপেক্ষা
  updateClock();
  timer = setInterval(updateClock, 250);
}

function stopAnalysis() {
  running = false;

  if (timer) clearInterval(timer);
  timer = null;

  if (requestController) requestController.abort();

  scanning = false;

  $("stopBtn").disabled = true;
  $("startBtn").disabled = false;
  $("startBtn").textContent = "START ANALYSIS";
  $("countdown").textContent = "--";

  showSignal("WAIT", "Analysis stopped. No new signals will be generated.");
}

$("startBtn").addEventListener("click", startAnalysis);
$("stopBtn").addEventListener("click", stopAnalysis);

$("launcher").addEventListener("click", () => {
  $("panel").classList.remove("hidden");
  $("launcher").style.display = "none";
});

$("closeBtn").addEventListener("click", () => {
  $("panel").classList.add("hidden");
  $("launcher").style.display = "block";
});

// Panel ও launcher drag
function drag(element, handle) {
  let x = 0, y = 0, left = 0, top = 0, active = false;

  handle.addEventListener("pointerdown", e => {
    if (e.target.closest("button,a")) return;

    const rect = element.getBoundingClientRect();
    x = e.clientX;
    y = e.clientY;
    left = rect.left;
    top = rect.top;
    active = true;

    element.style.right = "auto";
    element.style.bottom = "auto";
    element.style.left = `${left}px`;
    element.style.top = `${top}px`;

    handle.setPointerCapture(e.pointerId);
  });

  handle.addEventListener("pointermove", e => {
    if (!active) return;

    const rect = element.getBoundingClientRect();

    element.style.left =
      `${Math.max(0, Math.min(innerWidth - rect.width, left + e.clientX - x))}px`;

    element.style.top =
      `${Math.max(0, Math.min(innerHeight - rect.height, top + e.clientY - y))}px`;
  });

  const stop = () => active = false;
  handle.addEventListener("pointerup", stop);
  handle.addEventListener("pointercancel", stop);
}

drag($("panel"), $("dragHeader"));
drag($("launcher"), $("launcher"));
