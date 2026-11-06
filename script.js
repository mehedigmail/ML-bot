const API_BASE = ""; // একই Render সার্ভারে Frontend ও Backend থাকলে ফাঁকা রাখবে

const $ = (id) => document.getElementById(id);

const panel = $("panel");
const launcher = $("launcher");
const analyzeBtn = $("analyzeBtn");

let backendConnected = false;

function setSignal(type, reason) {
  const signal = $("signal");
  signal.className = "signal " + type;
  signal.textContent = type.toUpperCase();
  $("signalReason").textContent = reason;
}

function showError(message) {
  backendConnected = false;
  $("connection").textContent = "Backend offline";
  $("connection").className = "status offline";
  $("dataStatus").textContent = "Not connected";
  setSignal("wait", message);
}

async function checkBackend() {
  try {
    const response = await fetch(`${API_BASE}/api/health`, {
      method: "GET",
      cache: "no-store"
    });

    if (!response.ok) throw new Error("Backend health check failed");

    const data = await response.json();

    backendConnected =
      data.status === "ok" &&
      data.twelveDataConfigured === true &&
      data.groqConfigured === true;

    if (!backendConnected) {
      showError("Backend is running, but the required API configuration is incomplete.");
      return;
    }

    $("connection").textContent = "Backend connected";
    $("connection").className = "status online";
    $("dataStatus").textContent = "Connected";
  } catch (error) {
    showError("Backend connection failed. Please check your Render service.");
  }
}

function readValue(obj, keys, fallback = "--") {
  for (const key of keys) {
    if (obj && obj[key] !== undefined && obj[key] !== null) {
      return obj[key];
    }
  }
  return fallback;
}

function updateDashboard(data) {
  const market = data.market || data.marketData || {};
  const indicators = data.indicators || {};
  const analysis = data.analysis || data.result || data;

  const price = readValue(market, ["price", "close", "currentPrice"],
    readValue(data, ["price", "currentPrice"]));

  const rsi = readValue(indicators, ["rsi", "RSI"],
    readValue(data, ["rsi"]));

  const ema = readValue(indicators, ["emaTrend", "ema", "trend"],
    readValue(data, ["emaTrend", "ema"]));

  const macd = readValue(indicators, ["macd", "MACD"],
    readValue(data, ["macd"]));

  const trend = readValue(analysis, ["trend", "marketTrend"],
    readValue(data, ["trend", "marketTrend"]));

  const confidence = readValue(analysis, ["confidence", "confidenceScore"],
    readValue(data, ["confidence", "confidenceScore"]));

  const rawSignal = String(
    readValue(analysis, ["signal", "recommendation", "action"],
      readValue(data, ["signal", "recommendation", "action"], "WAIT"))
  ).toUpperCase();

  const reason = readValue(analysis,
    ["reason", "explanation", "summary", "analysis"],
    readValue(data, ["reason", "explanation", "summary"],
      "No explanation was returned by the AI."));

  $("price").textContent = price;
  $("rsi").textContent = rsi;
  $("ema").textContent = ema;
  $("macd").textContent = macd;
  $("trend").textContent = trend;
  $("confidence").textContent =
    confidence === "--" ? "--%" :
    String(confidence).includes("%") ? confidence : `${confidence}%`;

  $("selectedPair").textContent = $("symbol").value;
  $("dataStatus").textContent = "Live response received";

  if (rawSignal === "CALL" || rawSignal === "PUT") {
    setSignal(rawSignal.toLowerCase(), reason);
  } else {
    setSignal("wait", reason);
  }

  $("analysisText").textContent =
    typeof reason === "string" ? reason : JSON.stringify(reason);

  $("lastUpdated").textContent =
    "Updated: " + new Date().toLocaleTimeString();
}

async function analyzeMarket() {
  analyzeBtn.disabled = true;
  analyzeBtn.textContent = "Analyzing...";
  setSignal("wait", "Requesting live market data and AI analysis...");

  try {
    await checkBackend();

    if (!backendConnected) {
      throw new Error("Backend or API configuration is not ready.");
    }

    const response = await fetch(`${API_BASE}/api/analyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        symbol: $("symbol").value,
        timeframe: $("timeframe").value
      })
    });

    const data = await response.json();

    if (!response.ok || data.error) {
      throw new Error(data.error || data.message || "Analysis request failed.");
    }

    updateDashboard(data);

  } catch (error) {
    setSignal("wait", error.message || "Analysis failed. No signal generated.");
    $("dataStatus").textContent = "Analysis failed";
    $("analysisText").textContent =
      "No verified analysis was received. Please try again later.";
  } finally {
    analyzeBtn.disabled = false;
    analyzeBtn.textContent = "Analyze Market";
  }
}

analyzeBtn.addEventListener("click", analyzeMarket);

$("refreshBtn").addEventListener("click", checkBackend);

$("symbol").addEventListener("change", () => {
  $("selectedPair").textContent = $("symbol").value;
  $("price").textContent = "--";
  $("trend").textContent = "--";
  $("confidence").textContent = "--%";
  $("rsi").textContent = "--";
  $("ema").textContent = "--";
  $("macd").textContent = "--";
  $("analysisText").textContent = "Pair changed. Run a new analysis.";
  setSignal("wait", "New pair selected. Waiting for fresh market analysis.");
});

// Panel open / minimize
launcher.addEventListener("click", () => {
  if (launcher.dataset.moved === "yes") {
    launcher.dataset.moved = "no";
    return;
  }
  panel.classList.remove("hidden");
  launcher.style.display = "none";
});

$("closeBtn").addEventListener("click", () => {
  panel.classList.add("hidden");
  launcher.style.display = "block";
});

// Drag support for both panel header and launcher
function makeDraggable(element, handle, isLauncher = false) {
  let startX = 0, startY = 0;
  let startLeft = 0, startTop = 0;
  let dragging = false;
  let moved = false;

  handle.addEventListener("pointerdown", (event) => {
    if (event.target.closest("button, select, a")) return;

    const rect = element.getBoundingClientRect();
    startX = event.clientX;
    startY = event.clientY;
    startLeft = rect.left;
    startTop = rect.top;
    dragging = true;
    moved = false;

    element.style.right = "auto";
    element.style.bottom = "auto";
    element.style.left = `${rect.left}px`;
    element.style.top = `${rect.top}px`;

    handle.setPointerCapture(event.pointerId);
  });

  handle.addEventListener("pointermove", (event) => {
    if (!dragging) return;

    const dx = event.clientX - startX;
    const dy = event.clientY - startY;

    if (Math.abs(dx) > 5 || Math.abs(dy) > 5) moved = true;

    const rect = element.getBoundingClientRect();
    const maxLeft = window.innerWidth - rect.width;
    const maxTop = window.innerHeight - rect.height;

    element.style.left =
      `${Math.max(0, Math.min(maxLeft, startLeft + dx))}px`;

    element.style.top =
      `${Math.max(0, Math.min(maxTop, startTop + dy))}px`;
  });

  function stopDrag() {
    dragging = false;
    if (isLauncher && moved) {
      launcher.dataset.moved = "yes";
    }
  }

  handle.addEventListener("pointerup", stopDrag);
  handle.addEventListener("pointercancel", stopDrag);
}

makeDraggable(panel, $("dragHeader"));
makeDraggable(launcher, launcher, true);

// Initial backend check
checkBackend();
