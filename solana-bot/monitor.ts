import fetch from 'cross-fetch';
import { fetchBirdeyeMultiPrice } from './birdeye';

// If Jupiter is down, we can use Birdeye
const JUPITER_PRICE_API = "https://api.jup.ag/price/v2?ids=";

interface MonitoredPosition {
  tokenMint: string;
  entryPrice: number;
  highestPrice: number;
  takeProfitPct: number;
  stopLossPct: number;
  resolve: (value: string) => void;
}

const activePositions = new Map<string, MonitoredPosition>();

// Global loop that batches price checks for all active positions
setInterval(async () => {
  if (activePositions.size === 0) return;

  const mints = Array.from(activePositions.keys());

  try {
    let prices: Record<string, number> = {};

    if (process.env.BIRDEYE_API_KEY) {
      // Use Birdeye's multi_price endpoint to fetch all active positions in 1 request
      const data = await fetchBirdeyeMultiPrice(mints);
      for (const mint of mints) {
        if (data && data[mint] && data[mint].value) {
          prices[mint] = data[mint].value;
        }
      }
    } else {
      // Fallback to Jupiter batching
      const response = await fetch(`${JUPITER_PRICE_API}${mints.join(',')}`).then(res => res.json());
      if (response.data) {
        for (const mint of mints) {
          if (response.data[mint] && response.data[mint].price) {
            prices[mint] = parseFloat(response.data[mint].price);
          }
        }
      }
    }

    for (const [mint, position] of activePositions.entries()) {
      const currentPrice = prices[mint];
      if (!currentPrice || currentPrice === 0) continue;

      // Update trailing ATH
      if (currentPrice > position.highestPrice) {
        position.highestPrice = currentPrice;
        console.log(`🚀 New Local ATH for ${mint.substring(0, 4)}... : $${position.highestPrice.toFixed(6)}! Trailing SL moved up.`);
      }

      const priceChangeFromEntry = ((currentPrice - position.entryPrice) / position.entryPrice) * 100;
      const priceChangeFromATH = ((currentPrice - position.highestPrice) / position.highestPrice) * 100;

      console.log(`💰 ${mint.substring(0, 4)}... Current: $${currentPrice.toFixed(6)} | PnL: ${priceChangeFromEntry > 0 ? '+' : ''}${priceChangeFromEntry.toFixed(2)}% | Drawdown from ATH: ${priceChangeFromATH.toFixed(2)}%`);

      // 2. Check Take Profit
      if (priceChangeFromEntry >= position.takeProfitPct) {
        console.log(`🎯 TARGET REACHED for ${mint}! Preparing to sell for profit...`);
        position.resolve("SELL");
        activePositions.delete(mint);
        continue;
      }

      // 3. Check Trailing Stop Loss
      if (priceChangeFromATH <= -position.stopLossPct) {
        console.log(`🚨 TRAILING STOP LOSS TRIGGERED for ${mint} at -${position.stopLossPct}% from ATH! Preparing to sell to save capital...`);
        position.resolve("SELL");
        activePositions.delete(mint);
        continue;
      }
    }
  } catch (error) {
    console.error("Batch price check failed, retrying on next tick...");
  }
}, 2000); // Global loop runs every 2 seconds

export const monitorPosition = async (
  tokenMint: string,
  entryPrice: number,
  takeProfitPct: number, // e.g., 20 for 20%
  stopLossPct: number    // e.g., 10 for 10%
): Promise<string> => {
  console.log(`📈 Monitoring ${tokenMint} | Entry: $${entryPrice.toFixed(6)} | TP: +${takeProfitPct}% | Trailing SL: -${stopLossPct}%`);

  return new Promise((resolve) => {
    activePositions.set(tokenMint, {
      tokenMint,
      entryPrice,
      highestPrice: entryPrice,
      takeProfitPct,
      stopLossPct,
      resolve
    });
  });
};
