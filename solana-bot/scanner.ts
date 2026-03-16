import { Connection, PublicKey, ParsedTransactionWithMeta } from '@solana/web3.js';
import bs58 from 'bs58';
import Client from '@triton-one/yellowstone-grpc';

const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const GRPC_ENDPOINT = process.env.GRPC_ENDPOINT;

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function fetchWithBackoff<T>(
  action: () => Promise<T>,
  maxRetries = 3,
  initialDelayMs = 1000
): Promise<T | null> {
  let attempt = 0;
  while (attempt < maxRetries) {
    try {
      return await action();
    } catch (error: any) {
      if (error?.message?.includes('429')) {
        const backoffTime = initialDelayMs * Math.pow(2, attempt);
        console.warn(`⚠️ Rate limit (429) hit. Retrying in ${backoffTime}ms...`);
        await delay(backoffTime);
        attempt++;
      } else {
        throw error;
      }
    }
  }
  console.error(`❌ Exhausted all ${maxRetries} retries for RPC request.`);
  return null;
}

// A simple queue to prevent parallel getParsedTransaction spam
let isFetching = false;
const queue: string[] = [];

async function processQueue(connection: Connection, callback: (mint: string) => void) {
  if (isFetching || queue.length === 0) return;
  isFetching = true;

  while (queue.length > 0) {
    const signature = queue.shift();
    if (!signature) continue;

    try {
      // Small 500ms baseline delay to respect standard RPC limits
      await delay(500);

      const tx = await fetchWithBackoff(async () => {
        return await connection.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0 });
      });

      if (!tx || !tx.transaction || !tx.transaction.message || !tx.transaction.message.accountKeys) {
        console.log(`⚠️ Could not parse base mint from transaction ${signature}`);
        continue;
      }

      const accountKeys = tx.transaction.message.accountKeys;
      if (accountKeys && accountKeys.length > 1 && accountKeys[1] && accountKeys[1].pubkey) {
        const mint = accountKeys[1].pubkey.toString();
        console.log(`Identified New Token Mint: ${mint}`);
        callback(mint);
      } else {
        console.log(`⚠️ Could not parse base mint from transaction ${signature}`);
      }
    } catch (error: any) {
      console.error(`Error parsing new token transaction ${signature}:`, error?.message || error);
    }
  }

  isFetching = false;
}

export const startGrpcScanner = async (callback: (mint: string) => void) => {
  if (!GRPC_ENDPOINT) return;

  console.log(`⚡ Initializing sub-100ms gRPC scanner via ${GRPC_ENDPOINT}...`);

  const client = new Client(GRPC_ENDPOINT, undefined, undefined);

  const stream = await client.subscribe();

  stream.on("data", (data) => {
     if (data.transaction && data.transaction.transaction && data.transaction.transaction.signature) {
        const signatureBuffer = data.transaction.transaction.signature;
        const signature = bs58.encode(signatureBuffer);

        // Ensure there are log messages in the transaction meta
        const meta = data.transaction.transaction.meta;
        if (!meta || !meta.logMessages || meta.err) return;

        // Check if logs indicate a new token mint
        if (meta.logMessages.some((log: string) => log.includes("InitializeMint"))) {
           console.log(`⚡ [gRPC] New Token Detected! Signature: ${signature}`);

           // In a gRPC payload from Yellowstone, we don't need a secondary HTTP fetch.
           // The parsed accounts are included directly in the stream payload.
           const accountKeys = data.transaction.transaction.transaction.message.accountKeys;
           // The newly initialized mint is usually the second account (index 1) in the transaction.
           if (accountKeys && accountKeys.length > 1) {
              const mintPubkeyBuf = accountKeys[1];
              const mint = bs58.encode(mintPubkeyBuf);
              console.log(`⚡ [gRPC] Identified New Token Mint: ${mint}`);
              callback(mint);
           }
        }
     }
  });

  stream.on("error", (error) => {
    console.error("gRPC stream error:", error);
  });

  // Create a filter to only stream transactions that mention the Token Program
  const req = {
    accounts: {},
    slots: {},
    transactions: {
      new_tokens: {
        vote: false,
        failed: false,
        accountInclude: [TOKEN_PROGRAM_ID.toBase58()],
        accountExclude: [],
        accountRequired: []
      }
    },
    blocks: {},
    blocksMeta: {},
    entry: {},
    commitment: 1 // 1 for confirmed
  };

  await new Promise<void>((resolve, reject) => {
    stream.write(req, (err: any) => {
      if (err) {
        console.error("Failed to subscribe to gRPC:", err);
        reject(err);
      } else {
        console.log("⚡ gRPC Subscription active.");
        resolve();
      }
    });
  });
};

export const startScanner = async (connection: Connection, callback: (mint: string) => void) => {
  if (GRPC_ENDPOINT) {
     await startGrpcScanner(callback);
     return;
  }

  console.log("🔭 Standard RPC Scanner active. Monitoring for new token launches...");

  // We listen to the SPL Token Program for the "InitializeMint" instruction
  connection.onLogs(
    TOKEN_PROGRAM_ID,
    ({ logs, signature, err }) => {
      if (err) return;

      // Check if the log contains the 'InitializeMint' command
      if (logs.some((log: string) => log.includes("InitializeMint"))) {
        console.log(`✨ New Token Detected! Signature: ${signature} (Added to Queue)`);

        // Push to queue to rate limit RPC calls
        queue.push(signature);
        processQueue(connection, callback);
      }
    },
    "confirmed"
  );
};
