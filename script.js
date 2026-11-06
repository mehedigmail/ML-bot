const API_BASE = "";

const $ = id => document.getElementById(id);

let running = false;
let timer = null;
let requestController = null;
let lastScannedMinute = null;
let scanning = false;

// Signal display
function showSignal(signal, reason) {
  const el = $("signal");

  const allowed = ["BUY", "SELL", "WAIT"];
  const normalized = String(signal || "WAIT").toUpperCase();

  const safeSignal = allowed.includes(normalized)
    ? normalized
    : "WAIT";

  el.textContent = safeSignal;
  el.className = safeSignal.toLowerCase();

  $("signalReason").textContent = reason || "";
}

// Backend health check
async function checkHealth() {
  try {
    const r = await fetch(`${API_BASE}/api/health`);
    const d = await r.json();

    const ok =
      r.ok &&
      d.status === "ok" &&
      d.groqConfigured === true &&
      d.twelveDataConfigured === true;

    $("connection").textContent = ok
      ? "● Connected"
      : "● API not ready";

    return ok;

  } catch (error) {
    $("connection").textContent = "● Offline";
    return false;
  }
}

// Automatic market scanning
async function scanMarkets() {
  if (!running || scanning) return;

  scanning = true;
  requestController = new AbortController();

  showSignal("WAIT", "Scanning all market pairs...");

  try {
    const response = await fetch(`${API_BASE}/api/scan`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({}),
      signal: requestController.signal
    });

    const data = await response.json();

    if (!response.ok || !data.success) {
      throw new Error(data.error || "Market scan failed.");
    }

    if (!running) return;

    $("selectedPair").textContent =
      data.symbol || "--";

    $("price").textContent =
      data.market?.price ?? "--";

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

// Clock and automatic scan timing
function updateClock() {
  if (!running) return;

  const now = new Date();
  const seconds = now.getSeconds();

  const remaining = 50 - seconds;

  $("countdown").textContent =
    remaining > 0
      ? `${remaining}s`
      : "Scanning...";

  if (seconds >= 50) {

    const minuteKey =
      `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}-${now.getMinutes()}`;

    if (lastScannedMinute !== minuteKey) {
      lastScannedMinute = minuteKey;
      scanMarkets();
    }
  }
}

// Start analysis
async function startAnalysis() {
  if (running) return;

  $("startBtn").disabled = true;

  $("signalReason").textContent =
    "Checking backend...";

  const connected = await checkHealth();

  if (!connected) {
    $("startBtn").disabled = false;

    showSignal(
      "WAIT",
      "Backend or API configuration is unavailable."
    );

    return;
  }

  running = true;
  lastScannedMinute = null;

  $("stopBtn").disabled = false;

  $("startBtn").textContent = "RUNNING";

  showSignal(
    "WAIT",
    "Automatic market scanning started."
  );

  updateClock();

  timer = setInterval(updateClock, 250);
}

// Stop analysis
function stopAnalysis() {
  running = false;

  if (timer) {
    clearInterval(timer);
  }

  timer = null;

  if (requestController) {
    requestController.abort();
  }

  scanning = false;

  $("stopBtn").disabled = true;
  $("startBtn").disabled = false;

  $("startBtn").textContent =
    "START ANALYSIS";

  $("countdown").textContent = "--";

  showSignal(
    "WAIT",
    "Analysis stopped. No new signals will be generated."
  );
}

// Start and stop buttons
$("startBtn").addEventListener(
  "click",
  startAnalysis
);

$("stopBtn").addEventListener(
  "click",
  stopAnalysis
);

// Open AI panel
$("launcher").addEventListener("click", () => {
  $("panel").classList.remove("hidden");
  $("launcher").style.display = "none";
});

// Close AI panel
$("closeBtn").addEventListener("click", () => {
  $("panel").classList.add("hidden");
  $("launcher").style.display = "block";
});

// Drag functionality
function drag(element, handle) {

  let x = 0;
  let y = 0;
  let left = 0;
  let top = 0;
  let active = false;

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

  const stop = () => {
    active = false;
  };

  handle.addEventListener("pointerup", stop);
  handle.addEventListener("pointercancel", stop);
}

// Enable dragging
drag($("panel"), $("dragHeader"));
drag($("launcher"), $("launcher"));
