"use client";

import { useEffect } from "react";

import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Underline from "@tiptap/extension-underline";

import type { Block } from "@/lib/udm";
import { blocksToTipTap, tipTapToBlocks } from "@/lib/udm-tiptap";

interface FlowEditorProps {
  initialBlocks: Block[];
  onChange?: (blocks: Block[]) => void;
}

export function FlowEditor({ initialBlocks, onChange }: FlowEditorProps) {
  const editor = useEditor({
    extensions: [StarterKit, Underline],
    content: blocksToTipTap(initialBlocks),
    immediatelyRender: false,
    editorProps: {
      attributes: {
        class:
          "min-h-[400px] focus:outline-none text-fg [&_h1]:text-3xl [&_h1]:font-bold [&_h1]:mb-4 [&_h2]:text-2xl [&_h2]:font-semibold [&_h2]:mt-6 [&_h2]:mb-3 [&_h3]:text-xl [&_h3]:font-semibold [&_h3]:mt-4 [&_h3]:mb-2 [&_p]:my-3 [&_p]:leading-relaxed [&_ul]:list-disc [&_ul]:pl-6 [&_ul]:my-3 [&_ol]:list-decimal [&_ol]:pl-6 [&_ol]:my-3 [&_li]:my-1 [&_blockquote]:border-l-2 [&_blockquote]:border-accent [&_blockquote]:pl-4 [&_blockquote]:italic [&_blockquote]:text-muted [&_blockquote]:my-4 [&_pre]:bg-bg [&_pre]:border [&_pre]:border-border [&_pre]:p-3 [&_pre]:font-mono [&_pre]:text-sm [&_pre]:text-code [&_pre]:overflow-x-auto [&_hr]:border-border [&_hr]:my-6",
      },
    },
    onUpdate: ({ editor: ed }) => {
      if (onChange) {
        onChange(tipTapToBlocks(ed.getJSON()));
      }
    },
  });

  // When the loaded document changes (new upload, discard) push fresh
  // content into the editor without losing focus state.
  useEffect(() => {
    if (!editor) return;
    const incoming = blocksToTipTap(initialBlocks);
    const current = editor.getJSON();
    if (JSON.stringify(current) !== JSON.stringify(incoming)) {
      editor.commands.setContent(incoming, { emitUpdate: false });
    }
  }, [editor, initialBlocks]);

  if (!editor) {
    return (
      <div className="border border-border bg-surface px-4 py-12 text-center font-mono text-xs uppercase tracking-wider text-muted">
        loading editor…
      </div>
    );
  }

  return (
    <div className="border border-border bg-surface">
      <Toolbar editor={editor} />
      <div className="p-10">
        <EditorContent editor={editor} />
      </div>
    </div>
  );
}

function Toolbar({ editor }: { editor: Editor }) {
  return (
    <div className="flex flex-wrap items-center gap-px border-b border-border bg-elevated px-3 py-2 sticky top-0 z-10">
      <ToolBtn
        onClick={() => editor.chain().focus().toggleBold().run()}
        active={editor.isActive("bold")}
        title="Bold (Ctrl+B)"
      >
        B
      </ToolBtn>
      <ToolBtn
        onClick={() => editor.chain().focus().toggleItalic().run()}
        active={editor.isActive("italic")}
        title="Italic (Ctrl+I)"
      >
        I
      </ToolBtn>
      <ToolBtn
        onClick={() => editor.chain().focus().toggleUnderline().run()}
        active={editor.isActive("underline")}
        title="Underline (Ctrl+U)"
      >
        U
      </ToolBtn>
      <ToolBtn
        onClick={() => editor.chain().focus().toggleStrike().run()}
        active={editor.isActive("strike")}
        title="Strikethrough"
      >
        S
      </ToolBtn>
      <Sep />
      <ToolBtn
        onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
        active={editor.isActive("heading", { level: 1 })}
        title="Heading 1"
      >
        H1
      </ToolBtn>
      <ToolBtn
        onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
        active={editor.isActive("heading", { level: 2 })}
        title="Heading 2"
      >
        H2
      </ToolBtn>
      <ToolBtn
        onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
        active={editor.isActive("heading", { level: 3 })}
        title="Heading 3"
      >
        H3
      </ToolBtn>
      <Sep />
      <ToolBtn
        onClick={() => editor.chain().focus().toggleBulletList().run()}
        active={editor.isActive("bulletList")}
        title="Bullet list"
      >
        UL
      </ToolBtn>
      <ToolBtn
        onClick={() => editor.chain().focus().toggleOrderedList().run()}
        active={editor.isActive("orderedList")}
        title="Numbered list"
      >
        OL
      </ToolBtn>
      <ToolBtn
        onClick={() => editor.chain().focus().toggleBlockquote().run()}
        active={editor.isActive("blockquote")}
        title="Quote"
      >
        &quot;
      </ToolBtn>
      <ToolBtn
        onClick={() => editor.chain().focus().toggleCodeBlock().run()}
        active={editor.isActive("codeBlock")}
        title="Code block"
      >
        &lt;/&gt;
      </ToolBtn>
      <ToolBtn
        onClick={() => editor.chain().focus().setHorizontalRule().run()}
        title="Horizontal rule"
      >
        HR
      </ToolBtn>
      <Sep />
      <ToolBtn
        onClick={() => editor.chain().focus().undo().run()}
        title="Undo (Ctrl+Z)"
        disabled={!editor.can().undo()}
      >
        ↶
      </ToolBtn>
      <ToolBtn
        onClick={() => editor.chain().focus().redo().run()}
        title="Redo (Ctrl+Shift+Z)"
        disabled={!editor.can().redo()}
      >
        ↷
      </ToolBtn>
    </div>
  );
}

function ToolBtn({
  onClick,
  active,
  title,
  disabled,
  children,
}: {
  onClick: () => void;
  active?: boolean;
  title: string;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      disabled={disabled}
      className={`min-w-[34px] h-7 px-2 font-mono text-xs uppercase tracking-wider border transition-colors ${
        active
          ? "bg-accent text-accent-fg border-accent"
          : "bg-transparent text-fg border-border hover:border-fg"
      } ${disabled ? "opacity-30 cursor-not-allowed" : "cursor-pointer"}`}
    >
      {children}
    </button>
  );
}

function Sep() {
  return <span className="self-stretch w-px bg-border mx-1" />;
}
