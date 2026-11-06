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

// ==================================
// TWELVE DATA MARKET DATA
// ==================================

async function getMarketData(symbol) {
  const url = new URL(
    "https://api.twelvedata.com/time_series"
  );

  url.searchParams.set("symbol", symbol);
  url.searchParams.set("interval", "1min");
  url.searchParams.set("outputsize", "100");
  url.searchParams.set("apikey", TWELVE_DATA_API_KEY);

  const response = await fetch(url);
  const data = await response.json();

  if (
    !response.ok ||
    data.status === "error" ||
    !data.values ||
    data.values.length < 35
  ) {
    throw new Error(
      data.message || `Market data unavailable: ${symbol}`
    );
  }

  return data.values.reverse().map(c => ({
    datetime: c.datetime,
    open: Number(c.open),
    high: Number(c.high),
    low: Number(c.low),
    close: Number(c.close)
  }));
}

// ==================================
// EMA CALCULATION
// ==================================

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

function calculateEMAArray(values, period) {
  const output = Array(values.length).fill(null);

  if (values.length < period) return output;

  const multiplier = 2 / (period + 1);

  let ema = values
    .slice(0, period)
    .reduce((sum, value) => sum + value, 0) / period;

  output[period - 1] = ema;

  for (let i = period; i < values.length; i++) {
    ema = (values[i] - ema) * multiplier + ema;
    output[i] = ema;
  }

  return output;
}

// ==================================
// RSI CALCULATION
// ==================================

function calculateRSI(values, period = 14) {
  if (values.length <= period) return null;

  let gains = 0;
  let losses = 0;

  for (
    let i = values.length - period;
    i < values.length;
    i++
  ) {
    const change = values[i] - values[i - 1];

    if (change > 0) {
      gains += change;
    } else {
      losses += Math.abs(change);
    }
  }

  if (losses === 0) {
    return gains === 0 ? 50 : 100;
  }

  const averageGain = gains / period;
  const averageLoss = losses / period;
  const rs = averageGain / averageLoss;

  return Number(
    (100 - 100 / (1 + rs)).toFixed(2)
  );
}

// ==================================
// MACD CALCULATION
// ==================================

function calculateMACD(values) {
  if (values.length < 35) return null;

  const ema12 = calculateEMAArray(values, 12);
  const ema26 = calculateEMAArray(values, 26);

  const macdValues = [];

  for (let i = 0; i < values.length; i++) {
    if (
      ema12[i] !== null &&
      ema26[i] !== null
    ) {
      macdValues.push(ema12[i] - ema26[i]);
    }
  }

  if (macdValues.length < 9) return null;

  const signalValues = calculateEMAArray(
    macdValues,
    9
  );

  const line = macdValues[macdValues.length - 1];

  const signal =
    signalValues[signalValues.length - 1];

  return {
    line: Number(line.toFixed(6)),
    signal: Number(signal.toFixed(6)),
    histogram: Number(
      (line - signal).toFixed(6)
    )
  };
}

// ==================================
// TECHNICAL INDICATORS
// ==================================

function calculateIndicators(candles) {
  const closes = candles.map(c => c.close);

  const ema9 = calculateEMA(closes, 9);
  const ema21 = calculateEMA(closes, 21);
  const rsi = calculateRSI(closes, 14);
  const macd = calculateMACD(closes);

  let emaTrend = "SIDEWAYS";

  if (ema9 !== null && ema21 !== null) {
    if (ema9 > ema21) {
      emaTrend = "BULLISH";
    } else if (ema9 < ema21) {
      emaTrend = "BEARISH";
    }
  }

  return {
    rsi,
    ema9,
    ema21,
    emaTrend,
    macd
  };
}

// ==================================
// GROQ AI ANALYSIS
// ==================================

