import fetch from 'cross-fetch';

const JUPITER_PRICE_API = "https://price.jup.ag/v4/price?ids=";

export const monitorPosition = async (
  tokenMint: string,
  entryPrice: number,
  takeProfitPct: number, // e.g., 20 for 20%
  stopLossPct: number    // e.g., 10 for 10%
): Promise<string> => {
  console.log(`📈 Monitoring ${tokenMint} | Entry: $${entryPrice.toFixed(6)} | TP: +${takeProfitPct}% | SL: -${stopLossPct}%`);

  return new Promise((resolve) => {
    const interval = setInterval(async () => {
      try {
        // 1. Fetch current price from Jupiter
        const response = await fetch(`${JUPITER_PRICE_API}${tokenMint}`).then(res => res.json());

        if (!response.data || !response.data[tokenMint] || !response.data[tokenMint].price) {
           return; // Price not found yet, skip tick
        }

        const currentPrice = parseFloat(response.data[tokenMint].price);

        const priceChange = ((currentPrice - entryPrice) / entryPrice) * 100;
        console.log(`💰 ${tokenMint.substring(0, 4)}... Current: $${currentPrice.toFixed(6)} (${priceChange > 0 ? '+' : ''}${priceChange.toFixed(2)}%)`);

        // 2. Check Take Profit
        if (priceChange >= takeProfitPct) {
          console.log("🎯 TARGET REACHED! Preparing to sell for profit...");
          clearInterval(interval);
          resolve("SELL");
          return;
        }

        // 3. Check Stop Loss
        if (priceChange <= -stopLossPct) {
          console.log("🚨 STOP LOSS TRIGGERED! Preparing to sell to save capital...");
          clearInterval(interval);
          resolve("SELL");
          return;
        }
      } catch (e) {
        console.error("Price check failed, retrying in 2s...");
      }
    }, 2000); // Check every 2 seconds
  });
};
