require("dotenv").config();

const express = require("express");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.json({ limit: "100kb" }));
app.use(express.static(__dirname));

const PORT = process.env.PORT || 3000;

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const TWELVE_DATA_API_KEY = process.env.TWELVE_DATA_API_KEY;

const GROQ_MODEL =
  process.env.GROQ_MODEL || "openai/gpt-oss-20b";

const AUTO_PAIRS = [
  "EUR/USD",
  "GBP/USD",
  "USD/JPY",
  "AUD/USD",
  "USD/CAD",
  "EUR/GBP"
];

// ======================================
// COMMON HELPERS
// ======================================

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function normalizeTrend(value) {
  const trend = String(value || "").toUpperCase();

  if (["BULLISH", "BEARISH", "SIDEWAYS", "UNCLEAR"].includes(trend)) {
    return trend;
  }

  return "UNCLEAR";
}

function parseDateTime(value) {
  if (!value) return null;

  const text = String(value).replace(" ", "T");

  const date = new Date(
    /Z$|[+-]\d{2}:\d{2}$/.test(text)
      ? text
      : `${text}Z`
  );

  return Number.isNaN(date.getTime()) ? null : date;
}

// ======================================
// TWELVE DATA
// ======================================

async function getMarketData(symbol) {
  if (!TWELVE_DATA_API_KEY) {
    throw new Error("TWELVE_DATA_API_KEY is missing.");
  }

  const url = new URL(
    "https://api.twelvedata.com/time_series"
  );

  url.searchParams.set("symbol", symbol);
  url.searchParams.set("interval", "1min");
  url.searchParams.set("outputsize", "120");
  url.searchParams.set("timezone", "UTC");
  url.searchParams.set("apikey", TWELVE_DATA_API_KEY);

  const response = await fetch(url, {
    signal: AbortSignal.timeout(15000)
  });

  const data = await response.json().catch(() => ({}));

  if (
    !response.ok ||
    data.status === "error" ||
    !Array.isArray(data.values)
  ) {
    throw new Error(
      data.message || `Twelve Data error: ${symbol}`
    );
  }

  const candles = data.values
    .map(c => ({
      datetime: c.datetime,
      open: Number(c.open),
      high: Number(c.high),
      low: Number(c.low),
      close: Number(c.close)
    }))
    .filter(c =>
      c.datetime &&
      Number.isFinite(c.open) &&
      Number.isFinite(c.high) &&
      Number.isFinite(c.low) &&
      Number.isFinite(c.close)
    )
    .reverse();

  // Exclude the currently forming candle.
  const currentMinute = Math.floor(Date.now() / 60000) * 60000;

  const closedCandles = candles.filter(c => {
    const time = parseDateTime(c.datetime);

    return time && time.getTime() < currentMinute;
  });

  if (closedCandles.length < 40) {
    throw new Error(
      `Not enough closed candles for ${symbol}.`
    );
  }

  // Reject stale market data.
  const latest = closedCandles[closedCandles.length - 1];
  const latestTime = parseDateTime(latest.datetime);

  const ageMinutes =
    (Date.now() - latestTime.getTime()) / 60000;

  if (ageMinutes > 5) {
    throw new Error(
      `Market data is outdated for ${symbol}.`
    );
  }

  return closedCandles.slice(-120);
}

// ======================================
// EMA
// ======================================

function calculateEMAArray(values, period) {
  const output = Array(values.length).fill(null);

  if (values.length < period) return output;

  const multiplier = 2 / (period + 1);

  let ema =
    values.slice(0, period).reduce((a, b) => a + b, 0) /
    period;

  output[period - 1] = ema;

  for (let i = period; i < values.length; i++) {
    ema =
      values[i] * multiplier +
      ema * (1 - multiplier);

    output[i] = ema;
  }

  return output;
}

function calculateEMA(values, period) {
  const result = calculateEMAArray(values, period);
  return result[result.length - 1];
}

// ======================================
// RSI - WILDER METHOD
// ======================================

function calculateRSI(values, period = 14) {
  if (values.length <= period) return null;

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const change = values[i] - values[i - 1];

    gains += Math.max(change, 0);
    losses += Math.max(-change, 0);
  }

  let averageGain = gains / period;
  let averageLoss = losses / period;

  for (let i = period + 1; i < values.length; i++) {
    const change = values[i] - values[i - 1];

    averageGain =
      (averageGain * (period - 1) +
        Math.max(change, 0)) / period;

    averageLoss =
      (averageLoss * (period - 1) +
        Math.max(-change, 0)) / period;
  }

  if (averageLoss === 0) {
    return averageGain === 0 ? 50 : 100;
  }

  const rs = averageGain / averageLoss;

  return Number(
    (100 - 100 / (1 + rs)).toFixed(2)
  );
}

// ======================================
// MACD
// ======================================

