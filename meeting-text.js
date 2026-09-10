// READING A MEETING BACK OUT OF ITS TEXT FORM.
//
// The same problem `parseBriefText` solves, for the same reason. The warm store holds
// records — `{ id, title, type, date, text }` and nothing else — so a meeting crosses to
// the gateway, to MCP, and to any client that reads the index as one flat string. A client
// that wants to show a transcript with speakers, or a summary separate from the captions,
// has to get that structure from somewhere.
//
// It is a GRAMMAR, not a rendering: the extension's meeting source writes
//
//     MEETING: <title>
//     Date: <date>
//     Platform: <platform>
//
//     SUMMARY:
//     <markdown>
//
//     TRANSCRIPT:
//     <preamble>
//     [<clock>] <speaker>: <line>
//
// and this reads it back. Round-trips in the tests.
//
// THE TRANSCRIPT IS UNTRUSTED CONTENT, and the source text says so in its own preamble:
// live captions, meeting chat and participant-CHOSEN display names. A speaker can name
// themselves anything, including something shaped like an instruction. This module returns
// it as DATA with the speaker as a separate field — never merged into a line that a prompt
// might read as a directive — and every consumer must render it escaped.

const HEAD = /^MEETING:\s*(.*)$/;
const LINE = /^\[([^\]]{1,20})\]\s*([^:]{1,80}?):\s*([\s\S]*)$/;

/** Returns `null` for text that is not a meeting, so "not a meeting" differs from "empty". */
export function parseMeetingText(text) {
  const lines = String(text ?? '').split('\n');
  const head = HEAD.exec(lines[0] || '');
  if (!head) return null;

  const out = {
    title: head[1].trim(),
    date: '',
    platform: '',
    tags: [],
    summary: '',
    preamble: '',
    segments: [],
    speakers: [],
  };

  let section = 'head';
  const summary = [];
  const preamble = [];

  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed === 'SUMMARY:') { section = 'summary'; continue; }
    if (trimmed === 'TRANSCRIPT:') { section = 'transcript'; continue; }

    if (section === 'head') {
      if (line.startsWith('Date: ')) out.date = line.slice(6).trim();
      else if (line.startsWith('Platform: ')) out.platform = line.slice(10).trim();
      else if (line.startsWith('Tags: ')) out.tags = line.slice(6).split(',').map((t) => t.trim()).filter(Boolean);
      continue;
    }

    if (section === 'summary') { summary.push(line); continue; }

    // Transcript. A line that matches the grammar is a segment; anything before the first
    // one is the preamble (the injection warning and the "--- Meeting Transcript ---" rule),
    // which is framing rather than content and should not be rendered as somebody speaking.
    const m = LINE.exec(line);
    if (m) {
      out.segments.push({ at: m[1].trim(), speaker: m[2].trim(), text: m[3].trim() });
    } else if (!out.segments.length) {
      preamble.push(line);
    } else if (trimmed && out.segments.length) {
      // A continuation of the previous speaker's line — a wrapped caption, not a new turn.
      out.segments[out.segments.length - 1].text += `\n${line}`;
    }
  }

  out.summary = summary.join('\n').trim();
  out.preamble = preamble.join('\n').trim();
  out.speakers = [...new Set(out.segments.map((s) => s.speaker))];
  return out;
}

/**
 * Who spoke, and how much — the shape of the meeting rather than its content.
 *
 * Ordered by line count, because "who ran this meeting" is usually the first thing someone
 * wants from a transcript they did not attend.
 */
export function speakerStats(meeting) {
  const by = new Map();
  for (const s of meeting?.segments || []) {
    const prev = by.get(s.speaker) || { speaker: s.speaker, lines: 0, chars: 0 };
    prev.lines += 1;
    prev.chars += s.text.length;
    by.set(s.speaker, prev);
  }
  const total = [...by.values()].reduce((n, s) => n + s.chars, 0) || 1;
  return [...by.values()]
    .map((s) => ({ ...s, share: s.chars / total }))
    .sort((a, b) => b.chars - a.chars);
}

/**
 * The meeting as one ribbon of who-spoke-when.
 *
 * `buckets` slices the transcript by POSITION rather than by clock: the timestamps are
 * display strings from the capture ("6:28:00 PM"), not durations, and parsing them into a
 * timeline would be guessing at a date, a timezone and whether the meeting crossed midnight.
 * Position is honest about being an approximation of pace.
 */
export function densityRibbon(meeting, buckets = 40) {
  const segs = meeting?.segments || [];
  if (!segs.length) return [];
  const out = [];
  const per = segs.length / buckets;
  for (let b = 0; b < buckets; b += 1) {
    const from = Math.floor(b * per);
    const to = Math.max(from + 1, Math.floor((b + 1) * per));
    const slice = segs.slice(from, to);
    if (!slice.length) { out.push({ speaker: '', weight: 0 }); continue; }
    const by = new Map();
    for (const s of slice) by.set(s.speaker, (by.get(s.speaker) || 0) + s.text.length);
    const [speaker, chars] = [...by.entries()].sort((a, b2) => b2[1] - a[1])[0];
    out.push({ speaker, weight: chars });
  }
  const max = Math.max(...out.map((o) => o.weight), 1);
  return out.map((o) => ({ ...o, weight: o.weight / max }));
}
