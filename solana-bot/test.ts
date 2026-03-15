import assert from 'assert';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { getPhantomWallet } from './index';

console.log("Running Tests...");

// Test 1: getPhantomWallet with valid base58 key
function testValidKey() {
  // Generate a random keypair and encode its secret to base58
  const keypair = Keypair.generate();
  const base58Secret = bs58.encode(keypair.secretKey);

  // Temporarily set the env var for the test
  const originalEnv = process.env.PHANTOM_PRIVATE_KEY;
  process.env.PHANTOM_PRIVATE_KEY = base58Secret;

  const wallet = getPhantomWallet();
  process.env.PHANTOM_PRIVATE_KEY = originalEnv;

  assert(wallet !== null, "Wallet should not be null for valid key");
  assert.strictEqual(wallet.publicKey.toBase58(), keypair.publicKey.toBase58(), "Public keys should match");
  console.log("✅ testValidKey passed");
}

// Test 2: getPhantomWallet with invalid key throws error
function testInvalidKey() {
  const originalEnv = process.env.PHANTOM_PRIVATE_KEY;
  process.env.PHANTOM_PRIVATE_KEY = "invalid_base58_string_here!!!";

  let didThrow = false;
  try {
     getPhantomWallet();
  } catch (e: any) {
     didThrow = true;
  }

  process.env.PHANTOM_PRIVATE_KEY = originalEnv; // Restore env

  assert(didThrow, "getPhantomWallet should throw error for invalid key");
  console.log("✅ testInvalidKey passed");
}

// Test 3: getPhantomWallet with empty key throws error
function testEmptyKey() {
  const originalEnv = process.env.PHANTOM_PRIVATE_KEY;
  process.env.PHANTOM_PRIVATE_KEY = "";

  let didThrow = false;
  try {
     getPhantomWallet();
  } catch (e: any) {
     didThrow = true;
  }

  process.env.PHANTOM_PRIVATE_KEY = originalEnv; // Restore env

  assert(didThrow, "getPhantomWallet should throw error for empty key");
  console.log("✅ testEmptyKey passed");
}

try {
  testValidKey();
  testInvalidKey();
  testEmptyKey();
  console.log("All tests passed!");
} catch (error: any) {
  console.error("❌ Test failed:", error.message);
  process.exit(1);
}