function calculateMACD(values) {
  if (values.length < 35) return null;

  const ema12 = calculateEMAArray(values, 12);
  const ema26 = calculateEMAArray(values, 26);

  const macdValues = [];

  for (let i = 0; i < values.length; i++) {
    if (ema12[i] !== null && ema26[i] !== null) {
      macdValues.push(ema12[i] - ema26[i]);
    }
  }

  if (macdValues.length < 9) return null;

  const signalValues =
    calculateEMAArray(macdValues, 9);

  const line = macdValues[macdValues.length - 1];

  const signal =
    signalValues[signalValues.length - 1];

  return {
    line: Number(line.toFixed(8)),
    signal: Number(signal.toFixed(8)),
    histogram: Number((line - signal).toFixed(8))
  };
}

// ======================================
// TECHNICAL INDICATORS
// ======================================

function calculateIndicators(candles) {
  const closes = candles.map(c => c.close);

  const ema9 = calculateEMA(closes, 9);
  const ema21 = calculateEMA(closes, 21);

  const rsi = calculateRSI(closes, 14);
  const macd = calculateMACD(closes);

  let emaTrend = "SIDEWAYS";

  if (ema9 > ema21) {
    emaTrend = "BULLISH";
  } else if (ema9 < ema21) {
    emaTrend = "BEARISH";
  }

  return {
    rsi,
    ema9: Number(ema9.toFixed(8)),
    ema21: Number(ema21.toFixed(8)),
    emaTrend,
    macd
  };
}

// ======================================
// PREPARE MARKET INFORMATION
// ======================================

function prepareMarket(symbol, candles) {
  const indicators = calculateIndicators(candles);

  if (
    indicators.rsi === null ||
    !indicators.macd
  ) {
    throw new Error(
      `Indicator calculation failed: ${symbol}`
    );
  }

  const latest = candles[candles.length - 1];

  return {
    symbol,
    price: latest.close,
    latestCandle: latest,
    previousCandle: candles[candles.length - 2],
    indicators,

    // Send recent 40 candles to AI.
    recentCandles: candles.slice(-40)
  };
}

// ======================================
// GROQ AI ANALYSIS
// ======================================

async function analyzeWithGroq(markets) {
  if (!GROQ_API_KEY) {
    throw new Error("GROQ_API_KEY is missing.");
  }

  const marketData = markets.map(m => ({
    symbol: m.symbol,
    price: m.price,
    latestCandle: m.latestCandle,
    previousCandle: m.previousCandle,
    indicators: m.indicators,
    recentCandles: m.recentCandles
  }));

  const prompt = `
You are an experienced technical forex market analyst.

Analyze the supplied REAL FOREX MARKET data.

TIMEFRAME: 1 minute.
EXPIRY REFERENCE: Next 1-minute candle.

You have received data for multiple currency pairs.

For EACH pair:
- Study the latest 40 closed candles.
- Study candle direction and momentum.
- Study RSI(14).
- Study EMA9 and EMA21.
- Study MACD line, signal and histogram.
- Consider the recent price movement.
- Identify trend, momentum and possible reversal.
- Do not invent missing information.

Compare all available pairs.

Choose ONLY the single best directional setup if a genuinely
clear opportunity exists.

Do not require all three indicators to agree.
Do not reject a setup only because one indicator disagrees.
Use the complete candle pattern and indicator context.

Do not force a trade.
If no pair has a reasonably clear setup, return WAIT.

Return ONLY valid JSON in this format:

{
  "selectedPair": "EUR/USD",
  "signal": "CALL",
  "confidence": 75,
  "trend": "BULLISH",
  "reason": "Short technical explanation",
  "riskNote": "Short risk warning"
}

Rules:
- signal must be CALL, PUT or WAIT.
- selectedPair must be one of the supplied pairs.
- CALL should represent bullish direction.
- PUT should represent bearish direction.
- WAIT means no sufficiently clear setup.
- Confidence means analytical confidence only.
- Confidence is NOT probability of winning.
- Never promise profit.
- Never fabricate market data.
- For WAIT, confidence must be 0.
- Use a realistic confidence score.
`;

  const response = await fetch(
    "https://api.groq.com/openai/v1/chat/completions",
    {
      method: "POST",

      headers: {
        Authorization: `Bearer ${GROQ_API_KEY}`,
        "Content-Type": "application/json"
      },

      body: JSON.stringify({
        model: GROQ_MODEL,
        temperature: 0.1,
        max_tokens: 900,

        response_format: {
          type: "json_object"
        },

        messages: [
          {
            role: "system",
            content:
              "You are a careful forex analyst. Return only valid JSON."
          },
          {
            role: "user",
            content:
              prompt + "\n\nMARKET DATA:\n" +
              JSON.stringify(marketData)
          }
        ]
      }),

      signal: AbortSignal.timeout(30000)
    }
  );

  const result = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      result.error?.message ||
      `Groq API error: ${response.status}`
    );
  }

  const content =
    result.choices?.[0]?.message?.content;

  if (!content) {
    throw new Error("Groq returned an empty response.");
  }

  const cleaned = content
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();

  const analysis = JSON.parse(cleaned);

  const signal = String(
    analysis.signal || "WAIT"
  ).toUpperCase();

  if (!["CALL", "PUT", "WAIT"].includes(signal)) {
    throw new Error("Invalid AI signal.");
  }

  const selectedPair = String(
    analysis.selectedPair || ""
  ).toUpperCase();

  const selectedMarket = markets.find(
    m => m.symbol.toUpperCase() === selectedPair
  );

  if (signal !== "WAIT" && !selectedMarket) {
    throw new Error(
      "AI selected an unavailable market pair."
    );
  }

  const confidence =
    signal === "WAIT"
      ? 0
      : clamp(
          Math.round(Number(analysis.confidence) || 0),
          0,
          100
        );

  return {
    symbol: signal === "WAIT"
      ? selectedMarket?.symbol || markets[0].symbol
      : selectedMarket.symbol,

    signal,
    confidence,

    trend: normalizeTrend(analysis.trend),

    reason:
      String(analysis.reason || "No explanation provided."),

    riskNote:
      String(
        analysis.riskNote ||
        "Signals are estimates, not guarantees."
      )
  };
}

