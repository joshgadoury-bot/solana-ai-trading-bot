import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, VersionedTransaction, ParsedAccountData } from '@solana/web3.js';
import bs58 from 'bs58';
import fetch from 'cross-fetch';
import { createJupiterApiClient } from '@jup-ag/api';
import { getAssociatedTokenAddress, getAccount } from '@solana/spl-token';
import { OpenAI } from 'openai';
import dotenv from 'dotenv';
import { startScanner } from './scanner';
import { monitorPosition } from './monitor';

dotenv.config();

// Configuration
const RPC_URL = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
const PRIVATE_KEY = process.env.PHANTOM_PRIVATE_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const BIRDEYE_API_KEY = process.env.BIRDEYE_API_KEY;

// Constants (Tokens)
const TOKENS = {
  SOL: "So11111111111111111111111111111111111111112", // Wrapped SOL
  USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" // USDC
};

const JUPITER_API = "https://quote-api.jup.ag/v6";

export const getDynamicPriorityFee = async (connection: Connection) => {
  const recentFees = await connection.getRecentPrioritizationFees();
  if (recentFees.length === 0) return 1000; // Fallback

  // Get the 50th percentile (median) fee to be competitive but not overpay
  const sortedFees = recentFees.map(f => f.prioritizationFee).sort((a, b) => a - b);
  const medianFee = sortedFees[Math.floor(sortedFees.length * 0.5)] || 0;

  // Minimum of 5000 to ensure landing
  return Math.max(medianFee, 5000);
};

export const getSwapTransaction = async (
  wallet: Keypair,
  inputMint: string,
  outputMint: string,
  amountInLamports: number,
  priorityFee: number
) => {
  // 1. Get the best price (Quote)
  const quoteResponse = await fetch(
    `${JUPITER_API}/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountInLamports}&slippageBps=50`
  ).then(res => res.json());

  // 2. Get the serialized transaction
  const response = await fetch(`${JUPITER_API}/swap`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      quoteResponse,
      userPublicKey: wallet.publicKey.toString(),
      wrapAndUnwrapSol: true,
      // 2026 Pro Tip: Set high priority to beat other bots
      computeUnitPriceMicroLamports: priorityFee
    })
  });

  const { swapTransaction, error } = await response.json();
  if (error) {
     console.error("Jupiter Swap API Error:", error);
     return null;
  }

  return swapTransaction;
};

export const signAndSend = async (connection: Connection, wallet: Keypair, swapTransaction: string) => {
  // 3. Deserialize and Sign
  const swapTransactionBuf = Buffer.from(swapTransaction, 'base64');
  var transaction = VersionedTransaction.deserialize(swapTransactionBuf);
  transaction.sign([wallet]);

  // 4. Execute and Await Confirmation
  const latestBlockhash = await connection.getLatestBlockhash();

  console.log(`🚀 Sending Trade...`);
  const txid = await connection.sendTransaction(transaction);
  console.log(`⏳ Awaiting Confirmation...`);

  const confirmation = await connection.confirmTransaction({
    signature: txid,
    blockhash: latestBlockhash.blockhash,
    lastValidBlockHeight: latestBlockhash.lastValidBlockHeight
  });

  if (confirmation.value.err) {
     throw new Error(`Transaction Failed: ${confirmation.value.err}`);
  }

  console.log(`✅ Trade Confirmed! View on Solscan: https://solscan.io/tx/${txid}`);

  // Update Trade count
  totalTrades++;
};

if (!PRIVATE_KEY) {
  console.warn("WARNING: PHANTOM_PRIVATE_KEY is not set in the .env file. The bot will not be able to execute trades.");
}

if (!OPENAI_API_KEY) {
  console.warn("WARNING: OPENAI_API_KEY is not set. The bot's AI decision making will fail.");
}

if (!BIRDEYE_API_KEY) {
  console.warn("WARNING: BIRDEYE_API_KEY is not set. Token trend analysis will fail.");
}

export interface SecurityReport {
  isSafe: boolean;
  reason?: string;
}

