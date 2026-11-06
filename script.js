const API_BASE = "";

const $ = id => document.getElementById(id);

let running = false;
let timer = null;
let requestController = null;
let lastScannedMinute = null;
let scanning = false;

// ======================================
// SIGNAL DISPLAY
// ======================================

function showSignal(signal, reason) {
  const el = $("signal");

  const allowed = ["CALL", "PUT", "WAIT"];
  const normalized = String(signal || "WAIT").toUpperCase();

  const safeSignal = allowed.includes(normalized)
    ? normalized
    : "WAIT";

  el.textContent = safeSignal;
  el.className = safeSignal.toLowerCase();

  $("signalReason").textContent = reason || "";
}

// ======================================
// BACKEND HEALTH CHECK
// ======================================

async function checkHealth() {
  try {
    const response = await fetch(
      `${API_BASE}/api/health`,
      { signal: AbortSignal.timeout(10000) }
    );

    const data = await response.json();

    const connected =
      response.ok &&
      data.status === "ok" &&
      data.groqConfigured === true &&
      data.twelveDataConfigured === true;

    $("connection").textContent = connected
      ? "● Connected"
      : "● API not ready";

    return connected;

  } catch (error) {
    $("connection").textContent = "● Offline";
    return false;
  }
}

// ======================================
// MARKET SCANNER
// ======================================

async function scanMarkets() {
  if (!running || scanning) return;

  scanning = true;
  requestController = new AbortController();

  showSignal("WAIT", "Searching six market pairs...");

  $("countdown").textContent = "Scanning...";

  try {
    const response = await fetch(
      `${API_BASE}/api/scan`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({}),
        signal: requestController.signal
      }
    );

    const data = await response.json();

    if (!response.ok || data.success !== true) {
      throw new Error(
        data.error || "Market scan failed."
      );
    }

    if (!running) return;

    // Update selected pair
    $("selectedPair").textContent =
      data.symbol || "--";

    // Update market price
    $("price").textContent =
      data.market?.price ?? "--";

    // Update analytical confidence
    $("confidence").textContent =
      `${data.confidence ?? 0}%`;

    // Display actual backend signal
    showSignal(
      data.signal || "WAIT",
      data.reason || "Analysis completed."
    );

    $("lastUpdated").textContent =
      "Updated " + new Date().toLocaleTimeString();

    // Show pair scan information in reason if pairs failed
    if (Array.isArray(data.failedPairs) &&
        data.failedPairs.length > 0) {
      $("signalReason").textContent +=
        ` | Failed pairs: ${data.failedPairs.length}`;
    }

    $("connection").textContent = "● Connected";

  } catch (error) {

    if (error.name !== "AbortError" && running) {
      showSignal(
        "WAIT",
        `Scan error: ${error.message}`
      );

      $("connection").textContent =
        "● Scan error";
    }

  } finally {
    scanning = false;
    requestController = null;
  }
}

// ======================================
// CLOCK AND SCAN SCHEDULER
// ======================================

function updateClock() {
  if (!running) return;

  const now = new Date();
  const seconds = now.getSeconds();

  // Scan at second 50 of every minute
  const remaining = 50 - seconds;

  $("countdown").textContent =
    remaining > 0
      ? `${remaining}s`
      : scanning
        ? "Scanning..."
        : "Waiting...";

  if (seconds >= 50) {

    const minuteKey =
      `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}-${now.getMinutes()}`;

    if (
      lastScannedMinute !== minuteKey &&
      !scanning
    ) {
      lastScannedMinute = minuteKey;
      scanMarkets();
    }
  }
}

// ======================================
// START ANALYSIS
// ======================================

async function startAnalysis() {
  if (running) return;

  $("startBtn").disabled = true;

  $("signalReason").textContent =
    "Checking backend connection...";

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
    "Connected. Waiting for automatic scan."
  );

  // Start the clock
  updateClock();

  timer = setInterval(updateClock, 500);
}

// ======================================
// STOP ANALYSIS
// ======================================

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

  $("startBtn").textContent = "START ANALYSIS";

  $("countdown").textContent = "--";

  showSignal(
    "WAIT",
    "Analysis stopped. No new signals will be generated."
  );
}

// ======================================
// BUTTON EVENTS
// ======================================

$("startBtn").addEventListener(
  "click",
  startAnalysis
);

$("stopBtn").addEventListener(
  "click",
  stopAnalysis
);

// ======================================
// OPEN AI PANEL
// ======================================

$("launcher").addEventListener("click", () => {
  $("panel").classList.remove("hidden");
  $("launcher").style.display = "none";
});

// ======================================
// CLOSE AI PANEL
// ======================================

$("closeBtn").addEventListener("click", () => {
  $("panel").classList.add("hidden");
  $("launcher").style.display = "block";
});

// ======================================
// DRAG FUNCTIONALITY
// ======================================

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
