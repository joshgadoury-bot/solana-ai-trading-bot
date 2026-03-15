import { Connection, PublicKey, ParsedTransactionWithMeta } from '@solana/web3.js';

const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

async function fetchMintFromTx(connection: Connection, signature: string): Promise<string | null> {
  try {
    const tx: ParsedTransactionWithMeta | null = await connection.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0 });
    if (!tx || !tx.transaction || !tx.transaction.message || !tx.transaction.message.accountKeys) return null;

    // The first account created in an InitializeMint tx is usually the Mint address
    // It's often at index 1 because index 0 is the fee payer
    const accountKeys = tx.transaction.message.accountKeys;
    if (accountKeys && accountKeys.length > 1 && accountKeys[1] && accountKeys[1].pubkey) {
      return accountKeys[1].pubkey.toString();
    }
    return null;
  } catch (error: any) {
    console.error(`Error parsing new token transaction ${signature}:`, error?.message || error);
    return null;
  }
}

export const startScanner = (connection: Connection, callback: (mint: string) => void) => {
  console.log("🔭 Scanner active. Monitoring for new token launches...");

  // We listen to the SPL Token Program for the "InitializeMint" instruction
  connection.onLogs(
    TOKEN_PROGRAM_ID,
    ({ logs, signature, err }) => {
      if (err) return;

      // Check if the log contains the 'InitializeMint' command
      if (logs.some((log: string) => log.includes("InitializeMint"))) {
        console.log(`✨ New Token Detected! Signature: ${signature}`);

        fetchMintFromTx(connection, signature).then(mint => {
          if (mint) {
             console.log(`Identified New Token Mint: ${mint}`);
             callback(mint);
          } else {
             console.log(`⚠️ Could not parse base mint from transaction ${signature}`);
          }
        });
      }
    },
    "confirmed"
  );
};