export const checkRugCheck = async (mintAddress: string) => {
  try {
    const response = await fetch(`https://api.rugcheck.xyz/v1/tokens/${mintAddress}/report/summary`);
    if (!response.ok) {
      console.warn(`⚠️ Could not reach RugCheck API for ${mintAddress}. Proceeding with caution.`);
      return true; // Default to true if API is down, but you might want this to be false in production
    }

    const data = await response.json();

    // Some endpoints return 'score', others might return a different structure.
    // Based on common rugcheck summary formats:
    const trustScore = data?.score || 0;

    if (trustScore < 80) {
      console.warn(`🚨 WARNING: Mint ${mintAddress} has a low RugCheck Trust Score (${trustScore}/100).`);
      return false; // Unsafe
    }

    console.log(`✅ Mint ${mintAddress} has a good RugCheck Trust Score (${trustScore}/100).`);
    return true; // Safe
  } catch (error: any) {
    console.error(`Error fetching RugCheck score for ${mintAddress}:`, error?.message || error);
    return false; // Fail safe: Assume unsafe if we error out
  }
};

export const checkTokenSafety = async (
  connection: Connection,
  mintAddress: string
): Promise<SecurityReport> => {
  try {
    const mint = new PublicKey(mintAddress);
    const accountInfo = await connection.getParsedAccountInfo(mint);

    const data = (accountInfo?.value?.data as ParsedAccountData)?.parsed?.info;

    if (!data) return { isSafe: false, reason: "Could not fetch mint data." };

    // 1. MINT AUTHORITY CHECK (Is it a "printer"?)
    // If this is NOT null, the creator can print infinite tokens and dump on you.
    if (data.mintAuthority !== null) {
      return { isSafe: false, reason: "Mint Authority is still ENABLED. (Infinite Supply Risk)" };
    }

    // 2. FREEZE AUTHORITY CHECK (Can they lock your funds?)
    // If this is NOT null, the creator can freeze your wallet so you can't sell.
    if (data.freezeAuthority !== null) {
      return { isSafe: false, reason: "Freeze Authority is still ENABLED. (Honeypot Risk)" };
    }

    // 3. TOKEN-2022 PERMANENT DELEGATE CHECK
    const ownerProgram = accountInfo?.value?.owner?.toBase58();
    if (ownerProgram === "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb") { // Token-2022 Program ID
      const extensions = (accountInfo?.value?.data as ParsedAccountData)?.parsed?.info?.extensions;
      if (extensions && Array.isArray(extensions)) {
        const hasPermanentDelegate = extensions.some((ext: any) => ext.extension === 'permanentDelegate');
        if (hasPermanentDelegate) {
          return { isSafe: false, reason: "Token-2022 Permanent Delegate is ENABLED. (Creator can drain your tokens)" };
        }
      }
    }

    // 4. LP BURN CHECK (2026 Strategy)
    // Note: For a true audit, Jules would check the Raydium/Orca LP pair
    // to ensure the Liquidity Provider tokens are sent to a "Dead" address.

    console.log(`✅ Mint ${mintAddress} passed all safety checks.`);
    return { isSafe: true };
  } catch (error: any) {
    console.error(`Error checking token safety for ${mintAddress}:`, error?.message || error);
    return { isSafe: false, reason: "Error parsing token data on-chain." };
  }
};

// Dashboard State
let initialBalanceSol = 0;
let currentBalanceSol = 0;
export let totalTrades = 0;

export const checkBalance = async (connection: Connection, publicKey: PublicKey) => {
  const balance = await connection.getBalance(publicKey);
  const balanceSol = balance / LAMPORTS_PER_SOL;

  if (initialBalanceSol === 0) {
    initialBalanceSol = balanceSol;
  }
  currentBalanceSol = balanceSol;

  return balance;
};

export const getTokenBalance = async (connection: Connection, walletAddress: PublicKey, mintAddress: PublicKey) => {
  try {
    const ata = await getAssociatedTokenAddress(mintAddress, walletAddress);
    const accountInfo = await getAccount(connection, ata);
    return Number(accountInfo.amount); // amount is in raw smallest units
  } catch (e) {
    // Return 0 if the ATA doesn't exist or isn't funded
    return 0;
  }
};

