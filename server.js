require("dotenv").config();

const express = require("express");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.json({ limit: "20kb" }));
app.use(express.static(__dirname));

const PORT = process.env.PORT || 3000;

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const TWELVE_DATA_API_KEY = process.env.TWELVE_DATA_API_KEY;

const GROQ_MODEL =
  process.env.GROQ_MODEL || "openai/gpt-oss-20b";

// ------------------------------
// Health Check
// ------------------------------

app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    message: "AI Trading Agent backend is running",
    twelveDataConfigured: Boolean(TWELVE_DATA_API_KEY),
    groqConfigured: Boolean(GROQ_API_KEY),
    model: GROQ_MODEL
  });
});

// ------------------------------
// Market Data
// ------------------------------

async function getMarketData(symbol) {
  const url = new URL("https://api.twelvedata.com/time_series");

  url.searchParams.set("symbol", symbol);
  url.searchParams.set("interval", "1min");
  url.searchParams.set("outputsize", "100");
  url.searchParams.set("apikey", TWELVE_DATA_API_KEY);

  const response = await fetch(url, {
    signal: AbortSignal.timeout(20000)
  });

  if (!response.ok) {
    throw new Error("Twelve Data request failed.");
  }

  const data = await response.json();

  if (data.status === "error" || !Array.isArray(data.values)) {
    throw new Error(
      data.message || "Unable to receive market candles from Twelve Data."
    );
  }

  const candles = data.values
    .map(item => ({
      datetime: item.datetime,
      open: Number(item.open),
      high: Number(item.high),
      low: Number(item.low),
      close: Number(item.close),
      volume: Number(item.volume || 0)
    }))
    .filter(c =>
      Number.isFinite(c.close) &&
      Number.isFinite(c.open) &&
      Number.isFinite(c.high) &&
      Number.isFinite(c.low)
    )
    .reverse();

  if (candles.length < 30) {
    throw new Error("Not enough market candles for reliable indicator calculation.");
  }

  return candles;
}

// ------------------------------
// EMA Calculation
// ------------------------------

function calculateEMA(values, period) {
  if (values.length < period) return null;

  const multiplier = 2 / (period + 1);

  let ema = values
    .slice(0, period)
    .reduce((sum, value) => sum + value, 0) / period;

  for (let i = period; i < values.length; i++) {
    ema = (values[i] - ema) * multiplier + ema;
  }

  return ema;
}

// ------------------------------
// RSI Calculation
// ------------------------------

function calculateRSI(values, period = 14) {
  if (values.length <= period) return null;

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const change = values[i] - values[i - 1];

    if (change > 0) gains += change;
    else losses += Math.abs(change);
  }

  let averageGain = gains / period;
  let averageLoss = losses / period;

  for (let i = period + 1; i < values.length; i++) {
    const change = values[i] - values[i - 1];

    const gain = Math.max(change, 0);
    const loss = Math.max(-change, 0);

    averageGain =
      (averageGain * (period - 1) + gain) / period;

    averageLoss =
      (averageLoss * (period - 1) + loss) / period;
  }

  if (averageLoss === 0) return 100;

  const rs = averageGain / averageLoss;

  return 100 - (100 / (1 + rs));
}

// ------------------------------
// MACD Calculation
// ------------------------------

function calculateMACD(values) {
  if (values.length < 35) return null;

  const fastMultiplier = 2 / 13;
  const slowMultiplier = 2 / 27;

  let fastEMA = values[0];
  let slowEMA = values[0];

  const macdValues = [];

  for (const price of values) {
    fastEMA =
      price * fastMultiplier +
      fastEMA * (1 - fastMultiplier);

    slowEMA =
      price * slowMultiplier +
      slowEMA * (1 - slowMultiplier);

    macdValues.push(fastEMA - slowEMA);
  }

  const signal = calculateEMA(macdValues, 9);
  const macd = macdValues[macdValues.length - 1];

  return {
    value: macd,
    signal: signal,
    histogram: signal === null ? null : macd - signal
  };
}

// ------------------------------
// Calculate Indicators
// ------------------------------

function calculateIndicators(candles) {
  const closes = candles.map(c => c.close);

  const rsi = calculateRSI(closes, 14);
  const ema9 = calculateEMA(closes, 9);
  const ema21 = calculateEMA(closes, 21);
  const macd = calculateMACD(closes);

  let emaTrend = "NEUTRAL";

  if (ema9 !== null && ema21 !== null) {
    if (ema9 > ema21) emaTrend = "BULLISH";
    if (ema9 < ema21) emaTrend = "BEARISH";
  }

  return {
    rsi: rsi === null ? null : Number(rsi.toFixed(2)),
    ema9: ema9 === null ? null : Number(ema9.toFixed(6)),
    ema21: ema21 === null ? null : Number(ema21.toFixed(6)),
    emaTrend,
    macd: macd ? {
      value: Number(macd.value.toFixed(8)),
      signal: Number(macd.signal.toFixed(8)),
      histogram: Number(macd.histogram.toFixed(8))
    } : null
  };
}

