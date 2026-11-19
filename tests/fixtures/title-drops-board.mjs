// Local-parser title drops, including a tracking variant of the same opening.
console.log(JSON.stringify([
  { title: 'Marketplace Operations', url: 'https://boards.example.com/drops/1', company: 'Fixture Co', location: 'London, UK' },
  { title: 'Operations Intern', url: 'https://boards.example.com/drops/2', company: 'Fixture Co', location: 'London, UK' },
  { title: 'Marketplace Operations', url: 'https://boards.example.com/drops/1/?utm_source=repeat', company: 'Fixture Co', location: 'London, UK' },
  { title: 'Marketplace Operations', url: 'https://boards.example.com/drops/3', company: 'Fixture Co', location: 'Berlin, Germany' },
]));