export const renderDashboard = () => {
  const profitLoss = currentBalanceSol - initialBalanceSol;
  const plPercentage = initialBalanceSol > 0 ? (profitLoss / initialBalanceSol) * 100 : 0;
  const plColor = profitLoss >= 0 ? '\x1b[32m' : '\x1b[31m'; // Green or Red
  const resetColor = '\x1b[0m';

  console.log(`\n=========================================`);
  console.log(`📈  JULES AI SOLANA TRADING DASHBOARD  📈`);
  console.log(`=========================================`);
  console.log(`Started Balance:   ${initialBalanceSol.toFixed(4)} SOL`);
  console.log(`Current Balance:   ${currentBalanceSol.toFixed(4)} SOL`);
  console.log(`Total Trades:      ${totalTrades}`);
  console.log(`Profit / Loss:     ${plColor}${profitLoss.toFixed(4)} SOL (${plPercentage.toFixed(2)}%)${resetColor}`);
  console.log(`=========================================\n`);
};

export const getPhantomWallet = () => {
  const privateKeyString = process.env.PHANTOM_PRIVATE_KEY;
  if (!privateKeyString) throw new Error("Missing PHANTOM_PRIVATE_KEY in .env");

  // Decode the Base58 string from Phantom into a Uint8Array
  const secretKey = bs58.decode(privateKeyString);
  return Keypair.fromSecretKey(secretKey);
};

export const fetchBirdeyeTrend = async (mintAddress: string) => {
  if (!BIRDEYE_API_KEY) {
    console.warn("Skipping Birdeye trend analysis because BIRDEYE_API_KEY is not set.");
    return null;
  }

  // Get UNIX timestamp in seconds for the last 5 minutes
  const now = Math.floor(Date.now() / 1000);
  const fiveMinsAgo = now - (5 * 60);

  try {
    const response = await fetch(`https://public-api.birdeye.so/defi/history_price?address=${mintAddress}&address_type=token&type=1m&time_from=${fiveMinsAgo}&time_to=${now}`, {
      headers: {
        'X-API-KEY': BIRDEYE_API_KEY,
        'Accept': 'application/json'
      }
    });

    const data = await response.json();
    if (data.success && data.data && data.data.items.length > 0) {
      console.log(`📊 5-Minute Trend for ${mintAddress}: Fetched ${data.data.items.length} price points.`);
      return data.data.items;
    } else {
      console.log(`📉 No recent trend data found for ${mintAddress} on Birdeye.`);
      return null;
    }
  } catch (error: any) {
    console.error(`Failed to fetch Birdeye trend for ${mintAddress}:`, error?.message || error);
    return null;
  }
};

export const checkPriceSpike = (trendData: any[]) => {
  if (!trendData || trendData.length < 2) return false;

  // We want to check for a 5% spike in the *last 1 minute*.
  // Since each data point is a 1-minute candle, we compare the current price (newest)
  // to the price from 1 minute ago.
  const priceOneMinAgo = trendData[trendData.length - 2].value;
  const newestPrice = trendData[trendData.length - 1].value;

  if (!priceOneMinAgo || !newestPrice || priceOneMinAgo === 0) return false;

  const percentIncrease = ((newestPrice - priceOneMinAgo) / priceOneMinAgo) * 100;

  if (percentIncrease >= 5) {
    console.log(`🚀 PRICE SPIKE DETECTED! Increased by ${percentIncrease.toFixed(2)}% in the last 1 minute.`);
    return true;
  }

  console.log(`📉 Normal movement. Price changed by ${percentIncrease.toFixed(2)}% in the last 1 minute.`);
  return false;
};


