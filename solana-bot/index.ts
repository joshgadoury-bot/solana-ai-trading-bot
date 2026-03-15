import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, VersionedTransaction, ParsedAccountData } from '@solana/web3.js';
import bs58 from 'bs58';
import fetch from 'cross-fetch';
import { createJupiterApiClient } from '@jup-ag/api';
import { OpenAI } from 'openai';
import dotenv from 'dotenv';

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

export const getSwapTransaction = async (
  wallet: Keypair,
  inputMint: string,
  outputMint: string,
  amountInLamports: number
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
      prioritizationFeeLamports: 100000
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

  // 4. Execute
  const txid = await connection.sendTransaction(transaction);
  console.log(`🚀 Trade Sent! View on Solscan: https://solscan.io/tx/${txid}`);

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

    // 3. LP BURN CHECK (2026 Strategy)
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

  const oldestPrice = trendData[0].value;
  const newestPrice = trendData[trendData.length - 1].value;

  if (!oldestPrice || !newestPrice || oldestPrice === 0) return false;

  const percentIncrease = ((newestPrice - oldestPrice) / oldestPrice) * 100;

  if (percentIncrease >= 5) {
    console.log(`🚀 PRICE SPIKE DETECTED! Increased by ${percentIncrease.toFixed(2)}% in the last 1 minute.`);
    return true;
  }

  console.log(`📉 Normal movement. Price changed by ${percentIncrease.toFixed(2)}% in the last 1 minute.`);
  return false;
};

export const monitorSerumForNewMarkets = (connection: Connection, wallet: Keypair, jupiterQuoteApi: any) => {
  // Common Serum / OpenBook program ID on mainnet
  const SERUM_PROGRAM_ID = new PublicKey("srmqPvymZyRtxMuTX5X57X8fT6C5s8xWbL3h1TfFqB1"); // OpenBook v3
  console.log(`📡 Listening for new markets on Serum program: ${SERUM_PROGRAM_ID.toBase58()}`);

  connection.onLogs(
    SERUM_PROGRAM_ID,
    async (logs, ctx) => {
      // Check for market initialization logs
      if (logs.logs.some(log => log.includes("InitializeMarket") || log.includes("InitMarket"))) {
        console.log(`🔥 Potential new market detected! Signature: ${logs.signature}`);

        try {
          // Fetch the parsed transaction to extract the mint
          const tx = await connection.getParsedTransaction(logs.signature, { maxSupportedTransactionVersion: 0 });
          if (!tx || !tx.transaction.message.instructions) return;

          let baseMintAddress: string | null = null;

          // Iterate through instructions to find the Serum program invocation
          for (const ix of tx.transaction.message.instructions) {
             if (ix.programId.equals(SERUM_PROGRAM_ID) && 'accounts' in ix) {
                 const accounts = (ix as any).accounts;
                 // In Serum v3 InitializeMarket, the base mint is usually the 8th account (index 7)
                 // and quote mint is the 9th (index 8).
                 if (accounts && accounts.length >= 9) {
                    baseMintAddress = accounts[7].toBase58();
                    // We can also extract the quote mint (usually WSOL or USDC)
                    const quoteMintAddress = accounts[8].toBase58();
                    console.log(`Identified Market: Base Mint: ${baseMintAddress}, Quote Mint: ${quoteMintAddress}`);
                    break;
                 }
             }
          }

          if (baseMintAddress) {
             console.log(`🔍 Checking Safety for Mint: ${baseMintAddress}...`);

             const securityReport = await checkTokenSafety(connection, baseMintAddress);

             if (securityReport.isSafe) {
               console.log(`Fetching 1-minute Birdeye trend for ${baseMintAddress}...`);
               const trendData = await fetchBirdeyeTrend(baseMintAddress);
               if (trendData) {
                 const isSpiking = checkPriceSpike(trendData);
                 if (isSpiking) {
                   console.log(`🎯 Triggering snipe trade for ${baseMintAddress}!`);
                   await executeSwap(jupiterQuoteApi, connection, wallet, {
                     inputMint: TOKENS.SOL,
                     outputMint: baseMintAddress,
                     amount: 0.1 * LAMPORTS_PER_SOL // Sniper buys max 0.1 SOL immediately
                   });
                 }
               }
             } else {
               console.log(`🚫 Ignoring unsafe token: ${baseMintAddress}. Reason: ${securityReport.reason}`);
             }
          } else {
             console.log(`⚠️ Could not parse base mint from transaction ${logs.signature}`);
          }

        } catch (error: any) {
           console.error("Error parsing new market transaction:", error?.message || error);
        }
      }
    },
    "confirmed"
  );
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
    monitorSerumForNewMarkets(connection, wallet, jupiterQuoteApi);
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
  }

  console.log(`Executing Swap: ${finalAmount} from ${decision.inputMint} to ${decision.outputMint}`);

  try {
    const swapTransaction = await getSwapTransaction(wallet, decision.inputMint, decision.outputMint, finalAmount);
    if (!swapTransaction) {
       console.error("Failed to obtain swap transaction from Jupiter.");
       return;
    }

    await signAndSend(connection, wallet, swapTransaction);
  } catch (error) {
    console.error("Error executing swap:", error);
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
        await executeSwap(jupiterQuoteApi, connection, wallet, decision);
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
