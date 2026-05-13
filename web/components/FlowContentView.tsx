import type { ReactNode } from "react";

import {
  type Block,
  type Inline,
  type Mark,
  type Resources,
  colorRefToCss,
} from "@/lib/udm";

interface FlowContentViewProps {
  blocks: Block[];
  resources: Resources;
}

/**
 * Read-only renderer for UDM flow-mode content. Maps each Block to the
 * obvious semantic HTML tag (h1..h6, p, ol/ul, table, blockquote, hr).
 * Inline marks compose into nested elements (bold becomes <strong> etc.).
 */
export function FlowContentView({ blocks, resources }: FlowContentViewProps) {
  return (
    <article className="border border-border bg-surface p-10 text-fg [&_h1]:text-3xl [&_h1]:font-bold [&_h1]:mt-0 [&_h1]:mb-4 [&_h2]:text-2xl [&_h2]:font-semibold [&_h2]:mt-8 [&_h2]:mb-3 [&_h3]:text-xl [&_h3]:font-semibold [&_h3]:mt-6 [&_h3]:mb-2 [&_p]:my-3 [&_p]:leading-relaxed [&_ul]:list-disc [&_ul]:pl-6 [&_ul]:my-3 [&_ol]:list-decimal [&_ol]:pl-6 [&_ol]:my-3 [&_li]:my-1 [&_table]:w-full [&_table]:border-collapse [&_table]:my-4 [&_th]:border [&_th]:border-border-strong [&_th]:px-3 [&_th]:py-2 [&_th]:text-left [&_th]:bg-elevated [&_th]:font-mono [&_th]:text-xs [&_th]:uppercase [&_th]:tracking-wider [&_td]:border [&_td]:border-border [&_td]:px-3 [&_td]:py-2 [&_blockquote]:border-l-2 [&_blockquote]:border-accent [&_blockquote]:pl-4 [&_blockquote]:italic [&_blockquote]:text-muted [&_blockquote]:my-4 [&_hr]:my-6 [&_hr]:border-border [&_pre]:bg-bg [&_pre]:border [&_pre]:border-border [&_pre]:p-3 [&_pre]:font-mono [&_pre]:text-sm [&_pre]:text-code [&_pre]:overflow-x-auto">
      {blocks.map((block, i) => (
        <BlockView key={i} block={block} resources={resources} />
      ))}
    </article>
  );
}

function BlockView({ block, resources }: { block: Block; resources: Resources }) {
  switch (block.type) {
    case "heading":
      return renderHeading(block.level, renderInlines(block.inlines, resources));
    case "paragraph":
      return <p>{renderInlines(block.inlines, resources)}</p>;
    case "list": {
      const Tag = block.ordered ? "ol" : "ul";
      return (
        <Tag start={block.start}>
          {block.items.map((item, i) => (
            <li key={i}>
              {item.blocks.map((b, j) => (
                <BlockView key={j} block={b} resources={resources} />
              ))}
            </li>
          ))}
        </Tag>
      );
    }
    case "table":
      return (
        <table>
          <tbody>
            {block.rows.map((row, i) => (
              <tr key={i}>
                {row.cells.map((cell, j) => {
                  const Cell = row.is_header ? "th" : "td";
                  return (
                    <Cell key={j} colSpan={cell.colspan} rowSpan={cell.rowspan}>
                      {cell.blocks.map((b, k) => (
                        <BlockView key={k} block={b} resources={resources} />
                      ))}
                    </Cell>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      );
    case "code":
      return (
        <pre>
          <code>{block.content}</code>
        </pre>
      );
    case "quote":
      return (
        <blockquote>
          {block.blocks.map((b, i) => (
            <BlockView key={i} block={b} resources={resources} />
          ))}
        </blockquote>
      );
    case "divider":
      return <hr />;
    case "image":
      // v0.1: placeholder block image. The flow-mode pipeline doesn't
      // yet extract DOCX inline pictures (tracked for v0.2).
      return (
        <div className="my-4 border border-dashed border-border bg-elevated px-4 py-8 font-mono text-xs uppercase tracking-wider text-muted text-center">
          image · {block.image_id}
        </div>
      );
    default:
      return null;
  }
}

function renderHeading(level: 1 | 2 | 3 | 4 | 5 | 6, content: ReactNode): ReactNode {
  switch (level) {
    case 1:
      return <h1>{content}</h1>;
    case 2:
      return <h2>{content}</h2>;
    case 3:
      return <h3>{content}</h3>;
    case 4:
      return <h4>{content}</h4>;
    case 5:
      return <h5>{content}</h5>;
    case 6:
      return <h6>{content}</h6>;
  }
}

function renderInlines(inlines: Inline[], resources: Resources): ReactNode {
  return inlines.map((inline, i) => (
    <InlineView key={i} inline={inline} resources={resources} />
  ));
}

function InlineView({ inline, resources }: { inline: Inline; resources: Resources }) {
  switch (inline.type) {
    case "br":
      return <br />;
    case "link":
      return (
        <a
          href={inline.href}
          title={inline.title}
          className="text-accent underline underline-offset-4 hover:text-accent-hover"
          target="_blank"
          rel="noreferrer"
        >
          {renderInlines(inline.inlines, resources)}
        </a>
      );
    case "math":
      return (
        <span className="font-mono text-amber-700">
          {inline.source.latex ?? inline.source.mathml ?? ""}
        </span>
      );
    case "image_inline":
      return <span className="text-neutral-400">[image {inline.image_id}]</span>;
    case "text": {
      let el: ReactNode = inline.text;
      for (const mark of inline.marks ?? []) {
        el = applyMark(mark, el, resources);
      }
      return <>{el}</>;
    }
  }
}

function applyMark(mark: Mark, content: ReactNode, resources: Resources): ReactNode {
  switch (mark.type) {
    case "bold":
      return <strong>{content}</strong>;
    case "italic":
      return <em>{content}</em>;
    case "underline":
      return <u>{content}</u>;
    case "strikethrough":
      return <s>{content}</s>;
    case "superscript":
      return <sup>{content}</sup>;
    case "subscript":
      return <sub>{content}</sub>;
    case "code":
      return <code className="px-1 bg-bg border border-border text-code text-sm font-mono">{content}</code>;
    case "color":
      return <span style={{ color: colorRefToCss(mark.color, resources) }}>{content}</span>;
    case "highlight":
      return (
        <mark style={{ background: colorRefToCss(mark.color, resources) }}>{content}</mark>
      );
    case "font":
      return <span style={{ fontFamily: `udm-${mark.font_id}` }}>{content}</span>;
    case "size":
      return content; // size mark not visualized in v0.1 flow viewer
  }
}