export const run = async () => {
  console.log("Starting Solana AI Trading Bot...");

  // 1. Setup Connection to Solana
  console.log(`Connecting to Solana via RPC: ${RPC_URL}`);
  const connection = new Connection(RPC_URL, 'confirmed');

  try {
    const version = await connection.getVersion();
    console.log("Connected successfully! Solana Core Version:", version['solana-core']);
  } catch (error: any) {
    console.error("Failed to connect to Solana RPC:", error?.message || error);
    return;
  }

  // 2. Setup Wallet & 3. Check Balance
  let wallet;
  try {
    wallet = getPhantomWallet();
    await checkBalance(connection, wallet.publicKey);
  } catch (error: any) {
     console.error("Wallet setup failed:", error?.message || error);
     console.log("Running in watch-only mode (No wallet configured).");
  }

  // 4. Initialize Jupiter API
  console.log("Initializing Jupiter API Client...");
  const jupiterQuoteApi = createJupiterApiClient();
  console.log("Jupiter API ready for use.");

  // 5. Start Sniping Event Listener
  if (wallet) {
    await startScanner(connection, async (mintAddress: string) => {
       console.log(`🔍 Checking Safety for Mint: ${mintAddress}...`);

       const securityReport = await checkTokenSafety(connection, mintAddress);

       if (securityReport.isSafe) {
         console.log(`✅ BOTTING: ${mintAddress}`);

         const isRugCheckSafe = await checkRugCheck(mintAddress);
         if (isRugCheckSafe) {
           console.log(`Fetching 1-minute Birdeye trend for ${mintAddress}...`);
           const trendData = await fetchBirdeyeTrend(mintAddress);
           if (trendData) {
             const isSpiking = checkPriceSpike(trendData);
             if (isSpiking) {
               console.log(`🎯 Triggering snipe trade for ${mintAddress}!`);
               const buySuccess = await executeSwap(jupiterQuoteApi, connection, wallet!, {
                 inputMint: TOKENS.SOL,
                 outputMint: mintAddress,
                 amount: 0.1 * LAMPORTS_PER_SOL // Sniper buys max 0.1 SOL immediately
               });

               if (buySuccess) {
                 // Fetch the current entry price to begin monitoring
                 const entryData = await fetch(`https://price.jup.ag/v4/price?ids=${mintAddress}`).then(res => res.json());
                 if (entryData.data && entryData.data[mintAddress]) {
                    const entryPrice = entryData.data[mintAddress].price;
                    const action = await monitorPosition(mintAddress, entryPrice, 20, 10);

                    if (action === "SELL") {
                        const tokenBalance = await getTokenBalance(connection, wallet.publicKey, new PublicKey(mintAddress));
                        if (tokenBalance > 0) {
                           console.log(`Selling full balance of ${mintAddress}`);
                           await executeSwap(jupiterQuoteApi, connection, wallet!, {
                             inputMint: mintAddress,
                             outputMint: TOKENS.SOL,
                             amount: tokenBalance // Sell entire bag back to SOL
                           });
                        }
                    }
                 }
               }
             }
           }
         } else {
           console.log(`🚫 Ignoring token ${mintAddress}: Failed RugCheck.xyz Trust Score.`);
         }
       } else {
         console.log(`❌ SKIPPING: ${securityReport.reason}`);
       }
    });
  }

  // 6. Bot Logic Loop
  if (wallet && OPENAI_API_KEY) {
    console.log("Starting AI Trading Loop...");
    await startTradingLoop(connection, wallet, jupiterQuoteApi);
  }
};

async function analyzeMarketAndDecide(jupiterQuoteApi: any) {
  if (!OPENAI_API_KEY) {
     console.error("No OPENAI_API_KEY configured. Skipping AI analysis.");
     return null;
  }

  // 1. Fetch Real Market Data (SOL/USDC Price)
  let solPriceData = "Unknown";
  try {
      const priceResponse = await fetch(`https://price.jup.ag/v4/price?ids=SOL`);
      const priceJson = await priceResponse.json();
      if (priceJson.data && priceJson.data.SOL) {
          solPriceData = priceJson.data.SOL.price;
          console.log(`Current SOL Price (Jupiter): $${solPriceData}`);
      }
  } catch(e: any) {
      console.error("Failed to fetch market data:", e?.message || e);
  }

  const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
  console.log("AI is analyzing the market...");

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4-turbo",
      messages: [
        {
          role: "system",
          content: "You are an expert Solana trading bot. Decide whether to BUY (swap USDC to SOL), SELL (swap SOL to USDC), or HOLD based on provided data. Output only valid JSON with 'action' (BUY, SELL, HOLD), and if action is not HOLD, include 'amount' (in lamports for SOL or micro-USDC for USDC)."
        },
        {
          role: "user",
          content: `The current price of SOL is $${solPriceData}. Market conditions are volatile. Analyze the price and decide on a strategy.`
        }
      ],
      response_format: { type: "json_object" }
    });

    const decisionStr = response.choices[0]?.message?.content;
    if (!decisionStr) return null;
    const aiDecision = JSON.parse(decisionStr);
    console.log("AI Decision:", aiDecision);

    if (aiDecision.action === "BUY") {
      return {
        action: "SWAP",
        inputMint: TOKENS.USDC,
        outputMint: TOKENS.SOL,
        amount: aiDecision.amount || 1000000 // 1 USDC
      };
    } else if (aiDecision.action === "SELL") {
      return {
        action: "SWAP",
        inputMint: TOKENS.SOL,
        outputMint: TOKENS.USDC,
        amount: aiDecision.amount || 10000000 // 0.01 SOL
      };
    } else {
       console.log("AI decided to HOLD.");
       return null;
    }
  } catch (error: any) {
     console.error("AI Analysis failed:", error?.message || error);
     return null;
  }
}