// ------------------------------
// Groq AI Analysis
// ------------------------------

async function analyzeWithGroq(symbol, candles, indicators) {
  const recentCandles = candles.slice(-30).map(c => ({
    time: c.datetime,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close
  }));

  const prompt = `
You are a cautious financial market analysis assistant.

Analyze the supplied REAL market candle data and technical indicators.

Market: ${symbol}
Timeframe: 1 minute

Indicators:
${JSON.stringify(indicators)}

Recent candles:
${JSON.stringify(recentCandles)}

Rules:
1. Do not invent market prices or indicator values.
2. Use only the supplied data.
3. Consider trend, momentum and indicator agreement.
4. If evidence is weak, mixed or unclear, choose WAIT.
5. Do not promise profit or claim certainty.
6. Confidence is an analytical confidence score, NOT a win probability.
7. Return valid JSON only.

Required JSON format:
{
  "signal": "CALL or PUT or WAIT",
  "confidence": 0,
  "trend": "BULLISH or BEARISH or SIDEWAYS",
  "reason": "Short explanation of the analysis"
}
`;

  const response = await fetch(
    "https://api.groq.com/openai/v1/chat/completions",
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${GROQ_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: [
          {
            role: "system",
            content: "Return only valid JSON. Never invent market data."
          },
          {
            role: "user",
            content: prompt
          }
        ],
        temperature: 0.1,
        max_tokens: 500
      }),
      signal: AbortSignal.timeout(30000)
    }
  );

  const result = await response.json();

  if (!response.ok) {
    throw new Error(
      result.error?.message || "Groq AI analysis failed."
    );
  }

  const content = result.choices?.[0]?.message?.content;

  if (!content) {
    throw new Error("Groq returned an empty AI response.");
  }

  const cleaned = content
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();

  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");

  if (start === -1 || end === -1) {
    throw new Error("Groq returned an invalid analysis format.");
  }

  const analysis = JSON.parse(cleaned.slice(start, end + 1));

  const signal = String(analysis.signal || "WAIT").toUpperCase();

  if (!["CALL", "PUT", "WAIT"].includes(signal)) {
    throw new Error("Invalid signal returned by AI.");
  }

  const confidence = Number(analysis.confidence);

  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 100) {
    throw new Error("Invalid AI confidence value.");
  }

  return {
    signal,
    confidence,
    trend: ["BULLISH", "BEARISH", "SIDEWAYS"].includes(
      String(analysis.trend).toUpperCase()
    ) ? String(analysis.trend).toUpperCase() : "SIDEWAYS",
    reason: String(analysis.reason || "No explanation provided.")
  };
}

// ------------------------------
// Analyze Market API
// ------------------------------

app.post("/api/analyze", async (req, res) => {
  try {
    if (!GROQ_API_KEY || !TWELVE_DATA_API_KEY) {
      return res.status(503).json({
        error: "Backend API keys are not configured."
      });
    }

    const symbol = String(req.body.symbol || "EUR/USD").trim();

    const allowedSymbols = [
      "EUR/USD",
      "GBP/USD",
      "USD/JPY",
      "AUD/USD",
      "USD/CAD",
      "EUR/GBP"
    ];

    if (!allowedSymbols.includes(symbol)) {
      return res.status(400).json({
        error: "Unsupported market pair."
      });
    }

    const timeframe = req.body.timeframe || "1min";

    if (timeframe !== "1min") {
      return res.status(400).json({
        error: "Only 1-minute timeframe is supported."
      });
    }

    const candles = await getMarketData(symbol);
    const indicators = calculateIndicators(candles);

    if (
      indicators.rsi === null ||
      indicators.macd === null ||
      indicators.ema9 === null ||
      indicators.ema21 === null
    ) {
      throw new Error("Unable to calculate all required indicators.");
    }

    const analysis = await analyzeWithGroq(
      symbol,
      candles,
      indicators
    );

    const latestCandle = candles[candles.length - 1];

    return res.json({
      success: true,
      symbol,
      timeframe,
      market: {
        price: latestCandle.close,
        datetime: latestCandle.datetime,
        open: latestCandle.open,
        high: latestCandle.high,
        low: latestCandle.low,
        close: latestCandle.close
      },
      indicators: {
        rsi: indicators.rsi,
        emaTrend: indicators.emaTrend,
        ema9: indicators.ema9,
        ema21: indicators.ema21,
        macd: indicators.macd
      },
      analysis,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error("Analysis error:", error.message);

    return res.status(502).json({
      success: false,
      error: error.message || "Market analysis failed. No signal generated."
    });
  }
});

// ------------------------------
// Start Server
// ------------------------------

app.listen(PORT, "0.0.0.0", () => {
  console.log(`AI Trading Agent running on port ${PORT}`);
});
