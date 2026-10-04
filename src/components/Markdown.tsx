"use client";

import { Fragment, type ReactNode } from "react";

/**
 * Markdown mínimo y seguro (sin HTML crudo): títulos, listas, tablas,
 * bloques de código, citas, negrita, cursiva, código y enlaces.
 */

function inline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|__[^_]+__|\*[^*\s][^*]*\*|_[^_\s][^_]*_|`[^`]+`|\[[^\]]+\]\([^)\s]+\)|~~[^~]+~~)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    const key = `${keyBase}-${i++}`;
    if (tok.startsWith("**") || tok.startsWith("__")) out.push(<strong key={key}>{inline(tok.slice(2, -2), key)}</strong>);
    else if (tok.startsWith("~~")) out.push(<del key={key}>{tok.slice(2, -2)}</del>);
    else if (tok.startsWith("`")) out.push(<code key={key}>{tok.slice(1, -1)}</code>);
    else if (tok.startsWith("[")) {
      const mm = tok.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/)!;
      const href = /^(https?:|mailto:|\/)/.test(mm[2]) ? mm[2] : "#";
      out.push(
        <a key={key} href={href} target="_blank" rel="noreferrer">
          {mm[1]}
        </a>,
      );
    } else out.push(<em key={key}>{inline(tok.slice(1, -1), key)}</em>);
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function isTableSep(line: string) {
  return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);
}

function cells(line: string) {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
}

export function Markdown({ text }: { text: string }) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  let k = 0;
  while (i < lines.length) {
    const line = lines[i];
    const key = `b${k++}`;
    if (/^```/.test(line)) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      blocks.push(
        <pre key={key}>
          <code>{buf.join("\n")}</code>
        </pre>,
      );
      continue;
    }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      const level = Math.min(h[1].length + 2, 6);
      const Tag = `h${level}` as "h3";
      blocks.push(<Tag key={key}>{inline(h[2], key)}</Tag>);
      i++;
      continue;
    }
    if (line.includes("|") && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const head = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) rows.push(cells(lines[i++]));
      blocks.push(
        <div key={key} className="md-table">
          <table>
            <thead>
              <tr>
                {head.map((c, j) => (
                  <th key={j}>{inline(c, `${key}h${j}`)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri}>
                  {r.map((c, j) => (
                    <td key={j}>{inline(c, `${key}r${ri}c${j}`)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]/.test(line);
      const items: ReactNode[] = [];
      while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) {
        const raw = lines[i].replace(/^\s*([-*+]|\d+[.)])\s+/, "");
        const task = raw.match(/^\[( |x|X)\]\s+(.*)$/);
        items.push(
          <li key={i} className={task ? "md-task" : undefined}>
            {task ? (
              <>
                <span className={`md-check ${task[1] !== " " ? "on" : ""}`} aria-hidden />
                {inline(task[2], `${key}i${i}`)}
              </>
            ) : (
              inline(raw, `${key}i${i}`)
            )}
          </li>,
        );
        i++;
      }
      blocks.push(ordered ? <ol key={key}>{items}</ol> : <ul key={key}>{items}</ul>);
      continue;
    }
    if (/^>\s?/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ""));
      blocks.push(<blockquote key={key}>{inline(buf.join(" "), key)}</blockquote>);
      continue;
    }
    if (/^\s*(---|\*\*\*)\s*$/.test(line)) {
      blocks.push(<hr key={key} />);
      i++;
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const buf: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|```|>\s?|\s*([-*+]|\d+[.)])\s+)/.test(lines[i])) {
      if (lines[i].includes("|") && i + 1 < lines.length && isTableSep(lines[i + 1])) break;
      buf.push(lines[i++]);
    }
    blocks.push(
      <p key={key}>
        {buf.map((l, j) => (
          <Fragment key={j}>
            {j > 0 && <br />}
            {inline(l, `${key}l${j}`)}
          </Fragment>
        ))}
      </p>,
    );
  }
  return <div className="md">{blocks}</div>;
}