async function executeSwap(jupiterQuoteApi: any, connection: Connection, wallet: Keypair, decision: any) {
  let finalAmount = decision.amount;

  // Implement Max Buy Limit of 0.1 SOL per trade
  if (decision.inputMint === TOKENS.SOL) {
    const MAX_BUY_LAMPORTS = 0.1 * LAMPORTS_PER_SOL;
    if (finalAmount > MAX_BUY_LAMPORTS) {
      console.warn(`⚠️ Max Buy Limit Exceeded! Capping trade amount from ${finalAmount / LAMPORTS_PER_SOL} SOL to 0.1 SOL.`);
      finalAmount = MAX_BUY_LAMPORTS;
    }

    // MANDATORY SECURITY CHECK BEFORE BUYING A NEW TOKEN
    console.log(`🛡️  Checking safety for ${decision.outputMint} before executing swap...`);
    const securityReport = await checkTokenSafety(connection, decision.outputMint);

    if (!securityReport.isSafe) {
      console.error(`🚨 TRADE CANCELLED! Token ${decision.outputMint} is unsafe. Reason: ${securityReport.reason}`);
      return;
    }

    // MANDATORY RUGCHECK.XYZ TRUST SCORE CHECK
    console.log(`🛡️  Checking RugCheck score for ${decision.outputMint}...`);
    const isRugCheckSafe = await checkRugCheck(decision.outputMint);
    if (!isRugCheckSafe) {
       console.error(`🚨 TRADE CANCELLED! Token ${decision.outputMint} failed RugCheck.xyz Trust Score (< 80).`);
       return;
    }
  }

  console.log(`Executing Swap: ${finalAmount} from ${decision.inputMint} to ${decision.outputMint}`);

  try {
    const priorityFee = await getDynamicPriorityFee(connection);
    const swapTransaction = await getSwapTransaction(wallet, decision.inputMint, decision.outputMint, finalAmount, priorityFee);
    if (!swapTransaction) {
       console.error("Failed to obtain swap transaction from Jupiter.");
       return false;
    }

    await signAndSend(connection, wallet, swapTransaction);
    return true; // Successfully executed swap
  } catch (error) {
    console.error("Error executing swap:", error);
    return false;
  }
}

async function startTradingLoop(connection: Connection, wallet: Keypair, jupiterQuoteApi: any) {
  const loopDelay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

  // Sequential loop to prevent overlapping API calls
  while (true) {
    try {
      await checkBalance(connection, wallet.publicKey);
      renderDashboard();

      const decision = await analyzeMarketAndDecide(jupiterQuoteApi);
      if (decision && decision.action === "SWAP") {
        const buySuccess = await executeSwap(jupiterQuoteApi, connection, wallet, decision);

        // If we bought a token with SOL, monitor it
        if (buySuccess && decision.inputMint === TOKENS.SOL && decision.outputMint !== TOKENS.USDC) {
             const entryData = await fetch(`https://price.jup.ag/v4/price?ids=${decision.outputMint}`).then(res => res.json());
             if (entryData.data && entryData.data[decision.outputMint]) {
                const entryPrice = entryData.data[decision.outputMint].price;
                const action = await monitorPosition(decision.outputMint, entryPrice, 20, 10);

                if (action === "SELL") {
                    const tokenBalance = await getTokenBalance(connection, wallet.publicKey, new PublicKey(decision.outputMint));
                    if (tokenBalance > 0) {
                       console.log(`Selling full balance of ${decision.outputMint}`);
                       await executeSwap(jupiterQuoteApi, connection, wallet, {
                         inputMint: decision.outputMint,
                         outputMint: TOKENS.SOL,
                         amount: tokenBalance // Sell entire bag back to SOL
                       });
                    }
                }
             }
        }
      }
    } catch (error) {
      console.error("Error in trading loop:", error);
    }
    await loopDelay(10000); // Run every 10 seconds
  }
}

if (require.main === module) {
  run().catch(console.error);
}
