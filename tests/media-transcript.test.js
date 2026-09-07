import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseYouTubeUrl, isYouTubeUrl, YOUTUBE_HOSTS,
  captionTracksFromPlayerResponse, videoMetaFromPlayerResponse,
  pickCaptionTrack, timedTextUrl, parseTimedText, groupSegments,
  formatTimestamp, formatTranscript, buildTranscriptDocument, transcriptFromTracks,
} from '../media-transcript.js';

// --------------------------------------------------------------------------
// Recognising the URL
// --------------------------------------------------------------------------

test('every shape a YouTube link is actually pasted in is recognised', () => {
  const cases = [
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://youtube.com/watch?v=dQw4w9WgXcQ&list=PL123',
    'https://m.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://music.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://youtu.be/dQw4w9WgXcQ',
    'https://www.youtube.com/shorts/dQw4w9WgXcQ',
    'https://www.youtube.com/embed/dQw4w9WgXcQ',
    'https://www.youtube.com/live/dQw4w9WgXcQ',
    'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
  ];
  for (const url of cases) {
    assert.equal(parseYouTubeUrl(url)?.videoId, 'dQw4w9WgXcQ', url);
  }
});

test('the canonical watch URL comes back, so a Short and its /watch twin are one video', () => {
  assert.equal(
    parseYouTubeUrl('https://youtu.be/dQw4w9WgXcQ?t=90').url,
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  );
});

