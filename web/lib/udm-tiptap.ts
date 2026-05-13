/**
 * Conversion between UDM v0.1 flow content and TipTap (ProseMirror) JSON.
 *
 * UDM is the source of truth. The editor's TipTap document is derived from
 * UDM blocks on load and converted back to UDM blocks on save. Marks not
 * representable in TipTap StarterKit + Underline (color, highlight, font,
 * size) are preserved as opaque marks via the `_udm_marks` extension stash
 * so they survive an edit roundtrip even though they're not editable yet.
 */
import type { JSONContent } from "@tiptap/react";

import type { Block, Inline, Mark, TextInline } from "@/lib/udm";

// ---- UDM -> TipTap ------------------------------------------------------

export function blocksToTipTap(blocks: Block[]): JSONContent {
  return {
    type: "doc",
    content: blocks.map(blockToNode).filter((n): n is JSONContent => n !== null),
  };
}

function blockToNode(block: Block): JSONContent | null {
  switch (block.type) {
    case "paragraph":
      return {
        type: "paragraph",
        content: inlinesToNodes(block.inlines),
      };
    case "heading":
      return {
        type: "heading",
        attrs: { level: block.level },
        content: inlinesToNodes(block.inlines),
      };
    case "list":
      return {
        type: block.ordered ? "orderedList" : "bulletList",
        attrs: block.start ? { start: block.start } : undefined,
        content: block.items.map((item) => ({
          type: "listItem",
          content: item.blocks
            .map(blockToNode)
            .filter((n): n is JSONContent => n !== null),
        })),
      };
    case "table":
      // Tables aren't yet first-class in the editor (StarterKit doesn't
      // include the table extension). Round-trip them via passthrough so
      // they survive an edit even though the user can't modify them.
      return {
        type: "paragraph",
        attrs: { _udm_passthrough: block },
        content: [
          {
            type: "text",
            text: `[table · ${block.rows.length} rows · click to keep, edit elsewhere]`,
          },
        ],
      };
    case "code":
      return {
        type: "codeBlock",
        attrs: block.language ? { language: block.language } : undefined,
        content: block.content ? [{ type: "text", text: block.content }] : [],
      };
    case "quote":
      return {
        type: "blockquote",
        content: block.blocks
          .map(blockToNode)
          .filter((n): n is JSONContent => n !== null),
      };
    case "divider":
      return { type: "horizontalRule" };
    case "image":
      // Editor doesn't currently model UDM image blocks. Round-trip them
      // verbatim by stuffing the original block into a paragraph attribute.
      return {
        type: "paragraph",
        attrs: { _udm_passthrough: block },
        content: [{ type: "text", text: `[image: ${block.image_id}]` }],
      };
    default:
      return null;
  }
}

function inlinesToNodes(inlines: Inline[]): JSONContent[] {
  const out: JSONContent[] = [];
  for (const inline of inlines) {
    switch (inline.type) {
      case "text": {
        const marks = (inline.marks ?? [])
          .map(markToTipTap)
          .filter((m): m is NonNullable<ReturnType<typeof markToTipTap>> => m !== null);
        const opaque = (inline.marks ?? []).filter(isOpaqueMark);
        const node: JSONContent = { type: "text", text: inline.text };
        if (marks.length) node.marks = marks;
        if (opaque.length) {
          node.attrs = { ...(node.attrs ?? {}), _udm_opaque_marks: opaque };
        }
        out.push(node);
        break;
      }
      case "br":
        out.push({ type: "hardBreak" });
        break;
      case "link": {
        // TipTap models links as marks on text. Apply link mark to all
        // text descendants of this Hyperlink.
        const inner = inlinesToNodes(inline.inlines);
        for (const node of inner) {
          if (node.type === "text") {
            node.marks = [
              ...(node.marks ?? []),
              {
                type: "link",
                attrs: { href: inline.href, title: inline.title ?? null },
              },
            ];
          }
        }
        out.push(...inner);
        break;
      }
      // image_inline + math: editor doesn't model them in v0.1 — they get
      // dropped on edit. Tracked in office-adapter v0.2 backlog.
    }
  }
  return out;
}

const TIPTAP_NATIVE_MARKS = new Set([
  "bold",
  "italic",
  "underline",
  "strikethrough",
  "code",
]);

function isOpaqueMark(m: Mark): boolean {
  return !TIPTAP_NATIVE_MARKS.has(m.type);
}

