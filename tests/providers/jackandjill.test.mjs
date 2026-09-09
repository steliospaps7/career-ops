// tests/providers/jackandjill.test.mjs — provider-contract tests for the
// Jack & Jill board-wide XML feed provider (providers/jackandjill.mjs).
//
// The sample below is a trimmed recording of the real feed read on
// 8 September 2026: the same tag set, the same CDATA description, the same
// " at <company>" title shape.
import { pass, fail, ROOT } from '../helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nProvider — jackandjill');

try {
  const jackandjillModule = await import(pathToFileURL(join(ROOT, 'providers/jackandjill.mjs')).href);
  const jackandjill = jackandjillModule.default;
  const { parseJackandjillFeed, stripCompanySuffix } = jackandjillModule;

  if (jackandjill.id === 'jackandjill') pass('jackandjill.id is "jackandjill"');
  else fail(`jackandjill.id is ${JSON.stringify(jackandjill.id)}`);

  // detect() — explicit provider selection only (board-wide feed)
  const hit = jackandjill.detect({ name: 'Jack and Jill', provider: 'jackandjill' });
  if (hit && hit.url === 'https://www.jackandjill.ai/jobs/feed.xml') {
    pass('jackandjill.detect() resolves provider:jackandjill → feed URL');
  } else {
    fail(`jackandjill.detect() returned ${JSON.stringify(hit)}`);
  }
  if (jackandjill.detect({ name: 'X' }) === null) pass('jackandjill.detect() returns null without provider:jackandjill');
  else fail('jackandjill.detect() should require provider:jackandjill');

  const sampleXml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<source>',
    '  <publisher>Jack &amp; Jill</publisher>',
    '  <publisherurl>https://www.jackandjill.ai</publisherurl>',
    '  <job>',
    '    <title>AI Ops Associate at LightWork AI</title>',
    '    <date>2026-09-03T04:00:58.739Z</date>',
    '    <referencenumber>1b8eb12e-f716-4caa-9e8a-20784e8a02bc</referencenumber>',
    '    <url>https://www.jackandjill.ai/jobs/ops/ai-ops-associate-at-lightwork-ai-1b8eb12e?utm_source=linkedin</url>',
    '    <applyurl>https://www.jackandjill.ai/jobs/ops/ai-ops-associate-at-lightwork-ai-1b8eb12e/apply</applyurl>',
    '    <company>LightWork AI</company>',
    '    <city>London</city>',
    '    <location>London, United Kingdom</location>',
    '    <country>GB</country>',
    '    <workplaceTypes>On-site</workplaceTypes>',
    '    <description><![CDATA[<p><strong>Job Description</strong></p><p>You will run &amp; scale operations.</p>]]></description>',
    '    <salary>Not Disclosed + Equity</salary>',
    '    <jobtype>FULL_TIME</jobtype>',
    '    <expirationdate>2026-12-07T16:31:01.330Z</expirationdate>',
    '  </job>',
    '  <job>',
    '    <title>Chief of Staff</title>',
    '    <url>https://www.jackandjill.ai/jobs/strategy/chief-of-staff-99</url>',
    '    <location>Remote</location>',
    '    <workplaceTypes>Remote</workplaceTypes>',
    '  </job>',
    '  <job>',
    '    <title>Off-host role</title>',
    '    <url>https://example.com/jobs/1</url>',
    '  </job>',
    '  <job>',
    '    <title>Ghost (no url)</title>',
    '  </job>',
    '</source>',
  ].join('\n');

  const jobs = parseJackandjillFeed(sampleXml, 'Jack and Jill');
  if (jobs.length === 2) pass('parseJackandjillFeed keeps 2 valid jobs (drops the off-host and url-less ones)');
  else fail(`parseJackandjillFeed returned ${jobs.length} jobs, expected 2`);

  if (jobs[0]?.title === 'AI Ops Associate' && jobs[0]?.company === 'LightWork AI') {
    pass('parseJackandjillFeed strips the " at <company>" suffix and reads company');
  } else {
    fail(`row 0 title/company = ${JSON.stringify([jobs[0]?.title, jobs[0]?.company])}`);
  }
  if (jobs[0]?.url === 'https://www.jackandjill.ai/jobs/ops/ai-ops-associate-at-lightwork-ai-1b8eb12e?utm_source=linkedin') {
    pass('parseJackandjillFeed keeps the job URL, not the apply URL');
  } else {
    fail(`row 0 url = ${JSON.stringify(jobs[0]?.url)}`);
  }
  if (jobs[0]?.location === 'London, United Kingdom') pass('parseJackandjillFeed reads the location');
  else fail(`row 0 location = ${JSON.stringify(jobs[0]?.location)}`);

  // The posting date is the point of the reader: without it the age filter
  // never fires on anything this board returns.
  if (jobs[0]?.postedAt === Date.parse('2026-09-03T04:00:58.739Z')) {
    pass('parseJackandjillFeed maps <date> → postedAt');
  } else {
    fail(`row 0 postedAt = ${JSON.stringify(jobs[0]?.postedAt)}`);
  }

  if (jobs[0]?.description === 'Job Description You will run & scale operations.') {
    pass('parseJackandjillFeed turns the CDATA description into plain text');
  } else {
    fail(`row 0 description = ${JSON.stringify(jobs[0]?.description)}`);
  }

  if (jobs[1]?.company === 'Jack and Jill' && jobs[1]?.location === 'Remote, Remote' && jobs[1]?.postedAt === undefined) {
    pass('parseJackandjillFeed falls back to the entry name and tolerates a missing date');
  } else {
    fail(`row 1 = ${JSON.stringify(jobs[1])}`);
  }

  // stripCompanySuffix matches the company EXACTLY; it never splits on " at ".
  if (stripCompanySuffix('Analyst at Large', 'Acme') === 'Analyst at Large') {
    pass('stripCompanySuffix leaves a title whose " at " is not the company');
  } else {
    fail(`stripCompanySuffix mangled a non-suffix title: ${stripCompanySuffix('Analyst at Large', 'Acme')}`);
  }
  if (stripCompanySuffix('at Acme', 'Acme') === 'at Acme') {
    pass('stripCompanySuffix never empties a title');
  } else {
    fail(`stripCompanySuffix emptied a title: ${JSON.stringify(stripCompanySuffix('at Acme', 'Acme'))}`);
  }

  // Robustness
  if (parseJackandjillFeed('', 'X').length === 0) pass('empty input → empty result');
  else fail('empty input should yield empty result');
  if (parseJackandjillFeed(null, 'X').length === 0) pass('null input → empty result (no crash)');
  else fail('null input should yield empty result without crashing');

  // fetch() pins the request to the feed host and passes redirect:'error'
  const fetchJobs = await jackandjill.fetch(
    { name: 'Jack and Jill', provider: 'jackandjill' },
    {
      transport: 'http',
      fetchText: async (url, options) => {
        if (url !== 'https://www.jackandjill.ai/jobs/feed.xml') throw new Error(`fetchText called with unexpected URL: ${url}`);
        if (options?.redirect !== 'error') throw new Error(`fetchText called without redirect:'error': ${JSON.stringify(options)}`);
        return sampleXml;
      },
      fetchJson: async () => { throw new Error('fetchJson should not be called'); },
    },
  );
  if (fetchJobs.length === 2) pass('jackandjill.fetch() hits the feed with redirect:error and returns parsed jobs');
  else fail(`jackandjill.fetch() returned ${fetchJobs.length} jobs, expected 2`);

  // A board outage must surface as an error, never as an empty board: an empty
  // result would read as "nothing new today" and hide the outage for weeks.
  let surfaced = false;
  try {
    await jackandjill.fetch(
      { name: 'Jack and Jill', provider: 'jackandjill' },
      {
        transport: 'http',
        fetchText: async () => { throw new Error('HTTP 503'); },
        fetchJson: async () => { throw new Error('fetchJson should not be called'); },
      },
    );
  } catch (err) {
    surfaced = /503/.test(err.message);
  }
  if (surfaced) pass('jackandjill.fetch() surfaces a non-200 as an error, not an empty result');
  else fail('jackandjill.fetch() swallowed a non-200 response');

} catch (e) {
  fail(`jackandjill provider tests crashed: ${e.message}`);
}
