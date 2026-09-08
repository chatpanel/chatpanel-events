import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getWeather, weatherUrl, parseWeather, formatWeather, areaLabel, isAmbiguousLocation,
  WeatherError,
} from '../weather.js';

// A trimmed but real-shaped wttr.in `format=j1` body: every scalar this module reads is
// nested the way the service actually nests it, including the [{ value }] wrappers.
const BODY = {
  current_condition: [{
    temp_C: '16', temp_F: '60', FeelsLikeC: '14', FeelsLikeF: '57',
    weatherDesc: [{ value: 'Clear' }], humidity: '51',
    windspeedKmph: '3', windspeedMiles: '2', winddir16Point: 'NNW',
    precipMM: '0.0', uvIndex: '1', localObsDateTime: '2026-09-06 10:04 PM',
  }],
  nearest_area: [{
    areaName: [{ value: 'Seattle' }], region: [{ value: 'Washington' }],
    country: [{ value: 'United States of America' }], latitude: '47.606', longitude: '-122.333',
  }],
  weather: [{
    date: '2026-09-07', maxtempC: '23', maxtempF: '74', mintempC: '11', mintempF: '52',
    astronomy: [{ sunrise: '06:40 AM', sunset: '07:41 PM' }],
    hourly: [{ weatherDesc: [{ value: 'Partly cloudy' }], chanceofrain: '0' },
      {}, {}, {}, { weatherDesc: [{ value: 'Sunny' }], chanceofrain: '4' }],
  }],
};

test('the location goes in the path, encoded whole', () => {
  assert.equal(weatherUrl('Seattle'), 'https://wttr.in/Seattle?format=j1');
  // A raw comma or space would still be READ correctly by the service; a raw `/` or `?`
  // would reshape the request, which is why the whole thing is encoded rather than tidied.
  assert.equal(weatherUrl('Seattle, WA'), 'https://wttr.in/Seattle%2C%20WA?format=j1');
  assert.equal(weatherUrl('a/../b?x=1'), 'https://wttr.in/a%2F..%2Fb%3Fx%3D1?format=j1');
  assert.throws(() => weatherUrl('  '), WeatherError, 'no location is not a location');
  assert.throws(() => weatherUrl('x'.repeat(200)), WeatherError);
});

test('the body is read into a shape that does not mention wttr.in', () => {
  const w = parseWeather(BODY, { query: 'Seattle' });
  assert.equal(w.now.tempF, 60);
  assert.equal(w.now.condition, 'Clear');
  assert.equal(w.now.humidity, 51);
  assert.equal(w.now.windDir, 'NNW');
  assert.equal(w.area.region, 'Washington');
  assert.equal(w.days.length, 1);
  assert.equal(w.days[0].maxF, 74);
  assert.equal(w.days[0].condition, 'Sunny', 'the midday slot is the day’s headline, not 3am');
  assert.equal(w.days[0].chanceOfRain, 4);
});

test('half-empty output is not data', () => {
  // An error page served as JSON still parses into an object. A reading with no temperature
  // read as real data is worse than no reading — the fallback exists for exactly this.
  assert.equal(parseWeather(null), null);
  assert.equal(parseWeather({}), null);
  assert.equal(parseWeather({ current_condition: [] }), null);
  assert.equal(parseWeather({ current_condition: [{ humidity: '50' }] }), null);
});

test('the answer says WHICH place it resolved to', () => {
  // THE GEOCODER IS THE KNOWN WEAKNESS. "Issaquah" once resolved somewhere obscure and the
  // answer looked entirely plausible. Naming the resolved area is what makes a wrong place
  // visible instead of silent — and it is why this module does not rewrite the query, which
  // would turn a visible error into an invisible one.
  const text = formatWeather(parseWeather(BODY, { query: 'Seattle' }));
  assert.match(text, /^Weather for Seattle, Washington, United States of America/);
  assert.match(text, /Now: 60°F \/ 16°C, feels like 57°F \/ 14°C, clear/);
  assert.match(text, /humidity 51% · wind 2 mph NNW/);
  assert.match(text, /2026-09-07: 74°F \/ 23°C high/);
  assert.match(text, /Source: wttr\.in/);

  // A bare town name gets an explicit instruction to say so; a qualified one does not need it.
  assert.match(text, /place name was ambiguous/i, '"Seattle" alone is one of many Seattles');
  const qualified = formatWeather(parseWeather(BODY, { query: 'Seattle, WA' }));
  assert.doesNotMatch(qualified, /ambiguous/i);
  assert.match(qualified, /asked: "Seattle, WA"/, 'and it still shows what was asked');
});

test('ambiguity is about what the USER said, not what came back', () => {
  assert.equal(isAmbiguousLocation('Fairview'), true);
  assert.equal(isAmbiguousLocation('San Jose'), true);
  assert.equal(isAmbiguousLocation('Fairview, OR'), false);
  assert.equal(isAmbiguousLocation('New York City NY USA'), false);
  assert.equal(isAmbiguousLocation(''), false);
});

test('areaLabel does not repeat itself', () => {
  // City-states and one-word countries hand back the same word twice.
  assert.equal(areaLabel({ name: 'Singapore', region: 'Singapore', country: 'Singapore' }), 'Singapore');
  assert.equal(areaLabel(null, 'fallback'), 'fallback');
});

test('every failure is a reason, never a throw', async () => {
  // The caller turns a reason into "use search instead". An exception would surface as a tool
  // error and stop a turn the fallback could still have answered.
  const boom = await getWeather('Seattle', { fetchJson: async () => { throw new Error('offline'); } });
  assert.deepEqual(boom, { ok: false, reason: 'offline' });

  const junk = await getWeather('Seattle', { fetchJson: async () => ({ error: 'nope' }) });
  assert.equal(junk.ok, false);
  assert.match(junk.reason, /nothing usable/);

  assert.equal((await getWeather('', { fetchJson: async () => BODY })).ok, false);
  assert.equal((await getWeather('Seattle', {})).ok, false, 'no injected fetch is a reason too');
});

test('the happy path is one request', async () => {
  const seen = [];
  const got = await getWeather('Seattle, WA', {
    fetchJson: async (url, opts) => { seen.push([url, opts]); return BODY; },
  });
  assert.equal(seen.length, 1, 'one round trip — that is the whole reason this is not a search');
  assert.equal(seen[0][0], 'https://wttr.in/Seattle%2C%20WA?format=j1');
  assert.equal(typeof seen[0][1].timeoutMs, 'number', 'and it is bounded, or a hung host never falls back');
  assert.equal(got.ok, true);
  assert.match(got.text, /Weather for Seattle/);
});
