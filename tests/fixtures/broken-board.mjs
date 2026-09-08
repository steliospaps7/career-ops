// tests/fixtures/broken-board.mjs — a local-parser fixture board that fails.
// Used by tests/scan-source-ledger.test.mjs to prove one broken reader is an
// error line rather than a crashed scan.
console.error('board returned 503');
process.exit(1);
