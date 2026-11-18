import type { ReactNode } from 'react';
import type {
  BulletList,
  OrderedList,
  Paragraph,
  SparkDocument,
  TextNode,
} from '../api/types';
import { inspectSparkDocumentSupport, isValidHttpUrl } from '../lib/document';

function renderTextNode(node: TextNode, key: number): ReactNode {
  let content: ReactNode = node.text;
  for (const mark of node.marks ?? []) {
    if (mark.type === 'bold') {
      content = <strong>{content}</strong>;
    } else if (mark.type === 'highlight') {
      content = <mark className="sp-mark-highlight">{content}</mark>;
    } else if (mark.type === 'link' && isValidHttpUrl(mark.attrs.href)) {
      content = (
        <a href={mark.attrs.href} target="_blank" rel="noopener noreferrer">
          {content}
        </a>
      );
    }
  }
  return <span key={key}>{content}</span>;
}

function renderParagraph(node: Paragraph, key: number): ReactNode {
  const children = node.content ?? [];
  if (children.length === 0) {
    return <p key={key}>&nbsp;</p>;
  }
  return (
    <p key={key}>
      {children.map((child, idx) =>
        child.type === 'text' ? renderTextNode(child, idx) : <br key={idx} />,
      )}
    </p>
  );
}

function renderBlocks(blocks: Array<Paragraph | BulletList | OrderedList>): ReactNode[] {
  return blocks.map((block, idx) => {
    if (block.type === 'paragraph') {
      return renderParagraph(block, idx);
    }
    if (block.type === 'bulletList') {
      return (
        <ul key={idx}>
          {block.content.map((item, itemIdx) => (
            <li key={itemIdx}>{renderBlocks(item.content)}</li>
          ))}
        </ul>
      );
    }
    return (
      <ol key={idx} start={block.attrs?.start ?? 1}>
        {block.content.map((item, itemIdx) => (
          <li key={itemIdx}>{renderBlocks(item.content)}</li>
        ))}
      </ol>
    );
  });
}

export function SafeDocumentView({ document }: { document: SparkDocument }) {
  const support = inspectSparkDocumentSupport(document);
  if (!support.supported) {
    return (
      <div className="sp-stack">
        <div className="sp-banner sp-banner--warning">
          <span>{support.reason ?? '正文包含暂不支持的协议节点，已按原始结构只读保留。'}</span>
        </div>
        <pre
          className="sp-mono"
          style={{
            margin: 0,
            padding: 10,
            background: 'var(--sp-surface-muted)',
            borderRadius: 'var(--sp-radius-control)',
            overflowX: 'auto',
          }}
        >
          {JSON.stringify(document, null, 2)}
        </pre>
      </div>
    );
  }

  return <div className="sp-richtext">{renderBlocks(document.content.content)}</div>;
}