// ======================================
// HEALTH API
// ======================================

app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    message: "AI Trading Agent backend is running",
    twelveDataConfigured: Boolean(TWELVE_DATA_API_KEY),
    groqConfigured: Boolean(GROQ_API_KEY),
    model: GROQ_MODEL,
    pairs: AUTO_PAIRS,
    timeframe: "1min",
    candleHistory: 120,
    aiCandles: 40
  });
});

// ======================================
// SINGLE PAIR ANALYSIS
// ======================================

app.post("/api/analyze", async (req, res) => {
  try {
    if (!GROQ_API_KEY || !TWELVE_DATA_API_KEY) {
      throw new Error("API keys are not configured.");
    }

    const symbol = String(
      req.body.symbol || "EUR/USD"
    ).toUpperCase();

    if (!AUTO_PAIRS.includes(symbol)) {
      return res.status(400).json({
        success: false,
        error: "Unsupported forex pair."
      });
    }

    const candles = await getMarketData(symbol);

    const market = prepareMarket(symbol, candles);

    const analysis = await analyzeWithGroq([market]);

    res.json({
      success: true,
      symbol,
      timeframe: "1min",
      market: market.latestCandle,
      indicators: market.indicators,
      analysis,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error("Analyze error:", error.message);

    res.status(502).json({
      success: false,
      signal: "WAIT",
      confidence: 0,
      error: error.message
    });
  }
});

// ======================================
// AUTOMATIC SIX-PAIR SCANNER
// ======================================

app.post("/api/scan", async (req, res) => {
  try {
    if (!GROQ_API_KEY || !TWELVE_DATA_API_KEY) {
      throw new Error("API keys are not configured.");
    }

    // Collect all six pairs.
    const results = await Promise.allSettled(
      AUTO_PAIRS.map(async symbol => {
        const candles = await getMarketData(symbol);

        return prepareMarket(symbol, candles);
      })
    );

    const validMarkets = [];
    const failedPairs = [];

    results.forEach((result, index) => {
      if (result.status === "fulfilled") {
        validMarkets.push(result.value);
      } else {
        failedPairs.push({
          symbol: AUTO_PAIRS[index],
          error:
            result.reason?.message || "Unknown error"
        });
      }
    });

    if (!validMarkets.length) {
      throw new Error(
        "No valid market data available for any pair."
      );
    }

    // AI analyzes all valid pairs together.
    const analysis =
      await analyzeWithGroq(validMarkets);

    const selectedMarket = validMarkets.find(
      m => m.symbol === analysis.symbol
    );

    const market = selectedMarket || validMarkets[0];

    const finalSignal = analysis.signal;

    res.json({
      success: true,

      symbol: market.symbol,

      signal: finalSignal,

      confidence:
        finalSignal === "WAIT"
          ? 0
          : analysis.confidence,

      trend: analysis.trend,

      reason: analysis.reason,

      riskNote: analysis.riskNote,

      market: {
        price: market.price,
        datetime: market.latestCandle.datetime
      },

      indicators: market.indicators,

      scannedPairs: validMarkets.map(m => m.symbol),

      failedPairs,

      analysisTime: new Date().toISOString(),

      timestamp: new Date().toISOString(),

      timeframe: "1min",

      expiryReference: "1 minute"
    });

  } catch (error) {
    console.error("Auto scan error:", error.message);

    res.status(502).json({
      success: false,
      signal: "WAIT",
      confidence: 0,
      error: error.message
    });
  }
});

// ======================================
// START SERVER
// ======================================

app.listen(PORT, () => {
  console.log(
    `AI Trading Agent running on port ${PORT}`
  );
});