test('a start time is carried in whichever notation the link used', () => {
  assert.equal(parseYouTubeUrl('https://youtu.be/dQw4w9WgXcQ?t=90').start, 90);
  assert.equal(parseYouTubeUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1h2m3s').start, 3723);
  assert.equal(parseYouTubeUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=45s').start, 45);
  assert.equal(parseYouTubeUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ').start, 0);
});

test('anything that is not a YouTube video is refused, including lookalike hosts', () => {
  for (const url of [
    'https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ',
    'https://notyoutube.com/watch?v=dQw4w9WgXcQ',
    'https://www.youtube.com/watch?v=short',
    'https://www.youtube.com/results?search_query=cats',
    'https://www.youtube.com/@channel',
    'javascript:alert(1)',
    '',
    null,
  ]) {
    assert.equal(parseYouTubeUrl(url), null, String(url));
    assert.equal(isYouTubeUrl(url), false, String(url));
  }
});

test('the host list has no bare protocol or path in it', () => {
  for (const h of YOUTUBE_HOSTS) assert.match(h, /^[a-z0-9.-]+$/);
});

// --------------------------------------------------------------------------
// The player response
// --------------------------------------------------------------------------

const PLAYER_RESPONSE = {
  videoDetails: {
    videoId: 'dQw4w9WgXcQ',
    title: 'How the thing works',
    author: 'Example Channel',
    lengthSeconds: '3725',
    shortDescription: 'Slides at example.com/slides',
    isLiveContent: false,
  },
  captions: {
    playerCaptionsTracklistRenderer: {
      captionTracks: [
        { baseUrl: 'https://x.test/api/timedtext?v=1&lang=es', languageCode: 'es', name: { simpleText: 'Spanish' } },
        { baseUrl: 'https://x.test/api/timedtext?v=1&lang=en&kind=asr', languageCode: 'en', kind: 'asr', name: { simpleText: 'English (auto-generated)' } },
        { baseUrl: 'https://x.test/api/timedtext?v=1&lang=en', languageCode: 'en', name: { runs: [{ text: 'English' }] } },
      ],
    },
  },
};

test('caption tracks and video facts are read out of the player response', () => {
  const tracks = captionTracksFromPlayerResponse(PLAYER_RESPONSE);
  assert.equal(tracks.length, 3);
  assert.equal(tracks[1].generated, true, 'the asr track must be marked generated');
  assert.equal(tracks[2].name, 'English', 'a runs[] name is joined, not dropped');

  const meta = videoMetaFromPlayerResponse(PLAYER_RESPONSE);
  assert.equal(meta.title, 'How the thing works');
  assert.equal(meta.author, 'Example Channel');
  assert.equal(meta.durationSec, 3725);
  assert.equal(meta.url, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
});

test('a video with no captions yields no tracks rather than throwing', () => {
  assert.deepEqual(captionTracksFromPlayerResponse({}), []);
  assert.deepEqual(captionTracksFromPlayerResponse(null), []);
});

// --------------------------------------------------------------------------
// Choosing a track
// --------------------------------------------------------------------------

const TRACKS = captionTracksFromPlayerResponse(PLAYER_RESPONSE);

test('a human-written track beats the machine one in the same language', () => {
  assert.equal(pickCaptionTrack(TRACKS, { languages: ['en'] }).generated, false);
});

test('an explicit language ask wins over the preference list', () => {
  assert.equal(pickCaptionTrack(TRACKS, { language: 'es', languages: ['en'] }).lang, 'es');
});

test('a regional preference matches its family — en-GB takes the en track', () => {
  assert.equal(pickCaptionTrack(TRACKS, { languages: ['en-GB'] }).lang, 'en');
});

// THE POINT OF RANKING RATHER THAN FILTERING. Telling a user there is no transcript when
// the only track is an auto-generated one in another language is the failure this avoids.
test('the only track available is returned even when no preference matches it', () => {
  const only = [{ baseUrl: 'https://x.test/t?lang=hi', languageCode: 'hi', kind: 'asr' }];
  assert.equal(pickCaptionTrack(only, { languages: ['en'] })?.lang, 'hi');
});

test('no tracks means null, not a crash', () => {
  assert.equal(pickCaptionTrack([], { languages: ['en'] }), null);
  assert.equal(pickCaptionTrack(null), null);
});

test('a caption URL can be asked for a format, and a bad one yields no URL', () => {
  assert.match(timedTextUrl('https://x.test/t?v=1'), /fmt=json3/);
  assert.match(timedTextUrl('https://x.test/t?v=1', { fmt: 'srv1', language: 'de' }), /fmt=srv1.*tlang=de|tlang=de.*fmt=srv1/);
  assert.equal(timedTextUrl('not a url'), '');
});

// --------------------------------------------------------------------------
// Parsing — four serialisations, one segment list
// --------------------------------------------------------------------------

const JSON3 = JSON.stringify({
  events: [
    { tStartMs: 0, dDurationMs: 1500, segs: [{ utf8: 'it' }, { utf8: "'s" }, { utf8: ' here' }] },
    { tStartMs: 1500, dDurationMs: 900 },                                   // timing-only
    { tStartMs: 1500, dDurationMs: 900, segs: [{ utf8: '\n' }] },           // whitespace-only
    { tStartMs: 2400, dDurationMs: 1200, segs: [{ utf8: 'and it works' }] },
  ],
});

test('json3 parses, and its empty timing events do not become blank lines', () => {
  const segs = parseTimedText(JSON3);
  assert.deepEqual(segs, [
    { start: 0, dur: 1500, text: "it's here" },
    { start: 2400, dur: 1200, text: 'and it works' },
  ]);
});

test('srv1 XML parses, with its double-escaped entities decoded', () => {
  const xml = `<?xml version="1.0"?><transcript>`
    + `<text start="0" dur="1.5">it&amp;#39;s here</text>`
    + `<text start="2.4" dur="1.2">a &amp;lt;tag&amp;gt; &amp;amp; more</text>`
    + `</transcript>`;
  assert.deepEqual(parseTimedText(xml), [
    { start: 0, dur: 1500, text: "it's here" },
    { start: 2400, dur: 1200, text: 'a <tag> & more' },
  ]);
});

test('escaped italic markup is stripped, but an escaped word in angle brackets is kept', () => {
  const xml = '<transcript><text start="0" dur="1">&lt;i&gt;stressed&lt;/i&gt; word</text></transcript>';
  assert.equal(parseTimedText(xml)[0].text, 'stressed word');
});

test('srv3 XML parses — millisecond t/d attributes and karaoke <s> spans', () => {
  const xml = `<timedtext><body><p t="0" d="1500"><s>it</s><s> is</s></p>`
    + `<p t="2400" d="1200">here</p></body></timedtext>`;
  assert.deepEqual(parseTimedText(xml), [
    { start: 0, dur: 1500, text: 'it is' },
    { start: 2400, dur: 1200, text: 'here' },
  ]);
});

test('WebVTT parses, cue numbers and all', () => {
  const vtt = 'WEBVTT\n\n1\n00:00:00.000 --> 00:00:01.500\nit is\n\n2\n00:00:02.400 --> 00:00:03.600\nhere\n';
  assert.deepEqual(parseTimedText(vtt), [
    { start: 0, dur: 1500, text: 'it is' },
    { start: 2400, dur: 1200, text: 'here' },
  ]);
});

test('SRT parses — the comma decimal separator is not a different format', () => {
  const srt = '1\n00:00:00,000 --> 00:00:01,500\nit is\n\n2\n00:00:02,400 --> 00:00:03,600\nhere\n';
  assert.deepEqual(parseTimedText(srt), [
    { start: 0, dur: 1500, text: 'it is' },
    { start: 2400, dur: 1200, text: 'here' },
  ]);
});

// The reason parsing SNIFFS instead of trusting the requested format.
test('an endpoint that answers XML to a json3 request still parses', () => {
  assert.equal(parseTimedText('<transcript><text start="0" dur="1">hi</text></transcript>').length, 1);
});

test('junk and emptiness parse to nothing rather than throwing', () => {
  assert.deepEqual(parseTimedText(''), []);
  assert.deepEqual(parseTimedText('<!DOCTYPE html><html><body>sign in</body></html>'), []);
  assert.deepEqual(parseTimedText(null), []);
});

// --------------------------------------------------------------------------
// Segments → something a model can read
// --------------------------------------------------------------------------

test('cues group into paragraphs by a time window', () => {
  const segs = Array.from({ length: 40 }, (_, i) => ({ start: i * 2000, dur: 2000, text: `w${i}` }));
  const groups = groupSegments(segs, { windowMs: 30000, gapMs: 60000 });
  assert.equal(groups.length, 3);          // 15 two-second cues per 30s window
  assert.equal(groups[0].start, 0);
  assert.match(groups[0].text, /^w0 w1 /);
});

test('a real pause starts a new paragraph even inside the window', () => {
  const groups = groupSegments([
    { start: 0, dur: 1000, text: 'first thought' },
    { start: 9000, dur: 1000, text: 'second thought' },
  ], { windowMs: 30000, gapMs: 2500 });
  assert.equal(groups.length, 2);
});

// The rolling two-line caption artefact — without this, a third of an auto transcript is
// the same words twice.
test('an auto-generated track that repeats its own tail is de-duplicated', () => {
  const groups = groupSegments([
    { start: 0, dur: 1000, text: 'the model reads the' },
    { start: 1000, dur: 1000, text: 'model reads the transcript' },
  ], { windowMs: 30000, gapMs: 5000 });
  assert.equal(groups[0].text, 'the model reads the transcript');
});

test('timestamps grow an hour field only when there is an hour', () => {
  assert.equal(formatTimestamp(0), '0:00');
  assert.equal(formatTimestamp(62_000), '1:02');
  assert.equal(formatTimestamp(3_723_000), '1:02:03');
});

test('the transcript is timestamped by default and can be asked not to be', () => {
  const segs = [{ start: 62_000, dur: 1000, text: 'hello' }];
  assert.equal(formatTranscript(segs), '[1:02] hello');
  assert.equal(formatTranscript(segs, { timestamps: false }), 'hello');
});

test('a transcript longer than the cap is truncated and says so', () => {
  const segs = [{ start: 0, dur: 1000, text: 'x'.repeat(500) }];
  const out = formatTranscript(segs, { maxChars: 100 });
  assert.ok(out.length < 200);
  assert.match(out, /truncated at 100 characters/);
});

// --------------------------------------------------------------------------
// The document a caller attaches
// --------------------------------------------------------------------------

test('the document names what it is a transcript OF', () => {
  const doc = buildTranscriptDocument({
    meta: videoMetaFromPlayerResponse(PLAYER_RESPONSE),
    segments: [{ start: 0, dur: 1000, text: 'hello' }],
    language: 'en',
    generated: true,
  });
  assert.match(doc.text, /^# How the thing works/);
  assert.match(doc.text, /Channel: Example Channel/);
  assert.match(doc.text, /Duration: 1:02:05/);
  assert.match(doc.text, /Captions: en \(auto-generated\)/);
  assert.match(doc.text, /URL: https:\/\/www\.youtube\.com\/watch\?v=dQw4w9WgXcQ/);
  assert.match(doc.text, /## Description\nSlides at example\.com\/slides/);
  assert.match(doc.text, /## Transcript\n\n\[0:00\] hello/);
  assert.equal(doc.chars, doc.text.length);
  assert.equal(doc.segments, 1);
});

// --------------------------------------------------------------------------
// The orchestration, with the fetch injected
// --------------------------------------------------------------------------

test('tracks + an injected fetch produce a finished document', async () => {
  const asked = [];
  const doc = await transcriptFromTracks({
    tracks: TRACKS,
    meta: videoMetaFromPlayerResponse(PLAYER_RESPONSE),
    languages: ['en'],
    source: 'test',
    async fetchText(url) { asked.push(url); return JSON3; },
  });
  assert.match(asked[0], /fmt=json3/);
  assert.equal(asked.length, 1, 'a first format that works must not be retried in another');
  assert.equal(doc.language, 'en');
  assert.equal(doc.generated, false);
  assert.equal(doc.source, 'test');
  assert.match(doc.text, /and it works/);
});

test('a format the endpoint refuses falls through to the next one', async () => {
  const asked = [];
  const doc = await transcriptFromTracks({
    tracks: TRACKS,
    meta: {},
    async fetchText(url) {
      asked.push(url);
      if (url.includes('json3')) throw new Error('400');
      return '<transcript><text start="0" dur="1">fallback</text></transcript>';
    },
  });
  assert.equal(asked.length, 2);
  assert.match(doc.text, /fallback/);
});

test('a fetch that always answers with a sign-in page returns null, not a fake transcript', async () => {
  const doc = await transcriptFromTracks({
    tracks: TRACKS,
    meta: {},
    async fetchText() { return '<html><body>Sign in to confirm you are not a bot</body></html>'; },
  });
  assert.equal(doc, null);
});

test('no tracks at all is null — the caller says "no captions", it does not guess', async () => {
  assert.equal(await transcriptFromTracks({ tracks: [], fetchText: async () => JSON3 }), null);
});

test('a translation is requested only when the chosen track is a different language', async () => {
  const asked = [];
  await transcriptFromTracks({
    tracks: TRACKS, meta: {}, language: 'en',
    async fetchText(url) { asked.push(url); return JSON3; },
  });
  assert.ok(!asked[0].includes('tlang='), 'an en track asked for en must not be round-tripped');

  asked.length = 0;
  await transcriptFromTracks({
    tracks: [{ baseUrl: 'https://x.test/t', languageCode: 'ja' }], meta: {}, language: 'en',
    async fetchText(url) { asked.push(url); return JSON3; },
  });
  assert.match(asked[0], /tlang=en/, 'a ja-only video asked for en must ask for the translation');
});