function markToTipTap(mark: Mark): { type: string; attrs?: Record<string, unknown> } | null {
  switch (mark.type) {
    case "bold":
      return { type: "bold" };
    case "italic":
      return { type: "italic" };
    case "underline":
      return { type: "underline" };
    case "strikethrough":
      return { type: "strike" };
    case "code":
      return { type: "code" };
    default:
      return null; // color/highlight/font/size — handled via opaque stash
  }
}

// ---- TipTap -> UDM ------------------------------------------------------

export function tipTapToBlocks(doc: JSONContent): Block[] {
  if (doc.type !== "doc" || !doc.content) return [];
  return doc.content
    .map(nodeToBlock)
    .filter((b): b is Block => b !== null);
}

function nodeToBlock(node: JSONContent): Block | null {
  switch (node.type) {
    case "paragraph": {
      const passthrough = (node.attrs as Record<string, unknown> | undefined)?._udm_passthrough as
        | Block
        | undefined;
      if (passthrough) return passthrough;
      return { type: "paragraph", inlines: nodesToInlines(node.content ?? []) };
    }
    case "heading": {
      const level = clampHeadingLevel(
        (node.attrs as Record<string, unknown> | undefined)?.level
      );
      return { type: "heading", level, inlines: nodesToInlines(node.content ?? []) };
    }
    case "bulletList":
    case "orderedList":
      return {
        type: "list",
        ordered: node.type === "orderedList",
        items: (node.content ?? []).map((li) => ({
          blocks: (li.content ?? [])
            .map(nodeToBlock)
            .filter((b): b is Block => b !== null),
        })),
      };
    case "blockquote":
      return {
        type: "quote",
        blocks: (node.content ?? [])
          .map(nodeToBlock)
          .filter((b): b is Block => b !== null),
      };
    case "horizontalRule":
      return { type: "divider" };
    case "codeBlock": {
      const text = (node.content ?? [])
        .filter((c) => c.type === "text")
        .map((c) => c.text ?? "")
        .join("");
      const lang = (node.attrs as Record<string, unknown> | undefined)?.language as
        | string
        | undefined;
      const block: Block = { type: "code", content: text };
      if (lang) (block as { language?: string }).language = lang;
      return block;
    }
    // table: see passthrough comment in blockToNode — original block is
    // restored from the paragraph's _udm_passthrough attr above.
    default:
      return null;
  }
}

function clampHeadingLevel(value: unknown): 1 | 2 | 3 | 4 | 5 | 6 {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return 1;
  return Math.min(6, Math.max(1, Math.round(n))) as 1 | 2 | 3 | 4 | 5 | 6;
}

function nodesToInlines(nodes: JSONContent[]): Inline[] {
  const out: Inline[] = [];
  for (const node of nodes) {
    if (node.type === "hardBreak") {
      out.push({ type: "br" });
      continue;
    }
    if (node.type !== "text") continue;
    const text = node.text ?? "";
    if (!text) continue;

    const marks = node.marks ?? [];
    const linkMark = marks.find((m) => m.type === "link");
    const opaque = (node.attrs as Record<string, unknown> | undefined)?._udm_opaque_marks as
      | Mark[]
      | undefined;
    const udmMarks: Mark[] = [];
    for (const m of marks) {
      if (m.type === "link") continue;
      const converted = tipTapMarkToUdm(m);
      if (converted) udmMarks.push(converted);
    }
    if (opaque) udmMarks.push(...opaque);

    const textInline: TextInline = { type: "text", text };
    if (udmMarks.length) textInline.marks = udmMarks;

    if (linkMark) {
      const attrs = (linkMark.attrs as Record<string, unknown> | undefined) ?? {};
      out.push({
        type: "link",
        href: (attrs.href as string) ?? "",
        ...(attrs.title ? { title: attrs.title as string } : {}),
        inlines: [textInline],
      });
    } else {
      out.push(textInline);
    }
  }
  return out;
}

function tipTapMarkToUdm(mark: { type: string; attrs?: Record<string, unknown> }): Mark | null {
  switch (mark.type) {
    case "bold":
      return { type: "bold" };
    case "italic":
      return { type: "italic" };
    case "underline":
      return { type: "underline" };
    case "strike":
      return { type: "strikethrough" };
    case "code":
      return { type: "code" };
    default:
      return null;
  }
}