async function analyzeWithGroq(
  symbol,
  candles,
  indicators,
  setup = null
) {
  const latest = candles[candles.length - 1];

  const prompt = `
You are a careful technical forex market analysis assistant.

Analyze the REAL market data for the NEXT 1-minute candle.

Pair: ${symbol}
Latest price: ${latest.close}

RSI(14): ${indicators.rsi}
EMA Trend: ${indicators.emaTrend}
EMA9: ${indicators.ema9}
EMA21: ${indicators.ema21}
MACD: ${JSON.stringify(indicators.macd)}

Technical direction: ${setup?.direction || "NOT PRESELECTED"}
Matching indicators: ${setup?.score || 0} out of 3

Return ONLY valid JSON:

{
 "signal":"CALL or PUT or WAIT",
 "confidence":0,
 "trend":"BULLISH or BEARISH or SIDEWAYS",
 "reason":"short explanation"
}

Rules:
- Analyze all available indicators.
- Two agreeing indicators can support a directional setup.
- Consider the technical direction carefully.
- Do not require all three indicators to agree.
- Return WAIT if the market is genuinely unclear.
- Never invent market data.
- Confidence is analytical confidence, NOT probability of winning.
- Never promise profit.
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
            content:
              "Return only valid JSON. No markdown."
          },
          {
            role: "user",
            content: prompt
          }
        ]
      })
    }
  );

  const result = await response.json();

  if (!response.ok) {
    throw new Error(
      result.error?.message ||
      "Groq API request failed"
    );
  }

  const content =
    result.choices?.[0]?.message?.content;

  if (!content) {
    throw new Error("Empty Groq response");
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
    throw new Error("Invalid AI signal");
  }

  return {
    signal,
    confidence: Math.max(
      0,
      Math.min(
        100,
        Number(analysis.confidence) || 0
      )
    ),
    trend: analysis.trend || "SIDEWAYS",
    reason:
      analysis.reason || "No explanation provided."
  };
}

// ==================================
// HEALTH API
// ==================================

app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    message: "AI Trading Agent backend is running",
    twelveDataConfigured: Boolean(TWELVE_DATA_API_KEY),
    groqConfigured: Boolean(GROQ_API_KEY),
    model: GROQ_MODEL,
    pairs: AUTO_PAIRS
  });
});

// ==================================
// SINGLE PAIR ANALYSIS
// ==================================

app.post("/api/analyze", async (req, res) => {
  try {
    if (!GROQ_API_KEY || !TWELVE_DATA_API_KEY) {
      throw new Error("API keys are not configured.");
    }

    const symbol = req.body.symbol || "EUR/USD";

    if (!AUTO_PAIRS.includes(symbol)) {
      throw new Error("Unsupported forex pair.");
    }

    const candles = await getMarketData(symbol);
    const indicators = calculateIndicators(candles);

    if (
      indicators.rsi === null ||
      !indicators.macd
    ) {
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

// ==================================
// AUTOMATIC MULTI-PAIR SCANNER
// ==================================

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

        // Directional scoring
        const bullishScore =
          (indicators.emaTrend === "BULLISH" ? 1 : 0) +
          (indicators.macd.histogram > 0 ? 1 : 0) +
          (
            indicators.rsi > 50 &&
            indicators.rsi < 70 ? 1 : 0
          );

        const bearishScore =
          (indicators.emaTrend === "BEARISH" ? 1 : 0) +
          (indicators.macd.histogram < 0 ? 1 : 0) +
          (
            indicators.rsi < 50 &&
            indicators.rsi > 30 ? 1 : 0
          );

        let direction = "WAIT";

        const score = Math.max(
          bullishScore,
          bearishScore
        );

        if (
          bullishScore >= 2 &&
          bullishScore > bearishScore
        ) {
          direction = "CALL";
        } else if (
          bearishScore >= 2 &&
          bearishScore > bullishScore
        ) {
          direction = "PUT";
        }

        return {
          symbol,
          candles,
          indicators,
          direction,
          score
        };
      })
    );

    const valid = results
      .filter(item => item.status === "fulfilled")
      .map(item => item.value);

    const failedPairs = results
      .filter(item => item.status === "rejected")
      .map((item, index) => ({
        error:
          item.reason?.message || "Unknown error"
      }));

    if (!valid.length) {
      throw new Error(
        "No market data available from any pair."
      );
    }

    const candidates = valid
      .filter(
        item =>
          item.score >= 2 &&
          item.direction !== "WAIT"
      )
      .sort((a, b) => b.score - a.score);

    // No directional setup
    if (!candidates.length) {
      const best = [...valid].sort(
        (a, b) => b.score - a.score
      )[0];

      return res.json({
        success: true,
        symbol: best.symbol,
        signal: "WAIT",
        confidence: 0,
        trend: "SIDEWAYS",
        reason:
          "No sufficiently clear directional setup found.",
        market: {
          price:
            best.candles[best.candles.length - 1].close
        },
        indicators: best.indicators,
        scannedPairs: valid.map(x => x.symbol),
        failedPairs,
        timestamp: new Date().toISOString()
      });
    }

    // Analyze the strongest candidate
    const best = candidates[0];

    const analysis = await analyzeWithGroq(
      best.symbol,
      best.candles,
      best.indicators,
      {
        direction: best.direction,
        score: best.score
      }
    );

    const latest =
      best.candles[best.candles.length - 1];

    // Require AI confirmation
    const finalSignal =
      analysis.signal === best.direction
        ? analysis.signal
        : "WAIT";

    const finalReason =
      finalSignal === "WAIT" &&
      analysis.signal !== "WAIT"
        ? "AI analysis did not confirm the technical direction."
        : analysis.reason;

    res.json({
      success: true,
      symbol: best.symbol,
      signal: finalSignal,
      confidence:
        finalSignal === "WAIT"
          ? 0
          : analysis.confidence,
      trend: analysis.trend,
      reason: finalReason,
      market: {
        price: latest.close,
        datetime: latest.datetime
      },
      indicators: best.indicators,
      indicatorScore: best.score,
      scannedPairs: valid.map(x => x.symbol),
      failedPairs,
      timestamp: new Date().toISOString()
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

// ==================================
// START SERVER
// ==================================

app.listen(PORT, () => {
  console.log(
    `AI Trading Agent running on port ${PORT}`
  );
});
