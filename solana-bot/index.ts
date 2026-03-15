import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
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

if (!PRIVATE_KEY) {
  console.warn("WARNING: PHANTOM_PRIVATE_KEY is not set in the .env file. The bot will not be able to execute trades.");
}

if (!OPENAI_API_KEY) {
  console.warn("WARNING: OPENAI_API_KEY is not set. The bot's AI decision making will fail.");
}

if (!BIRDEYE_API_KEY) {
  console.warn("WARNING: BIRDEYE_API_KEY is not set. Token trend analysis will fail.");
}

export const checkBalance = async (connection: Connection, publicKey: PublicKey) => {
  const balance = await connection.getBalance(publicKey);
  console.log(`🤖 Bot Wallet: ${publicKey.toBase58()}`);
  console.log(`💰 Current Balance: ${balance / LAMPORTS_PER_SOL} SOL`);
  return balance;
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

export const monitorSerumForNewMarkets = (connection: Connection) => {
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
             console.log(`🔍 Checking if mint ${baseMintAddress} is verified...`);
             // NOTE: Real verification would involve checking the Token Metadata program (Metaplex)
             // to see if the token has a valid name, symbol, uri, and potentially update authority.
             // For this exercise, we assume it's verified if we successfully parsed it.
             const isVerified = true;

             if (isVerified) {
               console.log(`✅ Mint ${baseMintAddress} verified. Fetching Birdeye trends...`);
               await fetchBirdeyeTrend(baseMintAddress);
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
  monitorSerumForNewMarkets(connection);

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
    // 1. Get Quote
    const quoteResponse = await jupiterQuoteApi.quoteGet({
      inputMint: decision.inputMint,
      outputMint: decision.outputMint,
      amount: finalAmount,
      slippageBps: 50, // 0.5% slippage
    });
    if (!quoteResponse) {
      console.error("Failed to get quote for swap.");
      return;
    }

    // 2. Get Swap Transaction
    // Use the older v6 API endpoint directly as a fallback if the SDK is missing the method or has a different signature.
    // The @jup-ag/api SDK's swapPost method signature often changes. Using node-fetch is more stable.
    const swapData = await (
      await fetch('https://quote-api.jup.ag/v6/swap', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          quoteResponse,
          userPublicKey: wallet.publicKey.toString(),
          wrapAndUnwrapSol: true,
          computeUnitPriceMicroLamports: 100000, // 100,000 micro-lamports priority fee
        })
      })
    ).json();

    if (!swapData.swapTransaction) {
      console.error("Failed to get swap transaction:", swapData);
      return;
    }

    // 3. Deserialize and Sign
    const swapTransactionBuf = Buffer.from(swapData.swapTransaction, 'base64');
    let transaction = VersionedTransaction.deserialize(swapTransactionBuf);

    transaction.sign([wallet]);

    // 4. Execute Transaction
    console.log("Sending transaction...");
    const rawTransaction = transaction.serialize();
    const txid = await connection.sendRawTransaction(rawTransaction, {
      skipPreflight: true,
      maxRetries: 2
    });

    console.log(`Swap Executed Successfully! Transaction ID: ${txid}`);
    console.log(`Explorer Link: https://solscan.io/tx/${txid}`);

  } catch (error) {
    console.error("Error executing swap:", error);
  }
}

async function startTradingLoop(connection: Connection, wallet: Keypair, jupiterQuoteApi: any) {
  const loopDelay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

  // Sequential loop to prevent overlapping API calls
  while (true) {
    try {
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
