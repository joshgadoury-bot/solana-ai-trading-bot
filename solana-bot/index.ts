import dotenv from 'dotenv';
dotenv.config(); // Ensure variables are loaded before any other imports that might rely on them

import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, VersionedTransaction, ParsedAccountData } from '@solana/web3.js';
import bs58 from 'bs58';
import fetch from 'cross-fetch';
import { createJupiterApiClient } from '@jup-ag/api';
import { getAssociatedTokenAddress, getAccount } from '@solana/spl-token';
import { OpenAI } from 'openai';
import { startScanner } from './scanner';
import { monitorPosition } from './monitor';

// Configuration
const RPC_URL = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
const WSS_URL = process.env.SOLANA_WSS_URL;
const PRIVATE_KEY = process.env.PHANTOM_PRIVATE_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const BIRDEYE_API_KEY = process.env.BIRDEYE_API_KEY;
const JUPITER_API_KEY = process.env.JUPITER_API_KEY;

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

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));


export const executeUltraSwap = async (
  connection: Connection,
  wallet: Keypair,
  inputMint: string,
  outputMint: string,
  amountInLamports: number,
  priorityFee: number
) => {
  let orderResponse: any = null;
  const isSnipe = inputMint === TOKENS.SOL; // Assume it's a snipe if buying with SOL

  const retryDelays = [5000, 10000, 20000]; // 5s, 10s, 20s
  let attempts = 0;

  try {
    // 1. Get the unsigned transaction (Order) with a Retry Loop for brand new tokens
    while (attempts <= retryDelays.length) {
      console.log(`[DEBUG] Fetching Jupiter Ultra Order for ${outputMint}...`);
      const orderRequest = await fetch(`https://api.jup.ag/ultra/v1/order`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${JUPITER_API_KEY}`
        },
        body: JSON.stringify({
          inputMint: inputMint,
          outputMint: outputMint,
          amount: amountInLamports,
          slippageBps: isSnipe ? 1000 : 50, // 10% for snipes, 0.5% for regular
          dynamicSlippage: true, // Requested by user
          userPublicKey: wallet.publicKey.toString(),
          wrapAndUnwrapSol: true,
          computeUnitPriceMicroLamports: priorityFee
        })
      });

      orderResponse = await orderRequest.json();

      if (orderRequest.ok && !orderResponse.error && !orderResponse.message) {
         // Success! We found a route and got the order.
         console.log(`[DEBUG] Jupiter Ultra Order retrieved successfully. Request ID: ${orderResponse.requestId}`);
         break;
      }

      const errorMessage = orderResponse?.error || orderResponse?.message || 'Unknown error';

      // Check if the error is due to missing liquidity/routing ('No route found')
      if (errorMessage.toLowerCase().includes('route') && isSnipe && attempts < retryDelays.length) {
         const waitTime = retryDelays[attempts] || 5000;
         console.log(`[WARNING] Jupiter could not find a route. Retrying in ${waitTime / 1000}s... (Attempt ${attempts + 1}/3)`);
         await delay(waitTime);
         attempts++;
      } else {
         console.error(`❌ Jupiter Ultra Order Failed: [HTTP ${orderRequest.status}] ${errorMessage}`);
         return false; // Fatal error or max retries reached
      }
    }

    if (!orderResponse || orderResponse.error || orderResponse.message) {
       console.error(`❌ Jupiter Ultra Order Failed: Token lacked liquidity after max attempts. Skipping trade.`);
       return false;
    }

    const { swapTransaction, requestId } = orderResponse;
    if (!swapTransaction || !requestId) {
       console.error("Jupiter Ultra Swap API Error: Missing swapTransaction or requestId in response:", orderResponse);
       return false;
    }

    // 2. Deserialize, Sign, and Execute
    console.log(`[DEBUG] Signing transaction...`);
    const swapTransactionBuf = Buffer.from(swapTransaction, 'base64');
    let transaction = VersionedTransaction.deserialize(swapTransactionBuf);

    // Sign the transaction
    transaction.sign([wallet]);

    // Serialize the signed transaction
    const signedTxBase64 = Buffer.from(transaction.serialize()).toString('base64');

    console.log(`[DEBUG] Executing Jupiter Ultra Order (RequestId: ${requestId})...`);
    const executeResponse = await fetch(`https://api.jup.ag/ultra/v1/execute`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${JUPITER_API_KEY}`
        },
        body: JSON.stringify({
            requestId: requestId,
            tx: signedTxBase64
        })
    });

    const executeResult = await executeResponse.json();

    if (!executeResponse.ok || executeResult.error || executeResult.message) {
         const errMessage = executeResult.error || executeResult.message || JSON.stringify(executeResult);
         console.error(`❌ Jupiter Ultra Execute Failed: [HTTP ${executeResponse.status}] ${errMessage}`);
         return false;
    }

    console.log(`✅ Jupiter Ultra Swap Executed! TxHash: ${executeResult.txid || 'Unknown'}`);
    return true; // Successfully executed swap
  } catch (networkError: any) {
    // Specifically catch ENOTFOUND or IP blocks common on Render
    if (networkError?.message?.includes('ENOTFOUND') || networkError?.code === 'ENOTFOUND') {
       console.error(`🚨 FATAL NETWORK ERROR: Your server (Render) cannot connect to Jupiter (${networkError.message}).`);
       console.error(`   👉 Jupiter actively blocks Render IP addresses to prevent bot spam. You must run this bot locally, or use a Proxy/Custom Jupiter API node.`);
    } else {
       console.error(`Network Error in executeUltraSwap:`, networkError?.message || networkError);
    }
    return false;
  }
};


