// tests/fixtures/mixed-filter-board.mjs — a local-parser fixture board whose
// postings each fail a DIFFERENT filter, plus one that survives and one that
// repeats a URL already seen in the same sweep.
//
// Used by tests/scan-source-ledger.test.mjs to prove the per-source breakdown
// attributes every posting to exactly one source and one reason. No network.
const KEEP = 'Operations Associate';

console.log(JSON.stringify([
  { title: KEEP, url: 'https://boards.example.com/mixed/1', company: 'Mixed Co', location: 'London, UK' },
  { title: 'Senior Software Engineer', url: 'https://boards.example.com/mixed/2', company: 'Mixed Co', location: 'London, UK' },
  { title: KEEP, url: 'https://boards.example.com/mixed/3', company: 'Mixed Co', location: 'Berlin, Germany' },
  { title: KEEP, url: 'https://boards.example.com/mixed/1', company: 'Mixed Co', location: 'London, UK' },
]));
