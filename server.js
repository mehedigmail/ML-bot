const AUTO_PAIRS = [
  "EUR/USD",
  "GBP/USD",
  "USD/JPY",
  "AUD/USD",
  "USD/CAD",
  "EUR/GBP"
];

app.post("/api/scan", async (req, res) => {
  try {
    if (!GROQ_API_KEY || !TWELVE_DATA_API_KEY) {
      throw new Error("API keys are not configured.");
    }

    // সব Pair-এর ডেটা সংগ্রহ
    const results = await Promise.allSettled(
      AUTO_PAIRS.map(async (symbol) => {
        const candles = await getMarketData(symbol);
        const indicators = calculateIndicators(candles);

        if (
          indicators.rsi === null ||
          indicators.macd === null ||
          indicators.ema9 === null ||
          indicators.ema21 === null
        ) {
          throw new Error("Insufficient indicator data");
        }

        // প্রাথমিক Trend agreement score
        const macd = indicators.macd;
        let score = 0;

        if (indicators.emaTrend === "BULLISH") score++;
        if (indicators.emaTrend === "BEARISH") score++;

        if (macd.histogram > 0) score++;
        if (macd.histogram < 0) score++;

        if (indicators.rsi > 50 && indicators.rsi < 70) score++;
        if (indicators.rsi < 50 && indicators.rsi > 30) score++;

        return {
          symbol,
          candles,
          indicators,
          score
        };
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

    // দুর্বল বা পরস্পরবিরোধী সেটআপে WAIT
    if (best.score < 2) {
      return res.json({
        success: true,
        symbol: best.symbol,
        signal: "WAIT",
        confidence: 0,
        trend: "SIDEWAYS",
        reason: "No sufficiently strong market setup found.",
        market: { price: best.candles.at(-1).close },
        indicators: best.indicators,
        scannedPairs: valid.map(x => x.symbol)
      });
    }

    const analysis = await analyzeWithGroq(
      best.symbol,
      best.candles,
      best.indicators
    );

    const latestCandle = best.candles.at(-1);

    res.json({
      success: true,
      symbol: best.symbol,
      signal: analysis.signal,
      confidence: analysis.confidence,
      trend: analysis.trend,
      reason: analysis.reason,
      market: {
        price: latestCandle.close,
        datetime: latestCandle.datetime
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
