"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";

type MarkdownNode = {
  type: string;
  value?: string;
  checked?: boolean | null;
  data?: {
    hName: string;
    hChildren: { type: "text"; value: string }[];
  };
  position?: { start: { offset?: number }; end: { offset?: number } };
  children?: MarkdownNode[];
};

const supported: Record<string, true> = {
  root: true,
  paragraph: true,
  text: true,
  strong: true,
  emphasis: true,
  list: true,
  listItem: true,
  inlineCode: true,
  code: true,
};

function literalSource(value: string): MarkdownNode {
  return {
    type: "text",
    value,
    data: { hName: "span", hChildren: [{ type: "text", value }] },
  };
}

// Replace unsupported constructs with their source, rather than unwrapping
// their parsed children or allowing them to invoke rich renderers.
function remarkRestrictedThinking() {
  return (tree: MarkdownNode, file: { value: unknown }) => {
    const source = String(file.value);
    function visit(node: MarkdownNode) {
      if (!node.children) return;
      node.children = node.children.map((child) => {
        const start = child.position?.start.offset;
        const end = child.position?.end.offset;
        const raw =
          start === undefined || end === undefined
            ? ""
            : source.slice(start, end);
        const indentedCode =
          child.type === "code" && !/^ {0,3}(?:`{3,}|~{3,})/.test(raw);
        const taskList =
          child.type === "list" &&
          child.children?.some((item) => item.checked != null);
        if (!supported[child.type] || indentedCode || taskList) {
          return literalSource(raw);
        }
        // CommonMark consumes backslashes around Pandoc math delimiters.
        if (child.type === "text" && /\\[([]/.test(raw)) {
          return literalSource(raw);
        }
        visit(child);
        return child;
      });
    }
    visit(tree);
  };
}

const plugins = [remarkGfm, remarkMath, remarkRestrictedThinking];

export function ThinkingMarkdown({ children }: { children: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={plugins}
      components={{
        span: ({ children }) => (
          <span style={{ whiteSpace: "pre-wrap", fontSize: "inherit" }}>
            {children}
          </span>
        ),
        p: ({ children }) => (
          <p style={{ margin: "0 0 0.6em", fontSize: "inherit" }}>{children}</p>
        ),
        ul: ({ children }) => (
          <ul
            style={{
              margin: "0 0 0.6em",
              paddingLeft: "1.5em",
              listStyleType: "disc",
              fontSize: "inherit",
            }}
          >
            {children}
          </ul>
        ),
        ol: ({ children, start }) => (
          <ol
            start={start}
            style={{
              margin: "0 0 0.6em",
              paddingLeft: "1.5em",
              listStyleType: "decimal",
              fontSize: "inherit",
            }}
          >
            {children}
          </ol>
        ),
        li: ({ children }) => (
          <li style={{ fontSize: "inherit" }}>{children}</li>
        ),
        pre: ({ children }) => (
          <pre
            style={{
              margin: "0 0 0.6em",
              fontSize: "inherit",
              whiteSpace: "pre-wrap",
              overflowWrap: "anywhere",
            }}
          >
            {children}
          </pre>
        ),
        code: ({ children }) => (
          <code style={{ fontSize: "inherit" }}>{children}</code>
        ),
      }}
    >
      {children}
    </ReactMarkdown>
  );
}
