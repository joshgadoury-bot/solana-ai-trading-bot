import fetch from 'cross-fetch';
import { fetchWithBackoff, delay } from './scanner';

const BIRDEYE_API_KEY = process.env.BIRDEYE_API_KEY;

// Global Rate Limiter Lock (1 request per second max)
let lastBirdeyeRequestTime = 0;
let birdeyeLockPromise = Promise.resolve();

async function acquireBirdeyeLock() {
  const previousLock = birdeyeLockPromise;

  birdeyeLockPromise = (async () => {
    await previousLock;
    const now = Date.now();
    const timeSinceLastRequest = now - lastBirdeyeRequestTime;
    if (timeSinceLastRequest < 1000) {
      await delay(1000 - timeSinceLastRequest);
    }
    lastBirdeyeRequestTime = Date.now();
  })();

  await birdeyeLockPromise;
}

// Generic Fetch Wrapper
export async function fetchBirdeyeApi<T>(endpoint: string, options: RequestInit = {}): Promise<T | null> {
  if (!BIRDEYE_API_KEY) return null;

  return await fetchWithBackoff(async () => {
    await acquireBirdeyeLock();

    const response = await fetch(`https://public-api.birdeye.so${endpoint}`, {
      ...options,
      headers: {
        ...options.headers,
        'X-API-KEY': BIRDEYE_API_KEY as string,
        'x-chain': 'solana',
        'Accept': 'application/json',
      }
    });

    if (!response.ok) {
       if (response.status === 429) {
          throw new Error('429 Too Many Requests'); // Caught by fetchWithBackoff
       }
       console.error(`Birdeye API error ${response.status} on ${endpoint}`);
       return null;
    }

    return await response.json();
  }, 3, 2000); // 3 retries, starting at 2000ms exponential backoff
}

// ----------------------------------------------------
// 1. History Price (1-min Trend)
// ----------------------------------------------------
export const fetchBirdeyeTrend = async (mintAddress: string) => {
  if (!BIRDEYE_API_KEY) {
    console.warn(`⚠️ Skipping 1-minute trend analysis for ${mintAddress} because BIRDEYE_API_KEY is not set.`);
    return "SKIP_TREND";
  }

  const now = Math.floor(Date.now() / 1000);
  const oneMinAgo = now - 60;

  const data: any = await fetchBirdeyeApi(`/defi/history_price?address=${mintAddress}&address_type=token&type=1m&time_from=${oneMinAgo}&time_to=${now}`);

  if (data && data.success && data.data && data.data.items.length > 0) {
    console.log(`📊 1-Minute Trend for ${mintAddress}: Fetched ${data.data.items.length} price points.`);
    return data.data.items;
  } else {
    console.log(`📉 No recent trend data found for ${mintAddress} on Birdeye.`);
    return null;
  }
};

// ----------------------------------------------------
// 2. Multi Price Batching
// ----------------------------------------------------
export const fetchBirdeyeMultiPrice = async (mintAddresses: string[]) => {
   if (mintAddresses.length === 0) return {};

   // /defi/multi_price accepts a comma-separated list of addresses
   const list = mintAddresses.join(',');
   const data: any = await fetchBirdeyeApi(`/defi/multi_price?list_address=${list}`);

   if (data && data.success && data.data) {
      return data.data; // Record<string, { value: number, ... }>
   }
   return {};
};

// ----------------------------------------------------
// 3. Wallet Balance Caching
// ----------------------------------------------------
let walletCache: {
  timestamp: number,
  balances: Record<string, number>
} | null = null;

export const fetchBirdeyeWalletBalances = async (walletAddress: string): Promise<Record<string, number>> => {
  // Check cache (60 seconds)
  if (walletCache && (Date.now() - walletCache.timestamp < 60000)) {
     console.log(`⚡ Returning cached wallet balances for ${walletAddress}`);
     return walletCache.balances;
  }

  const data: any = await fetchBirdeyeApi(`/v1/wallet/token_list?wallet=${walletAddress}`);

  const balances: Record<string, number> = {};
  if (data && data.success && data.data && data.data.items) {
     for (const item of data.data.items) {
         balances[item.address] = item.uiAmount;
     }
  }

  // Update Cache
  walletCache = {
      timestamp: Date.now(),
      balances
  };

  return balances;
};
