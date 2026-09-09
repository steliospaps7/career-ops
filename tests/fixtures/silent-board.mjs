// tests/fixtures/silent-board.mjs — a local-parser fixture board that is live
// and returns nothing. Used by tests/scan-source-ledger.test.mjs to prove a
// source that found nothing says so, rather than being absent from the list.
console.log('[]');
