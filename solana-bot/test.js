const assert = require('assert');
const { Keypair } = require('@solana/web3.js');
const bs58 = require('bs58');
const { setupWallet } = require('./index');

console.log("Running Tests...");

// Test 1: setupWallet with valid base58 key
function testValidKey() {
  // Generate a random keypair and encode its secret to base58
  const keypair = Keypair.generate();
  const base58Secret = bs58.encode(keypair.secretKey);

  const wallet = setupWallet(base58Secret);

  assert(wallet !== null, "Wallet should not be null for valid key");
  assert.strictEqual(wallet.publicKey.toBase58(), keypair.publicKey.toBase58(), "Public keys should match");
  console.log("✅ testValidKey passed");
}

// Test 2: setupWallet with invalid key
function testInvalidKey() {
  // Overwrite console.error to avoid spamming the test output, but keep track if it was called
  const originalError = console.error;
  let errorCalled = false;
  console.error = () => { errorCalled = true; };

  const wallet = setupWallet("invalid_base58_string_here!!!");

  console.error = originalError; // Restore console.error

  assert.strictEqual(wallet, null, "Wallet should be null for invalid key");
  assert(errorCalled, "console.error should have been called for invalid key");
  console.log("✅ testInvalidKey passed");
}

// Test 3: setupWallet with empty key
function testEmptyKey() {
  const wallet = setupWallet("");
  assert.strictEqual(wallet, null, "Wallet should be null for empty key");
  console.log("✅ testEmptyKey passed");
}

try {
  testValidKey();
  testInvalidKey();
  testEmptyKey();
  console.log("All tests passed!");
} catch (error) {
  console.error("❌ Test failed:", error.message);
  process.exit(1);
}
