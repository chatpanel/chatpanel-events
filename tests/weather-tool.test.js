import { test } from 'node:test';
import assert from 'node:assert/strict';
import { weatherToolProvider, WEATHER_TOOL_NAME } from '../weather-tool.js';

const WTTR = { nearest_area: [{ areaName: [{ value: 'Snoqualmie' }], region: [{ value: 'Washington' }], country: [{ value: 'United States of America' }] }], current_condition: [{ temp_C: '18', temp_F: '64', FeelsLikeC: '18', FeelsLikeF: '64', weatherDesc: [{ value: 'Partly cloudy' }], humidity: '60', windspeedKmph: '10', windspeedMiles: '6', winddir16Point: 'W', precipMM: '0' }], weather: [{ date: '2026-09-12', maxtempC: '24', maxtempF: '75', mintempC: '12', mintempF: '54', hourly: [{ weatherDesc: [{ value: 'Sunny' }], chanceofrain: '0' }] }] };

test('the weather tool answers from the injected fetch and names the place it resolved', async () => {
  const urls = [];
  const p = weatherToolProvider({ fetchJson: async (u) => { urls.push(u); return WTTR; } });
  assert.equal(p.specs[0].name, WEATHER_TOOL_NAME);
  assert.equal(p.specs[0].annotations.readOnlyHint, true);
  const out = await p.execute('weather', { location: 'Snoqualmie' });
  assert.match(urls[0], /wttr\.in/);
  assert.match(out.text, /Snoqualmie/);
  assert.match(out.text, /64|18/);
  assert.equal(out.note, 'ChatPanel · wttr.in');
  assert.equal(await p.execute('weather', { location: ' ' }), 'No location provided to weather.');
});

test('a service that cannot answer hands the turn to web_search rather than reporting a failure', async () => {
  const p = weatherToolProvider({ fetchJson: async () => { throw new Error('502'); } });
  const out = await p.execute('weather', { location: 'Nowhere' });
  assert.match(out, /Now call web_search for "weather in Nowhere"/);
  assert.throws(() => weatherToolProvider({}), /fetchJson required/);
});
