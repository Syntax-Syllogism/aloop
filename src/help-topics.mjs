import { readdir, readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const DOCS_DIR = fileURLToPath(new URL('../docs/', import.meta.url));
const GUIDE_FILES = { 'metrics-guide': 'metrics' };

export const COMMAND_MANUALS = {
  run: {
    sections: [
      ['loop', 'Usage'],
      ['loop', 'Configuration'],
      ['loop', 'Phases'],
      ['loop', 'Stopping conditions'],
      ['loop', 'Resuming'],
    ],
  },
  init: {
    sections: [
      ['loop', 'Getting started'],
      ['loop', 'Prompts'],
    ],
  },
  status: {
    sections: [
      ['operations', 'Inspecting runs'],
      ['run-state', 'Starting and resuming'],
    ],
  },
  inspect: {
    sections: [
      ['operations', 'Inspecting runs'],
      ['run-state', 'Artefacts'],
    ],
  },
  list: { sections: [['operations', 'Inspecting runs']] },
  cancel: {
    sections: [
      ['operations', 'Cancelling an active run'],
      ['run-state', 'Concurrent-run protection'],
    ],
  },
  clean: { sections: [['operations', 'Cleaning completed runs']] },
  metrics: {
    sections: [
      ['loop', 'Run metrics'],
      ['metrics', 'CLI commands'],
      ['metrics', 'What the metrics mean'],
    ],
  },
  watch: {
    sections: [
      ['operations', 'Watching runs'],
      ['run-state', 'Recovery'],
    ],
  },
  doctor: {
    sections: [
      ['operations', 'Diagnosing local prerequisites'],
      ['loop', 'Getting started'],
    ],
  },
  replay: {
    sections: [
      ['operations', 'Replaying recorded evidence'],
      ['run-state', 'Artefacts'],
    ],
  },
  help: { sections: [['loop', 'Usage']] },
};

function parseFrontmatter(markdown) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown);
  if (!match) return { body: markdown, title: '', description: '' };
  const value = (key) => new RegExp(`^${key}:\\s*(.*?)\\s*$`, 'm').exec(match[1])?.[1] ?? '';
  return { body: markdown.slice(match[0].length), title: value('title'), description: value('description') };
}

function firstParagraph(body) {
  const lines = body.split(/\r?\n/);
  let afterTitle = false;
  const paragraph = [];
  for (const line of lines) {
    if (!afterTitle) {
      if (/^#\s+/.test(line)) afterTitle = true;
      continue;
    }
    if (!line.trim()) {
      if (paragraph.length) break;
      continue;
    }
    if (/^#{1,6}\s/.test(line)) continue;
    paragraph.push(line.trim());
  }
  return paragraph.join(' ');
}

export async function listGuides() {
  const files = (await readdir(DOCS_DIR)).filter((name) => name.endsWith('.md') && name !== 'README.md').sort();
  return Promise.all(
    files.map(async (file) => {
      const markdown = await readFile(join(DOCS_DIR, file), 'utf8');
      const { body, title, description } = parseFrontmatter(markdown);
      return {
        name: file === 'metrics.md' ? 'metrics-guide' : file.slice(0, -3),
        title: title || /^#\s+(.+)$/m.exec(body)?.[1]?.trim() || file.slice(0, -3),
        description: description || firstParagraph(body),
        path: join(DOCS_DIR, file),
      };
    }),
  );
}

function headings(markdown) {
  const result = [];
  const lines = markdown.split(/\r?\n/);
  let fence = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      if (!fence) fence = fenceMatch[1][0];
      else if (fenceMatch[1][0] === fence) fence = null;
      continue;
    }
    if (fence) continue;
    const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (match) result.push({ index, level: match[1].length, title: match[2].trim() });
  }
  return { lines, headings: result };
}

export function extractMarkdownSection(markdown, title) {
  const { lines, headings: found } = headings(markdown);
  const start = found.findIndex((heading) => heading.title === title);
  if (start === -1) throw new Error(`Documentation heading not found: ${title}`);
  const heading = found[start];
  const end = found.slice(start + 1).find((next) => next.level <= heading.level)?.index ?? lines.length;
  return lines.slice(heading.index, end).join('\n').trimEnd();
}

function headingSlug(title) {
  return title
    .toLowerCase()
    .replace(/[^\p{L}\p{N} -]/gu, '')
    .trim()
    .replace(/\s+/g, '-');
}

function sectionForAnchor(markdown, anchor) {
  if (!anchor) return '';
  const { headings: found } = headings(markdown);
  return found.find((heading) => headingSlug(heading.title) === anchor)?.title ?? '';
}

export function rewriteDocLinks(markdown) {
  return markdown.replace(/\[[^\]]+\]\((?!https?:|mailto:|#)([^)#]+\.md)(#[^)]*)?\)/g, (full, file, hash = '') => {
    const baseName = file.split('/').at(-1).slice(0, -3);
    const name = Object.keys(GUIDE_FILES).find((alias) => GUIDE_FILES[alias] === baseName) ?? baseName;
    let section = '';
    if (hash) {
      try {
        section = sectionForAnchor(readFileSyncDoc(file), hash.slice(1));
      } catch {
        section = '';
      }
    }
    return `\`aloop help ${name}\`${section ? ` (section "${section}")` : ''}`;
  });
}

// This small synchronous read is only used while rewriting links in already-loaded
// documentation, so guide rendering stays a single async operation.
function readFileSyncDoc(file) {
  return readFileSync(join(DOCS_DIR, file), 'utf8');
}

export async function renderGuide(name) {
  const file = join(DOCS_DIR, `${GUIDE_FILES[name] ?? name}.md`);
  const markdown = await readFile(file, 'utf8');
  return rewriteDocLinks(parseFrontmatter(markdown).body).trimEnd();
}

export async function renderCommandManual(command, shortUsage = `Usage: aloop ${command} [options]`) {
  const manual = COMMAND_MANUALS[command];
  if (!manual) throw new Error(`Unknown command manual: ${command}`);
  const sections = [];
  for (const [guide, title] of manual.sections) {
    const markdown = await readFile(join(DOCS_DIR, `${guide}.md`), 'utf8');
    sections.push(rewriteDocLinks(extractMarkdownSection(parseFrontmatter(markdown).body, title)));
  }
  const related = [
    ...new Set(
      manual.sections.map(([guide]) => Object.keys(GUIDE_FILES).find((alias) => GUIDE_FILES[alias] === guide) ?? guide),
    ),
  ].map((guide) => `\`aloop help ${guide}\``);
  return [shortUsage, '\n---', ...sections, `See also: ${related.join(', ')}`].join('\n\n');
}

export function suggestHelpTopics(topic, candidates) {
  const distance = (left, right) => {
    let row = Array.from({ length: right.length + 1 }, (_, index) => index);
    for (let i = 1; i <= left.length; i += 1) {
      const next = [i];
      for (let j = 1; j <= right.length; j += 1) {
        next[j] = Math.min(next[j - 1] + 1, row[j] + 1, row[j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1));
      }
      row = next;
    }
    return row[right.length];
  };
  return candidates
    .map((candidate) => ({
      candidate,
      score: candidate.startsWith(topic) || topic.startsWith(candidate) ? 0 : distance(topic, candidate),
    }))
    .filter(({ score }) => score <= 2)
    .sort((a, b) => a.score - b.score || a.candidate.localeCompare(b.candidate))
    .slice(0, 3)
    .map(({ candidate }) => candidate);
}