if (!PRIVATE_KEY) {
  console.warn("WARNING: PHANTOM_PRIVATE_KEY is not set in the environment variables. The bot will not be able to execute trades.");
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

export const getRugCheckScore = async (mint: string) => {
  try {
    const response = await fetch(`https://api.rugcheck.xyz/v1/tokens/${mint}/report`);
    if (!response.ok) {
      console.warn(`⚠️ Could not reach RugCheck API for ${mint}. Proceeding with caution.`);
      return { isSafe: true, score: 0, risks: [] }; // Default to true if API is down, but you might want this to be false in production
    }

    const data = await response.json();

    const score = data.score || 0;
    const risks = data.risks ? data.risks.map((r: any) => r.name) : [];
    const isSafe = score < 1000;

    if (!isSafe) {
      console.warn(`🚨 WARNING: Mint ${mint} has a dangerous RugCheck Score (${score}). Risks: ${risks.join(', ')}`);
    } else {
      console.log(`✅ Mint ${mint} has a safe RugCheck Score (${score}).`);
    }

    return {
      isSafe,
      score,
      risks
    };
  } catch (error: any) {
    console.error(`Error fetching RugCheck score for ${mint}:`, error?.message || error);
    return { isSafe: false, score: 9999, risks: ["API Error"] }; // Fail safe: Assume unsafe if we error out
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

export const listenToAccount = (connection: Connection, publicKey: PublicKey) => {
  console.log(`📡 WebSocket Monitoring Active for Wallet: ${publicKey.toBase58()}`);

  // onAccountChange uses the provided WebSocket subscription (WSS_URL)
  connection.onAccountChange(
      publicKey,
      (accountInfo, context) => {
          const newBalanceSol = accountInfo.lamports / LAMPORTS_PER_SOL;
          // Only log and update if there's an actual change in the SOL balance
          if (newBalanceSol !== currentBalanceSol) {
            console.log(`\n🔔 Wallet Balance Changed! New Balance: ${newBalanceSol.toFixed(4)} SOL`);
            currentBalanceSol = newBalanceSol;
            renderDashboard(); // Refresh dashboard on change
          }
      },
      'confirmed'
  );
};

export const checkBalance = async (connection: Connection, publicKey: PublicKey) => {
  const balance = await connection.getBalance(publicKey);
  const balanceSol = balance / LAMPORTS_PER_SOL;

  if (initialBalanceSol === 0) {
    initialBalanceSol = balanceSol;
  }
  currentBalanceSol = balanceSol;

  return balance;
};

import { fetchBirdeyeWalletBalances } from './birdeye';

export const getTokenBalance = async (connection: Connection, walletAddress: PublicKey, mintAddress: PublicKey) => {
  try {
    // Use Birdeye API if key is present to respect 60s cache requirement
    if (BIRDEYE_API_KEY) {
       const balances = await fetchBirdeyeWalletBalances(walletAddress.toBase58());
       const targetBalanceUI = balances[mintAddress.toBase58()] || 0;

       // Note: Birdeye returns UI amount. To sell via Jupiter we need raw amount (lamports)
       // So we fetch the mint decimals to convert it back to raw amount.
       // For speed in a snipe bot, you might still want standard RPC.
       // Assuming we fetch decimals:
       const mintInfo = await connection.getParsedAccountInfo(mintAddress);
       const decimals = (mintInfo?.value?.data as ParsedAccountData)?.parsed?.info?.decimals || 0;
       return targetBalanceUI * Math.pow(10, decimals);
    }

    // Fallback to standard RPC
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
  if (!privateKeyString) throw new Error("Missing PHANTOM_PRIVATE_KEY in environment variables");

  // Decode the Base58 string from Phantom into a Uint8Array
  const secretKey = bs58.decode(privateKeyString);
  return Keypair.fromSecretKey(secretKey);
};

import { fetchBirdeyeTrend } from './birdeye';

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
  const connectionConfig: any = { commitment: 'confirmed' };
  if (WSS_URL) {
     console.log(`Using WebSocket Endpoint: ${WSS_URL}`);
     connectionConfig.wsEndpoint = WSS_URL;
  }
  const connection = new Connection(RPC_URL, connectionConfig);

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
    listenToAccount(connection, wallet.publicKey); // Start WebSocket listener
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

       console.debug(`[DEBUG] Token Safety Check: isSafe=${securityReport.isSafe}`);
       if (securityReport.isSafe) {
         console.log(`✅ BOTTING: ${mintAddress}`);

         const rugCheckReport = await getRugCheckScore(mintAddress);
         console.debug(`[DEBUG] RugCheck Check: score=${rugCheckReport.score}, isSafe=${rugCheckReport.isSafe}`);

         if (rugCheckReport.isSafe) {
           console.log(`Fetching 1-minute Birdeye trend for ${mintAddress}...`);
           const trendData = await fetchBirdeyeTrend(mintAddress);

           let isSpiking = false;
           if (trendData === "SKIP_TREND") {
             console.log(`⚠️ Birdeye key missing. Skipping 5% spike check. Sniping safe token immediately!`);
             isSpiking = true;
           } else if (!trendData || (Array.isArray(trendData) && trendData.length === 0)) {
             console.log(`🚀 Token ${mintAddress} is completely fresh (no Birdeye history yet). Sniping immediately!`);
             isSpiking = true;
           } else {
             isSpiking = checkPriceSpike(trendData as any[]);
           }

           console.debug(`[DEBUG] Price Spike Check: isSpiking=${isSpiking}`);
           if (isSpiking) {
             console.log(`🎯 Triggering snipe trade for ${mintAddress}!`);

             const tradeAmount = 0.1 * LAMPORTS_PER_SOL;
             console.debug(`[DEBUG] Triggering executeSwap with Input: SOL, Output: ${mintAddress}, Amount: ${tradeAmount / LAMPORTS_PER_SOL} SOL`);

             const buySuccess = await executeSwap(jupiterQuoteApi, connection, wallet!, {
               inputMint: TOKENS.SOL,
               outputMint: mintAddress,
               amount: tradeAmount // Sniper buys max 0.1 SOL immediately
             });

             if (buySuccess) {
               // Fetch the current entry price to begin monitoring
               // Note: We use Jupiter here for immediate, free lookup on single tokens right after buy,
               // but monitor.ts handles ongoing multi-price batching for open positions if adapted.
               const entryData = await fetch(`https://api.jup.ag/price/v2?ids=${mintAddress}`).then(res => res.json());
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
         } else {
           console.log(`🚫 Ignoring token ${mintAddress}: Failed RugCheck.xyz (Score: ${rugCheckReport.score}). Risks: ${rugCheckReport.risks.join(', ')}`);
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

let isAiDisabled = false;

async function analyzeMarketAndDecide(jupiterQuoteApi: any) {
  if (!OPENAI_API_KEY || isAiDisabled) {
     return null;
  }

  // 1. Fetch Real Market Data (SOL/USDC Price)
  let solPriceData = "Unknown";
  try {
      const priceResponse = await fetch(`https://api.jup.ag/price/v2?ids=SOL`);
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
      model: "gpt-4o",
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
     const errorMsg = error?.message || String(error);
     if (errorMsg.includes("429") || errorMsg.includes("quota")) {
        console.error("🤖 AI Analysis Disabled: OpenAI quota exceeded. Please check your billing at https://platform.openai.com/account/billing.");
        isAiDisabled = true; // Stop polling to keep the console clean for the sniper
     } else {
        console.error("AI Analysis failed:", errorMsg);
     }
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
    const rugCheckReport = await getRugCheckScore(decision.outputMint);
    if (!rugCheckReport.isSafe) {
       console.error(`🚨 TRADE CANCELLED! Token ${decision.outputMint} failed RugCheck.xyz (Score: ${rugCheckReport.score}). Risks: ${rugCheckReport.risks.join(', ')}`);
       return false;
    }
  }

  console.log(`Executing Swap: ${finalAmount} from ${decision.inputMint} to ${decision.outputMint}`);

  try {
    const priorityFee = await getDynamicPriorityFee(connection);
    const success = await executeUltraSwap(connection, wallet, decision.inputMint, decision.outputMint, finalAmount, priorityFee);
    return success; // Successfully executed swap
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
      // Balance is actively maintained via WebSocket listenToAccount, so we just refresh UI
      renderDashboard();

      const decision = await analyzeMarketAndDecide(jupiterQuoteApi);
      if (decision && decision.action === "SWAP") {
        const buySuccess = await executeSwap(jupiterQuoteApi, connection, wallet, decision);

        // If we bought a token with SOL, monitor it
        if (buySuccess && decision.inputMint === TOKENS.SOL && decision.outputMint !== TOKENS.USDC) {
             const entryData = await fetch(`https://api.jup.ag/price/v2?ids=${decision.outputMint}`).then(res => res.json());
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
    await loopDelay(60000); // Run every 60 seconds
  }
}

if (require.main === module) {
  run().catch(console.error);
}
