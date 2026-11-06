require("dotenv").config();

const express = require("express");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

const PORT = process.env.PORT || 3000;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const TWELVE_DATA_API_KEY = process.env.TWELVE_DATA_API_KEY;
const GROQ_MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-20b";

const AUTO_PAIRS = [
  "EUR/USD",
  "GBP/USD",
  "USD/JPY",
  "AUD/USD",
  "USD/CAD",
  "EUR/GBP"
];

// Twelve Data candles
async function getMarketData(symbol) {
  const url = new URL("https://api.twelvedata.com/time_series");

  url.searchParams.set("symbol", symbol);
  url.searchParams.set("interval", "1min");
  url.searchParams.set("outputsize", "100");
  url.searchParams.set("apikey", TWELVE_DATA_API_KEY);

  const response = await fetch(url);
  const data = await response.json();

  if (!response.ok || data.status === "error" || !data.values) {
    throw new Error(data.message || `Market data unavailable: ${symbol}`);
  }

  return data.values.reverse().map(c => ({
    datetime: c.datetime,
    open: Number(c.open),
    high: Number(c.high),
    low: Number(c.low),
    close: Number(c.close)
  }));
}

// EMA calculation
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

// RSI calculation
function calculateRSI(values, period = 14) {
  if (values.length <= period) return null;

  let gains = 0;
  let losses = 0;

  for (let i = values.length - period; i < values.length; i++) {
    const change = values[i] - values[i - 1];

    if (change > 0) gains += change;
    else losses += Math.abs(change);
  }

  if (losses === 0) return gains === 0 ? 50 : 100;

  const averageGain = gains / period;
  const averageLoss = losses / period;
  const rs = averageGain / averageLoss;

  return Number((100 - 100 / (1 + rs)).toFixed(2));
}

// MACD calculation
function calculateMACD(values) {
  if (values.length < 35) return null;

  const ema12 = calculateEMA(values, 12);
  const ema26 = calculateEMA(values, 26);

  if (ema12 === null || ema26 === null) return null;

  const macdLine = ema12 - ema26;

  const previousValues = values.slice(0, -1);
  const previousMacd =
    calculateEMA(previousValues, 12) -
    calculateEMA(previousValues, 26);

  const signal = (macdLine + previousMacd) / 2;

  return {
    line: Number(macdLine.toFixed(6)),
    signal: Number(signal.toFixed(6)),
    histogram: Number((macdLine - signal).toFixed(6))
  };
}

// All technical indicators
function calculateIndicators(candles) {
  const closes = candles.map(c => c.close);

  const ema9 = calculateEMA(closes, 9);
  const ema21 = calculateEMA(closes, 21);
  const rsi = calculateRSI(closes, 14);
  const macd = calculateMACD(closes);

  let emaTrend = "SIDEWAYS";

  if (ema9 !== null && ema21 !== null) {
    if (ema9 > ema21) emaTrend = "BULLISH";
    if (ema9 < ema21) emaTrend = "BEARISH";
  }

  return {
    rsi,
    ema9,
    ema21,
    emaTrend,
    macd
  };
}

