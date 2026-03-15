import fetch from 'cross-fetch';

const JUPITER_PRICE_API = "https://price.jup.ag/v4/price?ids=";

export const monitorPosition = async (
  tokenMint: string,
  entryPrice: number,
  takeProfitPct: number, // e.g., 20 for 20%
  stopLossPct: number    // e.g., 10 for 10%
): Promise<string> => {
  let highestPrice = entryPrice; // Track ATH for Trailing Stop-Loss

  console.log(`📈 Monitoring ${tokenMint} | Entry: $${entryPrice.toFixed(6)} | TP: +${takeProfitPct}% | Trailing SL: -${stopLossPct}%`);

  return new Promise((resolve) => {
    const interval = setInterval(async () => {
      try {
        // 1. Fetch current price from Jupiter
        const response = await fetch(`${JUPITER_PRICE_API}${tokenMint}`).then(res => res.json());

        if (!response.data || !response.data[tokenMint] || !response.data[tokenMint].price) {
           return; // Price not found yet, skip tick
        }

        const currentPrice = parseFloat(response.data[tokenMint].price);

        // Update trailing ATH
        if (currentPrice > highestPrice) {
          highestPrice = currentPrice;
          console.log(`🚀 New Local ATH for ${tokenMint.substring(0, 4)}... : $${highestPrice.toFixed(6)}! Trailing SL moved up.`);
        }

        const priceChangeFromEntry = ((currentPrice - entryPrice) / entryPrice) * 100;
        const priceChangeFromATH = ((currentPrice - highestPrice) / highestPrice) * 100;

        console.log(`💰 ${tokenMint.substring(0, 4)}... Current: $${currentPrice.toFixed(6)} | PnL: ${priceChangeFromEntry > 0 ? '+' : ''}${priceChangeFromEntry.toFixed(2)}% | Drawdown from ATH: ${priceChangeFromATH.toFixed(2)}%`);

        // 2. Check Take Profit
        if (priceChangeFromEntry >= takeProfitPct) {
          console.log("🎯 TARGET REACHED! Preparing to sell for profit...");
          clearInterval(interval);
          resolve("SELL");
          return;
        }

        // 3. Check Trailing Stop Loss
        if (priceChangeFromATH <= -stopLossPct) {
          console.log(`🚨 TRAILING STOP LOSS TRIGGERED at -${stopLossPct}% from ATH! Preparing to sell to lock in/save capital...`);
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
