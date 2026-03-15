const { Connection, Keypair } = require('@solana/web3.js');
const bs58 = require('bs58');
const { createJupiterApiClient } = require('@jup-ag/api');
const { OpenAI } = require('openai');
require('dotenv').config();

// Configuration
const RPC_URL = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
const PRIVATE_KEY = process.env.SOLANA_PRIVATE_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// Constants (Tokens)
const TOKENS = {
  SOL: "So11111111111111111111111111111111111111112", // Wrapped SOL
  USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" // USDC
};

if (!PRIVATE_KEY) {
  console.warn("WARNING: SOLANA_PRIVATE_KEY is not set in the .env file. The bot will not be able to execute trades.");
}

if (!OPENAI_API_KEY) {
  console.warn("WARNING: OPENAI_API_KEY is not set. The bot's AI decision making will fail.");
}

async function checkBalance(connection, wallet) {
  if (!wallet) return;
  try {
    const balance = await connection.getBalance(wallet.publicKey);
    console.log(`Current Balance: ${(balance / 1e9).toFixed(4)} SOL`);
  } catch (error) {
    console.error("Failed to check balance:", error.message);
  }
}

function setupWallet(privateKeyString) {
  if (!privateKeyString) {
    return null;
  }

  try {
    // Phantom wallet exports private keys as base58 encoded strings.
    const secretKey = bs58.decode(privateKeyString);
    const keypair = Keypair.fromSecretKey(secretKey);
    console.log(`Wallet connected: ${keypair.publicKey.toBase58()}`);
    return keypair;
  } catch (error) {
    console.error("Invalid private key provided! Ensure it is a valid base58 string.");
    return null;
  }
}

async function main() {
  console.log("Starting Solana AI Trading Bot...");

  // 1. Setup Connection to Solana
  console.log(`Connecting to Solana via RPC: ${RPC_URL}`);
  const connection = new Connection(RPC_URL, 'confirmed');

  try {
    const version = await connection.getVersion();
    console.log("Connected successfully! Solana Core Version:", version['solana-core']);
  } catch (error) {
    console.error("Failed to connect to Solana RPC:", error.message);
    return;
  }

  // 2. Setup Wallet
  const wallet = setupWallet(PRIVATE_KEY);
  if (!wallet) {
    console.log("Running in watch-only mode (No wallet configured).");
  } else {
    // 3. Check Balance
    await checkBalance(connection, wallet);
  }

  // 4. Initialize Jupiter API
  console.log("Initializing Jupiter API Client...");
  const jupiterQuoteApi = createJupiterApiClient();
  console.log("Jupiter API ready for use.");

  // 5. Bot Logic Loop
  if (wallet && OPENAI_API_KEY) {
    console.log("Starting AI Trading Loop...");
    await startTradingLoop(connection, wallet, jupiterQuoteApi);
  }
}

async function analyzeMarketAndDecide(jupiterQuoteApi) {
  if (!OPENAI_API_KEY) {
     console.error("No OPENAI_API_KEY configured. Skipping AI analysis.");
     return null;
  }

  // 1. Fetch Real Market Data (SOL/USDC Price)
  let solPriceData = "Unknown";
  try {
      const priceResponse = await fetch(`https://price.jup.ag/v6/price?ids=SOL`);
      const priceJson = await priceResponse.json();
      if (priceJson.data && priceJson.data.SOL) {
          solPriceData = priceJson.data.SOL.price;
          console.log(`Current SOL Price (Jupiter): $${solPriceData}`);
      }
  } catch(e) {
      console.error("Failed to fetch market data:", e.message);
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

    const decisionStr = response.choices[0].message.content;
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
  } catch (error) {
     console.error("AI Analysis failed:", error.message);
     return null;
  }
}

const { VersionedTransaction } = require('@solana/web3.js');

async function executeSwap(jupiterQuoteApi, connection, wallet, decision) {
  console.log(`Executing Swap: ${decision.amount} from ${decision.inputMint} to ${decision.outputMint}`);

  try {
    // 1. Get Quote
    const quoteResponse = await jupiterQuoteApi.quoteGet({
      inputMint: decision.inputMint,
      outputMint: decision.outputMint,
      amount: decision.amount,
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

async function startTradingLoop(connection, wallet, jupiterQuoteApi) {
  // Simple periodic loop
  setInterval(async () => {
    try {
      const decision = await analyzeMarketAndDecide(jupiterQuoteApi);
      if (decision && decision.action === "SWAP") {
        await executeSwap(jupiterQuoteApi, connection, wallet, decision);
      }
    } catch (error) {
      console.error("Error in trading loop:", error);
    }
  }, 10000); // Run every 10 seconds
}

if (require.main === module) {
  main().catch(console.error);
}

module.exports = {
  main,
  setupWallet,
  checkBalance,
  analyzeMarketAndDecide,
  executeSwap
};
