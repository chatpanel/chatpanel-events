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

// The shape analysis — who spoke, when, for how long — lives in `meeting-shape.js` so the
// clients that never read the text form can have it without the parser. Re-exported here
// because these two names were part of this module before that split, and the desktop
// meeting pane imports them from this path.
export { speakerStats, densityRibbon } from './meeting-shape.js';