// Groq AI analysis
async function analyzeWithGroq(symbol, candles, indicators) {
  const latest = candles[candles.length - 1];

  const prompt = `
You are a cautious financial market analysis assistant.

Analyze this REAL forex market data for the next 1-minute candle.

Pair: ${symbol}
Latest price: ${latest.close}
RSI(14): ${indicators.rsi}
EMA trend: ${indicators.emaTrend}
EMA9: ${indicators.ema9}
EMA21: ${indicators.ema21}
MACD: ${JSON.stringify(indicators.macd)}

Return ONLY valid JSON:
{
 "signal":"CALL or PUT or WAIT",
 "confidence":0,
 "trend":"BULLISH or BEARISH or SIDEWAYS",
 "reason":"short explanation"
}

Rules:
- Never invent missing market data.
- If indicators conflict or setup is weak, return WAIT.
- Confidence is analytical confidence, NOT probability of winning.
- Do not promise profit.
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
        temperature: 0.1,
        messages: [
          {
            role: "system",
            content: "Return only valid JSON. Do not use markdown."
          },
          { role: "user", content: prompt }
        ]
      })
    }
  );

  const result = await response.json();

  if (!response.ok) {
    throw new Error(
      result.error?.message || "Groq API request failed"
    );
  }

  const content = result.choices?.[0]?.message?.content;

  if (!content) throw new Error("Empty Groq response");

  const cleaned = content
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();

  const analysis = JSON.parse(cleaned);

  const signal = String(analysis.signal || "WAIT").toUpperCase();

  if (!["CALL", "PUT", "WAIT"].includes(signal)) {
    throw new Error("Invalid AI signal");
  }

  return {
    signal,
    confidence: Math.max(
      0,
      Math.min(100, Number(analysis.confidence) || 0)
    ),
    trend: analysis.trend || "SIDEWAYS",
    reason: analysis.reason || "No explanation provided."
  };
}

// Health API
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    message: "AI Trading Agent backend is running",
    twelveDataConfigured: Boolean(TWELVE_DATA_API_KEY),
    groqConfigured: Boolean(GROQ_API_KEY),
    model: GROQ_MODEL
  });
});

// Single-pair analysis API
app.post("/api/analyze", async (req, res) => {
  try {
    if (!GROQ_API_KEY || !TWELVE_DATA_API_KEY) {
      throw new Error("API keys are not configured.");
    }

    const symbol = req.body.symbol || "EUR/USD";
    const candles = await getMarketData(symbol);
    const indicators = calculateIndicators(candles);

    if (!indicators.macd || indicators.rsi === null) {
      throw new Error("Insufficient indicator data.");
    }

    const analysis = await analyzeWithGroq(
      symbol,
      candles,
      indicators
    );

    res.json({
      success: true,
      symbol,
      timeframe: "1min",
      market: candles[candles.length - 1],
      indicators,
      analysis,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error("Analyze error:", error.message);

    res.status(502).json({
      success: false,
      signal: "WAIT",
      error: error.message
    });
  }
});

// Automatic multi-pair scan API
app.post("/api/scan", async (req, res) => {
  try {
    if (!GROQ_API_KEY || !TWELVE_DATA_API_KEY) {
      throw new Error("API keys are not configured.");
    }

    const results = await Promise.allSettled(
      AUTO_PAIRS.map(async symbol => {
        const candles = await getMarketData(symbol);
        const indicators = calculateIndicators(candles);

        if (
          indicators.rsi === null ||
          !indicators.macd ||
          indicators.ema9 === null ||
          indicators.ema21 === null
        ) {
          throw new Error("Insufficient indicator data");
        }

        const macd = indicators.macd;
        let score = 0;

        if (indicators.emaTrend === "BULLISH" &&
            macd.histogram > 0 &&
            indicators.rsi > 50 && indicators.rsi < 70) {
          score = 3;
        } else if (
          indicators.emaTrend === "BEARISH" &&
          macd.histogram < 0 &&
          indicators.rsi < 50 && indicators.rsi > 30
        ) {
          score = 3;
        } else {
          score = 0;
        }

        return { symbol, candles, indicators, score };
      })
    );

    const valid = results
      .filter(item => item.status === "fulfilled")
      .map(item => item.value)
      .sort((a, b) => b.score - a.score);

    if (!valid.length) {
      throw new Error("No market data available.");
    }

    const best = valid[0];

    if (best.score < 3) {
      return res.json({
        success: true,
        symbol: best.symbol,
        signal: "WAIT",
        confidence: 0,
        trend: "SIDEWAYS",
        reason: "No strong matching indicator setup found.",
        market: {
          price: best.candles[best.candles.length - 1].close
        },
        indicators: best.indicators,
        scannedPairs: valid.map(x => x.symbol)
      });
    }

    const analysis = await analyzeWithGroq(
      best.symbol,
      best.candles,
      best.indicators
    );

    const latest = best.candles[best.candles.length - 1];

    res.json({
      success: true,
      symbol: best.symbol,
      signal: analysis.signal,
      confidence: analysis.confidence,
      trend: analysis.trend,
      reason: analysis.reason,
      market: {
        price: latest.close,
        datetime: latest.datetime
      },
      indicators: best.indicators,
      scannedPairs: valid.map(x => x.symbol),
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error("Auto scan error:", error.message);

    res.status(502).json({
      success: false,
      signal: "WAIT",
      error: error.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`AI Trading Agent running on port ${PORT}`);
});
